const express = require('express');
const { Project, User, Ticket } = require('../models');
const { Conversation } = require('../models/chat');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// 5. Add new project (Admin/Manager only)
router.post('/add-project', authenticateToken, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const { project_name, start_date, estimated_end_date, assigned_users } = req.body;

        if (!project_name || !start_date || !estimated_end_date) {
            return res.status(400).json({ message: 'Project name, start date, and estimated end date are required' });
        }

        // Validate assigned users if provided
        if (assigned_users && assigned_users.length > 0) {
            const validUsers = await User.find({ _id: { $in: assigned_users } });
            console.log(assigned_users);
            if (validUsers.length !== assigned_users.length) {
                return res.status(400).json({ message: 'Some assigned users are invalid' });
            }
        }

        const newProject = new Project({
            project_name,
            start_date: new Date(start_date),
            estimated_end_date: new Date(estimated_end_date),
            assigned_users: assigned_users ,
        });

        await newProject.save();

        // Create project conversation group
        try {
            const projectConversation = new Conversation({
                participants: assigned_users || [],
                isGroup: true,
                groupName: project_name,
                project: newProject._id,
                groupAdmin: req.user._id
            });
            await projectConversation.save();
            console.log(`Project conversation created for project: ${project_name}`);
        } catch (convError) {
            console.error('Error creating project conversation:', convError);
            // Don't fail project creation if conversation creation fails
        }

        // Populate assigned users for response
        await newProject.populate('assigned_users', 'name title email role');

        res.status(201).json({
            message: 'Project created successfully',
            project: newProject
        });
    } catch (error) {
        console.error('Add project error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Assign users to project (Admin/Manager only)
router.put('/assign-users/:projectId', authenticateToken, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { assigned_users } = req.body;

        if (!assigned_users || !Array.isArray(assigned_users)) {
            return res.status(400).json({ message: 'Assigned users array is required' });
        }

        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        // Validate assigned users
        const validUsers = await User.find({ _id: { $in: assigned_users } });
        if (validUsers.length !== assigned_users.length) {
            return res.status(400).json({ message: 'Some assigned users are invalid' });
        }

        project.assigned_users = assigned_users;
        await project.save();

        // Update project conversation participants
        try {
            const projectConversation = await Conversation.findOne({ project: projectId });
            if (projectConversation) {
                projectConversation.participants = assigned_users;
                await projectConversation.save();
                console.log(`Project conversation participants updated for project: ${project._id}`);
            }
        } catch (convError) {
            console.error('Error updating project conversation participants:', convError);
            // Don't fail user assignment if conversation update fails
        }

        await project.populate('assigned_users', 'name title email role');

        res.json({
            message: 'Users assigned to project successfully',
            project
        });
    } catch (error) {
        console.error('Assign users error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 7. View projects (All users can view assigned projects, Admin/Manager can view all)
// Response includes totalTickets and openedTickets per project
router.get('/my-projects', authenticateToken, async (req, res) => {
    try {
        let projects;

        if (req.user.role === 'admin' || req.user.role === 'manager') {
            projects = await Project.find({}).populate('assigned_users', 'name title email role');
        } else {
            projects = await Project.find({ assigned_users: req.user._id }).populate('assigned_users', 'name title email role');
        }

        const projectIds = projects.map(p => p._id);

        // Aggregate total and opened (open + in_progress) ticket counts per project
        const ticketCounts = await Ticket.aggregate([
            { $match: { project: { $in: projectIds } } },
            {
                $group: {
                    _id: '$project',
                    totalTickets: { $sum: 1 },
                    openedTickets: {
                        $sum: { $cond: [{ $in: ['$status', ['open', 'in_progress']] }, 1, 0] }
                    }
                }
            }
        ]);

        const countByProject = {};
        ticketCounts.forEach(({ _id, totalTickets, openedTickets }) => {
            countByProject[_id.toString()] = { totalTickets, openedTickets };
        });

        const projectsWithCounts = projects.map(project => {
            const counts = countByProject[project._id.toString()] || { totalTickets: 0, openedTickets: 0 };
            return {
                ...project.toObject(),
                totalTickets: counts.totalTickets,
                openedTickets: counts.openedTickets
            };
        });

        res.json({ projects: projectsWithCounts });
    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get single project
router.get('/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;

        const project = await Project.findById(projectId).populate('assigned_users', 'name title email role');
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        // Check if user has access to this project
        if (req.user.role !== 'admin' && req.user.role !== 'manager' && !project.assigned_users.some(user => user._id.toString() === req.user._id.toString())) {
            return res.status(403).json({ message: 'Access denied to this project' });
        }

        res.json({ project });
    } catch (error) {
        console.error('Get project error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update project status (Admin/Manager only)
router.put('/:projectId/status', authenticateToken, requireRole(['admin', 'manager']), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({ message: 'Status is required' });
        }

        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        project.status = status;
        await project.save();

        res.json({
            message: 'Project status updated successfully',
            project
        });
    } catch (error) {
        console.error('Update project status error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
