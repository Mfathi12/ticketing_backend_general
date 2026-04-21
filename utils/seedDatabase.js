const bcrypt = require('bcryptjs');
const { User } = require('../models');

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
            role: 'admin'
        });

        await adminUser.save();
        console.log('Default admin user created successfully');
        console.log('Email: admin@admin.com');
        console.log('Password: 123456');
        console.log('Role: admin');
        
    } catch (error) {
        console.error('Error creating default admin user:', error);
    }
};

module.exports = { seedDefaultAdmin };

