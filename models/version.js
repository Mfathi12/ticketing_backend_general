const mongoose = require('mongoose');

const versionSchema = new mongoose.Schema(
    {
        version: {
            type: String,
            required: true,
            trim: true
        }
    },
    { timestamps: true }
);

module.exports = mongoose.models.Version || mongoose.model('Version', versionSchema);
