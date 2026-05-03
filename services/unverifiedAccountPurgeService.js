const { User, Company } = require('../models');

const DEFAULT_DAYS = 2;

/**
 * Removes self-registered owners who still have registrationEmailPending and never
 * verified within UNVERIFIED_ACCOUNT_PURGE_DAYS (default 2). Deletes companies they own
 * and pulls them from other companies' member lists.
 */
async function purgeStaleUnverifiedAccounts() {
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
