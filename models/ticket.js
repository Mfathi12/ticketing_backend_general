const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project',
        required: true
    },
    ticket: {
        type: String,
        required: true,
        trim: true
    },
    requested_from: {
        type: String,
        required: true,
        trim: true
    },
    requested_from_email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    requested_to: {
        type: String,
        required: true,
        trim: true
    },
    requested_to_email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    time: {
        type: String,
        trim: true
    },
    description: {
        type: String,
        required: true,
        trim: true
    },
    handler: [{
        type: String,
        trim: true,
        lowercase: true
    }],
    cc: [{
        type: String,
        trim: true,
        lowercase: true
    }],
    status: {
        type: String,
        enum: ['open', 'in_progress', 'resolved', 'closed'],
        default: 'open'
    },
    priority: {
        type: String,
        trim: true
    },
    comment: {
        type: String,
        trim: true
    },
    replies: [{
        user: {
            type: String,
            required: true,
            trim: true
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        userEmail: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        comment: {
            type: String,
            required: true,
            trim: true
        },
        images: [{
            type: String
        }]
    }, {
        timestamps: true
    }],
    end_date: {
        type: Date
    },
    images: [{
        type: String
    }]

}, {
    timestamps: true
});

// Virtual to get all comments (old comment + replies) for backward compatibility
ticketSchema.virtual('allComments').get(function() {
    const comments = [];
    
    // Add old comment if it exists (for backward compatibility)
    if (this.comment && this.comment.trim()) {
        comments.push({
            user: this.requested_to || 'System',
            userEmail: this.requested_to_email || '',
            comment: this.comment,
            createdAt: this.updatedAt || this.createdAt,
            isLegacy: true // Flag to identify old comments
        });
    }
    
    // Add all replies (handle case where replies field doesn't exist on old tickets)
    if (this.replies && Array.isArray(this.replies) && this.replies.length > 0) {
        this.replies.forEach(reply => {
            if (reply && reply.comment) {
                comments.push({
                    user: reply.user || 'Unknown',
                    userId: reply.userId || null,
                    userEmail: reply.userEmail || '',
                    comment: reply.comment,
                    images: (reply.images && Array.isArray(reply.images)) ? reply.images : [],
                    createdAt: reply.createdAt || new Date(),
                    isLegacy: false
                });
            }
        });
    }
    
    return comments;
});

// Ensure virtuals are included in JSON
ticketSchema.set('toJSON', { virtuals: true });
ticketSchema.set('toObject', { virtuals: true });

// Create compound unique index for ticket + project combination
ticketSchema.index({ ticket: 1, project: 1 }, { unique: true });

module.exports = mongoose.model('Ticket', ticketSchema);