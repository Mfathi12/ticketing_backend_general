const express = require('express');
const { Notification } = require('../models');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/notifications
 * Get all notifications for the logged-in user (newest first).
 * Query: page, limit, unreadOnly (true to filter only unread)
 */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const unreadOnly = req.query.unreadOnly === 'true';

        const query = { user: userId };
        if (unreadOnly) query.read = false;

        const [notifications, total] = await Promise.all([
            Notification.find(query)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Notification.countDocuments(query)
        ]);

        const unreadCount = await Notification.countDocuments({ user: userId, read: false });

        res.json({
            notifications,
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
        const { ids, all } = req.body;

        if (all === true) {
            const result = await Notification.updateMany(
                { user: userId, read: false },
                { read: true, readAt: new Date() }
            );
            return res.json({
                message: 'All notifications marked as read',
                modifiedCount: result.modifiedCount
            });
        }

        if (ids && Array.isArray(ids) && ids.length > 0) {
            const result = await Notification.updateMany(
                { _id: { $in: ids }, user: userId },
                { read: true, readAt: new Date() }
            );
            return res.json({
                message: 'Notifications marked as read',
                modifiedCount: result.modifiedCount
            });
        }

        return res.status(400).json({
            message: 'Provide body.ids (array of notification ids) or body.all: true'
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

        const notification = await Notification.findOneAndUpdate(
            { _id: id, user: userId },
            { read: true, readAt: new Date() },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({ message: 'Notification not found' });
        }

        res.json({ notification });
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
        const count = await Notification.countDocuments({
            user: req.user._id,
            read: false
        });
        res.json({ unreadCount: count });
    } catch (error) {
        console.error('Unread count error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
