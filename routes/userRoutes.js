const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User, Company } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { sendUserInviteEmail } = require('../services/emailService');
const { canAddMembers, getCompanyPlan } = require('../services/subscriptionService');

const router = express.Router();
const membershipCompanyId = (entry) => {
    if (!entry) return null;
    const raw = entry.companyId ?? entry.company;
    if (!raw) return null;
    if (typeof raw === 'object' && raw._id) return String(raw._id);
    return String(raw);
};
const mapCompaniesWithMembership = async (memberships = []) => {
    const companyIds = memberships
        .map((entry) => membershipCompanyId(entry))
        .filter(Boolean);

    const companies = companyIds.length
        ? await Company.find({ _id: { $in: companyIds } }).select('name email ownerUser')
        : [];

    return memberships.map((entry) => {
        const entryCompanyId = membershipCompanyId(entry);
        const matchedCompany = companies.find(
            (company) => entryCompanyId && company._id.toString() === entryCompanyId
        );
        return {
            companyId: entryCompanyId,
            companyRole: entry.companyRole,
            isOwner: entry.isOwner,
            company: matchedCompany || null
        };
    });
};
const createInviteToken = () => crypto.randomBytes(32).toString('hex');
const hashInviteToken = (token) =>
    crypto.createHash('sha256').update(String(token)).digest('hex');
const COMPANY_ROLES = ['owner', 'admin', 'manager', 'developer', 'tester', 'user'];
const canManageActiveCompanyUsers = (req) => {
    const m = req.companyMembership;
    return Boolean(m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole)));
};

// 3. Add user to company — active company from JWT; owner / company admin / manager may invite
router.post('/add-account', authenticateToken, async (req, res) => {
    try {
        const { name, title, email, role } = req.body;

        if (!req.companyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company, register a company, or call POST /api/auth/switch-company.'
            });
        }

        const companyId = req.companyId.toString();

        if (!name || !title || !email) {
            return res.status(400).json({ message: 'name, title and email are required' });
        }

        const m = req.companyMembership;
        const canInvite =
            m &&
            (Boolean(m.isOwner) || ['admin', 'manager'].includes(m.companyRole));
        if (!canInvite) {
            return res.status(403).json({
                message: 'Only company owner, admin or manager can add users to this company'
            });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const company = await Company.findById(companyId);
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

        let targetUser = await User.findOne({ email: normalizedEmail });
        const companyRole = role || 'user';
        if (!COMPANY_ROLES.includes(companyRole)) {
            return res.status(400).json({ message: `Invalid role. Allowed roles: ${COMPANY_ROLES.join(', ')}` });
        }
        const inviteToken = createInviteToken();
        const inviteTokenHash = hashInviteToken(inviteToken);
        const inviteExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
        const inviterName = req.user?.name || 'Team admin';

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
                    companyRole,
                    isOwner: false
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
                companyRole,
                isOwner: false
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
                isOwner: false
            });
            await company.save();
        }

        const shouldSendInvite = !targetUser.password || (targetUser.invite && targetUser.invite.tokenHash === inviteTokenHash);
        let inviteLink = null;
        if (shouldSendInvite) {
            const frontendBaseUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
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
        const company = await Company.findById(companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        if (req.user._id.toString() === userId) {
            return res.status(400).json({ message: 'Cannot remove your own account from this company' });
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
        if (userMembership.isOwner || userMembership.companyRole === 'owner') {
            return res.status(400).json({ message: 'Company owner cannot be removed' });
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

        const user = await User.findById(userId);
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
            if (targetMembership.isOwner || targetMembership.companyRole === 'owner') {
                return res.status(400).json({ message: 'Company owner cannot be edited from this action' });
            }
        }

        // Build update object
        const updateData = {};
        if (name) updateData.name = name;
        if (title) updateData.title = title;
        if (email) {
            // Check if email is already taken by another user
            const existingUser = await User.findOne({ email: email.toLowerCase(), _id: { $ne: userId } });
            if (existingUser) {
                return res.status(400).json({ message: 'Email already in use by another account' });
            }
            updateData.email = email.toLowerCase();
        }

        // Role update is company-scoped (membership role in active company)
        if (role) {
            if (!canManageCompanyUser || !activeCompanyId) {
                return res.status(403).json({ message: 'Only company owner, admin or manager can change user roles' });
            }
            if (!COMPANY_ROLES.includes(role)) {
                return res.status(400).json({ message: `Invalid role. Allowed roles: ${COMPANY_ROLES.join(', ')}` });
            }
            const membershipIndex = (user.companies || []).findIndex(
                (entry) => membershipCompanyId(entry) === activeCompanyId
            );
            if (membershipIndex === -1) {
                return res.status(400).json({ message: 'User is not a member of active company' });
            }
            user.companies[membershipIndex].companyRole = role;
        }

        if (Object.keys(updateData).length) {
            Object.assign(user, updateData);
        }
        await user.save();

        if (role && activeCompanyId) {
            await Company.updateOne(
                { _id: activeCompanyId, 'members.user': user._id },
                { $set: { 'members.$.role': role } }
            );
        }

        const updatedUser = await User.findById(userId).select('-password');

        res.json({
            message: 'User updated successfully',
            user: updatedUser
        });
    } catch (error) {
        console.error('Update user error:', error);
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

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
        if (!isCurrentPasswordValid) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 12);
        await User.findByIdAndUpdate(req.user._id, { password: hashedNewPassword });

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

        const user = await User.findByIdAndUpdate(
            req.user._id,
            { $addToSet: { fcmTokens: normalizedToken } }, // addToSet to avoid duplicates
            { new: true }
        ).select('-password');

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

        const user = await User.findByIdAndUpdate(
            req.user._id,
            { $pull: { fcmTokens: normalizedToken } },
            { new: true }
        ).select('-password');

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
        if (String(password).length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const tokenHash = hashInviteToken(token);
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
            req.user.role === 'admin' ||
            req.user.role === 'manager' ||
            (m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole)));

        if (!canList) {
            return res.status(403).json({ message: 'Insufficient permissions to list users for this company' });
        }

        const company = await Company.findById(req.companyId).populate({
            path: 'members.user',
            select: '-password'
        });

        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const users = (company.members || [])
            .map((mem) => {
                if (!mem.user) return null;
                const u = mem.user.toObject ? mem.user.toObject() : { ...mem.user };
                return {
                    ...u,
                    companyMemberRole: mem.role,
                    companyIsOwner: mem.isOwner
                };
            })
            .filter(Boolean);

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
        const user = await User.findById(req.user._id).select('-password');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const companiesWithMembership = await mapCompaniesWithMembership(user.companies || []);

        res.json({
            user: {
                id: user._id,
                name: user.name,
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

        const user = await User.findById(req.user._id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Build update object
        const updateData = {};
        if (name) updateData.name = name;
        if (title) updateData.title = title;
        if (email) {
            // Check if email is already taken by another user
            const existingUser = await User.findOne({ 
                email: email.toLowerCase(), 
                _id: { $ne: req.user._id } 
            });
            if (existingUser) {
                return res.status(400).json({ message: 'Email already in use by another account' });
            }
            updateData.email = email.toLowerCase();
        }

        const updatedUser = await User.findByIdAndUpdate(
            req.user._id,
            updateData,
            { new: true }
        ).select('-password');

        res.json({
            message: 'Profile updated successfully',
            user: updatedUser
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
