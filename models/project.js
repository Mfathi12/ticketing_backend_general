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
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        index: true
    },
    status: {
        type: String,
        enum: ['active', 'completed', 'on_hold', 'cancelled'],
        default: 'active'
    }
}, {
    timestamps: true
});

projectSchema.index({ company: 1, assigned_users: 1 });
projectSchema.index({ company: 1, status: 1 });
projectSchema.index({ company: 1, estimated_end_date: 1 });

module.exports = mongoose.model('Project', projectSchema);
