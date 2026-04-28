const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createSubscriptionPlan,
    cancelSubscriptionPlan
} = require('../services/paymobSubscriptionPlanService');

test('createSubscriptionPlan returns success object with is_active true', async () => {
    const mockClient = {
        post: async (url, body) => {
            assert.equal(
                url,
                'https://accept.paymob.com/api/acceptance/subscription_plans'
            );
            assert.equal(body.auth_token, 'tok_123');
            return {
                data: {
                    id: 127,
                    frequency: 7,
                    name: 'Testplan 3',
                    plan_type: 'rent',
                    amount_cents: 50000,
                    use_transaction_amount: true,
                    is_active: true,
                    integration: 50428,
                    webhook_url: 'https://example.com/webhook'
                }
            };
        }
    };

    const result = await createSubscriptionPlan(
        {
            auth_token: 'tok_123',
            name: 'Testplan 3',
            amount_cents: 50000,
            frequency: 7,
            plan_type: 'rent',
            use_transaction_amount: true,
            integration: 50428,
            webhook_url: 'https://example.com/webhook'
        },
        { client: mockClient }
    );

    assert.equal(result.is_active, true);
    assert.equal(result.id, 127);
});

test('cancelSubscriptionPlan returns success object with is_active false', async () => {
    const mockClient = {
        post: async (url, body) => {
            assert.equal(
                url,
                'https://accept.paymob.com/api/acceptance/subscription_plans/127/cancel'
            );
            assert.equal(body.auth_token, 'tok_123');
            return {
                data: {
                    id: 127,
                    frequency: 7,
                    name: 'Testplan 3',
                    plan_type: 'rent',
                    amount_cents: 50000,
                    use_transaction_amount: true,
                    is_active: false,
                    integration: 50428,
                    webhook_url: 'https://example.com/webhook'
                }
            };
        }
    };

    const result = await cancelSubscriptionPlan(
        127,
        { auth_token: 'tok_123' },
        { client: mockClient }
    );

    assert.equal(result.is_active, false);
    assert.equal(result.id, 127);
});

test('missing auth_token throws descriptive error', async () => {
    await assert.rejects(
        () =>
            createSubscriptionPlan({
                name: 'No token plan',
                amount_cents: 1000,
                frequency: 7,
                plan_type: 'rent',
                use_transaction_amount: true,
                integration: 50428,
                webhook_url: 'https://example.com/webhook'
            }),
        /missing required field\(s\): auth_token/
    );
});
