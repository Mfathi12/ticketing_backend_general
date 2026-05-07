const mongoose = require('mongoose');

const limitsSchema = new mongoose.Schema(
    {
        maxMembers: { type: mongoose.Schema.Types.Mixed, default: undefined },
        maxProjects: { type: mongoose.Schema.Types.Mixed, default: undefined },
        canUploadChatAttachments: { type: Boolean, default: undefined },
        canEditAttendance: { type: Boolean, default: undefined },
        canDownloadAttendanceReport: { type: Boolean, default: undefined }
    },
    { _id: false, strict: false }
);

const planCatalogOverrideSchema = new mongoose.Schema(
    {
        planId: {
            type: String,
            required: true,
            unique: true,
            enum: ['free', 'basic', 'pro', 'enterprise'],
            index: true
        },
        name: { type: String, trim: true },
        description: { type: String, trim: true },
        price: { type: Number },
        currency: { type: String, trim: true },
        billingPeriod: { type: String, trim: true },
        features: { type: [String], default: undefined },
        isActive: { type: Boolean },
        isPopular: { type: Boolean },
        trialDays: { type: Number },
        paymobIntegrationId: { type: Number },
        paymobSubscriptionPlanId: { type: Number },
        limits: { type: limitsSchema, default: undefined }
    },
    { timestamps: true }
);

module.exports =
    mongoose.models.PlanCatalogOverride ||
    mongoose.model('PlanCatalogOverride', planCatalogOverrideSchema);
