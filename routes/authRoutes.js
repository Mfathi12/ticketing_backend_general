const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { User, Company } = require('../models');
const { sendOTPEmail } = require('../services/emailService');
const { authenticateToken } = require('../middleware/auth');
const { getCompanyPlan, evaluateAndSyncCompanySubscription } = require('../services/subscriptionService');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Store OTPs temporarily (in production, use Redis or database)
const otpStore = new Map();

// Generate OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const waitForDbReady = async (timeoutMs = 4000) => {
    const conn = mongoose.connection;
    if (conn.readyState === 1) return true; // connected

    const mongoUri = process.env.MONGODB_URI;
    if (conn.readyState === 0 && mongoUri) {
        // In serverless/cold starts, connection might not be started yet.
        try {
            await mongoose.connect(mongoUri, {
                serverSelectionTimeoutMS: 15000,
                socketTimeoutMS: 45000,
                family: 4,
                maxPoolSize: 10
            });
            return true;
        } catch (_) {
            // fallback to timed wait below
        }
    }

    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            conn.off('connected', onConnected);
            conn.off('open', onConnected);
            conn.off('error', onError);
            conn.off('disconnected', onError);
            resolve(ok);
        };
        const onConnected = () => finish(true);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(conn.readyState === 1), timeoutMs);

        conn.on('connected', onConnected);
        conn.on('open', onConnected);
        conn.on('error', onError);
        conn.on('disconnected', onError);
    });
};

const ensureDbConnected = async (res) => {
    const ok = await waitForDbReady(15000);
    if (!ok) {
        res.status(503).json({
            message: 'Database is temporarily unavailable. Please try again in a moment.'
        });
        return false;
    }
    return true;
};

const normalizeCompanyId = (membership) => {
    if (!membership) return null;
    const raw = membership.companyId ?? membership.company;
    if (!raw) return null;
    if (typeof raw === 'object' && raw._id) return String(raw._id);
    return String(raw);
};

const mapCompaniesWithMembership = (memberships = [], companies = []) =>
    memberships.map((entry) => {
        const entryCompanyId = normalizeCompanyId(entry);
        const matchedCompany = companies.find(
            (company) => entryCompanyId && company._id.toString() === entryCompanyId
        );
        return {
            companyId: entryCompanyId,
            companyRole: entry.companyRole,
            isOwner: entry.isOwner,
            company: matchedCompany || null
        };
    });

// 0. Register company (SaaS tenant) with owner account
router.post('/register-company', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
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
            if (!ownerUser.password || typeof ownerUser.password !== 'string') {
                return res.status(400).json({
                    message: 'Existing account has no password. Please reset password first, then create company.'
                });
            }
            const isPasswordValid = await bcrypt.compare(password, ownerUser.password);
            if (!isPasswordValid) {
                return res.status(401).json({
                    message: 'Invalid credentials for existing user. Use your current account password to add another company.'
                });
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

        const createCompanyPayload = {
            name: companyName.trim(),
            email: normalizedEmail,
            ownerUser: ownerUser._id,
            subscription: {
                planId: 'free',
                status: 'active',
                isTrial: false,
                trialEndsAt: null,
                expiresAt: null,
                graceEndsAt: null
            },
            members: [{
                user: ownerUser._id,
                role: 'owner',
                isOwner: true
            }]
        };

        let company;
        try {
            company = await Company.create(createCompanyPayload);
        } catch (createErr) {
            const isDuplicateEmailIndex =
                createErr?.code === 11000 &&
                (createErr?.keyPattern?.email || String(createErr?.message || '').includes('email_1'));

            if (!isDuplicateEmailIndex) {
                throw createErr;
            }

            // Backward-compatibility: old DB may still have unique index on email.
            try {
                await Company.collection.dropIndex('email_1');
            } catch (dropErr) {
                console.error('Could not drop legacy email_1 index on Company:', dropErr.message);
            }

            company = await Company.create(createCompanyPayload);
        }

        if (!Array.isArray(ownerUser.companies)) {
            ownerUser.companies = [];
        }
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

        const companies = await Company.find({ _id: { $in: [company._id] } }).select('name email ownerUser');
        const companiesWithMembership = mapCompaniesWithMembership(ownerUser.companies || [], companies);

        const token = jwt.sign(
            {
                userId: ownerUser._id,
                email: ownerUser.email,
                role: ownerUser.role,
                companyId: company._id.toString()
            },
            JWT_SECRET
        );

        res.status(201).json({
            message: 'Company registered successfully',
            token,
            activeCompanyId: company._id,
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
                companies: companiesWithMembership
            },
            subscription: {
                planId: 'free',
                status: 'active',
                isTrial: false,
                expiresAt: null,
                graceEndsAt: null,
                trialEndsAt: null
            },
            activePlan: getCompanyPlan(company)
        });
    } catch (error) {
        console.error('Register company error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 1. Login via email and password
router.post('/login', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
        const { email, password, companyId: bodyCompanyId, token: fcmToken } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }
        

        const normalizedEmail = String(email).toLowerCase().trim();
        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!user.password || typeof user.password !== 'string') {
            return res.status(401).json({ message: 'This account cannot login with password' });
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

        const companyIds = (user.companies || [])
            .map((entry) => normalizeCompanyId(entry))
            .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
        const companies = companyIds.length
            ? await Company.find({ _id: { $in: companyIds } }).select('name email ownerUser')
            : [];

        const companiesWithMembership = mapCompaniesWithMembership(user.companies || [], companies);

        const memberships = user.companies || [];
        let activeCompanyId = null;

        if (bodyCompanyId) {
            const cid = String(bodyCompanyId).trim();
            const ok = memberships.some((e) => normalizeCompanyId(e) === cid);
            if (!ok) {
                return res.status(403).json({ message: 'You are not a member of the selected company' });
            }
            activeCompanyId = cid;
        } else if (memberships.length === 1) {
            activeCompanyId = normalizeCompanyId(memberships[0]);
        } else if (memberships.length > 1) {
            return res.status(400).json({
                message: 'companyId is required: you belong to more than one company',
                companies: companiesWithMembership
            });
        }

        const payload = {
            userId: user._id,
            email: user.email,
            role: user.role
        };
        if (activeCompanyId) {
            payload.companyId = activeCompanyId;
        }

        const token = jwt.sign(payload, JWT_SECRET);
        const activeCompany = activeCompanyId
            ? await Company.findById(activeCompanyId).select('subscription')
            : null;
        const subscriptionState = activeCompany
            ? await evaluateAndSyncCompanySubscription(activeCompany)
            : null;
        const activePlan = activeCompany ? getCompanyPlan(activeCompany) : getCompanyPlan({ subscription: { planId: 'free' } });

        res.json({
            message: 'Login successful',
            token,
            activeCompanyId: activeCompanyId || null,
            user: {
                id: user._id,
                name: user.name,
                title: user.title,
                email: user.email,
                role: user.role,
                companies: companiesWithMembership
            },
            subscription: activeCompany
                ? {
                    planId: activeCompany.subscription?.planId || 'free',
                    status: activeCompany.subscription?.status || 'active',
                    expiresAt: activeCompany.subscription?.expiresAt || null,
                    graceEndsAt: activeCompany.subscription?.graceEndsAt || null,
                    isTrial: Boolean(activeCompany.subscription?.isTrial),
                    trialEndsAt: activeCompany.subscription?.trialEndsAt || null
                }
                : null,
            activePlan,
            subscriptionNotice: subscriptionState?.notice || null
        });
    } catch (error) {
        console.error('Login error:', error);
        console.error('Login error stack:', error?.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Switch active company (new JWT with companyId)
router.post('/switch-company', authenticateToken, async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
        const { companyId } = req.body;
        if (!companyId) {
            return res.status(400).json({ message: 'companyId is required' });
        }
        const cid = String(companyId).trim();
        const membership = (req.user.companies || []).find(
            (e) => normalizeCompanyId(e) === cid
        );
        if (!membership) {
            return res.status(403).json({ message: 'You are not a member of this company' });
        }

        const token = jwt.sign(
            {
                userId: req.user._id,
                email: req.user.email,
                role: req.user.role,
                companyId: cid
            },
            JWT_SECRET
        );

        res.json({
            message: 'Company context updated',
            token,
            activeCompanyId: cid
        });
    } catch (error) {
        console.error('Switch company error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 2. Forget password
router.post('/forgot-password', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
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
        if (!(await ensureDbConnected(res))) return;
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
