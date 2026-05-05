const express = require('express');
const { sendEmail } = require('../services/emailService');

const router = express.Router();

const CONTACT_RECEIVER_EMAIL = 'youssef.abbas@absai.dev';

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

router.post('/contact-sales', async (req, res) => {
    try {
        const {
            name,
            email,
            company,
            phone,
            seats,
            message
        } = req.body || {};

        const cleanName = String(name || '').trim();
        const cleanEmail = String(email || '').trim();
        const cleanCompany = String(company || '').trim();
        const cleanPhone = String(phone || '').trim();
        const cleanSeats = String(seats || '').trim();
        const cleanMessage = String(message || '').trim();

        const missing = [];
        if (!cleanName) missing.push('name');
        if (!cleanEmail) missing.push('email');
        if (!cleanCompany) missing.push('company');
        if (!cleanSeats) missing.push('seats');

        if (missing.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Missing required fields: ${missing.join(', ')}`
            });
        }

        if (!isValidEmail(cleanEmail)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        const subject = `[Landing Contact] ${cleanCompany} - ${cleanSeats} seats`;
        const text = [
            'New landing contact-sales request',
            `Name: ${cleanName}`,
            `Email: ${cleanEmail}`,
            `Company: ${cleanCompany}`,
            `Phone: ${cleanPhone || 'N/A'}`,
            `Requested seats: ${cleanSeats}`,
            '',
            'Message:',
            cleanMessage || 'N/A'
        ].join('\n');

        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
                <h2 style="color: #111827;">New Contact Sales Request</h2>
                <table style="width: 100%; border-collapse: collapse; margin-top: 12px;">
                    <tr><td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Name</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${cleanName}</td></tr>
                    <tr><td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Email</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${cleanEmail}</td></tr>
                    <tr><td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Company</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${cleanCompany}</td></tr>
                    <tr><td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Phone</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${cleanPhone || 'N/A'}</td></tr>
                    <tr><td style="padding: 8px; border: 1px solid #e5e7eb;"><strong>Requested seats</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${cleanSeats}</td></tr>
                </table>
                <div style="margin-top: 14px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;">
                    <strong>Message</strong>
                    <p style="margin: 8px 0 0; white-space: pre-wrap;">${cleanMessage || 'N/A'}</p>
                </div>
            </div>
        `;

        const result = await sendEmail(CONTACT_RECEIVER_EMAIL, subject, text, html);

        return res.status(200).json({
            success: true,
            message: 'Contact request sent successfully',
            messageId: result?.messageId || null
        });
    } catch (error) {
        console.error('Landing contact-sales error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to send contact request'
        });
    }
});

module.exports = router;

