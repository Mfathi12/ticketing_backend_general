const mongoose = require('mongoose');
const { getSequelizeModels } = require('../../db/postgres');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const toApiShape = (row, { includeAdmin = false } = {}) => {
    if (!row) return null;
    const p = row.get ? row.get({ plain: true }) : row;
    const base = {
        id: p.id || p._id,
        url: p.url,
        label: p.label ?? null,
        tags: Array.isArray(p.tags) ? p.tags : [],
        weight: p.weight ?? 1,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
    if (includeAdmin) {
        base.isActive = Boolean(p.isActive);
    }
    return base;
};

const listActive = async () => {
    const m = requireModels();
    const rows = await m.CompletionGif.findAll({
        where: { isActive: true },
        order: [['createdAt', 'ASC']]
    });
    return rows.map((r) => toApiShape(r));
};

const listAll = async () => {
    const m = requireModels();
    const rows = await m.CompletionGif.findAll({
        order: [['createdAt', 'DESC']]
    });
    return rows.map((r) => toApiShape(r, { includeAdmin: true }));
};

const findById = async (id) => {
    const m = requireModels();
    return m.CompletionGif.findByPk(id);
};

const create = async ({ url, label, tags, weight }) => {
    const m = requireModels();
    const row = await m.CompletionGif.create({
        id: newObjectIdString(),
        url,
        label: label ?? null,
        tags: tags ?? [],
        weight: weight ?? 1,
        isActive: true
    });
    return toApiShape(row, { includeAdmin: true });
};

const updateById = async (id, patch) => {
    const m = requireModels();
    const row = await m.CompletionGif.findByPk(id);
    if (!row) return null;
    await row.update(patch);
    const fresh = await m.CompletionGif.findByPk(id);
    return toApiShape(fresh, { includeAdmin: true });
};

const deleteById = async (id) => {
    const m = requireModels();
    const row = await m.CompletionGif.findByPk(id);
    if (!row) return false;
    await row.destroy();
    return true;
};

module.exports = {
    listActive,
    listAll,
    findById,
    create,
    updateById,
    deleteById,
    toApiShape
};
