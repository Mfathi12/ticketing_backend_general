const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Company } = require('../models');
const { sendOTPEmail } = require('../services/emailService');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Store OTPs temporarily (in production, use Redis or database)
const otpStore = new Map();

// Generate OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// 0. Register company (SaaS tenant) with owner account
router.post('/register-company', async (req, res) => {
    try {
        const { companyName, email, password } = req.body;

        if (!companyName || !email || !password) {
            return res.status(400).json({ message: 'companyName, email and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const normalizedEmail = email.toLowerCase().trim();

        let ownerUser = await User.findOne({ email: normalizedEmail });

        if (ownerUser) {
            const isPasswordValid = await bcrypt.compare(password, ownerUser.password);
            if (!isPasswordValid) {
                return res.status(401).json({ message: 'Invalid credentials for existing user' });
            }
        } else {
            const hashedPassword = await bcrypt.hash(password, 12);
            ownerUser = await User.create({
                name: companyName.trim(),
                title: 'Owner',
                email: normalizedEmail,
                password: hashedPassword,
                role: 'admin'
            });
        }

        const company = await Company.create({
            name: companyName.trim(),
            email: normalizedEmail,
            ownerUser: ownerUser._id,
            members: [{
                user: ownerUser._id,
                role: 'owner',
                isOwner: true
            }]
        });

        const alreadyMember = ownerUser.companies?.some(
            (entry) => entry.company?.toString() === company._id.toString()
        );

        if (!alreadyMember) {
            ownerUser.companies.push({
                company: company._id,
                companyRole: 'owner',
                isOwner: true
            });
            await ownerUser.save();
        }

        const token = jwt.sign(
            { userId: ownerUser._id, email: ownerUser.email, role: ownerUser.role },
            JWT_SECRET
        );

        res.status(201).json({
            message: 'Company registered successfully',
            token,
            company: {
                id: company._id,
                name: company.name,
                email: company.email,
                ownerUser: company.ownerUser
            },
            user: {
                id: ownerUser._id,
                name: ownerUser.name,
                title: ownerUser.title,
                email: ownerUser.email,
                role: ownerUser.role,
                companies: ownerUser.companies
            }
        });
    } catch (error) {
        console.error('Register company error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 1. Login via email and password
router.post('/login', async (req, res) => {
    try {
        const { email, password, token: fcmToken } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // If FCM token is sent (optional), register it for this user
        if (fcmToken && typeof fcmToken === 'string' && fcmToken.trim()) {
            try {
                await User.findByIdAndUpdate(
                    user._id,
                    { $addToSet: { fcmTokens: fcmToken.trim() } }
                );
            } catch (tokenError) {
                console.error('Error saving FCM token on login:', tokenError);
            }
        }

        const token = jwt.sign(
            { userId: user._id, email: user.email, role: user.role },
            JWT_SECRET
        );

        const companyIds = (user.companies || []).map((entry) => entry.company).filter(Boolean);
        const companies = companyIds.length
            ? await Company.find({ _id: { $in: companyIds } }).select('name email ownerUser')
            : [];

        const companiesWithMembership = (user.companies || []).map((entry) => {
            const matchedCompany = companies.find(
                (company) => company._id.toString() === entry.company.toString()
            );
            return {
                companyId: entry.company,
                companyRole: entry.companyRole,
                isOwner: entry.isOwner,
                company: matchedCompany || null
            };
        });

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                title: user.title,
                email: user.email,
                role: user.role,
                companies: companiesWithMembership
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 2. Forget password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const otp = generateOTP();
        const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes

        otpStore.set(email.toLowerCase(), { otp, expiryTime });

        await sendOTPEmail(email, otp);

        res.json({ message: 'OTP sent to your email' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 3. Verify OTP and reset password
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({ message: 'Email, OTP, and new password are required' });
        }

        const storedOTP = otpStore.get(email.toLowerCase());
        if (!storedOTP) {
            return res.status(400).json({ message: 'OTP not found or expired' });
        }

        if (Date.now() > storedOTP.expiryTime) {
            otpStore.delete(email.toLowerCase());
            return res.status(400).json({ message: 'OTP expired' });
        }

        if (storedOTP.otp !== otp) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);
        await User.findOneAndUpdate(
            { email: email.toLowerCase() },
            { password: hashedPassword }
        );

        otpStore.delete(email.toLowerCase());

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
