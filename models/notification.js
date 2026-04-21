const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        required: true,
        enum: [
            'new_ticket',
            'ticket_assigned',
            'ticket_cc',
            'ticket_updated',
            'ticket_reply',
            'chat_message',
            'attendance_reminder',
            'attendance_day_rollover',
            'attendance_admin_edit'
        ]
    },
    title: {
        type: String,
        required: true
    },
    body: {
        type: String,
        default: ''
    },
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    read: {
        type: Boolean,
        default: false
    },
    readAt: {
        type: Date
    }
}, {
    timestamps: true
});

notificationSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
