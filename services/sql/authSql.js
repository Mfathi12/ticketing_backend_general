const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { getSequelizeModels, getSequelize } = require('../../db/postgres');
const { subscriptionFromRow, wrapCompanyForSubscription } = require('./companySubscriptionWrap');
const { DEFAULT_SUBSCRIPTION_PLAN_ID } = require('../../utils/subscriptionPlanIds');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) {
        throw new Error('PostgreSQL models are not ready');
    }
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const companySummaryFromRow = (row) => {
    const id = row.id;
    const o = {
        _id: id,
        name: row.name,
        email: row.email,
        ownerUser: row.ownerUserId,
        deletedAt: row.deletedAt || null
    };
    o.toString = () => String(id);
    return o;
};

const toLeanUser = (userInstance, { withPassword = false } = {}) => {
    const plain = userInstance.get({ plain: true });
    const memberships = (plain.companyLinks || []).map((c) => {
        const uc = c.UserCompany || {};
        return {
            company: c.id,
            companyId: c.id,
            displayName: typeof uc.displayName === 'string' ? uc.displayName : '',
            companyRole: uc.companyRole,
            isOwner: uc.isOwner
        };
    });
    const fcmTokens = (plain.fcmTokens || []).map((t) => t.token).filter(Boolean);
    const hasInvite =
        plain.inviteTokenHash != null ||
        plain.inviteExpiresAt != null ||
        plain.inviteInvitedByUserId != null ||
        plain.inviteCompanyId != null ||
        plain.inviteAcceptedAt != null;
    const invite = hasInvite
        ? {
            tokenHash: plain.inviteTokenHash,
            expiresAt: plain.inviteExpiresAt,
            invitedBy: plain.inviteInvitedByUserId,
            company: plain.inviteCompanyId,
            acceptedAt: plain.inviteAcceptedAt
        }
        : undefined;

    const lean = {
        _id: plain.id,
        id: plain.id,
        name: plain.name,
        title: plain.title,
        email: plain.email,
        emailVerified: plain.emailVerified,
        registrationEmailPending: plain.registrationEmailPending,
        role: plain.role,
        accountStatus: plain.accountStatus,
        lastLoginAt: plain.lastLoginAt,
        companies: memberships,
        fcmTokens,
        invite
    };
    if (withPassword) {
        lean.password = plain.password;
    }
    lean.toObject = () => ({ ...lean, password: withPassword ? lean.password : undefined });
    return lean;
};

const userIncludeAuth = () => {
    const { Company, UserFcmToken } = requireModels();
    return [
        {
            model: UserFcmToken,
            as: 'fcmTokens',
            required: false
        },
        {
            model: Company,
            as: 'companyLinks',
            through: { attributes: ['displayName', 'companyRole', 'isOwner'] },
            required: false
        }
    ];
};

const findUserByEmail = async (email, { withPassword = false } = {}) => {
    const { User } = requireModels();
    const u = await User.findOne({
        where: { email: String(email).toLowerCase().trim() },
        include: userIncludeAuth()
    });
    if (!u) return null;
    return toLeanUser(u, { withPassword });
};

const findUserById = async (id, { withPassword = false } = {}) => {
    const { User } = requireModels();
    const u = await User.findByPk(String(id), { include: userIncludeAuth() });
    if (!u) return null;
    return toLeanUser(u, { withPassword });
};

const updateLastLogin = async (userId) => {
    const { User } = requireModels();
    await User.update({ lastLoginAt: new Date() }, { where: { id: String(userId) } });
};

const addFcmToken = async (userId, token) => {
    const trimmed = String(token).trim();
    if (!trimmed) return;
    const { UserFcmToken } = requireModels();
    await UserFcmToken.findOrCreate({
        where: { userId: String(userId), token: trimmed },
        defaults: { id: newObjectIdString(), userId: String(userId), token: trimmed }
    });
};

const findCompaniesByIds = async (ids) => {
    const { Company } = requireModels();
    const uniq = [...new Set((ids || []).map(String).filter(Boolean))];
    if (!uniq.length) return [];
    const list = await Company.findAll({
        where: { id: { [Op.in]: uniq }, deletedAt: null }
    });
    return list.map((c) => companySummaryFromRow(c.get({ plain: true })));
};

const findCompanyById = async (companyId) => {
    const { Company } = requireModels();
    const c = await Company.findByPk(String(companyId));
    if (!c) return null;
    return companySummaryFromRow(c.get({ plain: true }));
};

const loadCompanyForSubscription = async (companyId) => {
    const { Company } = requireModels();
    const c = await Company.findByPk(String(companyId));
    if (!c) return null;
    return wrapCompanyForSubscription(c.get({ plain: true }), Company);
};

const verifyRegistration = async (userId) => {
    const { User } = requireModels();
    await User.update(
        { emailVerified: true, registrationEmailPending: false },
        { where: { id: String(userId) } }
    );
    return findUserById(userId);
};

const setPasswordAndVerifyEmail = async (email, hashedPassword) => {
    const { User } = requireModels();
    await User.update(
        {
            password: hashedPassword,
            emailVerified: true,
            registrationEmailPending: false
        },
        { where: { email: String(email).toLowerCase().trim() } }
    );
};

const createPlatformAdmin = async ({ name, title, email, passwordHash }) => {
    const { User } = requireModels();
    const row = await User.create({
        id: newObjectIdString(),
        name: String(name || 'Platform Admin').trim() || 'Platform Admin',
        title: String(title || 'admin').trim() || 'admin',
        email: String(email).toLowerCase().trim(),
        password: passwordHash,
        role: 'super_admin',
        emailVerified: true,
        registrationEmailPending: false,
        accountStatus: 'active'
    });
    return toLeanUser(row, { withPassword: false });
};

const registerCompany = async ({
    trimmedCompanyName,
    trimmedOwnerName,
    normalizedEmail,
    password,
    existingOwnerUser,
    setMissingPasswordPlain
}) => {
    const { User, Company, UserCompany, CompanyMember } = requireModels();
    const sql = getSequelize();

    return sql.transaction(async (t) => {
        let ownerId;

        if (existingOwnerUser) {
            ownerId = String(existingOwnerUser._id);
            if (setMissingPasswordPlain) {
                const hashedPassword = await bcrypt.hash(String(setMissingPasswordPlain), 12);
                await User.update(
                    {
                        password: hashedPassword,
                        emailVerified: true,
                        registrationEmailPending: false
                    },
                    { where: { id: ownerId }, transaction: t }
                );
            }
            const normalizedOwnerName = String(trimmedOwnerName || '').trim();
            const currentName = String(existingOwnerUser.name || '').trim();
            if (normalizedOwnerName && normalizedOwnerName !== currentName) {
                await User.update({ name: normalizedOwnerName }, { where: { id: ownerId }, transaction: t });
                await UserCompany.update(
                    { displayName: normalizedOwnerName },
                    { where: { userId: ownerId, isOwner: true }, transaction: t }
                );
            }
            await User.update({ role: 'owner' }, { where: { id: ownerId }, transaction: t });
        } else {
            const hashedPassword = await bcrypt.hash(password, 12);
            const ownerRow = await User.create(
                {
                    id: newObjectIdString(),
                    name: trimmedOwnerName,
                    title: 'Owner',
                    email: normalizedEmail,
                    password: hashedPassword,
                    role: 'owner',
                    emailVerified: false,
                    registrationEmailPending: true
                },
                { transaction: t }
            );
            ownerId = ownerRow.id;
        }

        const dupName = await Company.findOne({
            where: {
                ownerUserId: ownerId,
                name: { [Op.iLike]: trimmedCompanyName }
            },
            transaction: t
        });
        if (dupName) {
            const err = new Error('DUPLICATE_COMPANY_NAME');
            err.code = 'DUPLICATE_COMPANY_NAME';
            throw err;
        }

        const companyId = newObjectIdString();
        const companyRow = await Company.create(
            {
                id: companyId,
                name: trimmedCompanyName,
                email: normalizedEmail,
                ownerUserId: ownerId,
                subscriptionPlanId: DEFAULT_SUBSCRIPTION_PLAN_ID,
                subscriptionStatus: 'active',
                subscriptionIsTrial: false,
                subscriptionTrialEndsAt: null,
                subscriptionExpiresAt: null,
                subscriptionGraceEndsAt: null
            },
            { transaction: t }
        );

        await CompanyMember.create(
            {
                id: newObjectIdString(),
                companyId,
                userId: ownerId,
                role: 'owner',
                isOwner: true
            },
            { transaction: t }
        );

        const alreadyMember = await UserCompany.findOne({
            where: { userId: ownerId, companyId },
            transaction: t
        });
        if (!alreadyMember) {
            await UserCompany.create(
                {
                    id: newObjectIdString(),
                    userId: ownerId,
                    companyId,
                    displayName: trimmedOwnerName,
                    companyRole: 'owner',
                    isOwner: true
                },
                { transaction: t }
            );
        }

        const ownerFresh = await User.findByPk(ownerId, {
            include: userIncludeAuth(),
            transaction: t
        });
        const ownerLean = toLeanUser(ownerFresh, { withPassword: false });
        const companyPlain = companyRow.get({ plain: true });
        const companyLean = {
            _id: companyPlain.id,
            id: companyPlain.id,
            name: companyPlain.name,
            email: companyPlain.email,
            ownerUser: companyPlain.ownerUserId,
            subscription: subscriptionFromRow(companyPlain)
        };
        companyLean.toString = () => String(companyPlain.id);

        return { ownerUser: ownerLean, company: companyLean };
    });
};

/**
 * Logged-in user creates an additional owned workspace (PostgreSQL).
 */
const createAnotherOwnedCompany = async ({ userId, userEmail, companyName, displayName }) => {
    const { User, Company, UserCompany, CompanyMember } = requireModels();
    const sql = getSequelize();
    const trimmedCompanyName = String(companyName || '').trim();
    const trimmedDisplay = String(displayName || '').trim();
    if (trimmedCompanyName.length < 2) {
        const e = new Error('Company name must be at least 2 characters.');
        e.code = 'COMPANY_NAME_TOO_SHORT';
        throw e;
    }

    return sql.transaction(async (t) => {
        const ownerRow = await User.findByPk(String(userId), { transaction: t });
        if (!ownerRow) {
            const e = new Error('User not found');
            e.code = 'USER_NOT_FOUND';
            throw e;
        }
        const ownerPlain = ownerRow.get({ plain: true });
        const resolvedDisplay =
            trimmedDisplay ||
            String(ownerPlain.name || '')
                .trim()
                .slice(0, 200);

        const dupName = await Company.findOne({
            where: {
                ownerUserId: String(userId),
                name: { [Op.iLike]: trimmedCompanyName }
            },
            transaction: t
        });
        if (dupName) {
            const err = new Error('DUPLICATE_COMPANY_NAME');
            err.code = 'DUPLICATE_COMPANY_NAME';
            throw err;
        }

        const companyId = newObjectIdString();
        const emailForCompany = String(userEmail || ownerPlain.email || '')
            .toLowerCase()
            .trim();

        await Company.create(
            {
                id: companyId,
                name: trimmedCompanyName,
                email: emailForCompany,
                ownerUserId: String(userId),
                subscriptionPlanId: DEFAULT_SUBSCRIPTION_PLAN_ID,
                subscriptionStatus: 'active',
                subscriptionIsTrial: false,
                subscriptionTrialEndsAt: null,
                subscriptionExpiresAt: null,
                subscriptionGraceEndsAt: null
            },
            { transaction: t }
        );

        await CompanyMember.create(
            {
                id: newObjectIdString(),
                companyId,
                userId: String(userId),
                role: 'owner',
                isOwner: true
            },
            { transaction: t }
        );

        const alreadyMember = await UserCompany.findOne({
            where: { userId: String(userId), companyId },
            transaction: t
        });
        if (!alreadyMember) {
            await UserCompany.create(
                {
                    id: newObjectIdString(),
                    userId: String(userId),
                    companyId,
                    displayName: resolvedDisplay,
                    companyRole: 'owner',
                    isOwner: true
                },
                { transaction: t }
            );
        }

        if (ownerPlain.role !== 'super_admin') {
            await User.update({ role: 'owner' }, { where: { id: String(userId) }, transaction: t });
        }

        return { companyId, name: trimmedCompanyName };
    });
};

const updateCompanyNameIfAllowedSql = async ({ userId, companyId, newName }) => {
    const { Company, UserCompany } = requireModels();
    const trimmed = String(newName || '').trim();
    if (trimmed.length < 2) {
        const e = new Error('Company name must be at least 2 characters.');
        e.code = 'COMPANY_NAME_TOO_SHORT';
        throw e;
    }
    const uc = await UserCompany.findOne({
        where: { userId: String(userId), companyId: String(companyId) }
    });
    if (!uc) {
        const e = new Error('Not a member of this company');
        e.code = 'NOT_MEMBER';
        throw e;
    }
    const role = String(uc.companyRole || '').toLowerCase();
    const canEdit = Boolean(uc.isOwner) || role === 'owner' || role === 'admin';
    if (!canEdit) {
        const e = new Error('Only company owner or admin can rename the workspace');
        e.code = 'FORBIDDEN';
        throw e;
    }
    const company = await Company.findByPk(String(companyId));
    if (!company || company.get('deletedAt')) {
        const e = new Error('Company not found');
        e.code = 'NOT_FOUND';
        throw e;
    }
    const ownerId = String(company.ownerUserId || '');
    const dup = await Company.findOne({
        where: {
            ownerUserId: ownerId,
            name: { [Op.iLike]: trimmed },
            id: { [Op.ne]: String(companyId) }
        }
    });
    if (dup) {
        const err = new Error('DUPLICATE_COMPANY_NAME');
        err.code = 'DUPLICATE_COMPANY_NAME';
        throw err;
    }
    await Company.update({ name: trimmed }, { where: { id: String(companyId) } });
    return { companyId: String(companyId), name: trimmed };
};

const softDeleteCompanyAsOwnerSql = async ({ userId, companyId }) => {
    const { Company, UserCompany, CompanyMember } = requireModels();
    const sql = getSequelize();
    return sql.transaction(async (t) => {
        const company = await Company.findByPk(String(companyId), {
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!company) {
            const e = new Error('Company not found');
            e.code = 'NOT_FOUND';
            throw e;
        }
        const plain = company.get({ plain: true });
        if (String(plain.ownerUserId) !== String(userId)) {
            const e = new Error('Only the company owner can delete this workspace');
            e.code = 'FORBIDDEN';
            throw e;
        }
        if (plain.deletedAt) {
            return { alreadyDeleted: true };
        }
        await UserCompany.destroy({ where: { companyId: String(companyId) }, transaction: t });
        await CompanyMember.destroy({ where: { companyId: String(companyId) }, transaction: t });
        await Company.update({ deletedAt: new Date() }, { where: { id: String(companyId) }, transaction: t });
        return { ok: true };
    });
};

module.exports = {
    findUserByEmail,
    findUserById,
    updateLastLogin,
    addFcmToken,
    findCompaniesByIds,
    findCompanyById,
    loadCompanyForSubscription,
    verifyRegistration,
    setPasswordAndVerifyEmail,
    createPlatformAdmin,
    registerCompany,
    createAnotherOwnedCompany,
    updateCompanyNameIfAllowedSql,
    softDeleteCompanyAsOwnerSql,
    companySummaryFromRow,
    subscriptionFromRow,
    wrapCompanyForSubscription,
    toLeanUser,
    userIncludeAuth
};
