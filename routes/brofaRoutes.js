const express = require('express');
const { sendUserQuestion } = require('../services/brofaEmailService');

const router = express.Router();


// Send user question to brofa@absai.dev
router.post('/send-question', async (req, res) => {
    try {
        const { 
            name, 
            email, 
            phoneNumber, 
            businessCategory, 
            brandName, 
            serviceType, 
            message 
        } = req.body;

        // Validate required fields
        const missingFields = [];
        if (!name) missingFields.push('name');
        if (!phoneNumber) missingFields.push('phoneNumber');
        if (!businessCategory) missingFields.push('businessCategory');
        if (!brandName) missingFields.push('brandName');
        if (!serviceType) missingFields.push('serviceType');

        if (missingFields.length > 0) {
            return res.status(400).json({ 
                success: false,
                message: `Missing required fields: ${missingFields.join(', ')}` 
            });
        }

        // Validate email format if provided
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ 
                success: false,
                message: 'Invalid email format' 
            });
        }

        // Send the question email
        const result = await sendUserQuestion({
            name,
            email: email || undefined,
            phoneNumber,
            businessCategory,
            brandName,
            serviceType,
            message: message || undefined
        });

        res.status(200).json({
            success: true,
            message: 'Question sent successfully to brofa@absai.dev',
            messageId: result.messageId
        });
    } catch (error) {
        console.error('Send question error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to send question',
            error: error.message 
        });
    }
});

module.exports = router;

