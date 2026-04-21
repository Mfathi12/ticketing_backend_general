const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
    project_name: {
        type: String,
        required: true,
        trim: true
    },
    start_date: {
        type: Date,
        required: true
    },
    estimated_end_date: {
        type: Date,
        required: true
    },
    assigned_users: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    status: {
        type: String,
        enum: ['active', 'completed', 'on_hold', 'cancelled'],
        default: 'active'
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Project', projectSchema);
