const express = require('express');
const axios = require('axios');
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
const PAYMENT_METHOD_LIST = ['card'];

const getIntegrationIdForMethod = (paymentMethod, fallbackId) => {
    const method = String(paymentMethod || '').trim().toLowerCase();
    if (method === 'card') {
        return Number(process.env.PAYMOB_CARD_INTEGRATION_ID || fallbackId || process.env.PAYMOB_INTEGRATION_ID);
    }
    if (method === 'wallet') {
        return Number(process.env.PAYMOB_WALLET_INTEGRATION_ID || fallbackId || process.env.PAYMOB_INTEGRATION_ID);
    }
    if (method === 'kiosk') {
        return Number(process.env.PAYMOB_KIOSK_INTEGRATION_ID || fallbackId || process.env.PAYMOB_INTEGRATION_ID);
    }
    return Number(fallbackId || process.env.PAYMOB_INTEGRATION_ID);
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

        const { planId, paymentMethod, name, email, phoneNumber, country } = req.body;
        const normalizedPaymentMethod = String(paymentMethod || 'card').toLowerCase();
        const targetPlan = getPlanById(planId);
        if (!targetPlan || targetPlan.id === 'free') {
            return res.status(400).json({ message: 'Please select a paid plan' });
        }
        if (!PAYMENT_METHOD_LIST.includes(normalizedPaymentMethod)) {
            return res.status(400).json({
                message: 'Only card payment is supported',
                allowedMethods: PAYMENT_METHOD_LIST
            });
        }

        const integrationId = getIntegrationIdForMethod(normalizedPaymentMethod, targetPlan.paymobIntegrationId);
        if (!integrationId) {
            return res.status(400).json({ message: 'Plan is missing Paymob integration ID' });
        }

        const paymobApiUrl = process.env.PAYMOB_API_URL || 'https://accept.paymob.com/v1/intention';
        const paymobSecretKey = process.env.PAYMOB_SECRET_KEY;
        const paymobPublicKey = process.env.PAYMOB_PUBLIC_KEY;
        if (!paymobSecretKey || !paymobPublicKey) {
            return res.status(500).json({ message: 'PAYMOB_SECRET_KEY and PAYMOB_PUBLIC_KEY are required' });
        }

        const company = await Company.findById(req.companyId).select('name email subscription');
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
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
                payment_methods: [integrationId],
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
                message: 'Missing client_secret from Paymob response',
                details: intentionRes?.data || null
            });
        }

        company.subscription = {
            ...(company.subscription || {}),
            status: 'pending',
            paymobOrderId: String(intentionRes?.data?.id || ''),
            updatedAt: new Date()
        };
        await company.save();
        const checkoutUrl = `https://accept.paymob.com/unifiedcheckout/?publicKey=${paymobPublicKey}&clientSecret=${clientSecret}`;

        res.json({
            message: 'Paymob checkout created successfully',
            checkoutUrl,
            paymentMethod: normalizedPaymentMethod,
            paymentDetails: intentionRes.data,
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
        const obj = req.body?.obj || req.body;
        const merchantOrderId =
            obj?.order?.merchant_order_id ||
            obj?.extras?.merchant_order_id ||
            obj?.extras?.companyId ||
            obj?.payment_key_claims?.extra?.merchant_order_id ||
            obj?.payment_key_claims?.extra?.companyId;
        const planId =
            obj?.extras?.planId ||
            obj?.payment_key_claims?.extra?.planId;
        const success = Boolean(obj?.success);
        const companyId = String(merchantOrderId || '');
        if (!companyId || !planId) {
            return res.status(400).json({ message: 'Missing companyId or planId in webhook payload' });
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
