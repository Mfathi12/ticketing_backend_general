const { Notification, User } = require('../models');
const { sendNotificationToUser } = require('./fcmService');

/**
 * Create a notification (persist in DB and send FCM push).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {{ type: string, title: string, body?: string, data?: object }} payload
 * @returns {Promise<import('../models/notification')>}
 */
const createNotification = async (userId, payload) => {
    const { type, title, body = '', data = {}, company = null } = payload;

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
        const user = await User.findById(userId);
        if (user) {
            await sendNotificationToUser(
                user,
                { title, body },
                { type, ...data }
            );
        }
    } catch (err) {
        console.error('FCM send error in createNotification:', err);
        // Notification is already saved; don't throw
    }

    return doc;
};

module.exports = {
    createNotification
};
