/**
 * Canonical subscription tier ids (ascending). Shared by billing routes and subscriptionService.
 */
const PLAN_IDS = ['free', 'basic', 'pro', 'enterprise'];

const PLAN_RANK = { free: 0, basic: 1, pro: 2, enterprise: 3 };

/**
 * Canonical slug: trim, lowercase; unknown values → free so UI and Paymob checkout agree on tier order.
 */
const normalizeSubscriptionPlanId = (planId) => {
    const raw = String(planId ?? 'free').trim().toLowerCase();
    if (!raw) return 'free';
    return PLAN_IDS.includes(raw) ? raw : 'free';
};

const getSubscriptionPlanRank = (planId) => {
    const id = normalizeSubscriptionPlanId(planId);
    return PLAN_RANK[id] ?? 0;
};

module.exports = {
    PLAN_IDS,
    PLAN_RANK,
    normalizeSubscriptionPlanId,
    getSubscriptionPlanRank
};
