const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { User } = require('../models');
const { getSequelizeModels, isPostgresEnabled } = require('../db/postgres');

const seedDefaultAdmin = async () => {
    try {
        // Check if admin user already exists
        const existingAdmin = await User.findOne({ email: 'admin@admin.com' });
        
        if (existingAdmin) {
            console.log('Default admin user already exists');
            return;
        }

        // Create default admin user
        const hashedPassword = await bcrypt.hash('123456', 12);
        
        const adminUser = new User({
            name: 'admin',
            title: 'admin',
            email: 'admin@admin.com',
            password: hashedPassword,
            role: 'super_admin',
            emailVerified: true,
            registrationEmailPending: false,
            companies: []
        });

        await adminUser.save();
        console.log('Default admin user created successfully');
        console.log('Email: admin@admin.com');
        console.log('Password: 123456');
        console.log('Role: super_admin (platform console)');
        
    } catch (error) {
        console.error('Error creating default admin user:', error);
    }
};

/** When Mongo is off: create platform super_admin in Postgres (same credentials as Mongo seed). */
const seedDefaultAdminPostgres = async () => {
    if (!isPostgresEnabled()) return;
    const m = getSequelizeModels();
    if (!m?.User) return;
    try {
        const existing = await m.User.findOne({ where: { email: 'admin@admin.com' } });
        if (existing) {
            console.log('Default admin user already exists (Postgres)');
            return;
        }
        const hashedPassword = await bcrypt.hash('123456', 12);
        await m.User.create({
            id: new mongoose.Types.ObjectId().toString(),
            name: 'admin',
            title: 'admin',
            email: 'admin@admin.com',
            password: hashedPassword,
            role: 'super_admin',
            emailVerified: true,
            registrationEmailPending: false,
            accountStatus: 'active'
        });
        console.log('Default admin user created (Postgres). Email: admin@admin.com, Password: 123456');
    } catch (error) {
        console.error('Error creating default admin user (Postgres):', error.message);
    }
};

module.exports = { seedDefaultAdmin, seedDefaultAdminPostgres };

