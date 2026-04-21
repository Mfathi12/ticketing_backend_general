const express = require('express');
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// 3. Add new account (Admin/Manager only)
router.post('/add-account', authenticateToken, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const { name, title, email, password, role } = req.body;

        if (!name || !title || !email || !password) {
            return res.status(400).json({ message: 'Name, title, email, and password are required' });
        }

        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({ message: 'User with this email already exists' });
        }
        

        const hashedPassword = await bcrypt.hash(password, 12);

        const newUser = new User({
            name,
            title,
            email: email.toLowerCase(),
            password: hashedPassword,
            role: role || 'user'
        });

        await newUser.save();

        res.status(201).json({
            message: 'Account created successfully',
            user: {
                id: newUser._id,
                name: newUser.name,
                title: newUser.title,
                email: newUser.email,
                role: newUser.role
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

// Get all users (Admin/Manager only)
router.get('/all-users', authenticateToken, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const users = await User.find({}).select('-password');
        res.json({ users });
    } catch (error) {
        console.error('Get all users error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');
        res.json({ user });
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
