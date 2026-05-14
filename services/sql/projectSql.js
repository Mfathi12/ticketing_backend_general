const { Op, fn, col, literal } = require('sequelize');
const mongoose = require('mongoose');
const { getSequelizeModels, getSequelize } = require('../../db/postgres');
const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const userMiniDoc = (plain) => ({
    _id: plain.id,
    id: plain.id,
    name: plain.name,
    title: plain.title,
    email: plain.email,
    role: plain.role,
    toObject: () => ({ ...plain, _id: plain.id, password: undefined })
});

const projectToResponseShape = (projPlain, assigneeRows) => {
    const assignees = (assigneeRows || []).map((u) => userMiniDoc(u.get ? u.get({ plain: true }) : u));
    const p = projPlain;
    return {
        _id: p.id,
        id: p.id,
        project_name: p.project_name,
        start_date: p.start_date,
        estimated_end_date: p.estimated_end_date,
        company: p.companyId,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        assigned_users: assignees,
        toObject: function toObj() {
            // Match the API shape (including `company`), not raw Sequelize `p` (only has companyId).
            return {
                _id: p.id,
                id: p.id,
                project_name: p.project_name,
                start_date: p.start_date,
                estimated_end_date: p.estimated_end_date,
                company: p.companyId,
                status: p.status,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt,
                assigned_users: assignees.map((x) => ({ ...x }))
            };
        }
    };
};

const loadAssigneesForProjects = async (m, projectIds) => {
    if (!projectIds.length) return new Map();
    const pas = await m.ProjectAssignee.findAll({
        where: { projectId: { [Op.in]: projectIds } }
    });
    const userIds = [...new Set(pas.map((x) => x.userId))];
    const users = userIds.length
        ? await m.User.findAll({
            where: { id: userIds },
            attributes: ['id', 'name', 'title', 'email', 'role']
        })
        : [];
    const byUser = new Map(users.map((u) => [u.id, u]));
    const byProject = new Map();
    for (const pa of pas) {
        const list = byProject.get(pa.projectId) || [];
        const u = byUser.get(pa.userId);
        if (u) list.push(u);
        byProject.set(pa.projectId, list);
    }
    return byProject;
};

const countProjectsByCompany = async (companyId) => {
    const m = requireModels();
    return m.Project.count({ where: { companyId: String(companyId) } });
};

const findProjectByNameCI = async (companyId, projectName) => {
    const m = requireModels();
    return m.Project.findOne({
        where: {
            companyId: String(companyId),
            project_name: { [Op.iLike]: String(projectName).trim() }
        }
    });
};

const validateUsersInCompany = async (userIds, companyId) => {
    const m = requireModels();
    const ids = [...new Set(userIds.map(String))];
    if (!ids.length) return { ok: true, users: [] };
    const ucs = await m.UserCompany.findAll({
        where: { companyId: String(companyId), userId: { [Op.in]: ids } }
    });
    if (ucs.length !== ids.length) return { ok: false, users: [] };
    const users = await m.User.findAll({ where: { id: { [Op.in]: ids } } });
    if (users.length !== ids.length) return { ok: false, users: [] };
    return { ok: true, users };
};

const createProjectWithConversation = async ({
    companyId,
    projectName,
    startDate,
    endDate,
    assignedUserIds,
    groupAdminId
}) => {
    const m = requireModels();
    const sql = getSequelize();
    const projectId = newObjectIdString();
    const convId = newObjectIdString();
    await sql.transaction(async (t) => {
        await m.Project.create(
            {
                id: projectId,
                project_name: projectName,
                start_date: startDate,
                estimated_end_date: endDate,
                companyId: String(companyId),
                status: 'active'
            },
            { transaction: t }
        );
        for (const uid of assignedUserIds) {
            await m.ProjectAssignee.findOrCreate({
                where: { projectId, userId: String(uid) },
                defaults: { id: newObjectIdString(), projectId, userId: String(uid) },
                transaction: t
            });
        }
        await m.Conversation.create(
            {
                id: convId,
                companyId: String(companyId),
                isGroup: true,
                groupName: projectName,
                projectId,
                groupAdminId: String(groupAdminId),
                unreadCount: {},
                lastMessageAt: new Date()
            },
            { transaction: t }
        );
        let order = 0;
        for (const uid of assignedUserIds) {
            await m.ConversationParticipant.create(
                {
                    id: newObjectIdString(),
                    conversationId: convId,
                    userId: String(uid),
                    sortOrder: order++
                },
                { transaction: t }
            );
        }
    });
    return projectId;
};

const getProjectByIdWithAssignees = async (projectId) => {
    const m = requireModels();
    const p = await m.Project.findByPk(String(projectId));
    if (!p) return null;
    const plain = p.get({ plain: true });
    const byProject = await loadAssigneesForProjects(m, [plain.id]);
    return projectToResponseShape(plain, byProject.get(plain.id) || []);
};

const setProjectAssignees = async (projectId, userIds) => {
    const m = requireModels();
    const sql = getSequelize();
    const pid = String(projectId);
    await sql.transaction(async (t) => {
        await m.ProjectAssignee.destroy({ where: { projectId: pid }, transaction: t });
        for (const uid of userIds) {
            await m.ProjectAssignee.create(
                {
                    id: newObjectIdString(),
                    projectId: pid,
                    userId: String(uid)
                },
                { transaction: t }
            );
        }
    });
};

const syncConversationParticipantsForProject = async (companyId, projectId, userIds) => {
    const m = requireModels();
    const conv = await m.Conversation.findOne({
        where: { companyId: String(companyId), projectId: String(projectId) }
    });
    if (!conv) return;
    const cid = conv.id;
    await m.ConversationParticipant.destroy({ where: { conversationId: cid } });
    let order = 0;
    for (const uid of userIds) {
        await m.ConversationParticipant.create({
            id: newObjectIdString(),
            conversationId: cid,
            userId: String(uid),
            sortOrder: order++
        });
    }
};

const listProjectsWithAssignees = async ({ companyId, userId, canViewAll }) => {
    const m = requireModels();
    const cid = String(companyId);
    let projects;
    if (canViewAll) {
        projects = await m.Project.findAll({ where: { companyId: cid } });
    } else {
        const pas = await m.ProjectAssignee.findAll({
            where: { userId: String(userId) },
            attributes: ['projectId']
        });
        const pids = [...new Set(pas.map((p) => p.projectId))];
        projects = pids.length
            ? await m.Project.findAll({ where: { companyId: cid, id: { [Op.in]: pids } } })
            : [];
    }
    const ids = projects.map((p) => p.id);
    const byProject = await loadAssigneesForProjects(m, ids);
    return projects.map((p) => {
        const plain = p.get({ plain: true });
        return projectToResponseShape(plain, byProject.get(plain.id) || []);
    });
};

const ticketCountsByProject = async (companyId, projectIds) => {
    const m = requireModels();
    if (!projectIds.length) return {};
    const rows = await m.Ticket.findAll({
        attributes: [
            'projectId',
            [fn('COUNT', col('id')), 'totalTickets'],
            [
                fn(
                    'SUM',
                    literal(`CASE WHEN status IN ('open', 'in_progress') THEN 1 ELSE 0 END`)
                ),
                'openedTickets'
            ]
        ],
        where: { companyId: String(companyId), projectId: { [Op.in]: projectIds } },
        group: ['projectId'],
        raw: true
    });
    const out = {};
    for (const r of rows) {
        const pid = r.projectId;
        out[String(pid)] = {
            totalTickets: Number(r.totalTickets) || 0,
            openedTickets: Number(r.openedTickets) || 0
        };
    }
    return out;
};

const getProjectLeanForNotes = async (projectId) => {
    const doc = await getProjectByIdWithAssignees(projectId);
    if (!doc) return null;
    const o = doc.toObject ? doc.toObject() : { ...doc };
    return o;
};

const listNotes = async (projectId, userId) => {
    const m = requireModels();
    const rows = await m.ProjectPersonalNote.findAll({
        where: { projectId: String(projectId), userId: String(userId) },
        order: [['updatedAt', 'DESC']]
    });
    return rows.map((r) => {
        const p = r.get({ plain: true });
        return {
            _id: p.id,
            id: p.id,
            project: p.projectId,
            user: p.userId,
            content: p.content,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt
        };
    });
};

const createNote = async (projectId, userId, content) => {
    const m = requireModels();
    const row = await m.ProjectPersonalNote.create({
        id: newObjectIdString(),
        projectId: String(projectId),
        userId: String(userId),
        content: String(content).trim()
    });
    const p = row.get({ plain: true });
    return {
        _id: p.id,
        id: p.id,
        project: p.projectId,
        user: p.userId,
        content: p.content,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
};

const updateNote = async (noteId, projectId, userId, content) => {
    const m = requireModels();
    const [n] = await m.ProjectPersonalNote.update(
        { content: String(content).trim() },
        { where: { id: String(noteId), projectId: String(projectId), userId: String(userId) } }
    );
    if (!n) return null;
    const row = await m.ProjectPersonalNote.findByPk(String(noteId));
    if (!row) return null;
    const p = row.get({ plain: true });
    return {
        _id: p.id,
        id: p.id,
        project: p.projectId,
        user: p.userId,
        content: p.content,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
};

const deleteNote = async (noteId, projectId, userId) => {
    const m = requireModels();
    const n = await m.ProjectPersonalNote.destroy({
        where: { id: String(noteId), projectId: String(projectId), userId: String(userId) }
    });
    return n > 0;
};

const updateProjectStatus = async (projectId, status) => {
    const m = requireModels();
    await m.Project.update({ status }, { where: { id: String(projectId) } });
    return m.Project.findByPk(String(projectId));
};

/** Full delete: tickets + chat + notes + assignees, then project (company-scoped). */
const deleteProjectFull = async (companyId, projectId) => {
    const m = requireModels();
    const sql = getSequelize();
    const cid = String(companyId);
    const pid = String(projectId);
    await sql.transaction(async (t) => {
        const tickets = await m.Ticket.findAll({
            where: { companyId: cid, projectId: pid },
            attributes: ['id'],
            transaction: t
        });
        const ticketIds = tickets.map((x) => x.id);
        if (ticketIds.length) {
            const replies = await m.TicketReply.findAll({
                where: { ticketId: { [Op.in]: ticketIds } },
                attributes: ['id'],
                transaction: t
            });
            const replyIds = replies.map((x) => x.id);
            if (replyIds.length) {
                await m.TicketReplyImage.destroy({
                    where: { ticketReplyId: { [Op.in]: replyIds } },
                    transaction: t
                });
            }
            await m.TicketReply.destroy({ where: { ticketId: { [Op.in]: ticketIds } }, transaction: t });
            await m.TicketImage.destroy({ where: { ticketId: { [Op.in]: ticketIds } }, transaction: t });
            await m.TicketHandler.destroy({ where: { ticketId: { [Op.in]: ticketIds } }, transaction: t });
            await m.TicketCc.destroy({ where: { ticketId: { [Op.in]: ticketIds } }, transaction: t });
            await m.Ticket.destroy({ where: { id: { [Op.in]: ticketIds } }, transaction: t });
        }

        const convs = await m.Conversation.findAll({
            where: { companyId: cid, projectId: pid },
            attributes: ['id'],
            transaction: t
        });
        const convIds = convs.map((x) => x.id);
        if (convIds.length) {
            await m.Message.update(
                { replyToId: null, parentMessageId: null },
                { where: { conversationId: { [Op.in]: convIds } }, transaction: t }
            );
            const msgs = await m.Message.findAll({
                where: { conversationId: { [Op.in]: convIds } },
                attributes: ['id'],
                transaction: t
            });
            const msgIds = msgs.map((x) => x.id);
            if (msgIds.length) {
                await m.MessageReadBy.destroy({ where: { messageId: { [Op.in]: msgIds } }, transaction: t });
                await m.MessageMention.destroy({ where: { messageId: { [Op.in]: msgIds } }, transaction: t });
                await m.MessageReaction.destroy({ where: { messageId: { [Op.in]: msgIds } }, transaction: t });
            }
            await m.Message.destroy({ where: { conversationId: { [Op.in]: convIds } }, transaction: t });
            await m.ConversationParticipant.destroy({
                where: { conversationId: { [Op.in]: convIds } },
                transaction: t
            });
            await m.Conversation.destroy({ where: { id: { [Op.in]: convIds } }, transaction: t });
        }

        await m.ProjectAssignee.destroy({ where: { projectId: pid }, transaction: t });
        await m.ProjectPersonalNote.destroy({ where: { projectId: pid }, transaction: t });
        const n = await m.Project.destroy({ where: { id: pid, companyId: cid }, transaction: t });
        if (!n) {
            throw new Error('Project not found or company mismatch');
        }
    });
};

module.exports = {
    countProjectsByCompany,
    findProjectByNameCI,
    validateUsersInCompany,
    createProjectWithConversation,
    getProjectByIdWithAssignees,
    setProjectAssignees,
    syncConversationParticipantsForProject,
    listProjectsWithAssignees,
    ticketCountsByProject,
    getProjectLeanForNotes,
    listNotes,
    createNote,
    updateNote,
    deleteNote,
    updateProjectStatus,
    deleteProjectFull,
    projectToResponseShape,
    loadAssigneesForProjects
};
