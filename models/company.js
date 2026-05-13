const mongoose = require('mongoose');
const { DEFAULT_SUBSCRIPTION_PLAN_ID } = require('../utils/subscriptionPlanIds');

const companySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    ownerUser: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    members: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        role: {
            type: String,
            enum: ['owner', 'admin', 'manager', 'user'],
            default: 'user'
        },
        isOwner: {
            type: Boolean,
            default: false
        }
    }],
    /** Platform (super-admin) controls — not company org roles */
    platformStatus: {
        type: String,
        enum: ['active', 'suspended'],
        default: 'active'
    },
    deletedAt: {
        type: Date,
        default: null
    },
    subscription: {
        planId: {
            type: String,
            default: DEFAULT_SUBSCRIPTION_PLAN_ID
        },
        status: {
            type: String,
            enum: ['active', 'pending', 'expired', 'cancelled'],
            default: 'active'
        },
        isTrial: {
            type: Boolean,
            default: false
        },
        trialEndsAt: {
            type: Date,
            default: null
        },
        expiresAt: {
            type: Date,
            default: null
        },
        graceEndsAt: {
            type: Date,
            default: null
        },
        pendingPlanId: {
            type: String,
            default: null
        },
        paymobOrderId: {
            type: String,
            default: null
        },
        paymobTransactionId: {
            type: String,
            default: null
        },
        paymobSubscriptionId: {
            type: String,
            default: null
        },
        updatedAt: {
            type: Date,
            default: Date.now
        },
        lastBillingFailureAt: {
            type: Date,
            default: null
        },
        lastBillingFailureReason: {
            type: String,
            default: null
        }
    }
}, {
    timestamps: true
});

companySchema.index({ ownerUser: 1, platformStatus: 1 });
companySchema.index({ 'subscription.status': 1, 'subscription.expiresAt': 1 });

module.exports = mongoose.model('Company', companySchema);
