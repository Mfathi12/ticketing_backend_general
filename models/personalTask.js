const mongoose = require('mongoose');

const COLUMN_VALUES = ['backlog', 'this_week', 'today', 'done'];

const personalTaskSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 500
        },
        estimatedMinutes: {
            type: Number,
            required: true,
            min: 1,
            max: 24 * 60
        },
        column: {
            type: String,
            required: true,
            enum: COLUMN_VALUES,
            default: 'backlog',
            index: true
        },
        completedAt: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

personalTaskSchema.index({ user: 1, column: 1 });

module.exports = {
    PersonalTask: mongoose.model('PersonalTask', personalTaskSchema),
    PERSONAL_TASK_COLUMNS: COLUMN_VALUES
};

