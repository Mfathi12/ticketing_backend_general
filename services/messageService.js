/**
 * Message service: cursor-friendly reads for chat messages.
 *
 * Designed to coexist with the existing `routes/chatRoutes.js`
 * `GET /conversation/:id/messages` handler, which uses skip/limit and a
 * very specific response shape (see API_CONTRACT_REGRESSION_CHECKLIST).
 * This service only powers new code paths or opt-in cursor pagination —
 * existing routes are untouched.
 */
const mongoose = require('mongoose');
const { Message } = require('../models');
const { fetchUsersByIdMap } = require('../utils/userBatch');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const clampLimit = (raw) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, n);
};

const parseCursor = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Collect mention ObjectIds from a list of messages so the caller can
 * resolve them in a single round-trip.
 *
 * @param {object[]} messages - lean message docs
 * @returns {string[]} unique stringified ids
 */
const collectMentionIds = (messages) => {
    const out = new Set();
    if (!Array.isArray(messages)) return [];
    for (const m of messages) {
        if (!m || !Array.isArray(m.mentions)) continue;
        for (const id of m.mentions) {
            if (id != null) out.add(String(id));
        }
    }
    return [...out];
};

/**
 * Bulk-resolve mentioned users for a message page.
 *
 * @param {object[]} messages
 * @returns {Promise<Map<string, import('mongoose').Document>>}
 */
const loadMentionedUsers = async (messages) => {
    const ids = collectMentionIds(messages);
    if (!ids.length) return new Map();
    return fetchUsersByIdMap(ids);
};

/**
 * Cursor-paginated message read for a single conversation. Excludes
 * soft-deleted rows (matching the existing route's `isDeleted: false`
 * filter) and uses the new `{ conversation, createdAt:-1 }` index plus
 * `{ company, isDeleted, createdAt:-1 }` for company-wide audits.
 *
 * @param {object} args
 * @param {string|mongoose.Types.ObjectId} args.companyId
 * @param {string|mongoose.Types.ObjectId} args.conversationId
 * @param {string|Date|null} [args.cursor] - ISO date string or Date; returns
 *        messages strictly older than this timestamp.
 * @param {number} [args.limit] - capped at MAX_LIMIT.
 * @returns {Promise<{ messages: object[], nextCursor: string|null, hasMore: boolean }>}
 */
const getMessagesPage = async ({ companyId, conversationId, cursor = null, limit } = {}) => {
    if (!companyId || !conversationId) {
        return { messages: [], nextCursor: null, hasMore: false };
    }
    const cap = clampLimit(limit);
    const before = parseCursor(cursor);

    const query = {
        company: companyId,
        conversation: conversationId,
        isDeleted: false
    };
    if (before) query.createdAt = { $lt: before };

    const docs = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(cap + 1)
        .lean();

    const hasMore = docs.length > cap;
    const page = hasMore ? docs.slice(0, cap) : docs;
    const nextCursor = page.length && hasMore
        ? new Date(page[page.length - 1].createdAt).toISOString()
        : null;

    return { messages: page, nextCursor, hasMore };
};

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    clampLimit,
    parseCursor,
    collectMentionIds,
    loadMentionedUsers,
    getMessagesPage
};
