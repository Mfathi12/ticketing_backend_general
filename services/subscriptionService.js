const { SubscriptionPlanContent } = require('../models');
const { localizePlan, normalizeLang } = require('../utils/i18n');
const hasArabicChars = (value) => /[\u0600-\u06FF]/.test(String(value || ''));

const SUBSCRIPTION_PLANS = [
    {
        id: 'free',
        name: 'Free',
        description: 'Default plan for new companies',
        price: 0,
        currency: 'EGP',
        billingPeriod: 'monthly',
        features: [
            'Up to 3 accounts',
            'No chat images, videos, or files',
            'No attendance edit or download'
        ],
        isPopular: false,
        isActive: true,
        paymobIntegrationId: null,
        trialDays: 0,
        limits: {
            maxMembers: 3,
            canUploadChatAttachments: false,
            canEditAttendance: false,
            canDownloadAttendanceReport: false
        }
    },
    {
        id: 'basic',
        name: 'Basic',
        description: 'For growing teams',
        price: 100,
        currency: 'EGP',
        billingPeriod: 'monthly',
        features: [
            'From 3 to 10 members',
            'Chat attachments enabled',
            'Attendance edit and report download'
        ],
        isPopular: true,
        isActive: true,
        paymobIntegrationId: Number(process.env.PAYMOB_BASIC_INTEGRATION_ID || 123456),
        paymobSubscriptionPlanId: Number(process.env.PAYMOB_SUBSCRIPTION_PLAN_ID_BASIC || 0) || null,
        trialDays: 0,
        limits: {
            maxMembers: 10,
            canUploadChatAttachments: true,
            canEditAttendance: true,
            canDownloadAttendanceReport: true
        }
    },
    {
        id: 'pro',
        name: 'Pro',
        description: 'For larger teams',
        price: 250,
        currency: 'EGP',
        billingPeriod: 'monthly',
        features: [
            'From 10 to 50 members',
            'Chat attachments enabled',
            'Attendance edit and report download'
        ],
        isPopular: false,
        isActive: true,
        paymobIntegrationId: Number(process.env.PAYMOB_PRO_INTEGRATION_ID || 789012),
        paymobSubscriptionPlanId: Number(process.env.PAYMOB_SUBSCRIPTION_PLAN_ID_PRO || 0) || null,
        trialDays: 7,
        limits: {
            maxMembers: 50,
            canUploadChatAttachments: true,
            canEditAttendance: true,
            canDownloadAttendanceReport: true
        }
    }
];

const GRACE_PERIOD_DAYS = 7;

const getPlanById = (planId) => SUBSCRIPTION_PLANS.find((plan) => plan.id === planId) || SUBSCRIPTION_PLANS[0];

const getCompanyPlan = (company) => {
    const planId = company?.subscription?.planId || 'free';
    return getPlanById(planId);
};

const serializePlans = () =>
    SUBSCRIPTION_PLANS.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        price: plan.price,
        currency: plan.currency,
        billingPeriod: plan.billingPeriod,
        features: plan.features,
        isPopular: plan.isPopular,
        isActive: plan.isActive,
        paymobIntegrationId: plan.paymobIntegrationId,
        paymobSubscriptionPlanId: plan.paymobSubscriptionPlanId,
        trialDays: plan.trialDays
    }));

let plansSeedPromise = null;
const ensurePlanTranslationsSeeded = async () => {
    if (plansSeedPromise) return plansSeedPromise;
    plansSeedPromise = (async () => {
        const basePlans = serializePlans();
        const existingDocs = await SubscriptionPlanContent.find({
            planId: { $in: basePlans.map((p) => p.id) }
        }).lean();
        const existingIds = new Set(existingDocs.map((doc) => doc.planId));

        const inserts = basePlans
            .filter((plan) => !existingIds.has(plan.id))
            .map((plan) => ({
                planId: plan.id,
                translations: {
                    en: {
                        name: localizePlan(plan, 'en').name,
                        description: localizePlan(plan, 'en').description,
                        billingPeriod: localizePlan(plan, 'en').billingPeriod,
                        features: localizePlan(plan, 'en').features
                    },
                    ar: {
                        name: localizePlan(plan, 'ar').name,
                        description: localizePlan(plan, 'ar').description,
                        billingPeriod: localizePlan(plan, 'ar').billingPeriod,
                        features: localizePlan(plan, 'ar').features
                    }
                }
            }));

        if (inserts.length) {
            await SubscriptionPlanContent.insertMany(inserts, { ordered: false });
        }

        // Repair old DB rows where Arabic translation was missing/incorrect (same as English).
        const updates = [];
        for (const plan of basePlans) {
            const doc = existingDocs.find((d) => d.planId === plan.id);
            if (!doc) continue;
            const defaultEn = localizePlan(plan, 'en');
            const defaultAr = localizePlan(plan, 'ar');
            const en = doc.translations?.en || {};
            const ar = doc.translations?.ar || {};
            const arLooksEnglish =
                (ar.name && ar.name === en.name) ||
                (ar.description && ar.description === en.description) ||
                (ar.billingPeriod && ar.billingPeriod === en.billingPeriod);
            const arMissing =
                !ar.name ||
                !ar.description ||
                !ar.billingPeriod ||
                !Array.isArray(ar.features) ||
                ar.features.length === 0;

            if (arMissing || arLooksEnglish) {
                updates.push({
                    updateOne: {
                        filter: { planId: plan.id },
                        update: {
                            $set: {
                                'translations.en.name': en.name || defaultEn.name,
                                'translations.en.description': en.description || defaultEn.description,
                                'translations.en.billingPeriod': en.billingPeriod || defaultEn.billingPeriod,
                                'translations.en.features': Array.isArray(en.features) && en.features.length ? en.features : defaultEn.features,
                                'translations.ar.name': defaultAr.name,
                                'translations.ar.description': defaultAr.description,
                                'translations.ar.billingPeriod': defaultAr.billingPeriod,
                                'translations.ar.features': defaultAr.features
                            }
                        }
                    }
                });
            }
        }

        if (updates.length) {
            await SubscriptionPlanContent.bulkWrite(updates, { ordered: false });
        }
    })().catch((error) => {
        plansSeedPromise = null;
        throw error;
    });
    return plansSeedPromise;
};

const getLocalizedPlans = async (lang = 'en') => {
    const normalized = normalizeLang(lang);
    const basePlans = serializePlans();
    try {
        await ensurePlanTranslationsSeeded();
        const dbPlans = await SubscriptionPlanContent.find({
            planId: { $in: basePlans.map((p) => p.id) }
        }).lean();
        const byId = new Map(dbPlans.map((doc) => [doc.planId, doc]));

        return basePlans.map((plan) => {
            const dbPlan = byId.get(plan.id);
            const tr = dbPlan?.translations?.[normalized];
            if (!tr) return localizePlan(plan, normalized);
            const localizedFromDb = {
                ...plan,
                name: tr.name || plan.name,
                description: tr.description || plan.description,
                billingPeriod: tr.billingPeriod || plan.billingPeriod,
                features: Array.isArray(tr.features) && tr.features.length ? tr.features : plan.features
            };
            // Safety fallback: if Arabic requested but DB row is stale/English, return trusted Arabic defaults.
            if (normalized === 'ar') {
                const payloadText = [
                    localizedFromDb.name,
                    localizedFromDb.description,
                    localizedFromDb.billingPeriod,
                    ...(localizedFromDb.features || [])
                ].join(' ');
                if (!hasArabicChars(payloadText)) {
                    return localizePlan(plan, 'ar');
                }
            }
            return localizedFromDb;
        });
    } catch (error) {
        console.error('Failed to load plan translations from DB, using defaults:', error.message);
        return basePlans.map((plan) => localizePlan(plan, normalized));
    }
};

const canAddMembers = (company, currentMembersCount, membersToAdd = 1) => {
    const plan = getCompanyPlan(company);
    const maxMembers = plan?.limits?.maxMembers ?? 3;
    return currentMembersCount + membersToAdd <= maxMembers;
};

const addDays = (date, days) => {
    const value = new Date(date);
    value.setDate(value.getDate() + days);
    return value;
};

const addMonths = (date, months) => {
    const value = new Date(date);
    value.setMonth(value.getMonth() + months);
    return value;
};

const evaluateAndSyncCompanySubscription = async (company, now = new Date()) => {
    if (!company) {
        return {
            changed: false,
            downgraded: false,
            inGracePeriod: false,
            status: 'active',
            planId: 'free',
            notice: null
        };
    }

    if (!company.subscription) {
        company.subscription = {};
    }

    const currentPlanId = company.subscription.planId || 'free';
    if (company.subscription.status === 'pending') {
        return {
            changed: false,
            downgraded: false,
            inGracePeriod: false,
            status: 'pending',
            planId: currentPlanId,
            notice: null
        };
    }
    const isPaidPlan = currentPlanId !== 'free';

    if (!isPaidPlan) {
        const needsNormalize = company.subscription.status !== 'active' ||
            company.subscription.expiresAt != null ||
            company.subscription.graceEndsAt != null;
        if (needsNormalize) {
            company.subscription.planId = 'free';
            company.subscription.status = 'active';
            company.subscription.expiresAt = null;
            company.subscription.graceEndsAt = null;
            company.subscription.updatedAt = new Date();
            await company.save();
        }
        return {
            changed: needsNormalize,
            downgraded: false,
            inGracePeriod: false,
            status: 'active',
            planId: 'free',
            notice: null
        };
    }

    const expiresAt = company.subscription.expiresAt ? new Date(company.subscription.expiresAt) : null;
    if (!expiresAt) {
        const seededExpiry = addMonths(now, 1);
        company.subscription.status = 'active';
        company.subscription.expiresAt = seededExpiry;
        company.subscription.graceEndsAt = addDays(seededExpiry, GRACE_PERIOD_DAYS);
        company.subscription.updatedAt = new Date();
        await company.save();
        return {
            changed: true,
            downgraded: false,
            inGracePeriod: false,
            status: 'active',
            planId: currentPlanId,
            notice: null
        };
    }

    if (expiresAt >= now) {
        const nextGrace = addDays(expiresAt, GRACE_PERIOD_DAYS);
        const changed = company.subscription.status !== 'active' ||
            !company.subscription.graceEndsAt ||
            new Date(company.subscription.graceEndsAt).getTime() !== nextGrace.getTime();
        if (changed) {
            company.subscription.status = 'active';
            company.subscription.graceEndsAt = nextGrace;
            company.subscription.updatedAt = new Date();
            await company.save();
        }
        return {
            changed,
            downgraded: false,
            inGracePeriod: false,
            status: 'active',
            planId: currentPlanId,
            notice: null
        };
    }

    const graceEndsAt = company.subscription.graceEndsAt
        ? new Date(company.subscription.graceEndsAt)
        : addDays(expiresAt, GRACE_PERIOD_DAYS);

    if (now <= graceEndsAt) {
        const msLeft = graceEndsAt.getTime() - now.getTime();
        const daysLeft = Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
        const changed = company.subscription.status !== 'expired' || !company.subscription.graceEndsAt;
        if (changed) {
            company.subscription.status = 'expired';
            company.subscription.graceEndsAt = graceEndsAt;
            company.subscription.updatedAt = new Date();
            await company.save();
        }
        return {
            changed,
            downgraded: false,
            inGracePeriod: true,
            status: 'expired',
            planId: currentPlanId,
            expiresAt,
            graceEndsAt,
            noticeKey: 'subscription.notice_grace',
            noticeParams: { days: daysLeft }
        };
    }

    company.subscription.planId = 'free';
    company.subscription.status = 'active';
    company.subscription.isTrial = false;
    company.subscription.trialEndsAt = null;
    company.subscription.expiresAt = null;
    company.subscription.graceEndsAt = null;
    company.subscription.updatedAt = new Date();
    await company.save();

    return {
        changed: true,
        downgraded: true,
        inGracePeriod: false,
        status: 'active',
        planId: 'free',
        noticeKey: 'subscription.notice_downgraded',
        noticeParams: {}
    };
};

module.exports = {
    SUBSCRIPTION_PLANS,
    GRACE_PERIOD_DAYS,
    getPlanById,
    getCompanyPlan,
    serializePlans,
    getLocalizedPlans,
    canAddMembers,
    addDays,
    addMonths,
    evaluateAndSyncCompanySubscription
};
