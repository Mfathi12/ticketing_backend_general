const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    date: {
        type: String,
        required: true,
        index: true // Index for faster searching by date
    }, // Format: YYYY-MM-DD
    checkIn: {
        type: Date,
        required: true
    },
    /** If set, real session start (before midnight split). UI timer uses this; checkIn is this calendar day's boundary. */
    continuousCheckIn: {
        type: Date
    },
    checkOut: {
        type: Date
    },
    duration: {
        type: Number,
        default: 0
    }, // Store in minutes
    status: {
        type: String,
        enum: ['present', 'half-day', 'absent'],
        default: 'present'
    },
    note: {
        type: String
    },
    /** Captured at check-in when the client sends coordinates (WGS84). */
    checkInLatitude: {
        type: Number
    },
    checkInLongitude: {
        type: Number
    },
    /** Captured at check-out when the client sends coordinates (WGS84). */
    checkOutLatitude: {
        type: Number
    },
    checkOutLongitude: {
        type: Number
    },
    lastEditedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    lastEditedAt: {
        type: Date
    }
}, {
    timestamps: true
});

// Compound index for queries by user and calendar day (multiple sessions per day allowed)
attendanceSchema.index({ company: 1, user: 1, date: 1 });

module.exports = mongoose.model('Attendance', attendanceSchema);
