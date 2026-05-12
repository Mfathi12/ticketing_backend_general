/**
 * Company subscription shape + Sequelize save wrapper.
 * Kept separate from authSql so companySql can load without a circular dependency on authSql.
 */

const {
    DEFAULT_SUBSCRIPTION_PLAN_ID,
    normalizeSubscriptionPlanId
} = require('../../utils/subscriptionPlanIds');

const subscriptionFromRow = (row) => ({
    planId: normalizeSubscriptionPlanId(row.subscriptionPlanId),
    status: row.subscriptionStatus || 'active',
    isTrial: Boolean(row.subscriptionIsTrial),
    trialEndsAt: row.subscriptionTrialEndsAt,
    expiresAt: row.subscriptionExpiresAt,
    graceEndsAt: row.subscriptionGraceEndsAt,
    pendingPlanId: row.subscriptionPendingPlanId,
    paymobOrderId: row.paymobOrderId,
    paymobTransactionId: row.paymobTransactionId,
    paymobSubscriptionId: row.paymobSubscriptionId,
    updatedAt: row.subscriptionUpdatedAt,
    lastBillingFailureAt: row.lastBillingFailureAt,
    lastBillingFailureReason: row.lastBillingFailureReason
});

/**
 * Mutable company document compatible with evaluateAndSyncCompanySubscription (uses subscription + save()).
 */
const wrapCompanyForSubscription = (rowPlain, CompanyModel) => {
    const id = rowPlain.id;
    const doc = {
        _id: id,
        name: rowPlain.name,
        email: rowPlain.email,
        ownerUser: rowPlain.ownerUserId,
        platformStatus: rowPlain.platformStatus,
        deletedAt: rowPlain.deletedAt,
        subscription: subscriptionFromRow(rowPlain),
        members: [],
        save: async function saveCompanySubscription() {
            const sub = this.subscription || {};
            await CompanyModel.update(
                {
                    subscriptionPlanId: normalizeSubscriptionPlanId(sub.planId ?? DEFAULT_SUBSCRIPTION_PLAN_ID),
                    subscriptionStatus: sub.status ?? 'active',
                    subscriptionIsTrial: Boolean(sub.isTrial),
                    subscriptionTrialEndsAt: sub.trialEndsAt ?? null,
                    subscriptionExpiresAt: sub.expiresAt ?? null,
                    subscriptionGraceEndsAt: sub.graceEndsAt ?? null,
                    subscriptionPendingPlanId: sub.pendingPlanId ?? null,
                    paymobOrderId: sub.paymobOrderId ?? null,
                    paymobTransactionId: sub.paymobTransactionId ?? null,
                    paymobSubscriptionId: sub.paymobSubscriptionId ?? null,
                    subscriptionUpdatedAt: sub.updatedAt ?? new Date(),
                    lastBillingFailureAt: sub.lastBillingFailureAt ?? null,
                    lastBillingFailureReason: sub.lastBillingFailureReason ?? null
                },
                { where: { id } }
            );
        }
    };
    return doc;
};

module.exports = {
    subscriptionFromRow,
    wrapCompanyForSubscription
};
