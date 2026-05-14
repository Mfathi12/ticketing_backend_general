const express = require('express');
const { Project, User, Ticket, ProjectPersonalNote, Company } = require('../models');
const { Conversation, Message } = require('../models/chat');
const { authenticateToken, canBypassProjectAssignment } = require('../middleware/auth');
const {
    getCompanyPlan,
    evaluateAndSyncCompanySubscription,
    canCreateMoreProjects
} = require('../services/subscriptionService');
const { isPostgresPrimary } = require('../services/sql/runtime');
const authSql = require('../services/sql/authSql');
const projectSql = require('../services/sql/projectSql');

const router = express.Router();
const normalizeProjectName = (name) => String(name || '').trim();
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

        const normalizedProjectName = normalizeProjectName(project_name);
        if (!normalizedProjectName || !start_date || !estimated_end_date) {
            return res.status(400).json({ message: 'Project name, start date, and estimated end date are required' });
        }

        const sd = new Date(start_date);
        const ed = new Date(estimated_end_date);
        const todayUtc = new Date();
        todayUtc.setUTCHours(0, 0, 0, 0);
        const sdUtc = new Date(sd);
        sdUtc.setUTCHours(0, 0, 0, 0);
        if (sdUtc < todayUtc) {
            return res.status(400).json({ message: 'Start date cannot be in the past', code: 'START_DATE_IN_PAST' });
        }
        const edUtc = new Date(ed);
        edUtc.setUTCHours(0, 0, 0, 0);
        if (edUtc < todayUtc) {
            return res.status(400).json({
                message: 'Estimated end date cannot be in the past',
                code: 'END_DATE_IN_PAST'
            });
        }
        if (ed < sd) {
            return res.status(400).json({
                message: 'Estimated end date must be on or after the start date',
                code: 'END_BEFORE_START'
            });
        }

        const company = isPostgresPrimary()
            ? await authSql.loadCompanyForSubscription(activeCompanyId)
            : await Company.findById(activeCompanyId);
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }
        await evaluateAndSyncCompanySubscription(company);
        const projectCount = isPostgresPrimary()
            ? await projectSql.countProjectsByCompany(activeCompanyId)
            : await Project.countDocuments({ company: activeCompanyId });
        if (!canCreateMoreProjects(company, projectCount)) {
            const activePlan = getCompanyPlan(company);
            const rawMax = activePlan?.limits?.maxProjects;
            const capNum = rawMax == null ? NaN : Number(rawMax);
            const limitForClient = Number.isFinite(capNum) ? capNum : null;
            return res.status(403).json({
                message:
                    limitForClient != null
                        ? `Your ${activePlan?.name || 'current'} plan allows up to ${limitForClient} projects. Upgrade your subscription to add more.`
                        : 'Your subscription plan does not allow more projects. Upgrade your subscription to add more.',
                code: 'PROJECT_PLAN_LIMIT',
                planId: activePlan?.id,
                limit: limitForClient,
                current: projectCount
            });
        }

        const existingProject = isPostgresPrimary()
            ? await projectSql.findProjectByNameCI(activeCompanyId, normalizedProjectName)
            : await Project.findOne({
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

        if (normalizedAssignedUsers.length > 0) {
            if (isPostgresPrimary()) {
                const v = await projectSql.validateUsersInCompany(normalizedAssignedUsers, activeCompanyId);
                if (!v.ok || v.users.length !== normalizedAssignedUsers.length) {
                    return res.status(400).json({ message: 'Some assigned users are invalid' });
                }
            } else {
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
        }

        if (isPostgresPrimary()) {
            try {
                const projectId = await projectSql.createProjectWithConversation({
                    companyId: activeCompanyId,
                    projectName: normalizedProjectName,
                    startDate: new Date(start_date),
                    endDate: new Date(estimated_end_date),
                    assignedUserIds: normalizedAssignedUsers,
                    groupAdminId: req.user._id
                });
                const newProject = await projectSql.getProjectByIdWithAssignees(projectId);
                console.log(`Project conversation created for project: ${project_name}`);
                return res.status(201).json({
                    message: 'Project created successfully',
                    project: enrichAssignedUsersDisplayName(
                        newProject,
                        activeCompanyId,
                        req.activeCompanyName || null
                    )
                });
            } catch (convError) {
                console.error('Error creating project (SQL):', convError);
                return res.status(500).json({ message: 'Internal server error' });
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
        }

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

        if (isPostgresPrimary()) {
            const project = await projectSql.getProjectByIdWithAssignees(projectId);
            if (!project) {
                return res.status(404).json({ message: 'Project not found' });
            }
            const pCompany = project.company || project.companyId;
            if (!pCompany || String(pCompany) !== activeCompanyId) {
                return res.status(403).json({ message: 'You can only manage projects in your active company' });
            }
            const v = await projectSql.validateUsersInCompany(assigned_users, activeCompanyId);
            if (!v.ok || v.users.length !== assigned_users.length) {
                return res.status(400).json({ message: 'Some assigned users are invalid' });
            }
            await projectSql.setProjectAssignees(projectId, assigned_users);
            try {
                await projectSql.syncConversationParticipantsForProject(
                    activeCompanyId,
                    projectId,
                    assigned_users
                );
            } catch (convError) {
                console.error('Error updating project conversation participants:', convError);
            }
            const refreshed = await projectSql.getProjectByIdWithAssignees(projectId);
            return res.json({
                message: 'Users assigned to project successfully',
                project: enrichAssignedUsersDisplayName(
                    refreshed,
                    activeCompanyId,
                    req.activeCompanyName || null
                )
            });
        }

        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        if (!project.company || project.company.toString() !== activeCompanyId) {
            return res.status(403).json({ message: 'You can only manage projects in your active company' });
        }

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

        try {
            const projectConversation = await Conversation.findOne({ company: activeCompanyId, project: projectId });
            if (projectConversation) {
                projectConversation.participants = assigned_users;
                await projectConversation.save();
                console.log(`Project conversation participants updated for project: ${project._id}`);
            }
        } catch (convError) {
            console.error('Error updating project conversation participants:', convError);
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

        const m = req.companyMembership;
        const canViewAllCompanyProjects = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));

        let projectsWithCounts;
        if (isPostgresPrimary()) {
            const projects = await projectSql.listProjectsWithAssignees({
                companyId: activeCompanyId,
                userId: req.user._id,
                canViewAll: canViewAllCompanyProjects
            });
            const projectIds = projects.map((p) => p._id);
            const countByProject = await projectSql.ticketCountsByProject(activeCompanyId, projectIds);
            projectsWithCounts = projects.map((project) => {
                const counts = countByProject[String(project._id)] || { totalTickets: 0, openedTickets: 0 };
                return {
                    ...enrichAssignedUsersDisplayName(project, activeCompanyId, req.activeCompanyName || null),
                    totalTickets: counts.totalTickets,
                    openedTickets: counts.openedTickets
                };
            });
        } else {
            let projects;
            if (canViewAllCompanyProjects) {
                projects = await Project.find({ company: activeCompanyId }).populate(
                    'assigned_users',
                    'name title email role'
                );
            } else {
                projects = await Project.find({
                    company: activeCompanyId,
                    assigned_users: req.user._id
                }).populate('assigned_users', 'name title email role');
            }

            const projectIds = projects.map((p) => p._id);

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

            projectsWithCounts = projects.map((project) => {
                const counts = countByProject[project._id.toString()] || { totalTickets: 0, openedTickets: 0 };
                return {
                    ...enrichAssignedUsersDisplayName(project, activeCompanyId, req.activeCompanyName || null),
                    totalTickets: counts.totalTickets,
                    openedTickets: counts.openedTickets
                };
            });
        }

        res.json({ projects: projectsWithCounts });
    } catch (error) {
        console.error('Get projects error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

async function resolveProjectForNotes(req, projectId) {
    const activeCompanyId = req.companyId ? req.companyId.toString() : null;
    let project;
    if (isPostgresPrimary()) {
        project = await projectSql.getProjectLeanForNotes(projectId);
    } else {
        project = await Project.findById(projectId)
            .populate('assigned_users', 'name title email role')
            .lean();
    }
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

        const notes = isPostgresPrimary()
            ? await projectSql.listNotes(projectId, req.user._id)
            : await ProjectPersonalNote.find({
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

        let note;
        if (isPostgresPrimary()) {
            note = await projectSql.createNote(projectId, req.user._id, content);
        } else {
            const n = new ProjectPersonalNote({
                project: projectId,
                user: req.user._id,
                content: content.trim()
            });
            await n.save();
            note = n;
        }

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

        let note;
        if (isPostgresPrimary()) {
            note = await projectSql.updateNote(noteId, projectId, req.user._id, content);
        } else {
            note = await ProjectPersonalNote.findOneAndUpdate(
                { _id: noteId, project: projectId, user: req.user._id },
                { content: content.trim() },
                { new: true }
            );
        }

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

        const deleted = isPostgresPrimary()
            ? await projectSql.deleteNote(noteId, projectId, req.user._id)
            : (await ProjectPersonalNote.deleteOne({
                _id: noteId,
                project: projectId,
                user: req.user._id
            })).deletedCount > 0;

        if (!deleted) {
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

        const project = isPostgresPrimary()
            ? await projectSql.getProjectByIdWithAssignees(projectId)
            : await Project.findById(projectId).populate('assigned_users', 'name title email role');
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

// Delete entire project (company owner only)
router.delete('/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        const m = req.companyMembership;
        const isCompanyOwner =
            Boolean(m?.isOwner) || String(m?.companyRole || '').toLowerCase() === 'owner';
        if (!isCompanyOwner) {
            return res.status(403).json({ message: 'Only the company owner can delete a project' });
        }
        if (!activeCompanyId) {
            return res.status(400).json({
                message: 'Active company required. Log in with a company or switch company first.'
            });
        }

        if (isPostgresPrimary()) {
            const existing = await projectSql.getProjectByIdWithAssignees(projectId);
            if (!existing) {
                return res.status(404).json({ message: 'Project not found' });
            }
            if (String(existing.company) !== activeCompanyId) {
                return res.status(403).json({ message: 'You can only delete projects in your active company' });
            }
            await projectSql.deleteProjectFull(activeCompanyId, projectId);
            return res.json({ message: 'Project deleted successfully' });
        }

        const project = await Project.findById(projectId);
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }
        if (!project.company || project.company.toString() !== activeCompanyId) {
            return res.status(403).json({ message: 'You can only delete projects in your active company' });
        }

        await Ticket.deleteMany({ company: activeCompanyId, project: projectId });
        const convIds = await Conversation.find({
            company: activeCompanyId,
            project: projectId
        }).distinct('_id');
        if (convIds.length) {
            await Message.deleteMany({ conversation: { $in: convIds } });
        }
        await Conversation.deleteMany({ company: activeCompanyId, project: projectId });
        await ProjectPersonalNote.deleteMany({ project: projectId });
        await Project.deleteOne({ _id: projectId });

        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        console.error('Delete project error:', error);
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

        if (isPostgresPrimary()) {
            const existing = await projectSql.getProjectByIdWithAssignees(projectId);
            if (!existing) {
                return res.status(404).json({ message: 'Project not found' });
            }
            if (!activeCompanyId || !existing.company || String(existing.company) !== activeCompanyId) {
                return res.status(403).json({ message: 'You can only update projects in your active company' });
            }
            await projectSql.updateProjectStatus(projectId, status);
            const project = await projectSql.getProjectByIdWithAssignees(projectId);
            return res.json({
                message: 'Project status updated successfully',
                project
            });
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
