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
        ownerUser: row.ownerUserId
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
    const list = await Company.findAll({ where: { id: ids.map(String) } });
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
        } else {
            const hashedPassword = await bcrypt.hash(password, 12);
            const ownerRow = await User.create(
                {
                    id: newObjectIdString(),
                    name: trimmedOwnerName,
                    title: 'Owner',
                    email: normalizedEmail,
                    password: hashedPassword,
                    role: 'user',
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
    companySummaryFromRow,
    subscriptionFromRow,
    wrapCompanyForSubscription,
    toLeanUser,
    userIncludeAuth
};
