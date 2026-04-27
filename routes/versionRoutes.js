const express = require('express');
const Version = require('../models/version');
const { t } = require('../utils/i18n');

const router = express.Router();

const upsertVersionHandler = async (req, res) => {
    try {
        const { version } = req.body;
        if (!version || !String(version).trim()) {
            return res.status(400).json({
                success: false,
                message: t(req.lang, 'version.version_required')
            });
        }

        let existing = await Version.findOne().sort({ updatedAt: -1 });

        if (existing) {
            existing.version = String(version).trim();
            await existing.save();
            return res.status(200).json({
                success: true,
                data: existing
            });
        }

        const newVersion = new Version({ version: String(version).trim() });
        await newVersion.save();
        return res.status(201).json({
            success: true,
            data: newVersion
        });
    } catch (error) {
        console.error('Upsert version error:', error);
        return res.status(500).json({
            success: false,
            message: t(req.lang, 'common.internal_server_error')
        });
    }
};

// GET /api/version
router.get('/', async (_req, res) => {
    try {
        const existing = await Version.findOne().sort({ updatedAt: -1 });

        if (!existing) {
            return res.status(404).json({
                success: false,
                message: t(req.lang, 'version.no_version_found')
            });
        }

        return res.status(200).json({
            success: true,
            version: existing
        });
    } catch (error) {
        console.error('Get version error:', error);
        return res.status(500).json({
            success: false,
            message: t(req.lang, 'common.internal_server_error')
        });
    }
});

// POST /api/version/upsert
router.post('/upsert', upsertVersionHandler);

// PUT /api/version/upsert
router.put('/upsert', upsertVersionHandler);

module.exports = router;
