const { Op } = require('sequelize');
const { User, Company } = require('../models');
const { getSequelizeModels } = require('../db/postgres');
const { isPostgresPrimary } = require('./sql/runtime');

const DEFAULT_DAYS = 2;

async function purgeStaleUnverifiedAccountsSql() {
    const m = getSequelizeModels();
    if (!m) return { deletedUsers: 0, deletedCompanies: 0 };

    const days = parseInt(process.env.UNVERIFIED_ACCOUNT_PURGE_DAYS || String(DEFAULT_DAYS), 10);
    const safeDays = Math.max(1, Number.isFinite(days) ? days : DEFAULT_DAYS);
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

    const staleUsers = await m.User.findAll({
        where: {
            registrationEmailPending: true,
            createdAt: { [Op.lt]: cutoff }
        },
        attributes: ['id']
    });

    let deletedUsers = 0;
    let deletedCompanies = 0;

    for (const u of staleUsers) {
        const userId = u.id;
        try {
            await m.UserCompany.destroy({ where: { userId: String(userId) } });

            const owned = await m.Company.findAll({
                where: { ownerUserId: String(userId) },
                attributes: ['id']
            });
            for (const c of owned) {
                await m.UserCompany.destroy({ where: { companyId: c.id } });
                const r = await m.Company.destroy({ where: { id: c.id } });
                deletedCompanies += r;
            }

            const del = await m.User.destroy({ where: { id: String(userId) } });
            if (del) deletedUsers += 1;
        } catch (err) {
            console.error('purgeStaleUnverifiedAccounts error for user', userId, err);
        }
    }

    if (deletedUsers) {
        console.log(
            `purgeStaleUnverifiedAccounts: removed ${deletedUsers} unverified user(s), ${deletedCompanies} owned company row(s) (PostgreSQL)`
        );
    }

    return { deletedUsers, deletedCompanies };
}

/**
 * Removes self-registered owners who still have registrationEmailPending and never
 * verified within UNVERIFIED_ACCOUNT_PURGE_DAYS (default 2). Deletes companies they own
 * and pulls them from other companies' member lists.
 */
async function purgeStaleUnverifiedAccounts() {
    if (isPostgresPrimary()) {
        return purgeStaleUnverifiedAccountsSql();
    }

    const days = parseInt(process.env.UNVERIFIED_ACCOUNT_PURGE_DAYS || String(DEFAULT_DAYS), 10);
    const safeDays = Math.max(1, Number.isFinite(days) ? days : DEFAULT_DAYS);
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

    const staleUsers = await User.find({
        registrationEmailPending: true,
        createdAt: { $lt: cutoff }
    }).select('_id');

    let deletedUsers = 0;
    let deletedCompanies = 0;

    for (const u of staleUsers) {
        const userId = u._id;
        try {
            await Company.updateMany(
                { 'members.user': userId },
                { $pull: { members: { user: userId } } }
            );
            const owned = await Company.find({ ownerUser: userId }).select('_id');
            const ids = owned.map((c) => c._id);
            if (ids.length) {
                const r = await Company.deleteMany({ _id: { $in: ids } });
                deletedCompanies += r.deletedCount || 0;
            }
            await User.deleteOne({ _id: userId });
            deletedUsers += 1;
        } catch (err) {
            console.error('purgeStaleUnverifiedAccounts error for user', userId, err);
        }
    }

    if (deletedUsers) {
        console.log(
            `purgeStaleUnverifiedAccounts: removed ${deletedUsers} unverified user(s), ${deletedCompanies} owned company document(s)`
        );
    }

    return { deletedUsers, deletedCompanies };
}

module.exports = { purgeStaleUnverifiedAccounts };
