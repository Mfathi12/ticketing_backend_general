const express = require('express');
const mongoose = require('mongoose');
const { authenticateToken } = require('../middleware/auth');
const { User, Company, Project, Ticket, PlanCatalogOverride } = require('../models');
const {
    getPlanById,
    addMonths,
    evaluateAndSyncCompanySubscription,
    invalidateCompanySubscriptionEvalCache,
    PLAN_IDS,
    SUBSCRIPTION_PLANS,
    refreshPlanCatalogCache,
    getPlansSourceList,
    parseCatalogUnitPrice
} = require('../services/subscriptionService');
const { isPostgresPrimary } = require('../services/sql/runtime');
const platformAdminSql = require('../services/sql/platformAdminSql');
const { getSequelizeModels } = require('../db/postgres');

const router = express.Router();

const PAID_PLAN_IDS = ['basic', 'pro', 'enterprise'];

const requirePlatformAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'super_admin') {
        return res.status(403).json({ message: 'Platform super admin only' });
    }
    next();
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseIntParam = (v, def, min, max) => {
    const n = parseInt(String(v ?? def), 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
};

const now = () => new Date();

const resolveCompanyUiStatus = (company) => {
    if (company.platformStatus === 'suspended') return 'Suspended';
    const sub = company.subscription || {};
    const n = now();
    const planId = sub.planId || 'free';
    const paid = planId !== 'free';
    if (sub.status === 'expired') return 'Expired';
    if (paid && sub.expiresAt) {
        const exp = new Date(sub.expiresAt);
        const graceEnd = sub.graceEndsAt ? new Date(sub.graceEndsAt) : null;
        if (exp < n) {
            if (graceEnd && graceEnd > n) return 'Active';
            return 'Expired';
        }
    }
    return 'Active';
};

const resolveSubscriptionUiStatus = (company) => {
    const sub = company.subscription || {};
    const n = now();
    if (sub.status === 'cancelled') return 'Cancelled';
    if (sub.status === 'expired') return 'Past Due';
    if (sub.status === 'pending') return 'Past Due';
    const planId = sub.planId || 'free';
    if (planId !== 'free' && sub.expiresAt) {
        const exp = new Date(sub.expiresAt);
        if (exp < n) {
            const graceEnd = sub.graceEndsAt ? new Date(sub.graceEndsAt) : null;
            if (!graceEnd || graceEnd < n) return 'Past Due';
        }
    }
    return 'Active';
};

const companyMrrContribution = (company) => {
    if (company.platformStatus === 'suspended' || company.deletedAt) return 0;
    const planId = company.subscription?.planId || 'free';
    if (planId === 'free') return 0;
    const st = company.subscription?.status || 'active';
    if (st === 'cancelled' || st === 'expired') return 0;
    const plan = getPlanById(planId);
    return Number(plan.price) || 0;
};

const buildRevenueSeries = (companies, days = 30) => {
    const series = [];
    const end = now();
    for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        d.setHours(23, 59, 59, 999);
        let mrr = 0;
        for (const c of companies) {
            if (c.deletedAt && new Date(c.deletedAt) <= d) continue;
            if (c.platformStatus === 'suspended') continue;
            const sub = c.subscription || {};
            const planId = sub.planId || 'free';
            if (planId === 'free') continue;
            if (new Date(c.createdAt) > d) continue;
            if (sub.status === 'cancelled' && sub.updatedAt && new Date(sub.updatedAt) < d) continue;
            if (sub.status === 'expired' && sub.updatedAt && new Date(sub.updatedAt) < d) continue;
            const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
            if (exp && exp < d) continue;
            const plan = getPlanById(planId);
            mrr += Number(plan.price) || 0;
        }
        series.push({ date: d.toISOString().slice(0, 10), value: Math.round(mrr * 100) / 100 });
    }
    return series;
};

const buildCompaniesGrowthSeries = (companies, days = 30) => {
    const series = [];
    const end = now();
    for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        d.setHours(23, 59, 59, 999);
        const count = companies.filter((c) => !c.deletedAt && new Date(c.createdAt) <= d).length;
        series.push({ date: d.toISOString().slice(0, 10), value: count });
    }
    return series;
};

async function applyCompanyPlanChange(companyId, planId) {
    if (isPostgresPrimary()) {
        return platformAdminSql.applyCompanyPlanChangeSql(companyId, planId);
    }
    const next = String(planId || '').toLowerCase();
    if (!PLAN_IDS.includes(next)) {
        const err = new Error('Invalid planId');
        err.status = 400;
        throw err;
    }
    const c = await Company.findById(companyId);
    if (!c) {
        const err = new Error('Company not found');
        err.status = 404;
        throw err;
    }
    if (!c.subscription) c.subscription = {};
    c.subscription.planId = next;
    if (next === 'free') {
        c.subscription.status = 'active';
        c.subscription.expiresAt = null;
        c.subscription.graceEndsAt = null;
        c.subscription.isTrial = false;
        c.subscription.trialEndsAt = null;
        c.subscription.paymobOrderId = null;
        c.subscription.paymobTransactionId = null;
        c.subscription.paymobSubscriptionId = null;
    } else {
        c.subscription.status = 'active';
        c.subscription.expiresAt = addMonths(now(), 1);
        c.subscription.graceEndsAt = null;
        c.subscription.isTrial = false;
        c.subscription.trialEndsAt = null;
    }
    c.subscription.updatedAt = now();
    await c.save();
    invalidateCompanySubscriptionEvalCache(c._id);
    await evaluateAndSyncCompanySubscription(c);
    return c;
}

router.use(authenticateToken);
router.use(requirePlatformAdmin);

/** Short list for admin UI filters (name + id). */
router.get('/companies-for-select', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const items = await platformAdminSql.companiesForSelect();
            return res.json({ items });
        }
        const rows = await Company.find({ deletedAt: null })
            .select('name')
            .sort({ name: 1 })
            .limit(500)
            .lean();
        res.json({ items: rows.map((c) => ({ id: String(c._id), name: c.name })) });
    } catch (e) {
        console.error('platform-admin companies-for-select', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/overview', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const payload = await platformAdminSql.overviewPayload(PAID_PLAN_IDS);
            return res.json(payload);
        }
        const companies = await Company.find({}).lean();
        const n = now();
        const sevenAgo = new Date(n);
        sevenAgo.setDate(sevenAgo.getDate() - 7);

        const totalCompanies = companies.filter((c) => !c.deletedAt).length;
        const totalUsers = await User.countDocuments({
            registrationEmailPending: { $ne: true }
        });

        let mrr = 0;
        for (const c of companies) {
            mrr += companyMrrContribution(c);
        }

        const newSignups = await User.countDocuments({
            createdAt: { $gte: sevenAgo },
            registrationEmailPending: { $ne: true }
        });

        const newSubscriptions = companies.filter((c) => {
            const pid = c.subscription?.planId || 'free';
            if (pid === 'free') return false;
            const ref = c.subscription?.updatedAt || c.createdAt;
            return ref && new Date(ref) >= sevenAgo;
        }).length;

        const fourteen = new Date(n);
        fourteen.setDate(fourteen.getDate() + 14);
        const expiringSoon = companies
            .filter((c) => {
                if (c.deletedAt || c.platformStatus === 'suspended') return false;
                const pid = c.subscription?.planId || 'free';
                if (pid === 'free') return false;
                const exp = c.subscription?.expiresAt ? new Date(c.subscription.expiresAt) : null;
                return exp && exp >= n && exp <= fourteen;
            })
            .map((c) => ({
                id: String(c._id),
                name: c.name,
                planId: c.subscription?.planId || 'free',
                expiresAt: c.subscription?.expiresAt || null
            }))
            .slice(0, 50);

        const failedRenewals = companies
            .filter((c) => c.subscription?.lastBillingFailureAt)
            .map((c) => ({
                id: String(c._id),
                name: c.name,
                at: c.subscription.lastBillingFailureAt,
                reason: c.subscription.lastBillingFailureReason || 'Unknown'
            }))
            .sort((a, b) => new Date(b.at) - new Date(a.at))
            .slice(0, 50);

        res.json({
            kpis: {
                totalCompanies,
                totalUsers,
                mrr: Math.round(mrr * 100) / 100,
                newSignupsLast7Days: newSignups,
                newSubscriptionsLast7Days: newSubscriptions
            },
            charts: {
                revenueGrowth: buildRevenueSeries(companies, 30),
                companiesGrowth: buildCompaniesGrowthSeries(companies, 30)
            },
            alerts: {
                expiringSoon,
                failedRenewals
            }
        });
    } catch (e) {
        console.error('platform-admin overview', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

const buildCompanyStatusMatch = (status) => {
    const n = now();
    if (!status || status === 'all') return null;
    if (status === 'Suspended') return { platformStatus: 'suspended' };
    if (status === 'Expired') {
        return {
            platformStatus: { $ne: 'suspended' },
            $or: [
                { 'subscription.status': 'expired' },
                {
                    'subscription.planId': { $in: PAID_PLAN_IDS },
                    'subscription.expiresAt': { $lt: n },
                    $or: [
                        { 'subscription.graceEndsAt': null },
                        { 'subscription.graceEndsAt': { $lt: n } }
                    ]
                }
            ]
        };
    }
    if (status === 'Active') {
        return {
            $or: [
                { platformStatus: { $exists: false } },
                { platformStatus: null },
                { platformStatus: 'active' }
            ],
            'subscription.status': { $nin: ['expired', 'cancelled'] },
            $and: [
                {
                    $or: [
                        { 'subscription.planId': 'free' },
                        { 'subscription.expiresAt': null },
                        { 'subscription.expiresAt': { $gte: n } },
                        { 'subscription.graceEndsAt': { $gte: n } }
                    ]
                }
            ]
        };
    }
    return null;
};

router.get('/companies', async (req, res) => {
    try {
        const page = parseIntParam(req.query.page, 1, 1, 10_000);
        const limit = parseIntParam(req.query.limit, 20, 1, 100);
        const search = String(req.query.search || '').trim();
        const plan = String(req.query.plan || '').trim().toLowerCase();
        const status = String(req.query.status || '').trim();
        const activity = String(req.query.activity || '').trim().toLowerCase();
        const sortField = String(req.query.sort || 'name').toLowerCase();
        const sortDir = String(req.query.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
        const includeDeleted = String(req.query.includeDeleted || '') === '1';

        const match = {};
        if (!includeDeleted) match.deletedAt = null;
        if (search) match.name = { $regex: escapeRegex(search), $options: 'i' };
        if (PLAN_IDS.includes(plan)) match['subscription.planId'] = plan;

        const stMatch = buildCompanyStatusMatch(status);
        if (stMatch) Object.assign(match, stMatch);

        const fourteenAgo = new Date(now());
        fourteenAgo.setDate(fourteenAgo.getDate() - 14);
        const thirtyAgo = new Date(now());
        thirtyAgo.setDate(thirtyAgo.getDate() - 30);
        if (activity === 'recent') match.updatedAt = { $gte: fourteenAgo };
        if (activity === 'stale') match.updatedAt = { $lt: thirtyAgo };

        const sort = {};
        if (sortField === 'users') sort['memberCount'] = sortDir;
        else if (sortField === 'projects') sort['projectCount'] = sortDir;
        else if (sortField === 'lastactivity') sort['lastActivity'] = sortDir;
        else if (sortField === 'subscriptionend') sort['subscription.expiresAt'] = sortDir;
        else sort.name = sortDir;

        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'projects',
                    localField: '_id',
                    foreignField: 'company',
                    as: 'projDocs'
                }
            },
            {
                $addFields: {
                    memberCount: { $size: { $ifNull: ['$members', []] } },
                    projectCount: { $size: '$projDocs' }
                }
            },
            {
                $lookup: {
                    from: 'users',
                    let: { mids: '$members.user' },
                    pipeline: [
                        { $match: { $expr: { $in: ['$_id', '$$mids'] } } },
                        { $group: { _id: null, maxL: { $max: '$lastLoginAt' } } }
                    ],
                    as: '_loginAgg'
                }
            },
            {
                $addFields: {
                    lastActivity: {
                        $max: [
                            '$updatedAt',
                            { $ifNull: [{ $arrayElemAt: ['$_loginAgg.maxL', 0] }, '$createdAt'] }
                        ]
                    }
                }
            },
            { $project: { projDocs: 0, _loginAgg: 0 } },
            { $sort: Object.keys(sort).length ? sort : { name: 1 } },
            {
                $facet: {
                    rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
                    total: [{ $count: 'n' }]
                }
            }
        ];

        if (isPostgresPrimary()) {
            const out = await platformAdminSql.getAdminCompaniesList({
                page,
                limit,
                search,
                plan,
                status,
                activity,
                sortField,
                sortDir,
                includeDeleted,
                PAID_PLAN_IDS
            });
            return res.json(out);
        }

        const agg = await Company.aggregate(pipeline);
        const facet = agg[0] || { rows: [], total: [] };
        const total = facet.total?.[0]?.n ?? 0;
        const rows = facet.rows || [];

        const mapped = rows.map((c) => ({
            id: String(c._id),
            name: c.name,
            email: c.email,
            planId: c.subscription?.planId || 'free',
            uiStatus: resolveCompanyUiStatus(c),
            usersCount: c.memberCount ?? (c.members?.length || 0),
            projectsCount: c.projectCount ?? 0,
            lastActivity: c.lastActivity || c.updatedAt,
            subscriptionEndDate: c.subscription?.expiresAt || null,
            platformStatus: c.platformStatus || 'active',
            deletedAt: c.deletedAt || null
        }));

        res.json({
            items: mapped,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1
        });
    } catch (e) {
        console.error('platform-admin companies', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/companies/:id/suspend', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const m = getSequelizeModels();
            const [n] = await m.Company.update(
                { platformStatus: 'suspended' },
                { where: { id: String(req.params.id) } }
            );
            if (!n) return res.status(404).json({ message: 'Company not found' });
            return res.json({ ok: true, id: String(req.params.id), platformStatus: 'suspended' });
        }
        const c = await Company.findById(req.params.id);
        if (!c) return res.status(404).json({ message: 'Company not found' });
        c.platformStatus = 'suspended';
        await c.save();
        res.json({ ok: true, id: String(c._id), platformStatus: c.platformStatus });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/companies/:id/activate', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const m = getSequelizeModels();
            const [n] = await m.Company.update(
                { platformStatus: 'active' },
                { where: { id: String(req.params.id) } }
            );
            if (!n) return res.status(404).json({ message: 'Company not found' });
            return res.json({ ok: true, id: String(req.params.id), platformStatus: 'active' });
        }
        const c = await Company.findById(req.params.id);
        if (!c) return res.status(404).json({ message: 'Company not found' });
        c.platformStatus = 'active';
        await c.save();
        res.json({ ok: true, id: String(c._id), platformStatus: c.platformStatus });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/companies/:id/plan', async (req, res) => {
    try {
        const c = await applyCompanyPlanChange(req.params.id, req.body?.planId);
        res.json({
            ok: true,
            id: String(c._id),
            subscription: {
                planId: c.subscription.planId,
                status: c.subscription.status,
                expiresAt: c.subscription.expiresAt
            }
        });
    } catch (e) {
        if (e.status === 400 || e.status === 404) {
            return res.status(e.status).json({ message: e.message });
        }
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/companies/:id/soft-delete', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const m = getSequelizeModels();
            const ts = now();
            const [n] = await m.Company.update(
                { deletedAt: ts },
                { where: { id: String(req.params.id) } }
            );
            if (!n) return res.status(404).json({ message: 'Company not found' });
            return res.json({ ok: true, id: String(req.params.id), deletedAt: ts });
        }
        const c = await Company.findById(req.params.id);
        if (!c) return res.status(404).json({ message: 'Company not found' });
        c.deletedAt = now();
        await c.save();
        res.json({ ok: true, id: String(c._id), deletedAt: c.deletedAt });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/users', async (req, res) => {
    try {
        const page = parseIntParam(req.query.page, 1, 1, 10_000);
        const limit = parseIntParam(req.query.limit, 20, 1, 100);
        const search = String(req.query.search || '').trim();
        const companyId = String(req.query.companyId || '').trim();
        const role = String(req.query.role || '').trim().toLowerCase();
        const accountStatus = String(req.query.accountStatus || '').trim().toLowerCase();
        const sortField = String(req.query.sort || 'name').toLowerCase();
        const sortDir = String(req.query.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;

        const match = {};
        if (search) {
            match.$or = [
                { name: { $regex: escapeRegex(search), $options: 'i' } },
                { email: { $regex: escapeRegex(search), $options: 'i' } }
            ];
        }
        if (companyId && mongoose.Types.ObjectId.isValid(companyId)) {
            const oid = new mongoose.Types.ObjectId(companyId);
            if (['owner', 'admin', 'manager', 'developer', 'tester', 'user'].includes(role)) {
                match.companies = { $elemMatch: { company: oid, companyRole: role } };
            } else {
                match['companies.company'] = oid;
            }
        } else if (['owner', 'admin', 'manager', 'developer', 'tester', 'user'].includes(role)) {
            match['companies.companyRole'] = role;
        }
        if (accountStatus === 'banned') match.accountStatus = 'banned';
        if (accountStatus === 'active') match.accountStatus = { $in: [null, 'active'] };

        if (isPostgresPrimary()) {
            const out = await platformAdminSql.listUsersAdmin({
                page,
                limit,
                search,
                companyId,
                role,
                accountStatus,
                sortField,
                sortDir
            });
            return res.json(out);
        }

        const sort = {};
        if (sortField === 'email') sort.email = sortDir;
        else if (sortField === 'lastlogin') sort.lastLoginAt = sortDir;
        else sort.name = sortDir;

        const [items, total] = await Promise.all([
            User.find(match)
                .select('name email title role accountStatus lastLoginAt companies createdAt')
                .populate('companies.company', 'name')
                .sort(sort)
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            User.countDocuments(match)
        ]);

        const mapped = items.map((u) => ({
            id: String(u._id),
            name: u.name,
            email: u.email,
            accountStatus: u.accountStatus || 'active',
            lastLoginAt: u.lastLoginAt,
            companies: (u.companies || []).map((m) => ({
                id: m.company?._id ? String(m.company._id) : String(m.company),
                name: m.company?.name || '—',
                role: m.isOwner ? 'owner' : m.companyRole
            })),
            rolesSummary: [...new Set((u.companies || []).map((m) => (m.isOwner ? 'owner' : m.companyRole)))]
        }));

        res.json({ items: mapped, page, limit, total, totalPages: Math.ceil(total / limit) || 1 });
    } catch (e) {
        console.error('platform-admin users', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/users/:id', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: 'Invalid user id' });
        }
        if (isPostgresPrimary()) {
            const detail = await platformAdminSql.getUserDetailAdmin(req.params.id);
            if (!detail) return res.status(404).json({ message: 'User not found' });
            return res.json(detail);
        }
        const u = await User.findById(req.params.id)
            .select('-password -fcmTokens')
            .populate('companies.company', 'name email subscription')
            .lean();
        if (!u) return res.status(404).json({ message: 'User not found' });

        const [ticketsCount, repliesCount] = await Promise.all([
            Ticket.countDocuments({ requested_from_email: u.email }),
            Ticket.countDocuments({ 'replies.userEmail': u.email })
        ]);

        res.json({
            id: String(u._id),
            name: u.name,
            email: u.email,
            title: u.title,
            role: u.role,
            accountStatus: u.accountStatus || 'active',
            lastLoginAt: u.lastLoginAt,
            createdAt: u.createdAt,
            companies: (u.companies || []).map((m) => ({
                id: m.company?._id ? String(m.company._id) : String(m.company),
                name: m.company?.name || '—',
                role: m.isOwner ? 'owner' : m.companyRole,
                planId: m.company?.subscription?.planId || 'free'
            })),
            activity: {
                ticketsSubmitted: ticketsCount,
                ticketReplies: repliesCount
            }
        });
    } catch (e) {
        console.error('platform-admin user detail', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/users/:id/ban', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const m = getSequelizeModels();
            const u = await m.User.findByPk(String(req.params.id));
            if (!u) return res.status(404).json({ message: 'User not found' });
            if (String(u.id) === String(req.user._id)) {
                return res.status(400).json({ message: 'Cannot ban yourself' });
            }
            await u.update({ accountStatus: 'banned' });
            return res.json({ ok: true, id: String(u.id), accountStatus: 'banned' });
        }
        const u = await User.findById(req.params.id);
        if (!u) return res.status(404).json({ message: 'User not found' });
        if (String(u._id) === String(req.user._id)) {
            return res.status(400).json({ message: 'Cannot ban yourself' });
        }
        u.accountStatus = 'banned';
        await u.save();
        res.json({ ok: true, id: String(u._id), accountStatus: u.accountStatus });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/users/:id/unban', async (req, res) => {
    try {
        if (isPostgresPrimary()) {
            const m = getSequelizeModels();
            const u = await m.User.findByPk(String(req.params.id));
            if (!u) return res.status(404).json({ message: 'User not found' });
            await u.update({ accountStatus: 'active' });
            return res.json({ ok: true, id: String(u.id), accountStatus: 'active' });
        }
        const u = await User.findById(req.params.id);
        if (!u) return res.status(404).json({ message: 'User not found' });
        u.accountStatus = 'active';
        await u.save();
        res.json({ ok: true, id: String(u._id), accountStatus: u.accountStatus });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.get('/subscriptions', async (req, res) => {
    try {
        const page = parseIntParam(req.query.page, 1, 1, 10_000);
        const limit = parseIntParam(req.query.limit, 20, 1, 100);
        const search = String(req.query.search || '').trim();
        const sortField = String(req.query.sort || 'nextbilling').toLowerCase();
        const sortDir = String(req.query.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;

        if (isPostgresPrimary()) {
            const out = await platformAdminSql.listSubscriptionsAdmin({
                page,
                limit,
                search,
                sortField,
                sortDir,
                PAID_PLAN_IDS
            });
            return res.json(out);
        }

        const match = { deletedAt: null, 'subscription.planId': { $in: PAID_PLAN_IDS } };
        if (search) match.name = { $regex: escapeRegex(search), $options: 'i' };

        const sort = {};
        if (sortField === 'company') sort.name = sortDir;
        else if (sortField === 'plan') sort['subscription.planId'] = sortDir;
        else if (sortField === 'price') sort['_price'] = sortDir;
        else sort['subscription.expiresAt'] = sortDir;

        const companies = await Company.find(match).lean();
        const withPrice = companies.map((c) => {
            const plan = getPlanById(c.subscription?.planId);
            return { ...c, _price: Number(plan.price) || 0 };
        });
        withPrice.sort((a, b) => {
            if (sortField === 'company') {
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * sortDir;
            }
            if (sortField === 'plan') {
                const pa = a.subscription?.planId || '';
                const pb = b.subscription?.planId || '';
                if (pa < pb) return -1 * sortDir;
                if (pa > pb) return 1 * sortDir;
                return 0;
            }
            if (sortField === 'price') {
                if (a._price < b._price) return -1 * sortDir;
                if (a._price > b._price) return 1 * sortDir;
                return 0;
            }
            const ta = new Date(a.subscription?.expiresAt || 0).getTime();
            const tb = new Date(b.subscription?.expiresAt || 0).getTime();
            if (ta < tb) return -1 * sortDir;
            if (ta > tb) return 1 * sortDir;
            return 0;
        });

        const n = now();
        let mrr = 0;
        let activeCount = 0;
        let cancelledLast30 = 0;
        const thirtyAgo = new Date(n);
        thirtyAgo.setDate(thirtyAgo.getDate() - 30);

        for (const c of companies) {
            const st = resolveSubscriptionUiStatus(c);
            if (st === 'Active') {
                const plan = getPlanById(c.subscription?.planId);
                mrr += Number(plan.price) || 0;
                activeCount += 1;
            }
            if (c.subscription?.status === 'cancelled' && c.subscription?.updatedAt && new Date(c.subscription.updatedAt) >= thirtyAgo) {
                cancelledLast30 += 1;
            }
        }

        const arr = Math.round(mrr * 12 * 100) / 100;
        const churnRate = activeCount + cancelledLast30 > 0
            ? Math.round((cancelledLast30 / (activeCount + cancelledLast30)) * 10000) / 100
            : 0;

        const total = withPrice.length;
        const slice = withPrice.slice((page - 1) * limit, (page - 1) * limit + limit);
        const items = slice.map((c) => {
            const plan = getPlanById(c.subscription?.planId);
            return {
                companyId: String(c._id),
                companyName: c.name,
                planId: c.subscription?.planId,
                price: plan.price,
                currency: plan.currency,
                status: resolveSubscriptionUiStatus(c),
                nextBillingDate: c.subscription?.expiresAt || null
            };
        });

        res.json({
            metrics: {
                mrr: Math.round(mrr * 100) / 100,
                arr,
                churnRate,
                activeSubscriptions: activeCount
            },
            items,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit) || 1
        });
    } catch (e) {
        console.error('platform-admin subscriptions', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/subscriptions/:companyId/plan', async (req, res) => {
    try {
        const c = await applyCompanyPlanChange(req.params.companyId, req.body?.planId);
        res.json({
            ok: true,
            id: String(c._id),
            subscription: {
                planId: c.subscription.planId,
                status: c.subscription.status,
                expiresAt: c.subscription.expiresAt
            }
        });
    } catch (e) {
        if (e.status === 400 || e.status === 404) {
            return res.status(e.status).json({ message: e.message });
        }
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/subscriptions/:companyId/cancel', async (req, res) => {
    try {
        const c = await applyCompanyPlanChange(req.params.companyId, 'free');
        res.json({ ok: true, id: String(c._id), message: 'Subscription cancelled (plan set to Free).' });
    } catch (e) {
        if (e.status === 404) return res.status(404).json({ message: e.message });
        console.error(e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/** Merged catalog (code defaults + optional DB overrides) for super-admin UI. */
router.get('/plan-catalog', async (req, res) => {
    try {
        await refreshPlanCatalogCache();
        const plans = getPlansSourceList();
        if (isPostgresPrimary()) {
            const overrides = await platformAdminSql.planCatalogOverridesList();
            return res.json({ plans, basePlans: SUBSCRIPTION_PLANS, overrides });
        }
        const overrides = await PlanCatalogOverride.find({}).lean();
        res.json({ plans, basePlans: SUBSCRIPTION_PLANS, overrides });
    } catch (e) {
        console.error('plan-catalog get', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.put('/plan-catalog/:planId', async (req, res) => {
    try {
        const planId = String(req.params.planId || '').toLowerCase();
        if (!PLAN_IDS.includes(planId)) {
            return res.status(400).json({ message: 'Invalid planId' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const allowedTop = new Set([
            'name',
            'description',
            'price',
            'currency',
            'billingPeriod',
            'features',
            'isActive',
            'isPopular',
            'trialDays',
            'paymobIntegrationId',
            'paymobSubscriptionPlanId',
            'limits'
        ]);
        const set = { planId };
        Object.keys(body).forEach((k) => {
            if (allowedTop.has(k) && body[k] !== undefined) {
                set[k] = body[k];
            }
        });
        if (Object.prototype.hasOwnProperty.call(set, 'price')) {
            const p = parseCatalogUnitPrice(set.price);
            if (!Number.isFinite(p) || p < 0) {
                delete set.price;
            } else {
                set.price = p;
            }
        }
        if (isPostgresPrimary()) {
            await platformAdminSql.planCatalogUpsert(planId, set);
            await refreshPlanCatalogCache();
            const plan = getPlanById(planId);
            const override = await platformAdminSql.planCatalogOverridesList().then((rows) =>
                rows.find((r) => r.planId === planId)
            );
            return res.json({ ok: true, plan, override });
        }
        await PlanCatalogOverride.findOneAndUpdate(
            { planId },
            { $set: set },
            { upsert: true, new: true }
        );
        await refreshPlanCatalogCache();
        const plan = getPlanById(planId);
        const override = await PlanCatalogOverride.findOne({ planId }).lean();
        res.json({ ok: true, plan, override });
    } catch (e) {
        console.error('plan-catalog put', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

/** Remove override row so the plan reverts to code defaults. */
router.delete('/plan-catalog/:planId', async (req, res) => {
    try {
        const planId = String(req.params.planId || '').toLowerCase();
        if (!PLAN_IDS.includes(planId)) {
            return res.status(400).json({ message: 'Invalid planId' });
        }
        if (isPostgresPrimary()) {
            await platformAdminSql.planCatalogDelete(planId);
            await refreshPlanCatalogCache();
            return res.json({ ok: true, plan: getPlanById(planId) });
        }
        await PlanCatalogOverride.deleteOne({ planId });
        await refreshPlanCatalogCache();
        res.json({ ok: true, plan: getPlanById(planId) });
    } catch (e) {
        console.error('plan-catalog delete', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;