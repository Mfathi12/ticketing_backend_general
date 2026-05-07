const mongoose = require('mongoose');

const localizedPlanFieldsSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        description: { type: String, required: true, trim: true },
        billingPeriod: { type: String, required: true, trim: true },
        features: { type: [String], default: [] }
    },
    { _id: false }
);

const subscriptionPlanContentSchema = new mongoose.Schema(
    {
        planId: {
            type: String,
            required: true,
            unique: true,
            enum: ['free', 'basic', 'pro', 'enterprise'],
            index: true
        },
        translations: {
            en: { type: localizedPlanFieldsSchema, required: true },
            ar: { type: localizedPlanFieldsSchema, required: true }
        }
    },
    { timestamps: true }
);

module.exports = mongoose.models.SubscriptionPlanContent || mongoose.model('SubscriptionPlanContent', subscriptionPlanContentSchema);
