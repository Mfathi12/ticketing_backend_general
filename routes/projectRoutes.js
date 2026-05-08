const express = require('express');
const { Project, User, Ticket, ProjectPersonalNote, Company } = require('../models');
const { Conversation } = require('../models/chat');
const { authenticateToken, canBypassProjectAssignment } = require('../middleware/auth');
const {
    getCompanyPlan,
    evaluateAndSyncCompanySubscription,
    canCreateMoreProjects
} = require('../services/subscriptionService');

const router = express.Router();
const membershipCompanyId = (entry) => {
    if (!entry) return null;
    const raw = entry.companyId ?? entry.company;
    if (!raw) return null;
    if (typeof raw === 'object' && raw._id) return String(raw._id);
    return String(raw);
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
const enrichAssignedUsersDisplayName = (projectDoc, companyId, fallbackCompanyName = null) => {
    if (!projectDoc) return projectDoc;
    const project = projectDoc.toObject ? projectDoc.toObject() : { ...projectDoc };
    if (Array.isArray(project.assigned_users)) {
        project.assigned_users = project.assigned_users.map((u) => ({
            ...(u?.toObject ? u.toObject() : u),
            name: resolveMembershipDisplayName(u, companyId, fallbackCompanyName)
        }));
    }
    return project;
};

// 5. Add new project (Admin/Manager only)
router.post('/add-project', authenticateToken, async (req, res) => {
    try {
        const { project_name, start_date, estimated_end_date, assigned_users } = req.body;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;

        if (!activeCompanyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company or switch company first.'
            });
        }
        const m = req.companyMembership;
        const canManageProjects = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canManageProjects) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        const company = await Company.findById(activeCompanyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }
        await evaluateAndSyncCompanySubscription(company);
        const projectCount = await Project.countDocuments({ company: activeCompanyId });
        if (!canCreateMoreProjects(company, projectCount)) {
            const activePlan = getCompanyPlan(company);
            const maxProjects = activePlan.limits.maxProjects;
            return res.status(403).json({
                message: `Your ${activePlan.name} plan allows up to ${maxProjects} projects. Upgrade your subscription to add more.`,
                planId: activePlan.id,
                limit: maxProjects,
                current: projectCount
            });
        }

        const normalizedProjectName = normalizeProjectName(project_name);
        if (!normalizedProjectName || !start_date || !estimated_end_date) {
            return res.status(400).json({ message: 'Project name, start date, and estimated end date are required' });
        }

        const existingProject = await Project.findOne({
            company: activeCompanyId,
            project_name: normalizedProjectName
        }).collation({ locale: 'en', strength: 2 });
        if (existingProject) {
            return res.status(409).json({
                message: 'A project with this name already exists in your company'
            });
        }

        const incomingAssignedUsers = Array.isArray(assigned_users) ? assigned_users : [];
        const creatorUserId = req.user?._id ? req.user._id.toString() : null;
        const normalizedAssignedUsers = creatorUserId
            ? Array.from(new Set([...incomingAssignedUsers.map((id) => id.toString()), creatorUserId]))
            : incomingAssignedUsers.map((id) => id.toString());

        // Validate assigned users if provided
        if (normalizedAssignedUsers.length > 0) {
            const validUsers = await User.find({ _id: { $in: normalizedAssignedUsers } });
            console.log(normalizedAssignedUsers);
            if (validUsers.length !== normalizedAssignedUsers.length) {
                return res.status(400).json({ message: 'Some assigned users are invalid' });
            }

            const allBelongToCompany = validUsers.every((u) =>
                (u.companies || []).some((entry) => membershipCompanyId(entry) === activeCompanyId)
            );
            if (!allBelongToCompany) {
                return res.status(400).json({ message: 'Assigned users must belong to the active company' });
            }
        }

        const newProject = new Project({
            project_name: normalizedProjectName,
            start_date: new Date(start_date),
            estimated_end_date: new Date(estimated_end_date),
            assigned_users: normalizedAssignedUsers,
            company: activeCompanyId
        });

        await newProject.save();

        // Create project conversation group
        try {
            const projectConversation = new Conversation({
                company: activeCompanyId,
                participants: normalizedAssignedUsers,
                isGroup: true,
                groupName: normalizedProjectName,
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
            project: enrichAssignedUsersDisplayName(newProject, activeCompanyId, req.activeCompanyName || null)
        });
    } catch (error) {
        console.error('Add project error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Assign users to project (Admin/Manager only)
router.put('/assign-users/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { assigned_users } = req.body;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;

        if (!activeCompanyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company or switch company first.'
            });
        }
        const m = req.companyMembership;
        const canManageProjects = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canManageProjects) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        if (!assigned_users || !Array.isArray(assigned_users)) {
            return res.status(400).json({ message: 'Assigned users array is required' });
        }

        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        if (!project.company || project.company.toString() !== activeCompanyId) {
            return res.status(403).json({ message: 'You can only manage projects in your active company' });
        }

        // Validate assigned users
        const validUsers = await User.find({ _id: { $in: assigned_users } });
        if (validUsers.length !== assigned_users.length) {
            return res.status(400).json({ message: 'Some assigned users are invalid' });
        }
        const allBelongToCompany = validUsers.every((u) =>
            (u.companies || []).some((entry) => membershipCompanyId(entry) === activeCompanyId)
        );
        if (!allBelongToCompany) {
            return res.status(400).json({ message: 'Assigned users must belong to the active company' });
        }

        project.assigned_users = assigned_users;
        await project.save();

        // Update project conversation participants
        try {
            const projectConversation = await Conversation.findOne({ company: activeCompanyId, project: projectId });
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
            project: enrichAssignedUsersDisplayName(project, activeCompanyId, req.activeCompanyName || null)
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
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company or switch company first.'
            });
        }

        let projects;

        const m = req.companyMembership;
        const canViewAllCompanyProjects = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (canViewAllCompanyProjects) {
            projects = await Project.find({ company: activeCompanyId }).populate('assigned_users', 'name title email role');
        } else {
            projects = await Project.find({
                company: activeCompanyId,
                assigned_users: req.user._id
            }).populate('assigned_users', 'name title email role');
        }

        const projectIds = projects.map(p => p._id);

        // Aggregate total and opened (open + in_progress) ticket counts per project
        const ticketCounts = await Ticket.aggregate([
            { $match: { company: req.companyId, project: { $in: projectIds } } },
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
                ...enrichAssignedUsersDisplayName(project, activeCompanyId, req.activeCompanyName || null),
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

async function resolveProjectForNotes(req, projectId) {
    const activeCompanyId = req.companyId ? req.companyId.toString() : null;
    const project = await Project.findById(projectId)
        .populate('assigned_users', 'name title email role')
        .lean();
    if (!project) {
        return { error: { status: 404, message: 'Project not found' } };
    }
    if (!activeCompanyId || !project.company || project.company.toString() !== activeCompanyId) {
        return { error: { status: 403, message: 'Access denied to this project' } };
    }
    if (
        !canBypassProjectAssignment(req) &&
        !project.assigned_users.some((user) => user._id.toString() === req.user._id.toString())
    ) {
        return { error: { status: 403, message: 'Access denied to this project' } };
    }
    return { project };
}

// Personal notes (current user only, per project)
router.get('/:projectId/notes', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const gate = await resolveProjectForNotes(req, projectId);
        if (gate.error) {
            return res.status(gate.error.status).json({ message: gate.error.message });
        }

        const notes = await ProjectPersonalNote.find({
            project: projectId,
            user: req.user._id
        })
            .sort({ updatedAt: -1 })
            .lean();

        res.json({ notes });
    } catch (error) {
        console.error('List project notes error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/:projectId/notes', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { content } = req.body;
        const gate = await resolveProjectForNotes(req, projectId);
        if (gate.error) {
            return res.status(gate.error.status).json({ message: gate.error.message });
        }

        if (typeof content !== 'string' || !content.trim()) {
            return res.status(400).json({ message: 'Note content is required' });
        }

        const note = new ProjectPersonalNote({
            project: projectId,
            user: req.user._id,
            content: content.trim()
        });
        await note.save();

        res.status(201).json({ note });
    } catch (error) {
        console.error('Create project note error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.put('/:projectId/notes/:noteId', authenticateToken, async (req, res) => {
    try {
        const { projectId, noteId } = req.params;
        const { content } = req.body;
        const gate = await resolveProjectForNotes(req, projectId);
        if (gate.error) {
            return res.status(gate.error.status).json({ message: gate.error.message });
        }

        if (typeof content !== 'string' || !content.trim()) {
            return res.status(400).json({ message: 'Note content is required' });
        }

        const note = await ProjectPersonalNote.findOneAndUpdate(
            { _id: noteId, project: projectId, user: req.user._id },
            { content: content.trim() },
            { new: true }
        );

        if (!note) {
            return res.status(404).json({ message: 'Note not found' });
        }

        res.json({ note });
    } catch (error) {
        console.error('Update project note error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/:projectId/notes/:noteId', authenticateToken, async (req, res) => {
    try {
        const { projectId, noteId } = req.params;
        const gate = await resolveProjectForNotes(req, projectId);
        if (gate.error) {
            return res.status(gate.error.status).json({ message: gate.error.message });
        }

        const result = await ProjectPersonalNote.deleteOne({
            _id: noteId,
            project: projectId,
            user: req.user._id
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Note not found' });
        }

        res.json({ message: 'Note deleted successfully' });
    } catch (error) {
        console.error('Delete project note error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get single project
router.get('/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;

        const project = await Project.findById(projectId).populate('assigned_users', 'name title email role');
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        if (!activeCompanyId || !project.company || project.company.toString() !== activeCompanyId) {
            return res.status(403).json({ message: 'Access denied to this project' });
        }

        if (
            !canBypassProjectAssignment(req) &&
            !project.assigned_users.some((user) => user._id.toString() === req.user._id.toString())
        ) {
            return res.status(403).json({ message: 'Access denied to this project' });
        }

        res.json({
            project: enrichAssignedUsersDisplayName(project, activeCompanyId, req.activeCompanyName || null)
        });
    } catch (error) {
        console.error('Get project error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Update project status (Admin/Manager only)
router.put('/:projectId/status', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { status } = req.body;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        const m = req.companyMembership;
        const canManageProjects = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canManageProjects) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        if (!status) {
            return res.status(400).json({ message: 'Status is required' });
        }

        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        if (!activeCompanyId || !project.company || project.company.toString() !== activeCompanyId) {
            return res.status(403).json({ message: 'You can only update projects in your active company' });
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
