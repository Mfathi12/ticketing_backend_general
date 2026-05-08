const mongoose = require('mongoose');
const { Notification, User } = require('../models');
const { sendNotificationToUser } = require('./fcmService');
const { fetchUsersByIdMap } = require('../utils/userBatch');
const { isPostgresPrimary } = require('./sql/runtime');
const { getSequelizeModels } = require('../db/postgres');
const authSql = require('./sql/authSql');

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const notificationRowToLean = (row) => {
    const p = row.get ? row.get({ plain: true }) : row;
    return {
        _id: p.id,
        id: p.id,
        user: p.userId,
        company: p.companyId,
        type: p.type,
        title: p.title,
        body: p.body,
        data: p.data || {},
        read: p.read,
        readAt: p.readAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
};

/**
 * Create a notification (persist in DB and send FCM push).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ type: string, title: string, body?: string, data?: object, company?: import('mongoose').Types.ObjectId|null }} payload
 * @param {{ userDoc?: import('mongoose').Document|null }} [options]
 * @returns {Promise<import('../models/notification')>}
 */
const createNotification = async (userId, payload, options = {}) => {
    const { type, title, body = '', data = {}, company = null } = payload;
    const { userDoc = null } = options;

    if (isPostgresPrimary()) {
        const m = getSequelizeModels();
        const row = await m.Notification.create({
            id: newObjectIdString(),
            userId: String(userId),
            companyId: company ? String(company) : null,
            type,
            title,
            body,
            data: data || {},
            read: false
        });
        const lean = notificationRowToLean(row);
        try {
            const user = userDoc || (await authSql.findUserById(userId));
            if (user && Array.isArray(user.fcmTokens) && user.fcmTokens.length) {
                await sendNotificationToUser(user, { title, body }, { type, ...data });
            }
        } catch (err) {
            console.error('FCM send error in createNotification:', err);
        }
        return lean;
    }

    const doc = new Notification({
        ...(company ? { company } : {}),
        user: userId,
        type,
        title,
        body,
        data
    });
    await doc.save();

    try {
        const user = userDoc || await User.findById(userId);
        if (user) {
            await sendNotificationToUser(
                user,
                { title, body },
                { type, ...data }
            );
        }
    } catch (err) {
        console.error('FCM send error in createNotification:', err);
    }

    return doc;
};

/**
 * Batch-mark a set of notifications as read for a specific user/company
 * scope. Mirrors the existing `PATCH /api/notifications/read` semantics
 * (caller is responsible for enforcing scope; we echo it through the filter).
 *
 * @param {object} args
 * @param {string|import('mongoose').Types.ObjectId} args.userId
 * @param {string|import('mongoose').Types.ObjectId} args.companyId
 * @param {Array<string|import('mongoose').Types.ObjectId>} [args.ids]
 * @param {boolean} [args.all=false]
 * @returns {Promise<{ modifiedCount: number }>}
 */
const markNotificationsRead = async ({ userId, companyId, ids, all = false } = {}) => {
    if (!userId || !companyId) return { modifiedCount: 0 };
    if (isPostgresPrimary()) {
        const m = getSequelizeModels();
        const { Op } = require('sequelize');
        const where = { userId: String(userId), companyId: String(companyId) };
        if (all === true) {
            where.read = false;
        } else if (Array.isArray(ids) && ids.length) {
            where.id = { [Op.in]: ids.map(String) };
        } else {
            return { modifiedCount: 0 };
        }
        const [n] = await m.Notification.update(
            { read: true, readAt: new Date() },
            { where }
        );
        return { modifiedCount: n };
    }
    const baseFilter = { user: userId, company: companyId };
    let filter;
    if (all === true) {
        filter = { ...baseFilter, read: false };
    } else if (Array.isArray(ids) && ids.length) {
        filter = { ...baseFilter, _id: { $in: ids } };
    } else {
        return { modifiedCount: 0 };
    }
    const result = await Notification.updateMany(filter, {
        read: true,
        readAt: new Date()
    });
    return { modifiedCount: result.modifiedCount || 0 };
};

/**
 * Resolve FCM token bundles for many users in one round-trip. Useful when
 * fanning out a notification to a list of recipients without N+1 user reads.
 *
 * @param {Iterable<string|import('mongoose').Types.ObjectId>} userIds
 * @returns {Promise<Map<string, { _id: any, fcmTokens: string[] }>>}
 */
const loadFcmTokensForUsers = async (userIds) => {
    const map = await fetchUsersByIdMap(userIds);
    const out = new Map();
    for (const [id, user] of map.entries()) {
        out.set(id, {
            _id: user._id,
            fcmTokens: Array.isArray(user.fcmTokens) ? user.fcmTokens : []
        });
    }
    return out;
};

module.exports = {
    createNotification,
    markNotificationsRead,
    loadFcmTokensForUsers
};
