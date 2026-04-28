const axios = require('axios');

const PAYMOB_BASE_URL = process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com';
const AUTH_TOKEN_TTL_MS = 55 * 60 * 1000;

let tokenCache = {
    token: null,
    expiresAt: 0
};

const requiredCreateFields = [
    'auth_token',
    'name',
    'amount_cents',
    'frequency',
    'plan_type',
    'use_transaction_amount',
    'integration',
    'webhook_url'
];

const assertRequired = (data, fields, fnName) => {
    const missing = fields.filter((field) => {
        const value = data?.[field];
        return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
        throw new Error(`${fnName}: missing required field(s): ${missing.join(', ')}`);
    }
};

const getPaymobAuthToken = async ({
    client = axios,
    apiKey = process.env.PAYMOB_API_KEY,
    baseUrl = PAYMOB_BASE_URL,
    forceRefresh = false
} = {}) => {
    if (!forceRefresh && tokenCache.token && tokenCache.expiresAt > Date.now() + 10_000) {
        return tokenCache.token;
    }
    if (!apiKey) {
        throw new Error('getPaymobAuthToken: PAYMOB_API_KEY is required');
    }

    let response;
    try {
        response = await client.post(
            `${baseUrl}/api/auth/tokens`,
            { api_key: apiKey },
            { headers: { 'Content-Type': 'application/json' } }
        );
    } catch (error) {
        const status = error?.response?.status;
        const details = error?.response?.data?.detail || error?.response?.data?.message || error.message;
        throw new Error(`getPaymobAuthToken: failed (${status || 'network'}) - ${details}`);
    }

    const token = response?.data?.token;
    if (!token) {
        throw new Error('getPaymobAuthToken: token was not returned by Paymob');
    }

    tokenCache = {
        token,
        expiresAt: Date.now() + AUTH_TOKEN_TTL_MS
    };
    return token;
};

const postWithRetryOn401 = async ({
    url,
    payload,
    client = axios,
    apiKey = process.env.PAYMOB_API_KEY,
    baseUrl = PAYMOB_BASE_URL,
    operationName
}) => {
    try {
        const response = await client.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response?.data;
    } catch (error) {
        const status = error?.response?.status;
        if (status !== 401) {
            const details = error?.response?.data?.detail || error?.response?.data?.message || error.message;
            throw new Error(`${operationName}: failed (${status || 'network'}) - ${details}`);
        }

        // Handle expired/invalid token by fetching a fresh auth token then retrying once.
        const freshToken = await getPaymobAuthToken({
            client,
            apiKey,
            baseUrl,
            forceRefresh: true
        });
        const retryPayload = { ...payload, auth_token: freshToken };
        const retryResponse = await client.post(url, retryPayload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return retryResponse?.data;
    }
};

const createSubscriptionPlan = async (data, options = {}) => {
    assertRequired(data, requiredCreateFields, 'createSubscriptionPlan');

    const payload = {
        auth_token: data.auth_token,
        name: data.name,
        amount_cents: Number(data.amount_cents),
        frequency: Number(data.frequency),
        plan_type: data.plan_type,
        use_transaction_amount: Boolean(data.use_transaction_amount),
        integration: Number(data.integration),
        webhook_url: data.webhook_url
    };

    const url = `${options.baseUrl || PAYMOB_BASE_URL}/api/acceptance/subscription_plans`;
    return postWithRetryOn401({
        url,
        payload,
        client: options.client || axios,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl || PAYMOB_BASE_URL,
        operationName: 'createSubscriptionPlan'
    });
};

const cancelSubscriptionPlan = async (planId, data, options = {}) => {
    if (!planId) {
        throw new Error('cancelSubscriptionPlan: planId is required');
    }
    assertRequired(data, ['auth_token'], 'cancelSubscriptionPlan');

    const payload = { auth_token: data.auth_token };
    const url = `${options.baseUrl || PAYMOB_BASE_URL}/api/acceptance/subscription_plans/${planId}/cancel`;
    return postWithRetryOn401({
        url,
        payload,
        client: options.client || axios,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl || PAYMOB_BASE_URL,
        operationName: 'cancelSubscriptionPlan'
    });
};

module.exports = {
    getPaymobAuthToken,
    createSubscriptionPlan,
    cancelSubscriptionPlan
};
