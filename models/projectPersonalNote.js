const mongoose = require('mongoose');

const projectPersonalNoteSchema = new mongoose.Schema(
    {
        project: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Project',
            required: true,
            index: true
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        content: {
            type: String,
            required: true,
            trim: true
        }
    },
    {
        timestamps: true
    }
);

projectPersonalNoteSchema.index({ project: 1, user: 1 });

module.exports = mongoose.model('ProjectPersonalNote', projectPersonalNoteSchema);
