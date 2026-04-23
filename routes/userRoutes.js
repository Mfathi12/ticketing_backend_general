const express = require('express');
const bcrypt = require('bcryptjs');
const { User, Company } = require('../models');
const { authenticateToken, requireRole } = require('../middleware/auth');

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

// 3. Add user to company — active company from JWT; owner / company admin / manager may invite
router.post('/add-account', authenticateToken, async (req, res) => {
    try {
        const { name, title, email, password, role } = req.body;

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
        let targetUser = await User.findOne({ email: normalizedEmail });
        const companyRole = role || 'user';

        if (!targetUser) {
            if (!password) {
                return res.status(400).json({ message: 'password is required when creating a new user' });
            }
            const hashedPassword = await bcrypt.hash(password, 12);
            targetUser = await User.create({
                name,
                title,
                email: normalizedEmail,
                password: hashedPassword,
                role: companyRole,
                companies: [{
                    company: companyId,
                    companyRole,
                    isOwner: false
                }]
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
            await targetUser.save();
        }

        const company = await Company.findById(companyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
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

        res.status(201).json({
            message: 'User added to company successfully',
            user: {
                id: targetUser._id,
                name: targetUser.name,
                title: targetUser.title,
                email: targetUser.email,
                role: targetUser.role
            }
        });
    } catch (error) {
        console.error('Add account error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 4. Delete account (Admin/Manager only)
router.delete('/delete-account/:userId', authenticateToken, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const { userId } = req.params;

        if (req.user._id.toString() === userId) {
            return res.status(400).json({ message: 'Cannot delete your own account' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        await User.findByIdAndDelete(userId);

        res.json({ message: 'Account deleted successfully' });
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
        const isAdminOrManager = req.user.role === 'admin' || req.user.role === 'manager';
        const isOwnAccount = req.user._id.toString() === userId;

        if (!isAdminOrManager && !isOwnAccount) {
            return res.status(403).json({ message: 'You can only update your own account' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
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

        // Only admin/manager can change role
        if (role) {
            if (!isAdminOrManager) {
                return res.status(403).json({ message: 'Only admin or manager can change user roles' });
            }
            updateData.role = role;
        }

        const updatedUser = await User.findByIdAndUpdate(
            userId,
            updateData,
            { new: true }
        ).select('-password');

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
