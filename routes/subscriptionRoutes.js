const express = require('express');
const axios = require('axios');
const { authenticateToken } = require('../middleware/auth');
const { Company } = require('../models');
const {
    serializePlans,
    getLocalizedPlans,
    getPlanById,
    getCompanyPlan,
    addDays,
    addMonths,
    GRACE_PERIOD_DAYS,
    evaluateAndSyncCompanySubscription
} = require('../services/subscriptionService');
const { t, localizePlan } = require('../utils/i18n');

const router = express.Router();

const canManageSubscription = (membership) =>
    Boolean(membership && (membership.isOwner || ['admin', 'manager'].includes(membership.companyRole)));

const amountToCents = (amount) => Math.round(Number(amount || 0) * 100);
const PAYMENT_METHOD_LIST = ['card'];
const PAYMOB_BASE_URL = process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com';
let paymobAuthTokenCache = { token: null, expiresAt: 0 };

const getIntegrationIdForMethod = (paymentMethod, fallbackId) => {
    const method = String(paymentMethod || '').trim().toLowerCase();
    if (method === 'card') {
        return Number(process.env.PAYMOB_CARD_INTEGRATION_ID || process.env.PAYMOB_INTEGRATION_ID || fallbackId);
    }
    if (method === 'wallet') {
        return Number(process.env.PAYMOB_WALLET_INTEGRATION_ID || process.env.PAYMOB_INTEGRATION_ID || fallbackId);
    }
    if (method === 'kiosk') {
        return Number(process.env.PAYMOB_KIOSK_INTEGRATION_ID || process.env.PAYMOB_INTEGRATION_ID || fallbackId);
    }
    return Number(process.env.PAYMOB_INTEGRATION_ID || fallbackId);
};

const buildBillingData = (company, user) => ({
    apartment: 'NA',
    email: user?.email || company?.email || 'billing@ticketing.local',
    floor: 'NA',
    first_name: user?.name || company?.name || 'Company',
    street: 'NA',
    building: 'NA',
    phone_number: 'NA',
    shipping_method: 'NA',
    postal_code: 'NA',
    city: 'Cairo',
    country: 'EG',
    last_name: 'Team',
    state: 'Cairo'
});

const extractPaymobSubscriptionId = (payload) => {
    const candidates = [
        payload?.subscription?.id,
        payload?.subscription_id,
        payload?.subscriptionv2_id,
        payload?.obj?.subscription?.id,
        payload?.obj?.subscription_id,
        payload?.obj?.subscriptionv2_id,
        payload?.order?.subscription_id,
        payload?.extras?.subscription_id,
        payload?.payment_key_claims?.extra?.subscription_id
    ];
    const found = candidates.find((value) => value !== null && value !== undefined && String(value).trim() !== '');
    return found != null ? String(found) : null;
};

const getPaymobAuthToken = async () => {
    const now = Date.now();
    if (paymobAuthTokenCache.token && paymobAuthTokenCache.expiresAt > now + 10_000) {
        return paymobAuthTokenCache.token;
    }

    const apiKey = process.env.PAYMOB_API_KEY;
    if (!apiKey) return null;

    const tokenRes = await axios.post(
        `${PAYMOB_BASE_URL}/api/auth/tokens`,
        { api_key: apiKey },
        { headers: { 'Content-Type': 'application/json' } }
    );
    const token = tokenRes?.data?.token || null;
    if (!token) return null;

    // Paymob auth token validity ~1 hour.
    paymobAuthTokenCache = {
        token,
        expiresAt: Date.now() + 55 * 60 * 1000
    };
    return token;
};

router.get('/plans', authenticateToken, async (_req, res) => {
    const lang =
        _req.lang ||
        _req.query?.lang ||
        _req.headers['x-lang'] ||
        _req.headers['accept-language'] ||
        'en';
    const plans = await getLocalizedPlans(lang);
    res.json({ plans });
});

router.get('/me', authenticateToken, async (req, res) => {
    if (!req.companyId) {
        return res.status(400).json({ message: t(req.lang, 'common.active_company_required') });
    }

    const company = await Company.findById(req.companyId).select('subscription');
    if (!company) {
        return res.status(404).json({ message: t(req.lang, 'common.company_not_found') });
    }

    const state = await evaluateAndSyncCompanySubscription(company);
    const plan = getCompanyPlan(company);
    res.json({
        planId: plan.id,
        status: company.subscription?.status || 'active',
        expiresAt: company.subscription?.expiresAt || null,
        graceEndsAt: company.subscription?.graceEndsAt || null,
        paymobSubscriptionId: company.subscription?.paymobSubscriptionId || null,
        isTrial: Boolean(company.subscription?.isTrial),
        trialEndsAt: company.subscription?.trialEndsAt || null,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        notice: state.noticeKey ? t(req.lang, state.noticeKey, state.noticeParams || {}) : null
    });
});

router.post('/paymob/checkout', authenticateToken, async (req, res) => {
    try {
        if (!req.companyId) {
            return res.status(400).json({ message: t(req.lang, 'common.active_company_required') });
        }
        if (!canManageSubscription(req.companyMembership)) {
            return res.status(403).json({ message: t(req.lang, 'common.insufficient_permissions') });
        }

        const { planId, paymentMethod, name, email, phoneNumber, country } = req.body;
        const normalizedPaymentMethod = String(paymentMethod || 'card').toLowerCase();
        const targetPlan = getPlanById(planId);
        if (!targetPlan || targetPlan.id === 'free') {
            return res.status(400).json({ message: t(req.lang, 'subscription.select_paid_plan') });
        }
        if (!PAYMENT_METHOD_LIST.includes(normalizedPaymentMethod)) {
            return res.status(400).json({
                message: t(req.lang, 'subscription.only_card_supported'),
                allowedMethods: PAYMENT_METHOD_LIST
            });
        }

        const integrationId = getIntegrationIdForMethod(normalizedPaymentMethod, targetPlan.paymobIntegrationId);
        if (!integrationId) {
            return res.status(400).json({ message: t(req.lang, 'subscription.plan_missing_integration') });
        }
        if (!targetPlan.paymobSubscriptionPlanId) {
            return res.status(400).json({ message: t(req.lang, 'subscription.plan_missing_subscription_plan_id') });
        }

        const paymobApiUrl = process.env.PAYMOB_API_URL || 'https://accept.paymob.com/v1/intention';
        const paymobSecretKey = process.env.PAYMOB_SECRET_KEY;
        const paymobPublicKey = process.env.PAYMOB_PUBLIC_KEY;
        const paymobRedirectUrl = process.env.PAYMOB_REDIRECT_URL || 'http://localhost:3000/subscription';
        if (!paymobSecretKey || !paymobPublicKey) {
            return res.status(500).json({ message: t(req.lang, 'subscription.paymob_keys_required') });
        }

        const company = await Company.findById(req.companyId).select('name email subscription');
        if (!company) {
            return res.status(404).json({ message: t(req.lang, 'common.company_not_found') });
        }
        const now = new Date();
        const currentPlanId = company.subscription?.planId || 'free';
        const currentExpiry = company.subscription?.expiresAt
            ? new Date(company.subscription.expiresAt)
            : null;
        const hasUnexpiredSubscription =
            currentPlanId !== 'free' &&
            currentExpiry &&
            currentExpiry > now;

        if (hasUnexpiredSubscription && currentPlanId === targetPlan.id) {
            return res.status(400).json({
                message: t(req.lang, 'subscription.already_active_until', {
                    plan: localizePlan(targetPlan, req.lang).name,
                    expiresAt: new Date(company.subscription.expiresAt).toISOString()
                }),
                planId: targetPlan.id,
                expiresAt: company.subscription.expiresAt
            });
        }

        const amountCents = amountToCents(targetPlan.price);
        const merchantOrderId = String(req.companyId);
        const billingData = {
            ...buildBillingData(company, req.user),
            first_name: name || req.user?.name || company.name || 'Guest',
            email: email || req.user?.email || company.email || 'guest@test.com',
            phone_number: phoneNumber || '01000000000',
            country: country || 'EG'
        };

        const intentionRes = await axios.post(
            paymobApiUrl,
            {
                amount: amountCents,
                currency: targetPlan.currency || 'EGP',
                merchant_order_id: merchantOrderId,
                redirection_url: paymobRedirectUrl,
                payment_methods: [integrationId],
                subscription_plan_id: targetPlan.paymobSubscriptionPlanId,
                items: [
                    {
                        name: `${targetPlan.name} Subscription`,
                        amount: amountCents,
                        description: targetPlan.description || 'Subscription payment',
                        quantity: 1
                    }
                ],
                billing_data: billingData,
                customer: {
                    first_name: billingData.first_name,
                    last_name: billingData.last_name || 'User',
                    email: billingData.email,
                    country: billingData.country,
                    phone_number: billingData.phone_number
                },
                extras: {
                    project: 'TICKETING',
                    companyId: String(req.companyId),
                    merchant_order_id: merchantOrderId,
                    planId: targetPlan.id,
                    paymentMethod: normalizedPaymentMethod
                }
            },
            {
                headers: {
                    Authorization: `Token ${paymobSecretKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const clientSecret = intentionRes?.data?.client_secret;
        if (!clientSecret) {
            return res.status(502).json({
                message: t(req.lang, 'subscription.missing_client_secret'),
                details: intentionRes?.data || null
            });
        }

        company.subscription = {
            ...(company.subscription || {}),
            status: 'pending',
            pendingPlanId: targetPlan.id,
            paymobSubscriptionId: null,
            paymobOrderId: String(
                intentionRes?.data?.order?.id ||
                intentionRes?.data?.order_id ||
                intentionRes?.data?.id ||
                ''
            ),
            updatedAt: new Date()
        };
        await company.save();
        const checkoutUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${paymobPublicKey}&clientSecret=${clientSecret}`;

        res.json({
            message: t(req.lang, 'subscription.paymob_checkout_created'),
            checkoutUrl,
            paymentMethod: normalizedPaymentMethod,
            paymentDetails: intentionRes.data,
            plan: localizePlan({
                id: targetPlan.id,
                name: targetPlan.name,
                description: targetPlan.description,
                price: targetPlan.price,
                currency: targetPlan.currency,
                billingPeriod: targetPlan.billingPeriod,
                features: targetPlan.features,
                isPopular: targetPlan.isPopular,
                isActive: targetPlan.isActive,
                paymobIntegrationId: targetPlan.paymobIntegrationId,
                trialDays: targetPlan.trialDays
            }, req.lang)
        });
    } catch (error) {
        console.error('Paymob checkout error:', error?.response?.data || error.message);
        res.status(500).json({
            message: t(req.lang, 'common.internal_server_error'),
            error: error?.response?.data || error.message
        });
    }
});

router.post('/paymob/webhook', async (req, res) => {
    try {
        const obj = req.body?.obj || req.body;
        console.log('Paymob webhook payload:', JSON.stringify(obj || {}, null, 2));
        const merchantOrderId =
            obj?.order?.merchant_order_id ||
            obj?.extras?.merchant_order_id ||
            obj?.extras?.companyId ||
            obj?.payment_key_claims?.extra?.merchant_order_id ||
            obj?.payment_key_claims?.extra?.companyId;
        const payloadPlanId =
            obj?.extras?.planId ||
            obj?.payment_key_claims?.extra?.planId;
        const orderId = obj?.order?.id || obj?.order?.order_id || null;
        const success =
            obj?.success === true ||
            String(obj?.success).toLowerCase() === 'true' ||
            obj?.order?.payment_status === 'PAID' ||
            obj?.payment_status === 'PAID';
        const companyId = merchantOrderId ? String(merchantOrderId) : '';
        let company = null;
        if (companyId) {
            company = await Company.findById(companyId);
        }
        if (!company && orderId) {
            company = await Company.findOne({
                'subscription.paymobOrderId': String(orderId)
            });
        }
        if (!company) {
            return res.status(404).json({ message: t(req.lang, 'common.company_not_found') });
        }
        const planId = payloadPlanId || company.subscription?.pendingPlanId;
        if (!planId) {
            return res.status(400).json({ message: t(req.lang, 'subscription.missing_plan_webhook') });
        }

        if (success) {
            const selectedPlan = getPlanById(planId);
            const oldExpiry = company.subscription?.expiresAt
                ? new Date(company.subscription.expiresAt)
                : null;
            // Renewal starts from old expiry so users do not gain extra days by delaying payment.
            const renewalAnchor = oldExpiry || new Date();
            const expiresAt = addMonths(renewalAnchor, 1);
            const graceEndsAt = addDays(expiresAt, GRACE_PERIOD_DAYS);

            company.subscription = {
                ...(company.subscription || {}),
                planId: selectedPlan.id,
                status: 'active',
                isTrial: selectedPlan.trialDays > 0,
                trialEndsAt: selectedPlan.trialDays > 0
                    ? new Date(Date.now() + selectedPlan.trialDays * 24 * 60 * 60 * 1000)
                    : null,
                expiresAt,
                graceEndsAt,
                pendingPlanId: null,
                paymobTransactionId: String(obj?.id || ''),
                paymobSubscriptionId:
                    extractPaymobSubscriptionId(req.body) ||
                    extractPaymobSubscriptionId(obj) ||
                    company.subscription?.paymobSubscriptionId ||
                    null,
                updatedAt: new Date()
            };
        } else {
            company.subscription = {
                ...(company.subscription || {}),
                planId: 'free',
                status: 'active',
                isTrial: false,
                trialEndsAt: null,
                expiresAt: null,
                graceEndsAt: null,
                pendingPlanId: null,
                paymobSubscriptionId: null,
                updatedAt: new Date()
            };
        }

        await company.save();
        res.json({ message: t(req.lang, 'subscription.webhook_processed') });
    } catch (error) {
        console.error('Paymob webhook error:', error);
        res.status(500).json({ message: t(req.lang, 'common.internal_server_error') });
    }
});

router.post('/paymob/confirm', authenticateToken, async (req, res) => {
    try {
        if (!req.companyId) {
            return res.status(400).json({ message: t(req.lang, 'common.active_company_required') });
        }
        if (!canManageSubscription(req.companyMembership)) {
            return res.status(403).json({ message: t(req.lang, 'common.insufficient_permissions') });
        }

        const company = await Company.findById(req.companyId);
        if (!company) {
            return res.status(404).json({ message: t(req.lang, 'common.company_not_found') });
        }

        const { postPayUrl = '', success = false } = req.body || {};
        let successFlag = Boolean(success);
        let transactionId = null;
        if (postPayUrl && typeof postPayUrl === 'string') {
            try {
                const parsed = new URL(postPayUrl);
                const successParam = parsed.searchParams.get('success');
                if (successParam != null) {
                    successFlag = String(successParam).toLowerCase() === 'true';
                }
                transactionId = parsed.searchParams.get('id') || null;
            } catch (_) {
                return res.status(400).json({ message: t(req.lang, 'subscription.invalid_post_pay_url') });
            }
        }

        if (!successFlag) {
            return res.status(400).json({ message: t(req.lang, 'subscription.payment_not_successful') });
        }

        // Idempotency guard: if a previous confirm/webhook already activated plan,
        // do not return an error on duplicate confirm attempts.
        if (company.subscription?.status !== 'pending' || !company.subscription?.pendingPlanId) {
            if ((company.subscription?.planId || 'free') !== 'free' && company.subscription?.status === 'active') {
                return res.json({
                    message: t(req.lang, 'subscription.subscription_already_active'),
                    subscription: {
                        planId: company.subscription.planId,
                        status: company.subscription.status,
                        expiresAt: company.subscription.expiresAt,
                        graceEndsAt: company.subscription.graceEndsAt,
                        paymobSubscriptionId: company.subscription.paymobSubscriptionId || null
                    }
                });
            }
            return res.status(400).json({ message: t(req.lang, 'subscription.no_pending_subscription') });
        }

        const selectedPlan = getPlanById(company.subscription.pendingPlanId);
        const oldExpiry = company.subscription?.expiresAt ? new Date(company.subscription.expiresAt) : null;
        const renewalAnchor = oldExpiry || new Date();
        const expiresAt = addMonths(renewalAnchor, 1);
        const graceEndsAt = addDays(expiresAt, GRACE_PERIOD_DAYS);

        company.subscription = {
            ...(company.subscription || {}),
            planId: selectedPlan.id,
            status: 'active',
            isTrial: selectedPlan.trialDays > 0,
            trialEndsAt: selectedPlan.trialDays > 0
                ? new Date(Date.now() + selectedPlan.trialDays * 24 * 60 * 60 * 1000)
                : null,
            expiresAt,
            graceEndsAt,
            pendingPlanId: null,
            paymobTransactionId: transactionId || company.subscription?.paymobTransactionId || null,
            paymobSubscriptionId:
                extractPaymobSubscriptionId(req.body) ||
                company.subscription?.paymobSubscriptionId ||
                null,
            updatedAt: new Date()
        };
        await company.save();

        return res.json({
            message: t(req.lang, 'subscription.subscription_activated'),
            subscription: {
                planId: company.subscription.planId,
                status: company.subscription.status,
                expiresAt: company.subscription.expiresAt,
                graceEndsAt: company.subscription.graceEndsAt,
                paymobSubscriptionId: company.subscription.paymobSubscriptionId || null
            }
        });
    } catch (error) {
        console.error('Paymob confirm error:', error);
        return res.status(500).json({ message: t(req.lang, 'common.internal_server_error') });
    }
});

router.post('/paymob/cancel', authenticateToken, async (req, res) => {
    try {
        if (!req.companyId) {
            return res.status(400).json({ message: t(req.lang, 'common.active_company_required') });
        }
        if (!canManageSubscription(req.companyMembership)) {
            return res.status(403).json({ message: t(req.lang, 'common.insufficient_permissions') });
        }

        const company = await Company.findById(req.companyId);
        if (!company) {
            return res.status(404).json({ message: t(req.lang, 'common.company_not_found') });
        }

        const bodySubscriptionId = req.body?.subscriptionId;
        const paymobSubscriptionId = String(
            bodySubscriptionId || company.subscription?.paymobSubscriptionId || ''
        ).trim();

        if (!paymobSubscriptionId) {
            return res.status(400).json({ message: t(req.lang, 'subscription.missing_paymob_subscription_id') });
        }

        const authToken = await getPaymobAuthToken();
        if (!authToken) {
            return res.status(500).json({ message: t(req.lang, 'subscription.paymob_api_key_required') });
        }

        await axios.post(
            `${PAYMOB_BASE_URL}/api/acceptance/subscriptions/${paymobSubscriptionId}/cancel`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${authToken}`
                }
            }
        );

        company.subscription = {
            ...(company.subscription || {}),
            status: 'cancelled',
            pendingPlanId: null,
            paymobSubscriptionId,
            updatedAt: new Date()
        };
        await company.save();

        return res.json({
            message: t(req.lang, 'subscription.cancelled_successfully'),
            subscription: {
                planId: company.subscription.planId,
                status: company.subscription.status,
                expiresAt: company.subscription.expiresAt || null,
                graceEndsAt: company.subscription.graceEndsAt || null,
                paymobSubscriptionId: company.subscription.paymobSubscriptionId || null
            }
        });
    } catch (error) {
        console.error('Paymob cancel subscription error:', error?.response?.data || error);
        return res.status(500).json({
            message: t(req.lang, 'common.internal_server_error'),
            error: error?.response?.data || error?.message || null
        });
    }
});

module.exports = router;
