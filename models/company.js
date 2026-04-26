const mongoose = require('mongoose');

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
            enum: ['owner', 'admin', 'manager', 'developer', 'tester', 'user'],
            default: 'user'
        },
        isOwner: {
            type: Boolean,
            default: false
        }
    }],
    subscription: {
        planId: {
            type: String,
            default: 'free'
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
        paymobOrderId: {
            type: String,
            default: null
        },
        paymobTransactionId: {
            type: String,
            default: null
        },
        updatedAt: {
            type: Date,
            default: Date.now
        }
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Company', companySchema);
