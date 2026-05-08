const jwt = require('jsonwebtoken');
const { User, Company } = require('../models');
const { evaluateAndSyncCompanySubscription } = require('../services/subscriptionService');
const { isPostgresPrimary } = require('../services/sql/runtime');
const authSql = require('../services/sql/authSql');
const { t } = require('../utils/i18n');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
/** Access token TTL (refresh extends session without re-login). */
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const signAccessToken = (payload) =>
    jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

const membershipCompanyId = (entry) => {
    if (!entry) return null;
    const raw = entry.companyId ?? entry.company;
    if (!raw) return null;
    if (typeof raw === 'object' && raw._id) return String(raw._id);
    return String(raw);
};

const getRequestDisplayName = (req) => {
    const membershipDisplayName = typeof req.companyMembership?.displayName === 'string'
        ? req.companyMembership.displayName.trim()
        : '';
    if (membershipDisplayName) {
        return membershipDisplayName;
    }

    const isOwner = Boolean(req.companyMembership?.isOwner) || req.companyMembership?.companyRole === 'owner';
    if (isOwner && req.activeCompanyName) {
        return req.activeCompanyName;
    }

    return req.user?.name || req.user?.email || '';
};

/**
 * Resolves active company from JWT `companyId` (preferred) or `x-company-id` header.
 * Validates membership on the loaded user. Sets req.companyId / req.companyMembership or null.
 */
const resolveActiveCompany = (req, user, decoded) => {
    const fromToken = decoded.companyId != null && String(decoded.companyId).trim()
        ? String(decoded.companyId).trim()
        : null;
    const headerRaw = req.headers['x-company-id'];
    const fromHeader = headerRaw != null && String(headerRaw).trim()
        ? String(headerRaw).trim()
        : null;
    const candidate = fromToken || fromHeader;

    if (!candidate) {
        req.companyId = null;
        req.companyMembership = null;
        return;
    }

    const membership = (user.companies || []).find(
        (entry) => membershipCompanyId(entry) === candidate
    );

    if (!membership) {
        return { error: { status: 403, message: 'You are not a member of this company' } };
    }

    req.companyId = membershipCompanyId(membership);
    req.companyMembership = membership;
    return null;
};

const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({ message: 'Access token required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = isPostgresPrimary()
            ? await authSql.findUserById(decoded.userId)
            : await User.findById(decoded.userId).select('-password');
        
        if (!user) {
            return res.status(401).json({ message: 'Invalid token' });
        }

        if (user.accountStatus === 'banned') {
            return res.status(403).json({ message: 'Account suspended' });
        }

        if (user.registrationEmailPending === true) {
            return res.status(403).json({
                message: 'Email not verified. Complete verification before using the API.'
            });
        }

        req.user = user;
        req.authPayload = decoded;

        const companyErr = resolveActiveCompany(req, user, decoded);
        if (companyErr) {
            return res.status(companyErr.error.status).json({ message: companyErr.error.message });
        }

        if (req.companyId) {
            const company = isPostgresPrimary()
                ? await authSql.loadCompanyForSubscription(req.companyId)
                : await Company.findById(req.companyId).select(
                    'name subscription platformStatus deletedAt'
                );
            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }
            req.activeCompanyName = company.name || null;
            const isPlatformStaff = req.user.role === 'super_admin';
            if (company.deletedAt && !isPlatformStaff) {
                return res.status(403).json({ message: 'This workspace is no longer available' });
            }
            if (company.platformStatus === 'suspended' && !isPlatformStaff) {
                return res.status(403).json({ message: 'This workspace has been suspended' });
            }
            const state = await evaluateAndSyncCompanySubscription(company);
            req.subscriptionState = state;
            if (state.noticeKey) {
                res.setHeader('x-subscription-notice', t(req.lang, state.noticeKey, state.noticeParams || {}));
            }
        }

        next();
    } catch (error) {
        return res.status(403).json({ message: 'Invalid or expired token' });
    }
};

const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        next();
    };
};

/**
 * See any project in the active company (owner / company admin|manager), legacy global manager, or platform super admin.
 */
const canBypassProjectAssignment = (req) => {
    const m = req.companyMembership;
    if (m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole))) return true;
    if (req.user?.role === 'manager') return true;
    if (req.user?.role === 'super_admin') return true;
    return false;
};

module.exports = {
    authenticateToken,
    requireRole,
    resolveActiveCompany,
    getRequestDisplayName,
    canBypassProjectAssignment,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    signAccessToken
};
