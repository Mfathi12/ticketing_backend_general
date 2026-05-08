const mongoose = require('mongoose');
const { getSequelizeModels } = require('../../db/postgres');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const getLatestVersion = async () => {
    const m = requireModels();
    return m.Version.findOne({ order: [['updatedAt', 'DESC']] });
};

const upsertVersion = async (versionStr) => {
    const m = requireModels();
    const trimmed = String(versionStr).trim();
    const existing = await m.Version.findOne({ order: [['updatedAt', 'DESC']] });
    if (existing) {
        await existing.update({ version: trimmed });
        const row = await m.Version.findByPk(existing.id);
        return { row, created: false };
    }
    const row = await m.Version.create({ id: newObjectIdString(), version: trimmed });
    return { row, created: true };
};

const toApiShape = (row) => {
    if (!row) return null;
    const p = row.get ? row.get({ plain: true }) : row;
    return {
        _id: p.id,
        id: p.id,
        version: p.version,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
};

module.exports = {
    getLatestVersion,
    upsertVersion,
    toApiShape
};
