const express = require('express');
const models = require('../models');
const { PersonalTask } = models;
const { authenticateToken } = require('../middleware/auth');
const { isPostgresPrimary } = require('../services/sql/runtime');
const { waitForPostgres } = require('../db/postgres');

const router = express.Router();

const PERSONAL_TASK_COLUMNS = ['backlog', 'this_week', 'today', 'done'];

const mapTask = (doc) => {
    const o = doc.toJSON ? doc.toJSON() : (doc.toObject ? doc.toObject() : doc);
    return {
        _id: o.id || o._id,
        user_id: o.userId || o.user,
        title: o.title,
        estimated_minutes: o.estimatedMinutes,
        column: o.column,
        created_at: o.createdAt,
        updated_at: o.updatedAt,
        completed_at: o.completedAt ?? null
    };
};

router.get('/personal-tasks', authenticateToken, async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const { PersonalTask: PT } = await waitForPostgres();
            const tasks = await PT.findAll({
                where: { userId: req.user.id || req.user._id },
                order: [['updatedAt', 'DESC']]
            });
            return res.json({ tasks: tasks.map(mapTask) });
        }

        const tasks = await PersonalTask.find({ user: req.user._id })
            .sort({ updatedAt: -1 })
            .lean();
        res.json({ tasks: tasks.map(mapTask) });
    } catch (error) {
        console.error('List personal tasks error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/personal-tasks', authenticateToken, async (req, res) => {
    try {
        const { title, estimated_minutes, column } = req.body || {};

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ message: 'title is required' });
        }
        const minutes = Number(estimated_minutes);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
            return res.status(400).json({ message: 'estimated_minutes must be between 1 and 1440' });
        }
        let col = 'backlog';
        if (column != null && String(column).trim()) {
            col = String(column).trim();
            if (!PERSONAL_TASK_COLUMNS.includes(col)) {
                return res.status(400).json({ message: 'Invalid column' });
            }
        }

        if (isPostgresPrimary()) {
            const { PersonalTask: PT } = await waitForPostgres();
            const doc = await PT.create({
                userId: req.user.id || req.user._id,
                title: title.trim(),
                estimatedMinutes: Math.round(minutes),
                column: col,
                completedAt: col === 'done' ? new Date() : null
            });
            return res.status(201).json({ task: mapTask(doc) });
        }

        const doc = await PersonalTask.create({
            user: req.user._id,
            title: title.trim(),
            estimatedMinutes: Math.round(minutes),
            column: col,
            completedAt: col === 'done' ? new Date() : null
        });
        res.status(201).json({ task: mapTask(doc) });
    } catch (error) {
        console.error('Create personal task error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/personal-tasks/:taskId', authenticateToken, async (req, res) => {
    try {
        const { taskId } = req.params;
        const { title, estimated_minutes, column } = req.body || {};
        const update = {};

        if (title != null) {
            if (typeof title !== 'string' || !title.trim()) {
                return res.status(400).json({ message: 'title must be non-empty' });
            }
            update.title = title.trim();
        }
        if (estimated_minutes != null) {
            const minutes = Number(estimated_minutes);
            if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
                return res.status(400).json({ message: 'estimated_minutes must be between 1 and 1440' });
            }
            update.estimatedMinutes = Math.round(minutes);
        }
        if (column != null && String(column).trim()) {
            const col = String(column).trim();
            if (!PERSONAL_TASK_COLUMNS.includes(col)) {
                return res.status(400).json({ message: 'Invalid column' });
            }
            update.column = col;
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ message: 'No valid fields to update' });
        }

        if (isPostgresPrimary()) {
            const { PersonalTask: PT } = await waitForPostgres();
            const task = await PT.findOne({
                where: { id: taskId, userId: req.user.id || req.user._id }
            });
            if (!task) return res.status(404).json({ message: 'Task not found' });

            if (update.column) {
                const prevCol = task.column;
                if (update.column === 'done' && prevCol !== 'done') update.completedAt = new Date();
                else if (update.column !== 'done' && prevCol === 'done') update.completedAt = null;
            }

            Object.assign(task, update);
            await task.save();
            return res.json({ task: mapTask(task) });
        }

        const task = await PersonalTask.findOne({ _id: taskId, user: req.user._id });
        if (!task) return res.status(404).json({ message: 'Task not found' });

        if (update.column) {
            const prevCol = task.column;
            if (update.column === 'done' && prevCol !== 'done') update.completedAt = new Date();
            else if (update.column !== 'done' && prevCol === 'done') update.completedAt = null;
        }

        Object.assign(task, update);
        await task.save();
        res.json({ task: mapTask(task) });
    } catch (error) {
        console.error('Update personal task error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/personal-tasks/:taskId', authenticateToken, async (req, res) => {
    try {
        const { taskId } = req.params;

        if (isPostgresPrimary()) {
            const { PersonalTask: PT } = await waitForPostgres(); // fixed: was waitForPostgresModels
            const deletedCount = await PT.destroy({
                where: { id: taskId, userId: req.user.id || req.user._id }
            });
            if (!deletedCount) return res.status(404).json({ message: 'Task not found' });
            return res.json({ message: 'Task deleted' });
        }

        const result = await PersonalTask.deleteOne({ _id: taskId, user: req.user._id });
        if (result.deletedCount === 0) return res.status(404).json({ message: 'Task not found' });
        res.json({ message: 'Task deleted' });
    } catch (error) {
        console.error('Delete personal task error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;