const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { Types } = require('mongoose');
const { User, Company, Project, ProjectPersonalNote } = require('../models');
const { authenticateToken, signAccessToken } = require('../middleware/auth');
const { sendUserInviteEmail } = require('../services/emailService');
const { canAddMembers, getCompanyPlan } = require('../services/subscriptionService');
const { isPostgresEnabled } = require('../db/postgres');
const { isPostgresPrimary } = require('../services/sql/runtime');
const authSql = require('../services/sql/authSql');
const { loadCompanyWithMembers } = require('../services/sql/companySql');
const userCompanySql = require('../services/sql/userCompanySql');

const router = express.Router();
const membershipCompanyId = (entry) => {
    if (!entry) return null;
    const raw = entry.companyId ?? entry.company;
    if (!raw) return null;
    if (typeof raw === 'object' && raw._id) return String(raw._id);
    return String(raw);
};

const companyRowId = (company) => {
    if (!company) return '';
    if (company._id != null) return String(company._id);
    if (company.id != null) return String(company.id);
    return '';
};

const mapCompaniesWithMembership = async (memberships = []) => {
    const companyIds = memberships
        .map((entry) => membershipCompanyId(entry))
        .filter(Boolean);

    const companies = companyIds.length
        ? isPostgresPrimary()
            ? await authSql.findCompaniesByIds(companyIds)
            : await Company.find({ _id: { $in: companyIds }, deletedAt: null }).select('name email ownerUser deletedAt')
        : [];

    return memberships.map((entry) => {
        const entryCompanyId = membershipCompanyId(entry);
        const matchedCompany = companies.find(
            (company) => entryCompanyId && companyRowId(company) === String(entryCompanyId)
        );
        return {
            companyId: entryCompanyId,
            displayName: typeof entry?.displayName === 'string' ? entry.displayName.trim() : '',
            companyRole: entry.companyRole,
            isOwner: entry.isOwner,
            company: matchedCompany || null
        };
    });
};
const createInviteToken = () => crypto.randomBytes(32).toString('hex');

/** Normalize invite tokens so hashing matches after email clients / browsers alter the URL (case, ZWSP, etc.). */
const normalizeInviteToken = (token) =>
    String(token)
        .trim()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .toLowerCase();

const hashInviteToken = (token) =>
    crypto.createHash('sha256').update(normalizeInviteToken(token)).digest('hex');
/** Invited / updated membership roles (includes co-owner). */
const ASSIGNABLE_COMPANY_ROLES = ['owner', 'admin', 'manager', 'user'];
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/;
const MIN_TITLE_LENGTH = 2;
const hasAtLeastTwoWords = (value) =>
    String(value || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length >= 2;
const canManageActiveCompanyUsers = (req) => {
    const m = req.companyMembership;
    return Boolean(m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole)));
};
const resolveMembershipDisplayName = (userDoc, companyId, fallbackCompanyName = null) => {
    const membership = (userDoc?.companies || []).find(
        (entry) => membershipCompanyId(entry) === String(companyId)
    );
    const alias = typeof membership?.displayName === 'string' ? membership.displayName.trim() : '';
    if (alias) return alias;
    const isOwner = Boolean(membership?.isOwner) || membership?.companyRole === 'owner';
    if (isOwner && fallbackCompanyName) return fallbackCompanyName;
    return userDoc?.name || userDoc?.email || '';
};

// 3. Add user to company — active company from JWT; owner / company admin / manager may invite
router.post('/add-account', authenticateToken, async (req, res) => {
    try {
        const { name, title, email, role: roleBody } = req.body;

        if (!req.companyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company, register a company, or call POST /api/auth/switch-company.'
            });
        }

        const companyId = req.companyId.toString();

        if (!name || !title || !email) {
            return res.status(400).json({ message: 'name, title and email are required' });
        }
        if (!hasAtLeastTwoWords(name)) {
            return res.status(400).json({ message: 'Name must contain at least two words' });
        }
        if (String(title).trim().length < MIN_TITLE_LENGTH) {
            return res.status(400).json({ message: 'Title must be at least 2 characters' });
        }

        const m = req.companyMembership;
        const invokerIsCompanyOwner =
            Boolean(m?.isOwner) || String(m?.companyRole || '').toLowerCase() === 'owner';
        const canInvite =
            m &&
            (Boolean(m.isOwner) || ['admin', 'manager'].includes(m.companyRole));
        if (!canInvite) {
            return res.status(403).json({
                message: 'Only company owner, admin or manager can add users to this company'
            });
        }

        const normalizedEmail = email.toLowerCase().trim();
        let companyRole = invokerIsCompanyOwner ? 'owner' : 'user';
        if (roleBody != null && String(roleBody).trim() !== '') {
            const r = String(roleBody).trim().toLowerCase();
            if (!ASSIGNABLE_COMPANY_ROLES.includes(r)) {
                return res.status(400).json({ message: 'Invalid role' });
            }
            if (r === 'owner' && !invokerIsCompanyOwner) {
                return res.status(403).json({ message: 'Only a company owner can assign the owner role' });
            }
            companyRole = r;
        }
        const inviteToken = createInviteToken();
        const inviteTokenHash = hashInviteToken(inviteToken);
        const inviteExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
        const inviterName = req.user?.name || 'Team admin';

        let targetUser;
        let company;

        if (isPostgresPrimary()) {
            company = await loadCompanyWithMembers(companyId);
            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }
            const currentMembersCount = Array.isArray(company.members) ? company.members.length : 0;
            if (!canAddMembers(company, currentMembersCount, 1)) {
                const activePlan = getCompanyPlan(company);
                return res.status(403).json({
                    message: `Current ${activePlan.name} plan allows up to ${activePlan.limits.maxMembers} accounts.`,
                    limit: activePlan.limits.maxMembers,
                    planId: activePlan.id
                });
            }
            try {
                const result = await userCompanySql.addAccountSql({
                    companyId,
                    inviterUserId: req.user._id,
                    name,
                    title,
                    email: normalizedEmail,
                    companyRole,
                    inviteToken,
                    inviteTokenHash,
                    inviteExpiresAt,
                    inviterName
                });
                targetUser = result.targetUser;
                company = result.company;
                req._pgAddAccountShouldSendInvite = result.shouldSendInvite;
            } catch (e) {
                if (e.code === 'already_member') {
                    return res.status(400).json({ message: 'User is already a member of this company' });
                }
                throw e;
            }
        } else {
            company = await Company.findById(companyId);
            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }

            const currentMembersCount = Array.isArray(company.members) ? company.members.length : 0;
            if (!canAddMembers(company, currentMembersCount, 1)) {
                const activePlan = getCompanyPlan(company);
                return res.status(403).json({
                    message: `Current ${activePlan.name} plan allows up to ${activePlan.limits.maxMembers} accounts.`,
                    limit: activePlan.limits.maxMembers,
                    planId: activePlan.id
                });
            }

            const membershipIsOwner = String(companyRole).toLowerCase() === 'owner';

            targetUser = await User.findOne({ email: normalizedEmail });
            if (!targetUser) {
                targetUser = await User.create({
                    name,
                    title,
                    email: normalizedEmail,
                    role: companyRole,
                    emailVerified: true,
                    registrationEmailPending: false,
                    companies: [{
                        company: companyId,
                        displayName: String(name).trim(),
                        companyRole,
                        isOwner: membershipIsOwner
                    }],
                    invite: {
                        tokenHash: inviteTokenHash,
                        expiresAt: inviteExpiresAt,
                        invitedBy: req.user._id,
                        company: companyId
                    }
                });
            } else {
                const alreadyInCompany = (targetUser.companies || []).some(
                    (entry) => membershipCompanyId(entry) === companyId
                );
                if (alreadyInCompany) {
                    return res.status(400).json({ message: 'User is already a member of this company' });
                }

                targetUser.companies.push({
                    company: companyId,
                    displayName: String(name).trim(),
                    companyRole,
                    isOwner: membershipIsOwner
                });
                if (!targetUser.password) {
                    targetUser.invite = {
                        tokenHash: inviteTokenHash,
                        expiresAt: inviteExpiresAt,
                        invitedBy: req.user._id,
                        company: companyId,
                        acceptedAt: null
                    };
                }
                await targetUser.save();
            }

            const userExistsInCompany = (company.members || []).some(
                (member) => member.user.toString() === targetUser._id.toString()
            );
            if (!userExistsInCompany) {
                company.members.push({
                    user: targetUser._id,
                    role: companyRole,
                    isOwner: membershipIsOwner
                });
                await company.save();
            }
        }

        const shouldSendInvite = isPostgresPrimary()
            ? Boolean(req._pgAddAccountShouldSendInvite)
            : !targetUser.password || (targetUser.invite && targetUser.invite.tokenHash === inviteTokenHash);
        let inviteLink = null;
        if (shouldSendInvite) {
            const frontendBaseUrl = ('https://tik.absai.dev').replace(/\/+$/, '');
            inviteLink = `${frontendBaseUrl}/accept-invite?token=${encodeURIComponent(inviteToken)}`;
            try {
                await sendUserInviteEmail({
                    email: normalizedEmail,
                    invitedByName: inviterName,
                    companyName: company.name,
                    inviteUrl: inviteLink,
                    expiresInHours: 24
                });
            } catch (emailErr) {
                console.error('Failed to send invite email:', emailErr.message);
            }
        }

        res.status(201).json({
            message: shouldSendInvite
                ? 'User invited successfully. Invitation email sent.'
                : 'User added to company successfully',
            inviteSent: Boolean(shouldSendInvite),
            user: {
                id: targetUser._id,
                name: targetUser.name,
                title: targetUser.title,
                email: targetUser.email,
                role: targetUser.role
            },
            ...(inviteLink ? { inviteLink } : {})
        });
    } catch (error) {
        console.error('Add account error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 4. Remove user from active company (owner/admin/manager only)
router.delete('/delete-account/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!req.companyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company, register a company, or call POST /api/auth/switch-company.'
            });
        }
        if (!canManageActiveCompanyUsers(req)) {
            return res.status(403).json({
                message: 'Only company owner, admin or manager can remove users from this company'
            });
        }

        const companyId = req.companyId.toString();

        if (req.user._id.toString() === userId) {
            return res.status(400).json({ message: 'Cannot remove your own account from this company' });
        }

        const invokerIsCompanyOwner =
            Boolean(req.companyMembership?.isOwner) ||
            String(req.companyMembership?.companyRole || '').toLowerCase() === 'owner';

        if (isPostgresPrimary()) {
            const company = await loadCompanyWithMembers(companyId);
            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }
            const user = await authSql.findUserById(userId);
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            const userMembership = (user.companies || []).find(
                (entry) => membershipCompanyId(entry) === companyId
            );
            if (!userMembership) {
                return res.status(400).json({ message: 'User is not a member of the active company' });
            }
            const targetIsOwner =
                Boolean(userMembership.isOwner) || String(userMembership.companyRole || '').toLowerCase() === 'owner';
            if (targetIsOwner && !invokerIsCompanyOwner) {
                return res.status(400).json({ message: 'Company owner cannot be removed' });
            }
            await userCompanySql.deleteAccountSql({ companyId, userId });
            return res.json({ message: 'User removed from company successfully' });
        }

        const company = await Company.findById(companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const userMembership = (user.companies || []).find(
            (entry) => membershipCompanyId(entry) === companyId
        );
        if (!userMembership) {
            return res.status(400).json({ message: 'User is not a member of the active company' });
        }
        const targetIsOwnerMongo =
            Boolean(userMembership.isOwner) || String(userMembership.companyRole || '').toLowerCase() === 'owner';
        if (targetIsOwnerMongo && !invokerIsCompanyOwner) {
            return res.status(400).json({ message: 'Company owner cannot be removed' });
        }

        const companyOid = Types.ObjectId.isValid(companyId) ? new Types.ObjectId(companyId) : companyId;
        const userOid = Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : userId;
        await Project.updateMany({ company: companyOid }, { $pull: { assigned_users: userOid } });
        const projectsInCompany = await Project.find({ company: companyOid }).select('_id').lean();
        const projectObjectIds = projectsInCompany.map((p) => p._id).filter(Boolean);
        if (projectObjectIds.length) {
            await ProjectPersonalNote.deleteMany({ user: userOid, project: { $in: projectObjectIds } });
        }

        user.companies = (user.companies || []).filter(
            (entry) => membershipCompanyId(entry) !== companyId
        );
        await user.save();

        company.members = (company.members || []).filter(
            (member) => member.user.toString() !== userId
        );
        await company.save();

        res.json({ message: 'User removed from company successfully' });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update user (Admin/Manager can update any user, users can update themselves)
router.put('/update-user/:userId', authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const { name, title, email, role } = req.body;

        // Check if user has permission to update
        const isOwnAccount = req.user._id.toString() === userId;
        const canManageCompanyUser = canManageActiveCompanyUsers(req);

        if (!canManageCompanyUser && !isOwnAccount) {
            return res.status(403).json({ message: 'You can only update your own account' });
        }

        const user = isPostgresPrimary()
            ? await authSql.findUserById(userId)
            : await User.findById(userId).lean();
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        const targetMembership = activeCompanyId
            ? (user.companies || []).find((entry) => membershipCompanyId(entry) === activeCompanyId)
            : null;

        // Editing another user must be inside the active company context
        if (!isOwnAccount) {
            if (!activeCompanyId) {
                return res.status(400).json({
                    message: 'Active company required. Log in with a company or switch company first.'
                });
            }
            if (!targetMembership) {
                return res.status(403).json({ message: 'You can only update users in your active company' });
            }
        }

        // Build update object
        const updateData = {};
        if (name != null) {
            if (!hasAtLeastTwoWords(name)) {
                return res.status(400).json({ message: 'Name must contain at least two words' });
            }
            updateData.name = String(name).trim();
        }
        if (title != null) {
            if (String(title).trim().length < MIN_TITLE_LENGTH) {
                return res.status(400).json({ message: 'Title must be at least 2 characters' });
            }
            updateData.title = String(title).trim();
        }
        if (email) {
            const normalized = email.toLowerCase();
            if (isPostgresPrimary()) {
                const m = require('../db/postgres').getSequelizeModels();
                const existingUser = await m.User.findOne({
                    where: {
                        email: normalized,
                        id: { [Op.ne]: String(userId) }
                    }
                });
                if (existingUser) {
                    return res.status(400).json({ message: 'Email already in use by another account' });
                }
            } else {
                const existingUser = await User.findOne({ email: normalized, _id: { $ne: userId } });
                if (existingUser) {
                    return res.status(400).json({ message: 'Email already in use by another account' });
                }
            }
            updateData.email = normalized;
        }

        let roleToApply = null;
        if (role !== undefined && role !== null && String(role).trim() !== '') {
            if (!canManageCompanyUser) {
                return res.status(403).json({
                    message: 'Only company owner, admin or manager can change user roles'
                });
            }
            if (isOwnAccount) {
                return res.status(403).json({ message: 'You cannot change your own role' });
            }
            const r = String(role).trim().toLowerCase();
            if (!ASSIGNABLE_COMPANY_ROLES.includes(r)) {
                return res.status(400).json({ message: 'Invalid role' });
            }
            const invokerIsCompanyOwner =
                Boolean(req.companyMembership?.isOwner) ||
                String(req.companyMembership?.companyRole || '').toLowerCase() === 'owner';
            if (r === 'owner' && !invokerIsCompanyOwner) {
                return res.status(403).json({ message: 'Only a company owner can assign the owner role' });
            }
            roleToApply = r;
        }

        if (isPostgresPrimary()) {
            await userCompanySql.updateUserSql({
                userId,
                activeCompanyId,
                updateData,
                role: roleToApply,
                canManageCompanyUser,
                displayName: updateData.name || null
            });
            const updatedUser = await authSql.findUserById(userId);
            return res.json({
                message: 'User updated successfully',
                user: updatedUser
            });
        }

        const userDoc = await User.findById(userId);
        if (Object.keys(updateData).length) {
            Object.assign(userDoc, updateData);
        }
        if (updateData.name && activeCompanyId) {
            const membershipIndex = (userDoc.companies || []).findIndex(
                (entry) => membershipCompanyId(entry) === activeCompanyId
            );
            if (membershipIndex !== -1) {
                userDoc.companies[membershipIndex].displayName = updateData.name;
            }
        }
        if (roleToApply && activeCompanyId) {
            const membershipIndex = (userDoc.companies || []).findIndex(
                (entry) => membershipCompanyId(entry) === activeCompanyId
            );
            if (membershipIndex !== -1) {
                userDoc.companies[membershipIndex].companyRole = roleToApply;
                userDoc.companies[membershipIndex].isOwner = roleToApply === 'owner';
            }
            userDoc.role = roleToApply;
        }
        await userDoc.save();

        if (roleToApply && activeCompanyId) {
            await Company.updateOne(
                { _id: activeCompanyId, 'members.user': userDoc._id },
                { $set: { 'members.$.role': roleToApply, 'members.$.isOwner': roleToApply === 'owner' } }
            );
        }

        const updatedUser = await User.findById(userId).select('-password');

        res.json({
            message: 'User updated successfully',
            user: updatedUser
        });
    } catch (error) {
        console.error('Update user error:', error?.parent || error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 6. Change password (Any user)
router.put('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current password and new password are required' });
        }
        if (!STRONG_PASSWORD_REGEX.test(String(newPassword))) {
            return res.status(400).json({
                message: 'New password must be at least 8 characters and include uppercase, lowercase, and a special character'
            });
        }

        let user = null;
        let storedInPostgres = false;

        if (isPostgresEnabled()) {
            try {
                user = await authSql.findUserById(req.user._id, { withPassword: true });
                if (user) storedInPostgres = true;
            } catch (e) {
                console.error('Change password: Postgres load error:', e.message);
            }
        }

        if (!user) {
            user = await User.findById(req.user._id);
        }

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const pw = user.password;
        if (!pw || typeof pw !== 'string') {
            return res.status(400).json({
                message:
                    'No password is set on this account yet. Accept your invite or use forgot password.'
            });
        }

        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, pw);
        if (!isCurrentPasswordValid) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }
        const isSameAsCurrent = await bcrypt.compare(newPassword, pw);
        if (isSameAsCurrent) {
            return res.status(400).json({
                message: 'New password must be different from current password'
            });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 12);

        if (storedInPostgres) {
            const m = require('../db/postgres').getSequelizeModels();
            if (!m?.User) {
                return res.status(500).json({ message: 'Internal server error' });
            }
            await m.User.update({ password: hashedNewPassword }, { where: { id: String(req.user._id) } });
        } else {
            await User.findByIdAndUpdate(req.user._id, { password: hashedNewPassword });
        }

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Register or update FCM device token for the logged-in user
router.post('/register-fcm-token', authenticateToken, async (req, res) => {
    try {
        const { token } = req.body;

        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ message: 'Valid FCM token is required' });
        }

        const normalizedToken = token.trim();

        let user;
        if (isPostgresPrimary()) {
            user = await userCompanySql.registerFcmTokenSql(req.user._id, normalizedToken);
        } else {
            user = await User.findByIdAndUpdate(
                req.user._id,
                { $addToSet: { fcmTokens: normalizedToken } },
                { new: true }
            ).select('-password');
        }

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            message: 'FCM token registered successfully',
            user
        });
    } catch (error) {
        console.error('Register FCM token error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Remove an FCM device token for the logged-in user (e.g., on logout)
router.post('/unregister-fcm-token', authenticateToken, async (req, res) => {
    try {
        const { token } = req.body;

        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ message: 'Valid FCM token is required' });
        }

        const normalizedToken = token.trim();

        let user;
        if (isPostgresPrimary()) {
            user = await userCompanySql.unregisterFcmTokenSql(req.user._id, normalizedToken);
        } else {
            user = await User.findByIdAndUpdate(
                req.user._id,
                { $pull: { fcmTokens: normalizedToken } },
                { new: true }
            ).select('-password');
        }

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            message: 'FCM token unregistered successfully',
            user
        });
    } catch (error) {
        console.error('Unregister FCM token error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Accept invite and set password
router.post('/accept-invite', async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({ message: 'token and password are required' });
        }
        if (!STRONG_PASSWORD_REGEX.test(String(password))) {
            return res.status(400).json({
                message: 'Password must be at least 8 characters and include uppercase, lowercase, and a special character'
            });
        }

        const tokenHash = hashInviteToken(token);

        // Invites from add-account live in PostgreSQL when POSTGRES_ENABLED. Some deployments
        // mistakenly set POSTGRES_PRIMARY=false while still storing users in PG — try PG whenever
        // it is enabled, then fall back to Mongo only if PG is not the configured primary store.
        if (isPostgresEnabled()) {
            try {
                const r = await userCompanySql.acceptInviteSql(token, password, hashInviteToken);
                if (r.ok) {
                    return res.json({ message: 'Invitation accepted successfully. You can now login.' });
                }
                if (r.error === 'expired') {
                    return res.status(400).json({ message: 'Invitation token expired' });
                }
                if (isPostgresPrimary()) {
                    return res.status(400).json({ message: 'Invalid invitation token' });
                }
            } catch (pgErr) {
                console.error('Accept invite PostgreSQL error:', pgErr);
                if (isPostgresPrimary()) {
                    return res.status(500).json({ message: 'Internal server error' });
                }
            }
        }

        const user = await User.findOne({
            'invite.tokenHash': tokenHash
        });
        if (!user) {
            return res.status(400).json({ message: 'Invalid invitation token' });
        }
        if (!user.invite?.expiresAt || new Date(user.invite.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({ message: 'Invitation token expired' });
        }

        user.password = await bcrypt.hash(password, 12);
        user.emailVerified = true;
        user.registrationEmailPending = false;
        user.invite = {
            tokenHash: null,
            expiresAt: null,
            invitedBy: user.invite?.invitedBy || null,
            company: user.invite?.company || null,
            acceptedAt: new Date()
        };
        await user.save();

        res.json({ message: 'Invitation accepted successfully. You can now login.' });
    } catch (error) {
        console.error('Accept invite error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get users for the active company only
router.get('/all-users', authenticateToken, async (req, res) => {
    try {
        if (!req.companyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company, register a company, or call POST /api/auth/switch-company.'
            });
        }

        const m = req.companyMembership;
        const canList =
            req.user.role === 'super_admin' ||
            req.user.role === 'manager' ||
            (m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole)));

        if (!canList) {
            return res.status(403).json({ message: 'Insufficient permissions to list users for this company' });
        }

        let users;
        if (isPostgresPrimary()) {
            const company = await loadCompanyWithMembers(req.companyId);
            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }
            const raw = await userCompanySql.listCompanyUsersSql(req.companyId);
            users = raw.map((u) => ({
                ...u,
                name: resolveMembershipDisplayName(u, req.companyId, company.name)
            }));
        } else {
            const company = await Company.findById(req.companyId).populate({
                path: 'members.user',
                select: '-password'
            });

            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }

            users = (company.members || [])
                .map((mem) => {
                    if (!mem.user) return null;
                    const u = mem.user.toObject ? mem.user.toObject() : { ...mem.user };
                    return {
                        ...u,
                        name: resolveMembershipDisplayName(mem.user, req.companyId, company.name),
                        companyMemberRole: mem.role,
                        companyIsOwner: mem.isOwner
                    };
                })
                .filter(Boolean);
        }

        res.json({
            companyId: req.companyId,
            users
        });
    } catch (error) {
        console.error('Get all users error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const user = isPostgresPrimary()
            ? await authSql.findUserById(req.user._id)
            : await User.findById(req.user._id).select('-password').lean();
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const companiesWithMembership = await mapCompaniesWithMembership(user.companies || []);
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        const activeMembership = activeCompanyId
            ? companiesWithMembership.find((entry) => entry.companyId === activeCompanyId)
            : null;
        const activeMembershipDisplayName = typeof activeMembership?.displayName === 'string'
            ? activeMembership.displayName.trim()
            : '';
        const activeMembershipIsOwner =
            Boolean(activeMembership?.isOwner) || activeMembership?.companyRole === 'owner';
        const resolvedName = activeMembershipDisplayName
            || ((activeMembershipIsOwner && activeMembership?.company?.name)
                ? activeMembership.company.name
                : user.name);

        const uid = user._id || user.id;
        res.json({
            activeCompanyId: activeCompanyId || null,
            companyName: activeMembership?.company?.name || null,
            userName: resolvedName,
            user: {
                id: uid,
                name: resolvedName,
                title: user.title,
                email: user.email,
                role: user.role,
                companies: companiesWithMembership
            }
        });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update own profile (Any user)
router.put('/update-profile', authenticateToken, async (req, res) => {
    try {
        const { name, title, email } = req.body;

        const user = isPostgresPrimary()
            ? await authSql.findUserById(req.user._id)
            : await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Build update object
        const updateData = {};
        if (name != null) {
            if (!hasAtLeastTwoWords(name)) {
                return res.status(400).json({ message: 'Name must contain at least two words' });
            }
            updateData.name = String(name).trim();
        }
        if (title != null) {
            if (String(title).trim().length < MIN_TITLE_LENGTH) {
                return res.status(400).json({ message: 'Title must be at least 2 characters' });
            }
            updateData.title = String(title).trim();
        }
        if (email) {
            const normalized = email.toLowerCase();
            if (isPostgresPrimary()) {
                const m = require('../db/postgres').getSequelizeModels();
                const existingUser = await m.User.findOne({
                    where: { email: normalized, id: { [Op.ne]: String(req.user._id) } }
                });
                if (existingUser) {
                    return res.status(400).json({ message: 'Email already in use by another account' });
                }
            } else {
                const existingUser = await User.findOne({
                    email: normalized,
                    _id: { $ne: req.user._id }
                });
                if (existingUser) {
                    return res.status(400).json({ message: 'Email already in use by another account' });
                }
            }
            updateData.email = normalized;
        }

        let updatedUser;
        if (isPostgresPrimary()) {
            if (Object.keys(updateData).length) {
                const m = require('../db/postgres').getSequelizeModels();
                await m.User.update(updateData, { where: { id: String(req.user._id) } });
            }
            updatedUser = await authSql.findUserById(req.user._id);
        } else {
            updatedUser = await User.findByIdAndUpdate(
                req.user._id,
                updateData,
                { new: true }
            ).select('-password');
        }

        res.json({
            message: 'Profile updated successfully',
            user: updatedUser
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/workspaces', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const userEmail = req.user.email;
        const trimmed = String(req.body?.companyName || '').trim();
        if (trimmed.length < 2) {
            return res.status(400).json({ message: 'Company name must be at least 2 characters.' });
        }
        const switchToNew = req.body?.switchToNew !== false && req.body?.switchToNew !== 'false';

        if (isPostgresPrimary()) {
            try {
                const { companyId } = await authSql.createAnotherOwnedCompany({
                    userId,
                    userEmail,
                    companyName: trimmed,
                    displayName: req.user.name
                });
                const nextCompanyId = switchToNew ? String(companyId) : req.companyId
                    ? String(req.companyId)
                    : String(companyId);
                const token = signAccessToken({
                    userId,
                    email: userEmail,
                    role: req.user.role,
                    companyId: nextCompanyId
                });
                const freshUser = await authSql.findUserById(userId);
                const companiesWithMembership = await mapCompaniesWithMembership(freshUser.companies || []);
                const activeCompany = await authSql.loadCompanyForSubscription(nextCompanyId);
                const activeMembership = companiesWithMembership.find(
                    (e) => membershipCompanyId(e) === nextCompanyId
                );
                const activeMembershipDisplayName =
                    typeof activeMembership?.displayName === 'string'
                        ? activeMembership.displayName.trim()
                        : '';
                const activeMembershipIsOwner =
                    Boolean(activeMembership?.isOwner) || activeMembership?.companyRole === 'owner';
                const resolvedName =
                    activeMembershipDisplayName ||
                    (activeMembershipIsOwner && activeCompany?.name ? activeCompany.name : freshUser.name);

                return res.status(201).json({
                    message: 'Workspace created',
                    token,
                    activeCompanyId: nextCompanyId,
                    companyName: activeCompany?.name || null,
                    userName: resolvedName,
                    user: {
                        id: freshUser._id,
                        name: resolvedName,
                        title: freshUser.title,
                        email: freshUser.email,
                        role: freshUser.role,
                        companies: companiesWithMembership
                    }
                });
            } catch (e) {
                if (e.code === 'DUPLICATE_COMPANY_NAME') {
                    return res.status(409).json({
                        message: 'You already have a company with this name. Please choose a different company name.'
                    });
                }
                throw e;
            }
        }

        const ownerUser = await User.findById(userId);
        if (!ownerUser) {
            return res.status(404).json({ message: 'User not found' });
        }
        const dup = await Company.findOne({
            ownerUser: ownerUser._id,
            name: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
            deletedAt: null
        }).select('_id');
        if (dup) {
            return res.status(409).json({
                message: 'You already have a company with this name. Please choose a different company name.'
            });
        }
        const company = await Company.create({
            name: trimmed,
            email: String(userEmail).toLowerCase().trim(),
            ownerUser: ownerUser._id,
            subscription: {
                planId: 'free',
                status: 'active',
                isTrial: false,
                trialEndsAt: null,
                expiresAt: null,
                graceEndsAt: null
            },
            members: [
                {
                    user: ownerUser._id,
                    role: 'owner',
                    isOwner: true
                }
            ]
        });
        if (!Array.isArray(ownerUser.companies)) {
            ownerUser.companies = [];
        }
        const already = ownerUser.companies.some(
            (entry) => membershipCompanyId(entry) === company._id.toString()
        );
        if (!already) {
            ownerUser.companies.push({
                company: company._id,
                displayName: ownerUser.name,
                companyRole: 'owner',
                isOwner: true
            });
        }
        if (ownerUser.role !== 'super_admin') {
            ownerUser.role = 'owner';
        }
        await ownerUser.save();

        const nextCompanyId = switchToNew ? String(company._id) : req.companyId
            ? String(req.companyId)
            : String(company._id);
        const token = signAccessToken({
            userId,
            email: userEmail,
            role: ownerUser.role,
            companyId: nextCompanyId
        });
        const freshUser = await User.findById(userId).select('-password').lean();
        const companiesWithMembership = await mapCompaniesWithMembership(freshUser.companies || []);
        const activeCompany = await Company.findById(nextCompanyId).select('name');
        const activeMembership = companiesWithMembership.find(
            (e) => membershipCompanyId(e) === nextCompanyId
        );
        const activeMembershipDisplayName =
            typeof activeMembership?.displayName === 'string' ? activeMembership.displayName.trim() : '';
        const activeMembershipIsOwner =
            Boolean(activeMembership?.isOwner) || activeMembership?.companyRole === 'owner';
        const resolvedName =
            activeMembershipDisplayName ||
            (activeMembershipIsOwner && activeCompany?.name ? activeCompany.name : freshUser.name);

        return res.status(201).json({
            message: 'Workspace created',
            token,
            activeCompanyId: nextCompanyId,
            companyName: activeCompany?.name || null,
            userName: resolvedName,
            user: {
                id: freshUser._id,
                name: resolvedName,
                title: freshUser.title,
                email: freshUser.email,
                role: freshUser.role,
                companies: companiesWithMembership
            }
        });
    } catch (error) {
        console.error('Create workspace error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.patch('/workspaces/:companyId', authenticateToken, async (req, res) => {
    try {
        const companyId = String(req.params.companyId || '').trim();
        if (!companyId) {
            return res.status(400).json({ message: 'companyId is required' });
        }
        const newName = String(req.body?.name ?? req.body?.companyName ?? '').trim();
        if (newName.length < 2) {
            return res.status(400).json({ message: 'Company name must be at least 2 characters.' });
        }

        if (isPostgresPrimary()) {
            try {
                await authSql.updateCompanyNameIfAllowedSql({
                    userId: req.user._id,
                    companyId,
                    newName
                });
            } catch (e) {
                if (e.code === 'FORBIDDEN') {
                    return res.status(403).json({ message: e.message });
                }
                if (e.code === 'NOT_MEMBER' || e.code === 'NOT_FOUND') {
                    return res.status(404).json({ message: e.message });
                }
                if (e.code === 'DUPLICATE_COMPANY_NAME') {
                    return res.status(409).json({
                        message: 'You already have a company with this name. Please choose a different company name.'
                    });
                }
                throw e;
            }
        } else {
            const m = (req.user.companies || []).find((e) => membershipCompanyId(e) === companyId);
            if (!m) {
                return res.status(404).json({ message: 'Not a member of this company' });
            }
            const role = String(m.companyRole || '').toLowerCase();
            const canEdit = Boolean(m.isOwner) || role === 'owner' || role === 'admin';
            if (!canEdit) {
                return res.status(403).json({
                    message: 'Only company owner or admin can rename the workspace'
                });
            }
            const company = await Company.findById(companyId);
            if (!company || company.deletedAt) {
                return res.status(404).json({ message: 'Company not found' });
            }
            const dup = await Company.findOne({
                ownerUser: company.ownerUser,
                name: new RegExp(`^${newName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
                _id: { $ne: company._id },
                deletedAt: null
            });
            if (dup) {
                return res.status(409).json({
                    message: 'You already have a company with this name. Please choose a different company name.'
                });
            }
            company.name = newName;
            await company.save();
        }

        const freshUser = isPostgresPrimary()
            ? await authSql.findUserById(req.user._id)
            : await User.findById(req.user._id).select('-password').lean();
        const companiesWithMembership = await mapCompaniesWithMembership(freshUser.companies || []);

        return res.json({
            message: 'Workspace updated',
            companies: companiesWithMembership
        });
    } catch (error) {
        console.error('Rename workspace error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/workspaces/:companyId', authenticateToken, async (req, res) => {
    try {
        const companyId = String(req.params.companyId || '').trim();
        if (!companyId) {
            return res.status(400).json({ message: 'companyId is required' });
        }
        if (req.companyId && String(req.companyId) === companyId) {
            return res.status(400).json({
                message: 'Switch to another workspace before deleting this one.'
            });
        }

        const remaining = (req.user.companies || []).filter((e) => membershipCompanyId(e) !== companyId);
        if (remaining.length === 0) {
            return res.status(400).json({ message: 'You cannot delete your only workspace.' });
        }

        if (isPostgresPrimary()) {
            try {
                await authSql.softDeleteCompanyAsOwnerSql({ userId: req.user._id, companyId });
            } catch (e) {
                if (e.code === 'FORBIDDEN') {
                    return res.status(403).json({ message: e.message });
                }
                if (e.code === 'NOT_FOUND') {
                    return res.status(404).json({ message: e.message });
                }
                throw e;
            }
        } else {
            const company = await Company.findById(companyId);
            if (!company) {
                return res.status(404).json({ message: 'Company not found' });
            }
            if (String(company.ownerUser) !== String(req.user._id)) {
                return res.status(403).json({ message: 'Only the company owner can delete this workspace' });
            }
            company.deletedAt = new Date();
            await company.save();
            await User.updateMany(
                { 'companies.company': company._id },
                { $pull: { companies: { company: company._id } } }
            );
        }

        const freshUser = isPostgresPrimary()
            ? await authSql.findUserById(req.user._id)
            : await User.findById(req.user._id).select('-password').lean();
        const companiesWithMembership = await mapCompaniesWithMembership(freshUser.companies || []);

        return res.json({
            message: 'Workspace deleted',
            companies: companiesWithMembership
        });
    } catch (error) {
        console.error('Delete workspace error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
