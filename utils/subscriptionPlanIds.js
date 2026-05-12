/**
 * Canonical subscription tier ids (ascending). Shared by billing routes and subscriptionService.
 */
const PLAN_IDS = ['free', 'basic', 'pro', 'enterprise'];

/** Default tier for new companies and unknown / invalid stored values (backend single source of truth). */
const DEFAULT_SUBSCRIPTION_PLAN_ID = 'free';

const PLAN_RANK = { free: 0, basic: 1, pro: 2, enterprise: 3 };

/**
 * Canonical slug: trim, lowercase; unknown values → {@link DEFAULT_SUBSCRIPTION_PLAN_ID}.
 */
const normalizeSubscriptionPlanId = (planId) => {
    const raw = String(planId ?? DEFAULT_SUBSCRIPTION_PLAN_ID).trim().toLowerCase();
    if (!raw) return DEFAULT_SUBSCRIPTION_PLAN_ID;
    return PLAN_IDS.includes(raw) ? raw : DEFAULT_SUBSCRIPTION_PLAN_ID;
};

const getSubscriptionPlanRank = (planId) => {
    const id = normalizeSubscriptionPlanId(planId);
    return PLAN_RANK[id] ?? 0;
};

module.exports = {
    PLAN_IDS,
    DEFAULT_SUBSCRIPTION_PLAN_ID,
    PLAN_RANK,
    normalizeSubscriptionPlanId,
    getSubscriptionPlanRank
};
