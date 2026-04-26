const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { Company } = require('../models');
const {
    serializePlans,
    getPlanById,
    getCompanyPlan,
    addDays,
    addMonths,
    GRACE_PERIOD_DAYS,
    evaluateAndSyncCompanySubscription
} = require('../services/subscriptionService');

const router = express.Router();

const canManageSubscription = (membership) =>
    Boolean(membership && (membership.isOwner || ['admin', 'manager'].includes(membership.companyRole)));

const amountToCents = (amount) => Math.round(Number(amount || 0) * 100);

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

router.get('/plans', authenticateToken, async (_req, res) => {
    res.json({ plans: serializePlans() });
});

router.get('/me', authenticateToken, async (req, res) => {
    if (!req.companyId) {
        return res.status(400).json({ message: 'Active company required' });
    }

    const company = await Company.findById(req.companyId).select('subscription');
    if (!company) {
        return res.status(404).json({ message: 'Company not found' });
    }

    const state = await evaluateAndSyncCompanySubscription(company);
    const plan = getCompanyPlan(company);
    res.json({
        planId: plan.id,
        status: company.subscription?.status || 'active',
        expiresAt: company.subscription?.expiresAt || null,
        graceEndsAt: company.subscription?.graceEndsAt || null,
        isTrial: Boolean(company.subscription?.isTrial),
        trialEndsAt: company.subscription?.trialEndsAt || null,
        gracePeriodDays: GRACE_PERIOD_DAYS,
        notice: state.notice || null
    });
});

router.post('/paymob/checkout', authenticateToken, async (req, res) => {
    try {
        if (!req.companyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        if (!canManageSubscription(req.companyMembership)) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const { planId } = req.body;
        const targetPlan = getPlanById(planId);
        if (!targetPlan || targetPlan.id === 'free') {
            return res.status(400).json({ message: 'Please select a paid plan' });
        }

        if (!targetPlan.paymobIntegrationId) {
            return res.status(400).json({ message: 'Plan is missing Paymob integration ID' });
        }

        const apiKey = process.env.PAYMOB_API_KEY;
        const iframeId = process.env.PAYMOB_IFRAME_ID;
        if (!apiKey) {
            return res.status(500).json({ message: 'PAYMOB_API_KEY is not configured' });
        }

        const company = await Company.findById(req.companyId).select('name email subscription');
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const authRes = await fetch('https://accept.paymob.com/api/auth/tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey })
        });
        const authData = await authRes.json();
        if (!authRes.ok || !authData?.token) {
            return res.status(502).json({ message: 'Failed to authenticate with Paymob', details: authData });
        }

        const amountCents = amountToCents(targetPlan.price);
        const merchantOrderId = `company:${req.companyId}:plan:${targetPlan.id}:ts:${Date.now()}`;

        const orderRes = await fetch('https://accept.paymob.com/api/ecommerce/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                auth_token: authData.token,
                delivery_needed: false,
                amount_cents: amountCents,
                currency: targetPlan.currency,
                merchant_order_id: merchantOrderId,
                items: []
            })
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok || !orderData?.id) {
            return res.status(502).json({ message: 'Failed to create Paymob order', details: orderData });
        }

        const paymentKeyRes = await fetch('https://accept.paymob.com/api/acceptance/payment_keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                auth_token: authData.token,
                amount_cents: amountCents,
                expiration: 3600,
                order_id: orderData.id,
                billing_data: buildBillingData(company, req.user),
                currency: targetPlan.currency,
                integration_id: targetPlan.paymobIntegrationId
            })
        });
        const paymentKeyData = await paymentKeyRes.json();
        if (!paymentKeyRes.ok || !paymentKeyData?.token) {
            return res.status(502).json({ message: 'Failed to generate Paymob payment key', details: paymentKeyData });
        }

        company.subscription = {
            ...(company.subscription || {}),
            paymobOrderId: String(orderData.id),
            updatedAt: new Date()
        };
        await company.save();

        const checkoutUrl = iframeId
            ? `https://accept.paymob.com/api/acceptance/iframes/${iframeId}?payment_token=${paymentKeyData.token}`
            : null;

        res.json({
            message: 'Paymob checkout created successfully',
            checkoutUrl,
            paymentToken: paymentKeyData.token,
            orderId: orderData.id,
            plan: {
                id: targetPlan.id,
                name: targetPlan.name,
                price: targetPlan.price,
                currency: targetPlan.currency
            }
        });
    } catch (error) {
        console.error('Paymob checkout error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/paymob/webhook', async (req, res) => {
    try {
        const obj = req.body?.obj;
        const merchantOrderId = obj?.order?.merchant_order_id;
        const success = Boolean(obj?.success);
        if (!merchantOrderId || !String(merchantOrderId).startsWith('company:')) {
            return res.status(400).json({ message: 'Invalid merchant_order_id' });
        }
        const parts = String(merchantOrderId).split(':');
        const companyId = parts[1];
        const planId = parts[3];
        if (!companyId || !planId) {
            return res.status(400).json({ message: 'Invalid merchant_order_id format' });
        }
        const company = await Company.findById(companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
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
                paymobTransactionId: String(obj?.id || ''),
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
                updatedAt: new Date()
            };
        }

        await company.save();
        res.json({ message: 'Webhook processed' });
    } catch (error) {
        console.error('Paymob webhook error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
