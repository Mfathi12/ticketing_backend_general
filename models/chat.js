const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    conversation: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conversation',
        required: true
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    senderName: {
        type: String,
        required: true
    },
    senderEmail: {
        type: String,
        required: true,
        lowercase: true
    },
    type: {
        type: String,
        enum: ['text', 'voice', 'image', 'video', 'file'],
        default: 'text',
        required: true
    },
    content: {
        type: String,
        trim: true
    },
    fileUrl: {
        type: String // For voice, image, video, file
    },
    fileName: {
        type: String // Original filename
    },
    fileSize: {
        type: Number // File size in bytes
    },
    mimeType: {
        type: String // MIME type of the file
    },
    duration: {
        type: Number // For voice/video messages in seconds
    },
    thumbnail: {
        type: String // Thumbnail URL for videos
    },
    readBy: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        readAt: {
            type: Date,
            default: Date.now
        }
    }],
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },
    mentions: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    reactions: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        emoji: String,
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    isEdited: {
        type: Boolean,
        default: false
    },
    editedAt: {
        type: Date
    },
    isDeleted: {
        type: Boolean,
        default: false
    },
    deletedAt: {
        type: Date
    },
    // Thread support
    parentMessage: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
        default: null
    },
    isThread: {
        type: Boolean,
        default: false
    },
    threadCount: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

// Index for efficient querying
messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ sender: 1 });
messageSchema.index({ parentMessage: 1 }); // Index for thread queries

const conversationSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    participants: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }],
    lastMessage: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    },
    lastMessageAt: {
        type: Date,
        default: Date.now
    },
    unreadCount: {
        type: Map,
        of: Number,
        default: new Map()
    },
    isGroup: {
        type: Boolean,
        default: false
    },
    groupName: {
        type: String,
        trim: true
    },
    groupDescription: {
        type: String,
        trim: true
    },
    groupAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project'
    }
}, {
    timestamps: true
});

// Index for finding user conversations
conversationSchema.index({ participants: 1 });
conversationSchema.index({ lastMessageAt: -1 });
conversationSchema.index({ project: 1 });

// Ensure unique conversation between two users (for 1-on-1 chats)
conversationSchema.index({ participants: 1 }, {
    unique: true,
    partialFilterExpression: { isGroup: false, project: { $exists: false } },
    sparse: true
});

// Ensure unique project conversation
conversationSchema.index({ project: 1 }, {
    unique: true,
    partialFilterExpression: { project: { $exists: true } },
    sparse: true
});

const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);

module.exports = { Message, Conversation };

