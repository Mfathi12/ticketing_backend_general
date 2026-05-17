const mongoose = require('mongoose');

const completionGifSchema = new mongoose.Schema(
    {
        url: {
            type: String,
            required: true,
            trim: true,
            maxlength: 2048
        },
        label: {
            type: String,
            trim: true,
            maxlength: 200,
            default: null
        },
        tags: {
            type: [String],
            default: []
        },
        weight: {
            type: Number,
            default: 1,
            min: 1,
            max: 100
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    { timestamps: true }
);

module.exports =
    mongoose.models.CompletionGif ||
    mongoose.model('CompletionGif', completionGifSchema);
