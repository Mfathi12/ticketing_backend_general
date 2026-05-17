const express = require('express');
const { CompletionGif } = require('../models');
const { t } = require('../utils/i18n');
const { isPostgresPrimary } = require('../services/sql/runtime');
const completionGifSql = require('../services/sql/completionGifSql');

const router = express.Router();

const mongoToPublicShape = (doc) => {
    const p = doc.toObject ? doc.toObject() : doc;
    return {
        id: String(p._id || p.id),
        url: p.url,
        label: p.label ?? null
    };
};

const mongoToAdminShape = (doc) => {
    const p = doc.toObject ? doc.toObject() : doc;
    return {
        id: String(p._id || p.id),
        url: p.url,
        label: p.label ?? null,
        tags: Array.isArray(p.tags) ? p.tags : [],
        weight: p.weight ?? 1,
        isActive: Boolean(p.isActive),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
};

// GET /api/completion-gifs
router.get('/', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const gifs = await completionGifSql.listActive();
            return res.status(200).json({
                success: true,
                gifs: gifs.map(({ id, url, label }) => ({ id, url, label }))
            });
        }

        const docs = await CompletionGif.find({ isActive: true })
            .sort({ createdAt: 1 })
            .lean();
        return res.status(200).json({
            success: true,
            gifs: docs.map(mongoToPublicShape)
        });
    } catch (error) {
        console.error('List completion gifs error:', error);
        return res.status(500).json({
            success: false,
            message: t(req.lang, 'common.internal_server_error')
        });
    }
});

module.exports = router;

module.exports.mongoToPublicShape = mongoToPublicShape;
module.exports.mongoToAdminShape = mongoToAdminShape;
