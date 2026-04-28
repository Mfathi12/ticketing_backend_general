const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { uploadMultiple, uploadsDir } = require('../middleware/upload');
const path = require('path');

const router = express.Router();

// Upload images for tickets
router.post('/ticket-images', authenticateToken, (req, res) => {
    try {
        const { images } = req.body;

        res.json({
            success: true,
            message: 'Images uploaded successfully',
            images: images,
            count: imageUrls.length
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to upload images',
            error: error.message 
        });
    }
});

// Delete image
router.delete('/ticket-images/:filename', authenticateToken, (req, res) => {
    try {
        const { filename } = req.params;
        const fs = require('fs');
        const path = require('path');
        
        const filePath = path.join(uploadsDir, filename);
        
        // Check if file exists
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({
                success: true,
                message: 'Image deleted successfully'
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Image not found'
            });
        }
    } catch (error) {
        console.error('Delete image error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete image',
            error: error.message
        });
    }
});

module.exports = router;

