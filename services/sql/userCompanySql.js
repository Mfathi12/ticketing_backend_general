const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { getSequelizeModels, getSequelize } = require('../../db/postgres');
const authSql = require('./authSql');
const { loadCompanyWithMembers } = require('./companySql');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

/**
 * @param {Function} hashFn (token) => hash string
 */
const acceptInviteSql = async (token, password, hashFn) => {
    const m = requireModels();
    const tokenHash = hashFn(token);
    const user = await m.User.findOne({ where: { inviteTokenHash: tokenHash } });
    if (!user) return { error: 'invalid' };
    const plain = user.get({ plain: true });
    if (!plain.inviteExpiresAt || new Date(plain.inviteExpiresAt).getTime() < Date.now()) {
        return { error: 'expired' };
    }
    const hashed = await bcrypt.hash(password, 12);
    await m.User.update(
        {
            password: hashed,
            emailVerified: true,
            registrationEmailPending: false,
            inviteTokenHash: null,
            inviteExpiresAt: null,
            inviteAcceptedAt: new Date(),
            inviteInvitedByUserId: plain.inviteInvitedByUserId,
            inviteCompanyId: plain.inviteCompanyId
        },
        { where: { id: plain.id } }
    );
    return { ok: true };
};

const addAccountSql = async ({
    companyId,
    inviterUserId,
    name,
    title,
    email,
    companyRole,
    inviteToken,
    inviteTokenHash,
    inviteExpiresAt,
    inviterName
}) => {
    const m = requireModels();
    const sql = getSequelize();
    const normalizedEmail = String(email).toLowerCase().trim();
    const company = await loadCompanyWithMembers(companyId);
    if (!company) return { error: 'no_company' };

    const currentMembersCount = Array.isArray(company.members) ? company.members.length : 0;

    let targetId;
    await sql.transaction(async (t) => {
        let target = await m.User.findOne({
            where: { email: normalizedEmail },
            transaction: t
        });

        if (!target) {
            target = await m.User.create(
                {
                    id: newObjectIdString(),
                    name: String(name).trim(),
                    title: String(title).trim(),
                    email: normalizedEmail,
                    role: companyRole,
                    emailVerified: true,
                    registrationEmailPending: false,
                    inviteTokenHash,
                    inviteExpiresAt,
                    inviteInvitedByUserId: String(inviterUserId),
                    inviteCompanyId: String(companyId)
                },
                { transaction: t }
            );
            await m.UserCompany.create(
                {
                    id: newObjectIdString(),
                    userId: target.id,
                    companyId: String(companyId),
                    displayName: String(name).trim(),
                    companyRole,
                    isOwner: false
                },
                { transaction: t }
            );
        } else {
            const tid = target.id;
            const alreadyInCompany = await m.UserCompany.findOne({
                where: { userId: tid, companyId: String(companyId) },
                transaction: t
            });
            if (alreadyInCompany) {
                const err = new Error('already_member');
                err.code = 'already_member';
                throw err;
            }
            await m.UserCompany.create(
                {
                    id: newObjectIdString(),
                    userId: tid,
                    companyId: String(companyId),
                    displayName: String(name).trim(),
                    companyRole,
                    isOwner: false
                },
                { transaction: t }
            );
            const plain = target.get({ plain: true });
            if (!plain.password) {
                await m.User.update(
                    {
                        inviteTokenHash,
                        inviteExpiresAt,
                        inviteInvitedByUserId: String(inviterUserId),
                        inviteCompanyId: String(companyId),
                        inviteAcceptedAt: null
                    },
                    { where: { id: tid }, transaction: t }
                );
            }
            target = await m.User.findByPk(tid, { transaction: t });
        }

        targetId = target.id;

        const userExistsInCompany = await m.CompanyMember.findOne({
            where: { companyId: String(companyId), userId: targetId },
            transaction: t
        });
        if (!userExistsInCompany) {
            await m.CompanyMember.create(
                {
                    id: newObjectIdString(),
                    companyId: String(companyId),
                    userId: targetId,
                    role: companyRole,
                    isOwner: false
                },
                { transaction: t }
            );
        }
    });

    const finalLean = await authSql.findUserById(targetId);
    const rowCheck = await m.User.findByPk(targetId, { attributes: ['password', 'inviteTokenHash'] });
    const plainCheck = rowCheck ? rowCheck.get({ plain: true }) : {};
    const shouldSendInvite =
        !plainCheck.password ||
        (plainCheck.inviteTokenHash && plainCheck.inviteTokenHash === inviteTokenHash);
    return {
        company,
        currentMembersCount,
        targetUser: finalLean,
        companyName: company.name,
        shouldSendInvite
    };
};

const deleteAccountSql = async ({ companyId, userId }) => {
    const m = requireModels();
    const sql = getSequelize();
    return sql.transaction(async (t) => {
        await m.UserCompany.destroy({
            where: { userId: String(userId), companyId: String(companyId) },
            transaction: t
        });
        await m.CompanyMember.destroy({
            where: { userId: String(userId), companyId: String(companyId) },
            transaction: t
        });
        return { ok: true };
    });
};

const updateUserSql = async ({
    userId,
    activeCompanyId,
    updateData,
    role,
    canManageCompanyUser
}) => {
    const m = requireModels();
    const uid = String(userId);
    if (Object.keys(updateData).length) {
        await m.User.update(updateData, { where: { id: uid } });
    }
    if (role && activeCompanyId && canManageCompanyUser) {
        await m.UserCompany.update(
            { companyRole: role },
            { where: { userId: uid, companyId: String(activeCompanyId) } }
        );
        await m.CompanyMember.update(
            { role },
            { where: { userId: uid, companyId: String(activeCompanyId) } }
        );
    }
    return authSql.findUserById(uid);
};

const registerFcmTokenSql = async (userId, token) => {
    const m = requireModels();
    const trimmed = String(token).trim();
    await m.UserFcmToken.findOrCreate({
        where: { userId: String(userId), token: trimmed },
        defaults: { id: newObjectIdString(), userId: String(userId), token: trimmed }
    });
    return authSql.findUserById(userId);
};

const unregisterFcmTokenSql = async (userId, token) => {
    const m = requireModels();
    await m.UserFcmToken.destroy({
        where: { userId: String(userId), token: String(token).trim() }
    });
    return authSql.findUserById(userId);
};

const listCompanyUsersSql = async (companyId) => {
    const m = requireModels();
    const cid = String(companyId);
    const [members, userCompanies] = await Promise.all([
        m.CompanyMember.findAll({ where: { companyId: cid } }),
        m.UserCompany.findAll({ where: { companyId: cid } })
    ]);
    const userIds = [...new Set(members.map((x) => String(x.userId)))];
    const userRows = userIds.length
        ? await m.User.findAll({
            where: { id: userIds },
            attributes: { exclude: ['password'] }
        })
        : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const displayByUser = new Map(
        userCompanies.map((uc) => [uc.userId, typeof uc.displayName === 'string' ? uc.displayName : ''])
    );
    const users = members
        .map((mem) => {
            const u = userById.get(mem.userId);
            if (!u) return null;
            const plain = u.get({ plain: true });
            const doc = {
                _id: plain.id,
                id: plain.id,
                name: plain.name,
                title: plain.title,
                email: plain.email,
                role: plain.role,
                accountStatus: plain.accountStatus,
                emailVerified: plain.emailVerified,
                registrationEmailPending: plain.registrationEmailPending,
                companies: [
                    {
                        company: cid,
                        companyId: cid,
                        displayName: displayByUser.get(mem.userId) || '',
                        companyRole: mem.role,
                        isOwner: mem.isOwner
                    }
                ],
                toObject: () => ({ ...plain, _id: plain.id, password: undefined })
            };
            return {
                ...doc,
                companyMemberRole: mem.role,
                companyIsOwner: mem.isOwner
            };
        })
        .filter(Boolean);
    return users;
};

module.exports = {
    acceptInviteSql,
    addAccountSql,
    deleteAccountSql,
    updateUserSql,
    registerFcmTokenSql,
    unregisterFcmTokenSql,
    listCompanyUsersSql
};
