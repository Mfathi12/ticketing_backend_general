const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/auth');
const { uploadMultiple, uploadsDir } = require('../middleware/upload');

const router = express.Router();

const MAX_IMAGES = 10;
const MAX_URL_LENGTH = 2048;

const parseJsonBody = express.json({ limit: '512kb' });

function validateImageUrls(images) {
    if (!Array.isArray(images)) {
        throw new Error('images must be an array');
    }
    if (images.length > MAX_IMAGES) {
        throw new Error(`Maximum ${MAX_IMAGES} images allowed`);
    }
    const out = [];
    for (const item of images) {
        if (typeof item !== 'string' || !item.trim()) {
            throw new Error('Each image must be a non-empty URL string');
        }
        const url = item.trim();
        if (url.length > MAX_URL_LENGTH) {
            throw new Error('Image URL too long');
        }
        if (!/^https?:\/\//i.test(url)) {
            throw new Error('Each image must be a valid http(s) URL');
        }
        out.push(url);
    }
    return out;
}

// JSON: { images: ["https://..."] } after Bunny (or any CDN) upload.
// Multipart: legacy server-side storage (field name "images").
router.post(
    '/ticket-images',
    authenticateToken,
    (req, res, next) => {
        const ct = String(req.headers['content-type'] || '');
        if (ct.includes('multipart/form-data')) {
            return uploadMultiple(req, res, next);
        }
        return parseJsonBody(req, res, next);
    },
    (req, res) => {
        try {
            if (req.files && req.files.length > 0) {
                const images = req.files.map((f) => `/uploads/tickets/${f.filename}`);
                return res.json({
                    success: true,
                    message: 'Images uploaded successfully',
                    images,
                    count: images.length,
                });
            }

            const raw = req.body;
            if (!raw || typeof raw !== 'object') {
                return res.status(400).json({
                    success: false,
                    message: 'Send JSON { images: string[] } or multipart form-data with field "images"',
                });
            }

            const list = raw.images ?? raw.urls;
            const imageUrls = validateImageUrls(Array.isArray(list) ? list : []);

            return res.json({
                success: true,
                message: 'Images uploaded successfully',
                images: imageUrls,
                count: imageUrls.length,
            });
        } catch (error) {
            console.error('Upload error:', error);
            const msg = error.message || String(error);
            const clientError =
                msg.includes('must be') ||
                msg.includes('Maximum') ||
                msg.includes('valid http') ||
                msg.includes('too long') ||
                msg.includes('non-empty');
            res.status(clientError ? 400 : 500).json({
                success: false,
                message: 'Failed to upload images',
                error: msg,
            });
        }
    }
);

router.delete('/ticket-images/:filename', authenticateToken, (req, res) => {
    try {
        const { filename } = req.params;
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({
                success: false,
                message: 'Invalid filename',
            });
        }

        const filePath = path.join(uploadsDir, filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return res.json({
                success: true,
                message: 'Image deleted successfully',
            });
        }

        return res.status(404).json({
            success: false,
            message: 'Image not found',
        });
    } catch (error) {
        console.error('Delete image error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete image',
            error: error.message,
        });
    }
});

module.exports = router;
