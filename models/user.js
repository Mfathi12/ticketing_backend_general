const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    /**
     * Present for accounts that completed email proof (invite, verify, etc.).
     * Omitted on legacy users — auth does not require it for login.
     */
    emailVerified: {
        type: Boolean
    },
    /**
     * True only for brand-new owners created via POST /register-company until OTP is verified.
     * Legacy and invited users omit this (or false) — they log in normally.
     */
    registrationEmailPending: {
        type: Boolean
    },
    password: {
        type: String,
        required: false,
        validate: {
            validator(value) {
                if (!value) return true;
                return String(value).length >= 6;
            },
            message: 'Password must be at least 6 characters'
        }
    },
    role: {
        type: String,
        /**
         * `super_admin` = platform staff (admin dashboard only). Per-company power uses `companies[].companyRole`.
         * `admin` kept for legacy data; new company owners get `user`.
         */
        enum: ['super_admin', 'admin', 'manager', 'developer', 'tester', 'user'],
        default: 'user'
    },
    accountStatus: {
        type: String,
        enum: ['active', 'banned'],
        default: 'active'
    },
    lastLoginAt: {
        type: Date,
        default: null
    },
    companies: [{
        company: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Company',
            required: true
        },
        displayName: {
            type: String,
            trim: true
        },
        companyRole: {
            type: String,
            enum: ['owner', 'admin', 'manager', 'developer', 'tester', 'user'],
            default: 'user'
        },
        isOwner: {
            type: Boolean,
            default: false
        }
    }],
    // Store FCM device tokens for push notifications
    fcmTokens: {
        type: [String],
        default: []
    },
    invite: {
        tokenHash: {
            type: String,
            default: null
        },
        expiresAt: {
            type: Date,
            default: null
        },
        invitedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        company: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Company',
            default: null
        },
        acceptedAt: {
            type: Date,
            default: null
        }
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);
