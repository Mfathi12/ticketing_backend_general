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
        enum: ['admin', 'manager', 'developer', 'tester', 'user'],
        default: 'user'
    },
    companies: [{
        company: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Company',
            required: true
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
