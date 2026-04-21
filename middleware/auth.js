const jwt = require('jsonwebtoken');
const { User } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

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
        (entry) => entry.company && entry.company.toString() === candidate
    );

    if (!membership) {
        return { error: { status: 403, message: 'You are not a member of this company' } };
    }

    req.companyId = membership.company;
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
        const user = await User.findById(decoded.userId).select('-password');
        
        if (!user) {
            return res.status(401).json({ message: 'Invalid token' });
        }

        req.user = user;
        req.authPayload = decoded;

        const companyErr = resolveActiveCompany(req, user, decoded);
        if (companyErr) {
            return res.status(companyErr.error.status).json({ message: companyErr.error.message });
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

module.exports = {
    authenticateToken,
    requireRole,
    resolveActiveCompany,
    JWT_SECRET
};
