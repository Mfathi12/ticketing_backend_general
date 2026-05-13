const { Op, fn, col } = require('sequelize');
const mongoose = require('mongoose');
const { getSequelizeModels } = require('../../db/postgres');
const authSql = require('./authSql');
const {
    getPlanById,
    addMonths,
    evaluateAndSyncCompanySubscription,
    invalidateCompanySubscriptionEvalCache,
    PLAN_IDS
} = require('../subscriptionService');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const subscriptionNested = (p) => ({
    planId: p.subscriptionPlanId || 'free',
    status: p.subscriptionStatus || 'active',
    isTrial: Boolean(p.subscriptionIsTrial),
    trialEndsAt: p.subscriptionTrialEndsAt,
    expiresAt: p.subscriptionExpiresAt,
    graceEndsAt: p.subscriptionGraceEndsAt,
    pendingPlanId: p.subscriptionPendingPlanId,
    paymobOrderId: p.paymobOrderId,
    paymobTransactionId: p.paymobTransactionId,
    paymobSubscriptionId: p.paymobSubscriptionId,
    updatedAt: p.subscriptionUpdatedAt,
    lastBillingFailureAt: p.lastBillingFailureAt,
    lastBillingFailureReason: p.lastBillingFailureReason
});

const companyPgToLean = (p) => ({
    _id: p.id,
    name: p.name,
    email: p.email,
    ownerUser: p.ownerUserId,
    platformStatus: p.platformStatus || 'active',
    deletedAt: p.deletedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    subscription: subscriptionNested(p)
});

const now = () => new Date();

const matchesCompanyStatus = (c, status, n, PAID_PLAN_IDS) => {
    if (!status || status === 'all') return true;
    if (status === 'Suspended') return c.platformStatus === 'suspended';
    if (status === 'Expired') {
        if (c.platformStatus === 'suspended') return false;
        const sub = c.subscription || {};
        if (sub.status === 'expired') return true;
        if (!PAID_PLAN_IDS.includes(sub.planId || 'free')) return false;
        const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
        if (!exp || exp >= n) return false;
        const grace = sub.graceEndsAt ? new Date(sub.graceEndsAt) : null;
        return !grace || grace < n;
    }
    if (status === 'Active') {
        const ps = c.platformStatus;
        if (ps && ps !== 'active') return false;
        const sub = c.subscription || {};
        if (['expired', 'cancelled'].includes(sub.status)) return false;
        const pid = sub.planId || 'free';
        const exp = sub.expiresAt ? new Date(sub.expiresAt) : null;
        const grace = sub.graceEndsAt ? new Date(sub.graceEndsAt) : null;
        if (pid !== 'free' && exp && exp < n) {
            if (grace && grace >= n) return true;
            return false;
        }
        return true;
    }
    return true;
};

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

const companiesForSelect = async () => {
    const m = requireModels();
    const rows = await m.Company.findAll({
        where: { deletedAt: null },
        attributes: ['id', 'name'],
        order: [['name', 'ASC']],
        limit: 500,
        raw: true
    });
    return rows.map((c) => ({ id: String(c.id), name: c.name }));
};

const overviewPayload = async (PAID_PLAN_IDS) => {
    const m = requireModels();
    const rows = await m.Company.findAll({ raw: true });
    const companies = rows.map(companyPgToLean);
    const n = now();
    const sevenAgo = new Date(n);
    sevenAgo.setDate(sevenAgo.getDate() - 7);

    const totalCompanies = companies.filter((c) => !c.deletedAt).length;
    const totalUsers = await m.User.count({
        where: {
            [Op.or]: [{ registrationEmailPending: false }, { registrationEmailPending: null }]
        }
    });

    let mrr = 0;
    for (const c of companies) {
        mrr += companyMrrContribution(c);
    }

    const newSignups = await m.User.count({
        where: {
            createdAt: { [Op.gte]: sevenAgo },
            [Op.or]: [{ registrationEmailPending: false }, { registrationEmailPending: null }]
        }
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

    return {
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
    };
};

const getAdminCompaniesList = async ({
    page,
    limit,
    search,
    plan,
    status,
    activity,
    sortField,
    sortDir,
    includeDeleted,
    PAID_PLAN_IDS: paidIds
}) => {
    const m = requireModels();
    const where = {};
    if (!includeDeleted) where.deletedAt = null;
    if (search) {
        where.name = { [Op.iLike]: `%${search.replace(/%/g, '\\%')}%` };
    }
    if (PLAN_IDS.includes(plan)) where.subscriptionPlanId = plan;

    const fourteenAgo = new Date();
    fourteenAgo.setDate(fourteenAgo.getDate() - 14);
    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    if (activity === 'recent') where.updatedAt = { [Op.gte]: fourteenAgo };
    if (activity === 'stale') where.updatedAt = { [Op.lt]: thirtyAgo };

    const allRows = await m.Company.findAll({ where, raw: true });
    let leans = allRows.map(companyPgToLean);
    const n = now();
    leans = leans.filter((c) => matchesCompanyStatus(c, status, n, paidIds));

    const ids = leans.map((c) => c._id);
    if (!ids.length) {
        return {
            items: [],
            page,
            limit,
            total: 0,
            totalPages: 1
        };
    }

    const ucs = await m.UserCompany.findAll({
        where: { companyId: { [Op.in]: ids } },
        attributes: ['companyId', 'userId'],
        raw: true
    });
    const memberCountBy = new Map();
    const usersByCompany = new Map();
    for (const uc of ucs) {
        memberCountBy.set(uc.companyId, (memberCountBy.get(uc.companyId) || 0) + 1);
        const arr = usersByCompany.get(uc.companyId) || [];
        arr.push(uc.userId);
        usersByCompany.set(uc.companyId, arr);
    }

    const projAgg = await m.Project.findAll({
        attributes: ['companyId', [fn('COUNT', col('id')), 'cnt']],
        where: { companyId: { [Op.in]: ids } },
        group: ['companyId'],
        raw: true
    });
    const projectCountBy = new Map(projAgg.map((r) => [r.companyId, Number(r.cnt) || 0]));

    const allUserIds = [...new Set(ucs.map((u) => u.userId))];
    const users =
        allUserIds.length > 0
            ? await m.User.findAll({
                  where: { id: { [Op.in]: allUserIds } },
                  attributes: ['id', 'lastLoginAt'],
                  raw: true
              })
            : [];
    const loginBy = new Map(users.map((u) => [u.id, u.lastLoginAt]));

    const enriched = leans.map((c) => {
        const uids = usersByCompany.get(c._id) || [];
        let maxL = null;
        for (const uid of uids) {
            const t = loginBy.get(uid);
            if (t && (!maxL || new Date(t) > new Date(maxL))) maxL = t;
        }
        const lastActivity = maxL
            ? new Date(
                  Math.max(
                      new Date(c.updatedAt || 0).getTime(),
                      new Date(maxL).getTime(),
                      new Date(c.createdAt || 0).getTime()
                  )
              )
            : new Date(Math.max(new Date(c.updatedAt || 0).getTime(), new Date(c.createdAt || 0).getTime()));

        return {
            ...c,
            memberCount: memberCountBy.get(c._id) || 0,
            projectCount: projectCountBy.get(c._id) || 0,
            lastActivity
        };
    });

    const dir = sortDir;
    enriched.sort((a, b) => {
        if (sortField === 'users') {
            return (a.memberCount - b.memberCount) * dir;
        }
        if (sortField === 'projects') {
            return (a.projectCount - b.projectCount) * dir;
        }
        if (sortField === 'lastactivity') {
            return (new Date(a.lastActivity) - new Date(b.lastActivity)) * dir;
        }
        if (sortField === 'subscriptionend') {
            const ta = new Date(a.subscription?.expiresAt || 0).getTime();
            const tb = new Date(b.subscription?.expiresAt || 0).getTime();
            return (ta - tb) * dir;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir;
    });

    const total = enriched.length;
    const slice = enriched.slice((page - 1) * limit, (page - 1) * limit + limit);
    const items = slice.map((c) => ({
        id: String(c._id),
        name: c.name,
        email: c.email,
        planId: c.subscription?.planId || 'free',
        uiStatus: resolveCompanyUiStatus(c),
        usersCount: c.memberCount ?? 0,
        projectsCount: c.projectCount ?? 0,
        lastActivity: c.lastActivity || c.updatedAt,
        subscriptionEndDate: c.subscription?.expiresAt || null,
        platformStatus: c.platformStatus || 'active',
        deletedAt: c.deletedAt || null
    }));

    return {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
    };
};

const applyCompanyPlanChangeSql = async (companyId, planId) => {
    const next = String(planId || '').toLowerCase();
    if (!PLAN_IDS.includes(next)) {
        const err = new Error('Invalid planId');
        err.status = 400;
        throw err;
    }
    const c = await authSql.loadCompanyForSubscription(companyId);
    if (!c) {
        const err = new Error('Company not found');
        err.status = 404;
        throw err;
    }
    if (!c.subscription) c.subscription = {};
    const sub = c.subscription;
    sub.planId = next;
    if (next === 'free') {
        sub.status = 'active';
        sub.expiresAt = null;
        sub.graceEndsAt = null;
        sub.isTrial = false;
        sub.trialEndsAt = null;
        sub.paymobOrderId = null;
        sub.paymobTransactionId = null;
        sub.paymobSubscriptionId = null;
    } else {
        sub.status = 'active';
        sub.expiresAt = addMonths(now(), 1);
        sub.graceEndsAt = null;
        sub.isTrial = false;
        sub.trialEndsAt = null;
    }
    sub.updatedAt = now();
    c.subscription = sub;
    await c.save();
    invalidateCompanySubscriptionEvalCache(c._id);
    await evaluateAndSyncCompanySubscription(c);
    return c;
};

const listUsersAdmin = async ({
    page,
    limit,
    search,
    companyId,
    role,
    accountStatus,
    sortField,
    sortDir
}) => {
    const m = requireModels();
    const andParts = [];
    if (search) {
        andParts.push({
            [Op.or]: [
                { name: { [Op.iLike]: `%${search.replace(/%/g, '\\%')}%` } },
                { email: { [Op.iLike]: `%${search.replace(/%/g, '\\%')}%` } }
            ]
        });
    }
    if (accountStatus === 'banned') {
        andParts.push({ accountStatus: 'banned' });
    }
    if (accountStatus === 'active') {
        andParts.push({
            [Op.or]: [{ accountStatus: 'active' }, { accountStatus: null }]
        });
    }

    let userIdsFilter = null;
    if (companyId && /^[a-f0-9]{24}$/i.test(companyId)) {
        const ucWhere = { companyId: String(companyId) };
        if (['owner', 'admin', 'manager', 'user'].includes(role)) {
            if (role === 'owner') {
                ucWhere.isOwner = true;
            } else {
                ucWhere.companyRole = role;
            }
        }
        const ucs = await m.UserCompany.findAll({
            where: ucWhere,
            attributes: ['userId'],
            raw: true
        });
        userIdsFilter = [...new Set(ucs.map((u) => u.userId))];
        if (!userIdsFilter.length) {
            return { items: [], page, limit, total: 0, totalPages: 1 };
        }
    } else if (['owner', 'admin', 'manager', 'user'].includes(role)) {
        const ucWhere = {};
        if (role === 'owner') ucWhere.isOwner = true;
        else ucWhere.companyRole = role;
        const ucs = await m.UserCompany.findAll({
            where: ucWhere,
            attributes: ['userId'],
            raw: true
        });
        userIdsFilter = [...new Set(ucs.map((u) => u.userId))];
        if (!userIdsFilter.length) {
            return { items: [], page, limit, total: 0, totalPages: 1 };
        }
    }

    if (userIdsFilter) {
        andParts.push({ id: { [Op.in]: userIdsFilter } });
    }

    const userWhere = andParts.length ? { [Op.and]: andParts } : {};

    const order = [];
    if (sortField === 'email') order.push(['email', sortDir === 1 ? 'ASC' : 'DESC']);
    else if (sortField === 'lastlogin') order.push(['lastLoginAt', sortDir === 1 ? 'ASC' : 'DESC']);
    else order.push(['name', sortDir === 1 ? 'ASC' : 'DESC']);

    const total = await m.User.count({ where: userWhere });
    const userRows = await m.User.findAll({
        where: userWhere,
        attributes: [
            'id',
            'name',
            'email',
            'title',
            'role',
            'accountStatus',
            'lastLoginAt',
            'createdAt'
        ],
        order,
        offset: (page - 1) * limit,
        limit,
        raw: true
    });

    const uids = userRows.map((u) => u.id);
    const ucsAll =
        uids.length > 0
            ? await m.UserCompany.findAll({
                  where: { userId: { [Op.in]: uids } },
                  raw: true
              })
            : [];
    const cids = [...new Set(ucsAll.map((x) => x.companyId))];
    const comps =
        cids.length > 0
            ? await m.Company.findAll({
                  where: { id: { [Op.in]: cids } },
                  attributes: ['id', 'name'],
                  raw: true
              })
            : [];
    const compById = new Map(comps.map((c) => [c.id, c]));

    const ucByUser = new Map();
    for (const plain of ucsAll) {
        const uid = plain.userId;
        const list = ucByUser.get(uid) || [];
        list.push(plain);
        ucByUser.set(uid, list);
    }

    const items = userRows.map((u) => {
        const links = ucByUser.get(u.id) || [];
        const companies = links.map((link) => {
            const comp = compById.get(link.companyId) || {};
            return {
                id: String(link.companyId),
                name: comp.name || '—',
                role: link.isOwner ? 'owner' : link.companyRole
            };
        });
        const rolesSummary = [...new Set(links.map((link) => (link.isOwner ? 'owner' : link.companyRole)))];
        return {
            id: String(u.id),
            name: u.name,
            email: u.email,
            accountStatus: u.accountStatus || 'active',
            lastLoginAt: u.lastLoginAt,
            companies,
            rolesSummary
        };
    });

    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
};

const getUserDetailAdmin = async (userId) => {
    const m = requireModels();
    const u = await m.User.findByPk(String(userId), {
        attributes: { exclude: ['password'] },
        raw: true
    });
    if (!u) return null;
    const ucs = await m.UserCompany.findAll({
        where: { userId: String(userId) },
        raw: true
    });
    const detailCids = [...new Set(ucs.map((x) => x.companyId))];
    const detailComps =
        detailCids.length > 0
            ? await m.Company.findAll({ where: { id: { [Op.in]: detailCids } }, raw: true })
            : [];
    const dCompById = new Map(detailComps.map((c) => [c.id, c]));
    const companies = ucs.map((plain) => {
        const cp = dCompById.get(plain.companyId) || {};
        return {
            id: String(plain.companyId),
            name: cp.name || '—',
            role: plain.isOwner ? 'owner' : plain.companyRole,
            planId: cp.subscriptionPlanId || 'free'
        };
    });

    const ticketsSubmitted = await m.Ticket.count({
        where: { requested_from_email: String(u.email).toLowerCase() }
    });
    const repliesCount = await m.TicketReply.count({
        where: { userEmail: String(u.email).toLowerCase() }
    });

    return {
        id: String(u.id),
        name: u.name,
        email: u.email,
        title: u.title,
        role: u.role,
        accountStatus: u.accountStatus || 'active',
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        companies,
        activity: {
            ticketsSubmitted,
            ticketReplies: repliesCount
        }
    };
};

const listSubscriptionsAdmin = async ({ page, limit, search, sortField, sortDir, PAID_PLAN_IDS }) => {
    const m = requireModels();
    const where = {
        deletedAt: null,
        subscriptionPlanId: { [Op.in]: PAID_PLAN_IDS }
    };
    if (search) where.name = { [Op.iLike]: `%${search.replace(/%/g, '\\%')}%` };
    const rows = await m.Company.findAll({ where, raw: true });
    let companies = rows.map(companyPgToLean);
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
        if (
            c.subscription?.status === 'cancelled' &&
            c.subscription?.updatedAt &&
            new Date(c.subscription.updatedAt) >= thirtyAgo
        ) {
            cancelledLast30 += 1;
        }
    }

    const arr = Math.round(mrr * 12 * 100) / 100;
    const churnRate =
        activeCount + cancelledLast30 > 0
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

    return {
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
    };
};

const planCatalogOverridesList = async () => {
    const m = requireModels();
    return m.PlanCatalogOverride.findAll({ raw: true });
};

const planCatalogUpsert = async (planId, set) => {
    const m = requireModels();
    const pid = String(planId).toLowerCase();
    const payload = { ...set };
    delete payload.planId;
    let row = await m.PlanCatalogOverride.findOne({ where: { planId: pid } });
    if (row) {
        await row.update(payload);
    } else {
        row = await m.PlanCatalogOverride.create({
            id: newObjectIdString(),
            planId: pid,
            ...payload
        });
    }
    const out = await m.PlanCatalogOverride.findOne({ where: { planId: pid }, raw: true });
    return out;
};

const planCatalogDelete = async (planId) => {
    const m = requireModels();
    await m.PlanCatalogOverride.destroy({ where: { planId: String(planId).toLowerCase() } });
};

module.exports = {
    companyPgToLean,
    companiesForSelect,
    overviewPayload,
    getAdminCompaniesList,
    applyCompanyPlanChangeSql,
    listUsersAdmin,
    getUserDetailAdmin,
    listSubscriptionsAdmin,
    planCatalogOverridesList,
    planCatalogUpsert,
    planCatalogDelete
};
