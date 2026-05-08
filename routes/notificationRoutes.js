const express = require('express');
const { Notification } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { t, localizeNotification } = require('../utils/i18n');

const router = express.Router();

/**
 * GET /api/notifications
 * Get all notifications for the logged-in user (newest first).
 * Query: page, limit, unreadOnly (true to filter only unread)
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: t(req.lang, 'notifications.active_company_required') });
        }
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const unreadOnly = req.query.unreadOnly === 'true';

        const query = { user: userId, company: activeCompanyId };
        if (unreadOnly) query.read = false;

        const [notifications, total] = await Promise.all([
            Notification.find(query)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Notification.countDocuments(query)
        ]);

        const unreadCount = await Notification.countDocuments({ user: userId, company: activeCompanyId, read: false });

        res.json({
            notifications: notifications.map((item) => localizeNotification(item, req.lang)),
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            },
            unreadCount
        });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * PATCH /api/notifications/read
 * Mark as read: body { ids: [] } for specific ids, or { all: true } to mark all read.
 * (Must be defined before /:id/read to avoid "read" being parsed as id)
 */
router.patch('/read', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: t(req.lang, 'notifications.active_company_required') });
        }
        const { ids, all } = req.body;

        if (all === true) {
            const result = await Notification.updateMany(
                { user: userId, company: activeCompanyId, read: false },
                { read: true, readAt: new Date() }
            );
            return res.json({
                message: t(req.lang, 'notifications.all_marked_read'),
                modifiedCount: result.modifiedCount
            });
        }

        if (ids && Array.isArray(ids) && ids.length > 0) {
            const result = await Notification.updateMany(
                { _id: { $in: ids }, user: userId, company: activeCompanyId },
                { read: true, readAt: new Date() }
            );
            return res.json({
                message: t(req.lang, 'notifications.marked_read'),
                modifiedCount: result.modifiedCount
            });
        }

        return res.status(400).json({
            message: t(req.lang, 'notifications.ids_or_all_required')
        });
    } catch (error) {
        console.error('Mark notifications read error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read.
 */
router.patch('/:id/read', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user._id;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: t(req.lang, 'notifications.active_company_required') });
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: id, user: userId, company: activeCompanyId },
            { read: true, readAt: new Date() },
            { new: true, lean: true }
        );

        if (!notification) {
            return res.status(404).json({ message: t(req.lang, 'notifications.not_found') });
        }

        res.json({ notification: localizeNotification(notification, req.lang) });
    } catch (error) {
        console.error('Mark notification read error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * GET /api/notifications/unread-count
 * Get only the unread count (lightweight).
 */
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: t(req.lang, 'notifications.active_company_required') });
        }
        const count = await Notification.countDocuments({
            user: req.user._id,
            company: activeCompanyId,
            read: false
        });
        res.json({ unreadCount: count });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
