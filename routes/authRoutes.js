const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { User, Company } = require('../models');
const { sendOTPEmail, sendRegistrationOTPEmail } = require('../services/emailService');
const { authenticateToken, signAccessToken, JWT_SECRET } = require('../middleware/auth');
const { getCompanyPlan, evaluateAndSyncCompanySubscription } = require('../services/subscriptionService');
const { isPostgresPrimary } = require('../services/sql/runtime');
const { waitForPostgres } = require('../db/postgres');
const authSql = require('../services/sql/authSql');
const otpSql = require('../services/sql/otpSql');
require('dotenv').config();

const router = express.Router();

/** In-memory OTPs when MongoDB is primary (single process). PostgreSQL uses `auth_email_otps` for PM2-safe storage. */
const otpStore = new Map();

const otpKeyForgotPassword = (email) => `pw:${String(email).toLowerCase().trim()}`;
const otpKeyRegistration = (email) => `reg:${String(email).toLowerCase().trim()}`;

const OTP_PURPOSE_REG = 'registration';
const OTP_PURPOSE_FP = 'forgot_password';

/** Max time after JWT `exp` that POST /refresh still accepts the token. */
const MAX_REFRESH_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const REGISTRATION_OTP_TTL_MS = 10 * 60 * 1000;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/;

// Generate OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

const persistRegistrationOtp = async (normalizedEmail, otp) => {
    const expiryTime = Date.now() + REGISTRATION_OTP_TTL_MS;
    if (isPostgresPrimary()) {
        await otpSql.upsertOtp(normalizedEmail, OTP_PURPOSE_REG, otp, expiryTime);
    } else {
        otpStore.set(otpKeyRegistration(normalizedEmail), { otp, expiryTime });
    }
};

const readRegistrationOtp = async (normalizedEmail) => {
    if (isPostgresPrimary()) {
        return otpSql.getOtp(normalizedEmail, OTP_PURPOSE_REG);
    }
    const v = otpStore.get(otpKeyRegistration(normalizedEmail));
    return v ? { otp: v.otp, expiryTime: v.expiryTime } : null;
};

const removeRegistrationOtp = async (normalizedEmail) => {
    if (isPostgresPrimary()) {
        await otpSql.deleteOtp(normalizedEmail, OTP_PURPOSE_REG);
    } else {
        otpStore.delete(otpKeyRegistration(normalizedEmail));
    }
};

const persistForgotPasswordOtp = async (normalizedEmail, otp, expiryTime) => {
    if (isPostgresPrimary()) {
        await otpSql.upsertOtp(normalizedEmail, OTP_PURPOSE_FP, otp, expiryTime);
    } else {
        otpStore.set(otpKeyForgotPassword(normalizedEmail), { otp, expiryTime });
    }
};

const readForgotPasswordOtp = async (normalizedEmail) => {
    if (isPostgresPrimary()) {
        return otpSql.getOtp(normalizedEmail, OTP_PURPOSE_FP);
    }
    const v = otpStore.get(otpKeyForgotPassword(normalizedEmail));
    return v ? { otp: v.otp, expiryTime: v.expiryTime } : null;
};

const removeForgotPasswordOtp = async (normalizedEmail) => {
    if (isPostgresPrimary()) {
        await otpSql.deleteOtp(normalizedEmail, OTP_PURPOSE_FP);
    } else {
        otpStore.delete(otpKeyForgotPassword(normalizedEmail));
    }
};

/**
 * Builds the same JSON body as a successful POST /login (after credentials verified).
 */
const writeLoginSuccessResponse = async (res, user, { bodyCompanyId, fcmToken }) => {
    try {
        if (isPostgresPrimary()) {
            await authSql.updateLastLogin(user._id);
        } else {
            await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
        }
    } catch (e) {
        console.error('Error updating lastLoginAt:', e);
    }

    if (fcmToken && typeof fcmToken === 'string' && fcmToken.trim()) {
        try {
            if (isPostgresPrimary()) {
                await authSql.addFcmToken(user._id, fcmToken.trim());
            } else {
                await User.findByIdAndUpdate(user._id, { $addToSet: { fcmTokens: fcmToken.trim() } });
            }
        } catch (tokenError) {
            console.error('Error saving FCM token on login:', tokenError);
        }
    }

    const companyIds = (user.companies || [])
        .map((entry) => normalizeCompanyId(entry))
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
    const companies = companyIds.length
        ? isPostgresPrimary()
            ? await authSql.findCompaniesByIds(companyIds)
            : await Company.find({ _id: { $in: companyIds } }).select('name email ownerUser')
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

    const token = signAccessToken(payload);
    const activeCompany = activeCompanyId
        ? isPostgresPrimary()
            ? await authSql.loadCompanyForSubscription(activeCompanyId)
            : await Company.findById(activeCompanyId).select('name subscription')
        : null;
    const activeMembership = activeCompanyId
        ? memberships.find((entry) => normalizeCompanyId(entry) === activeCompanyId)
        : null;
    const activeMembershipDisplayName = typeof activeMembership?.displayName === 'string'
        ? activeMembership.displayName.trim()
        : '';
    const activeMembershipIsOwner =
        Boolean(activeMembership?.isOwner) || activeMembership?.companyRole === 'owner';
    const resolvedName = activeMembershipDisplayName
        || ((activeMembershipIsOwner && activeCompany?.name) ? activeCompany.name : user.name);
    const subscriptionState = activeCompany
        ? await evaluateAndSyncCompanySubscription(activeCompany)
        : null;
    const activePlan = activeCompany
        ? getCompanyPlan(activeCompany)
        : getCompanyPlan({ subscription: { planId: 'free' } });

    return res.json({
        message: 'Login successful',
        token,
        activeCompanyId: activeCompanyId || null,
        companyName: activeCompany?.name || null,
        userName: resolvedName,
        user: {
            id: user._id,
            name: resolvedName,
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
    if (isPostgresPrimary()) {
        try {
            await waitForPostgres(20000);
            return true;
        } catch (e) {
            console.error('PostgreSQL unavailable:', e.message);
            res.status(503).json({
                message: 'Database is temporarily unavailable. Please try again in a moment.'
            });
            return false;
        }
    }
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
        const { companyName, ownerName, email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'email and password are required' });
        }

        const rawCompanyName = companyName != null ? String(companyName).trim() : '';
        const rawOwnerName = ownerName != null ? String(ownerName).trim() : '';

        // Backward compatibility:
        // - older clients send only companyName
        // - newer clients send both companyName and ownerName
        // - if one side is missing, safely mirror from the other
        const trimmedCompanyName = rawCompanyName || rawOwnerName;
        const trimmedOwnerName = rawOwnerName || rawCompanyName;

        if (!trimmedCompanyName || !trimmedOwnerName) {
            return res.status(400).json({
                message: 'Provide at least one of companyName or ownerName, plus email and password'
            });
        }

        if (!STRONG_PASSWORD_REGEX.test(String(password))) {
            return res.status(400).json({
                message: 'Password must be at least 8 characters and include uppercase, lowercase, and a special character'
            });
        }

        const normalizedEmail = email.toLowerCase().trim();

        if (isPostgresPrimary()) {
            let ownerUserSql = await authSql.findUserByEmail(normalizedEmail, { withPassword: true });
            let setMissingPasswordPlain = null;
            if (ownerUserSql) {
                if (ownerUserSql.registrationEmailPending === true) {
                    return res.status(403).json({
                        message:
                            'This email has a registration pending email verification. Enter the code from your inbox, or use POST /api/auth/resend-registration-otp.',
                        requiresEmailVerification: true
                    });
                }
                const hasPassword =
                    ownerUserSql.password &&
                    typeof ownerUserSql.password === 'string' &&
                    String(ownerUserSql.password).trim().length > 0;
                if (hasPassword) {
                    const isPasswordValid = await bcrypt.compare(password, ownerUserSql.password);
                    if (!isPasswordValid) {
                        return res.status(401).json({
                            message:
                                'Invalid credentials for existing user. Use your current account password to add another company.'
                        });
                    }
                } else {
                    /** Invited / legacy account with no password: same signup form sets password + new company. */
                    setMissingPasswordPlain = password;
                }
            }

            let ownerUser;
            let company;
            try {
                const result = await authSql.registerCompany({
                    trimmedCompanyName,
                    trimmedOwnerName,
                    normalizedEmail,
                    password,
                    existingOwnerUser: ownerUserSql || undefined,
                    setMissingPasswordPlain
                });
                ownerUser = result.ownerUser;
                company = result.company;
            } catch (e) {
                if (e.code === 'DUPLICATE_COMPANY_NAME') {
                    return res.status(409).json({
                        message: 'You already have a company with this name. Please choose a different company name.'
                    });
                }
                throw e;
            }

            const companyRows = [
                {
                    _id: company._id,
                    name: company.name,
                    email: company.email,
                    ownerUser: company.ownerUser,
                    toString() {
                        return String(company._id);
                    }
                }
            ];
            const companiesWithMembership = mapCompaniesWithMembership(ownerUser.companies || [], companyRows);

            if (ownerUser.registrationEmailPending === true) {
                const otp = generateOTP();
                await persistRegistrationOtp(normalizedEmail, otp);
                try {
                    await sendRegistrationOTPEmail(normalizedEmail, otp, trimmedCompanyName);
                } catch (mailErr) {
                    console.error('Registration OTP email failed:', mailErr);
                    return res.status(502).json({
                        message:
                            'Company was created but we could not send the verification email. Try POST /api/auth/resend-registration-otp shortly.'
                    });
                }

                return res.status(201).json({
                    message:
                        'Company created. Enter the verification code sent to your email to activate your account.',
                    requiresEmailVerification: true,
                    activeCompanyId: company._id,
                    companyName: company.name,
                    userName: ownerUser.name,
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
            }

            const token = signAccessToken({
                userId: ownerUser._id,
                email: ownerUser.email,
                role: ownerUser.role,
                companyId: company._id.toString()
            });

            return res.status(201).json({
                message: 'Company registered successfully',
                token,
                activeCompanyId: company._id,
                companyName: company.name,
                userName: ownerUser.name,
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
        }

        let ownerUser = await User.findOne({ email: normalizedEmail });

        if (ownerUser) {
            if (ownerUser.registrationEmailPending === true) {
                return res.status(403).json({
                    message:
                        'This email has a registration pending email verification. Enter the code from your inbox, or use POST /api/auth/resend-registration-otp.',
                    requiresEmailVerification: true
                });
            }
            const hasPassword =
                ownerUser.password &&
                typeof ownerUser.password === 'string' &&
                String(ownerUser.password).trim().length > 0;
            if (hasPassword) {
                const isPasswordValid = await bcrypt.compare(password, ownerUser.password);
                if (!isPasswordValid) {
                    return res.status(401).json({
                        message:
                            'Invalid credentials for existing user. Use your current account password to add another company.'
                    });
                }
            } else {
                ownerUser.password = await bcrypt.hash(password, 12);
                ownerUser.emailVerified = true;
                ownerUser.registrationEmailPending = false;
                await ownerUser.save();
            }

            // If owner name was changed while adding another company with the same email,
            // keep the latest owner name in user profile and owner memberships.
            const normalizedOwnerName = String(trimmedOwnerName || '').trim();
            const currentName = String(ownerUser.name || '').trim();
            if (normalizedOwnerName && normalizedOwnerName !== currentName) {
                ownerUser.name = normalizedOwnerName;
                if (!Array.isArray(ownerUser.companies)) {
                    ownerUser.companies = [];
                }
                ownerUser.companies = ownerUser.companies.map((membership) => {
                    const isOwnerMembership = membership?.isOwner === true || membership?.companyRole === 'owner';
                    if (!isOwnerMembership) return membership;
                    const membershipObject =
                        membership && typeof membership.toObject === 'function'
                            ? membership.toObject()
                            : membership;
                    return {
                        ...membershipObject,
                        displayName: normalizedOwnerName
                    };
                });
                await ownerUser.save();
            }
        } else {
            const hashedPassword = await bcrypt.hash(password, 12);
            ownerUser = await User.create({
                name: trimmedOwnerName,
                title: 'Owner',
                email: normalizedEmail,
                password: hashedPassword,
                role: 'owner',
                emailVerified: false,
                registrationEmailPending: true
            });
        }
        if (ownerUser.role !== 'owner') {
            ownerUser.role = 'owner';
            await ownerUser.save();
        }

        const existingCompanyWithSameName = await Company.findOne({
            ownerUser: ownerUser._id,
            name: { $regex: new RegExp(`^${trimmedCompanyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        }).select('_id name');

        if (existingCompanyWithSameName) {
            return res.status(409).json({
                message: 'You already have a company with this name. Please choose a different company name.'
            });
        }

        const createCompanyPayload = {
            name: trimmedCompanyName,
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
                displayName: trimmedOwnerName,
                companyRole: 'owner',
                isOwner: true
            });
            await ownerUser.save();
        }

        const companies = await Company.find({ _id: { $in: [company._id] } }).select('name email ownerUser');
        const companiesWithMembership = mapCompaniesWithMembership(ownerUser.companies || [], companies);

        if (ownerUser.registrationEmailPending === true) {
            const otp = generateOTP();
            await persistRegistrationOtp(normalizedEmail, otp);
            try {
                await sendRegistrationOTPEmail(normalizedEmail, otp, trimmedCompanyName);
            } catch (mailErr) {
                console.error('Registration OTP email failed:', mailErr);
                return res.status(502).json({
                    message: 'Company was created but we could not send the verification email. Try POST /api/auth/resend-registration-otp shortly.'
                });
            }

            return res.status(201).json({
                message: 'Company created. Enter the verification code sent to your email to activate your account.',
                requiresEmailVerification: true,
                activeCompanyId: company._id,
                companyName: company.name,
                userName: ownerUser.name,
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
        }

        const token = signAccessToken({
            userId: ownerUser._id,
            email: ownerUser.email,
            role: ownerUser.role,
            companyId: company._id.toString()
        });

        res.status(201).json({
            message: 'Company registered successfully',
            token,
            activeCompanyId: company._id,
            companyName: company.name,
            userName: ownerUser.name,
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

// 0b. Verify registration email OTP (new company owner)
router.post('/verify-registration-otp', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
        const { email, otp, companyId: bodyCompanyId, token: fcmToken } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ message: 'email and otp are required' });
        }

        const normalizedEmail = String(email).toLowerCase().trim();
        const stored = await readRegistrationOtp(normalizedEmail);
        if (!stored) {
            return res.status(400).json({ message: 'Code not found or expired. Request a new one.' });
        }
        if (Date.now() > stored.expiryTime) {
            await removeRegistrationOtp(normalizedEmail);
            return res.status(400).json({ message: 'Code expired' });
        }
        if (stored.otp !== String(otp).trim()) {
            return res.status(400).json({ message: 'Invalid code' });
        }

        const user = isPostgresPrimary()
            ? await authSql.findUserByEmail(normalizedEmail)
            : await User.findOne({ email: normalizedEmail });
        if (!user) {
            await removeRegistrationOtp(normalizedEmail);
            return res.status(404).json({ message: 'User not found' });
        }
        if (user.registrationEmailPending !== true) {
            await removeRegistrationOtp(normalizedEmail);
            return res.status(400).json({ message: 'This account is already verified. Log in with your password.' });
        }
        

        let verifiedUser = user;
        if (isPostgresPrimary()) {
            verifiedUser = await authSql.verifyRegistration(user._id);
        } else {
            user.emailVerified = true;
            user.registrationEmailPending = false;
            await user.save();
            verifiedUser = user;
        }
        await removeRegistrationOtp(normalizedEmail);

        return writeLoginSuccessResponse(res, verifiedUser, { bodyCompanyId, fcmToken });
    } catch (error) {
        console.error('Verify registration OTP error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 0c. Resend registration OTP (requires password)
router.post('/resend-registration-otp', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'email and password are required' });
        }

        const normalizedEmail = String(email).toLowerCase().trim();
        const user = isPostgresPrimary()
            ? await authSql.findUserByEmail(normalizedEmail, { withPassword: true })
            : await User.findOne({ email: normalizedEmail });
        if (!user || !user.password) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        if (user.registrationEmailPending !== true) {
            return res.status(400).json({ message: 'This account is already verified.' });
        }

        const ok = await bcrypt.compare(password, user.password);
        if (!ok) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const otp = generateOTP();
        await persistRegistrationOtp(normalizedEmail, otp);
        await sendRegistrationOTPEmail(
            normalizedEmail,
            otp,
            user.name || 'your company'
        );

        res.json({ message: 'A new verification code was sent to your email.' });
    } catch (error) {
        console.error('Resend registration OTP error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * Create a platform super admin (`role: super_admin`) for the /admin dashboard.
 * Protected by env `PLATFORM_ADMIN_SETUP_SECRET` — set it in the server environment, call once, then remove or rotate.
 *
 * POST /api/auth/platform-admin/create
 * Body: { email, password, name?, title?, setupSecret }
 */
router.post('/platform-admin/create', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;

        const serverSecret = String(process.env.PLATFORM_ADMIN_SETUP_SECRET || '').trim();
        if (!serverSecret) {
            return res.status(403).json({
                message:
                    'This endpoint is disabled. Set PLATFORM_ADMIN_SETUP_SECRET in the server environment, then call again.'
            });
        }

        const { email, password, name, title, setupSecret } = req.body || {};
        const clientSecret = String(setupSecret || '').trim();

        const a = Buffer.from(serverSecret, 'utf8');
        const b = Buffer.from(clientSecret, 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(403).json({ message: 'Invalid setup secret' });
        }

        if (!email || !password) {
            return res.status(400).json({ message: 'email and password are required' });
        }
        if (!STRONG_PASSWORD_REGEX.test(String(password))) {
            return res.status(400).json({
                message: 'Password must be at least 8 characters and include uppercase, lowercase, and a special character'
            });
        }

        const normalizedEmail = String(email).toLowerCase().trim();
        const existing = isPostgresPrimary()
            ? await authSql.findUserByEmail(normalizedEmail)
            : await User.findOne({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({ message: 'An account with this email already exists' });
        }

        const hashed = await bcrypt.hash(String(password), 10);
        const user = isPostgresPrimary()
            ? await authSql.createPlatformAdmin({
                name: String(name || 'Platform Admin').trim() || 'Platform Admin',
                title: String(title || 'admin').trim() || 'admin',
                email: normalizedEmail,
                passwordHash: hashed
            })
            : await User.create({
                name: String(name || 'Platform Admin').trim() || 'Platform Admin',
                title: String(title || 'admin').trim() || 'admin',
                email: normalizedEmail,
                password: hashed,
                role: 'super_admin',
                emailVerified: true,
                registrationEmailPending: false,
                accountStatus: 'active',
                companies: []
            });

        return res.status(201).json({
            message:
                'Platform super admin created. Log in via POST /api/auth/login with platformAdminLogin: true (or the admin console).',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('platform-admin/create error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 1. Login via email and password
router.post('/login', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;
        const { email, password, companyId: bodyCompanyId, token: fcmToken, platformAdminLogin } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const normalizedEmail = String(email).toLowerCase().trim();
        const user = isPostgresPrimary()
            ? await authSql.findUserByEmail(normalizedEmail, { withPassword: true })
            : await User.findOne({ email: normalizedEmail });
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

        if (user.accountStatus === 'banned') {
            return res.status(403).json({ message: 'This account has been suspended' });
        }

        if (user.registrationEmailPending === true) {
            return res.status(403).json({
                message:
                    'Email not verified. Use the code we sent when you registered, or POST /api/auth/resend-registration-otp.',
                requiresEmailVerification: true
            });
        }

        if (platformAdminLogin === true && user.role !== 'super_admin') {
            return res.status(403).json({
                message:
                    'Platform administrator access only. Use the team / company sign-in page for workspace accounts.'
            });
        }

        return writeLoginSuccessResponse(res, user, { bodyCompanyId, fcmToken });
    } catch (error) {
        console.error('Login error:', error);
        console.error('Login error stack:', error?.stack);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/**
 * Rotate access token using current Bearer (signature must be valid; expiry ignored).
 * Frontend: POST /api/auth/refresh with Authorization: Bearer <token>
 */
router.post('/refresh', async (req, res) => {
    try {
        if (!(await ensureDbConnected(res))) return;

        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Access token required' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
        } catch (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }

        if (!decoded.userId) {
            return res.status(403).json({ message: 'Invalid token' });
        }

        if (typeof decoded.exp === 'number') {
            const expiredMsAgo = Date.now() - decoded.exp * 1000;
            if (expiredMsAgo > MAX_REFRESH_AFTER_EXPIRY_MS) {
                return res.status(403).json({ message: 'Session expired. Please login again.' });
            }
        }

        const user = isPostgresPrimary()
            ? await authSql.findUserById(decoded.userId)
            : await User.findById(decoded.userId).select('-password');
        if (!user) {
            return res.status(401).json({ message: 'User not found' });
        }

        if (user.accountStatus === 'banned') {
            return res.status(403).json({ message: 'This account has been suspended' });
        }

        if (user.registrationEmailPending === true) {
            return res.status(403).json({ message: 'Email not verified. Please verify your email or register again.' });
        }

        const payload = {
            userId: user._id,
            email: user.email,
            role: user.role
        };

        if (decoded.companyId != null && String(decoded.companyId).trim()) {
            const cid = String(decoded.companyId).trim();
            const ok = (user.companies || []).some((e) => normalizeCompanyId(e) === cid);
            if (ok) {
                payload.companyId = cid;
            }
        }

        const newToken = signAccessToken(payload);
        return res.json({
            message: 'Token refreshed',
            token: newToken
        });
    } catch (error) {
        console.error('Refresh token error:', error);
        return res.status(500).json({ message: 'Internal server error' });
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

        const token = signAccessToken({
            userId: req.user._id,
            email: req.user.email,
            role: req.user.role,
            companyId: cid
        });

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

        const normalizedForgotEmail = String(email).toLowerCase().trim();

        const user = isPostgresPrimary()
            ? await authSql.findUserByEmail(normalizedForgotEmail)
            : await User.findOne({ email: normalizedForgotEmail });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.registrationEmailPending === true || user.emailVerified === false) {
            return res.status(403).json({
                message: 'This account is not activated yet. Verify your email first before using forgot password.'
            });
        }

        const otp = generateOTP();
        const expiryTime = Date.now() + 10 * 60 * 1000; // 10 minutes

        await persistForgotPasswordOtp(normalizedForgotEmail, otp, expiryTime);

        await sendOTPEmail(normalizedForgotEmail, otp);

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
        if (!STRONG_PASSWORD_REGEX.test(String(newPassword))) {
            return res.status(400).json({
                message: 'Password must be at least 8 characters and include uppercase, lowercase, and a special character'
            });
        }

        const normalizedEmail = String(email).toLowerCase().trim();
        const storedOTP = await readForgotPasswordOtp(normalizedEmail);
        if (!storedOTP) {
            const regPending = await readRegistrationOtp(normalizedEmail);
            if (regPending) {
                return res.status(400).json({
                    message:
                        'This code is for email verification (new account), not password reset. Use POST /api/auth/verify-registration-otp with email and otp only.',
                    useEndpoint: '/api/auth/verify-registration-otp'
                });
            }
            return res.status(400).json({ message: 'OTP not found or expired' });
        }

        if (Date.now() > storedOTP.expiryTime) {
            await removeForgotPasswordOtp(normalizedEmail);
            return res.status(400).json({ message: 'OTP expired' });
        }

        if (storedOTP.otp !== String(otp).trim()) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);
        if (isPostgresPrimary()) {
            await authSql.setPasswordAndVerifyEmail(normalizedEmail, hashedPassword);
        } else {
            await User.findOneAndUpdate(
                { email: normalizedEmail },
                { password: hashedPassword, emailVerified: true, registrationEmailPending: false }
            );
        }

        await removeForgotPasswordOtp(normalizedEmail);

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
