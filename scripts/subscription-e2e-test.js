const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const Company = require('../models/company');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:9091/api';

const results = [];
const now = Date.now();
const randomEmail = `subtest_${now}@example.com`;
const password = '123456';
let token = '';
let companyId = '';

const pass = (name, details = '') => results.push({ name, status: 'PASS', details });
const fail = (name, details = '') => results.push({ name, status: 'FAIL', details });

const callApi = async (config) => {
    try {
        return await axios(config);
    } catch (error) {
        if (error.response) return error.response;
        throw error;
    }
};

const authHeaders = () => ({ Authorization: `Bearer ${token}` });

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        // 1) Register company and ensure default free subscription
        const registerRes = await callApi({
            method: 'post',
            url: `${BASE_URL}/auth/register-company`,
            data: {
                companyName: `Sub Test ${now}`,
                email: randomEmail,
                password
            }
        });

        if (registerRes.status === 201 && registerRes.data?.token && registerRes.data?.activeCompanyId) {
            token = registerRes.data.token;
            companyId = String(registerRes.data.activeCompanyId);
            pass('Register company returns token and activeCompanyId');
        } else {
            fail('Register company returns token and activeCompanyId', `status=${registerRes.status}`);
            throw new Error('Cannot continue tests without auth token.');
        }

        const subMeInitial = await callApi({
            method: 'get',
            url: `${BASE_URL}/subscriptions/me`,
            headers: authHeaders()
        });
        if (subMeInitial.status === 200 && subMeInitial.data?.planId === 'free') {
            pass('New company starts on Free plan');
        } else {
            fail('New company starts on Free plan', JSON.stringify(subMeInitial.data));
        }

        // 2) Free plan restrictions
        const reportRes = await callApi({
            method: 'get',
            url: `${BASE_URL}/attendance/admin/report`,
            headers: authHeaders(),
            params: { month: 4, year: 2026 }
        });
        if (reportRes.status === 403) {
            pass('Free plan blocks attendance report download');
        } else {
            fail('Free plan blocks attendance report download', `status=${reportRes.status}`);
        }

        const attendanceEditRes = await callApi({
            method: 'put',
            url: `${BASE_URL}/attendance/admin/record/662f9f6ef1cc6d2d7f6a9999`,
            headers: authHeaders(),
            data: { status: 'present' }
        });
        if (attendanceEditRes.status === 403) {
            pass('Free plan blocks attendance edit');
        } else {
            fail('Free plan blocks attendance edit', `status=${attendanceEditRes.status}`);
        }

        const chatFileRes = await callApi({
            method: 'post',
            url: `${BASE_URL}/chat/message/file`,
            headers: authHeaders(),
            data: { conversationId: '662f9f6ef1cc6d2d7f6a9999' }
        });
        if (chatFileRes.status === 403) {
            pass('Free plan blocks chat attachments');
        } else {
            fail('Free plan blocks chat attachments', `status=${chatFileRes.status}`);
        }

        // 3) Free plan member limit (owner is already one member => can add 2, 3rd should fail)
        for (let i = 1; i <= 3; i += 1) {
            const addUserRes = await callApi({
                method: 'post',
                url: `${BASE_URL}/users/add-account`,
                headers: authHeaders(),
                data: {
                    name: `User ${i}`,
                    title: 'Dev',
                    email: `subtest_member_${now}_${i}@example.com`,
                    role: 'user'
                }
            });
            if (i <= 2 && addUserRes.status === 201) {
                pass(`Free plan add-account #${i} allowed within limit`);
            } else if (i === 3 && addUserRes.status === 403) {
                pass('Free plan blocks add-account after reaching limit');
            } else {
                fail(`Free plan add-account #${i} behavior`, `status=${addUserRes.status}`);
            }
        }

        // 4) Same plan checkout should be blocked before expiry
        const futureExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
        await Company.findByIdAndUpdate(companyId, {
            $set: {
                'subscription.planId': 'basic',
                'subscription.status': 'active',
                'subscription.expiresAt': futureExpiry,
                'subscription.graceEndsAt': new Date(futureExpiry.getTime() + 7 * 24 * 60 * 60 * 1000)
            }
        });

        const duplicateCheckoutRes = await callApi({
            method: 'post',
            url: `${BASE_URL}/subscriptions/paymob/checkout`,
            headers: authHeaders(),
            data: { planId: 'basic', paymentMethod: 'card' }
        });
        if (duplicateCheckoutRes.status === 400) {
            pass('Cannot pay same active plan before current month expires');
        } else {
            const companyDebug = await Company.findById(companyId).select('subscription').lean();
            fail(
                'Cannot pay same active plan before current month expires',
                `status=${duplicateCheckoutRes.status}; me=${JSON.stringify((await callApi({
                    method: 'get',
                    url: `${BASE_URL}/subscriptions/me`,
                    headers: authHeaders()
                })).data)}; company=${JSON.stringify(companyDebug?.subscription || {})}`
            );
        }

        // 5) Grace period 7 days behavior
        const expiredYesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
        const graceFuture = new Date(expiredYesterday.getTime() + 7 * 24 * 60 * 60 * 1000);
        await Company.findByIdAndUpdate(companyId, {
            $set: {
                'subscription.planId': 'basic',
                'subscription.status': 'active',
                'subscription.expiresAt': expiredYesterday,
                'subscription.graceEndsAt': graceFuture
            }
        });

        const graceRes = await callApi({
            method: 'get',
            url: `${BASE_URL}/subscriptions/me`,
            headers: authHeaders()
        });
        if (graceRes.status === 200 && graceRes.data?.status === 'expired' && graceRes.data?.planId === 'basic') {
            pass('Expired subscription enters 7-day grace period without immediate downgrade');
        } else {
            fail('Expired subscription enters 7-day grace period without immediate downgrade', JSON.stringify(graceRes.data));
        }

        // 6) Downgrade to free after grace period
        const oldExpiry = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        const oldGrace = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        await Company.findByIdAndUpdate(companyId, {
            $set: {
                'subscription.planId': 'basic',
                'subscription.status': 'expired',
                'subscription.expiresAt': oldExpiry,
                'subscription.graceEndsAt': oldGrace
            }
        });

        const downgradeRes = await callApi({
            method: 'get',
            url: `${BASE_URL}/subscriptions/me`,
            headers: authHeaders()
        });
        if (downgradeRes.status === 200 && downgradeRes.data?.planId === 'free') {
            pass('Company is auto-downgraded to free after grace period');
        } else {
            fail('Company is auto-downgraded to free after grace period', JSON.stringify(downgradeRes.data));
        }

        // 7) Renewal should be anchored to expiry date, not payment date
        const anchorExpiry = new Date('2026-06-01T00:00:00.000Z');
        await Company.findByIdAndUpdate(companyId, {
            $set: {
                'subscription.planId': 'basic',
                'subscription.status': 'expired',
                'subscription.expiresAt': anchorExpiry,
                'subscription.graceEndsAt': new Date('2026-06-08T00:00:00.000Z')
            }
        });

        const webhookRes = await callApi({
            method: 'post',
            url: `${BASE_URL}/subscriptions/paymob/webhook`,
            data: {
                obj: {
                    success: true,
                    id: `txn_${Date.now()}`,
                    extras: {
                        companyId,
                        planId: 'basic'
                    }
                }
            }
        });

        const refreshedCompany = await Company.findById(companyId).lean();
        const expectedRenewal = new Date('2026-07-01T00:00:00.000Z').toISOString();
        const actualRenewal = refreshedCompany?.subscription?.expiresAt
            ? new Date(refreshedCompany.subscription.expiresAt).toISOString()
            : null;

        if (webhookRes.status === 200 && actualRenewal === expectedRenewal) {
            pass('Renewal extends from old expiry date (not from payment date)');
        } else {
            fail(
                'Renewal extends from old expiry date (not from payment date)',
                `status=${webhookRes.status}, expected=${expectedRenewal}, actual=${actualRenewal}`
            );
        }
    } catch (error) {
        fail('Test runner execution', error.message);
    } finally {
        await mongoose.disconnect();
    }

    const failed = results.filter((r) => r.status === 'FAIL');
    console.log('\n=== Subscription E2E Test Report ===');
    for (const r of results) {
        console.log(`[${r.status}] ${r.name}${r.details ? ` -> ${r.details}` : ''}`);
    }
    console.log(`\nTotal: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
    process.exit(failed.length ? 1 : 0);
}

run();
