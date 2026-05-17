const { Op } = require('sequelize');
const mongoose = require('mongoose');
const { getSequelizeModels, getSequelize } = require('../../db/postgres');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const buildAllComments = (ticketPlain, replyRows) => {
    const comments = [];
    if (ticketPlain.comment && String(ticketPlain.comment).trim()) {
        comments.push({
            user: ticketPlain.requested_to || 'System',
            userEmail: ticketPlain.requested_to_email || '',
            comment: ticketPlain.comment,
            createdAt: ticketPlain.updatedAt || ticketPlain.createdAt,
            isLegacy: true
        });
    }
    for (const r of replyRows || []) {
        if (r && r.comment) {
            comments.push({
                user: r.user || 'Unknown',
                userId: r.userId || null,
                userEmail: r.userEmail || '',
                comment: r.comment,
                images: Array.isArray(r.images) ? r.images : [],
                createdAt: r.createdAt || new Date(),
                isLegacy: false
            });
        }
    }
    return comments;
};

const assembleTicket = (tRow, projectMini, replyDocs, handlerEmails, ccEmails, imageUrls) => {
    const t = tRow.get ? tRow.get({ plain: true }) : tRow;
    const replies = (replyDocs || []).map((r) => {
        const rp = r.get ? r.get({ plain: true }) : r;
        return {
            _id: rp.id,
            id: rp.id,
            user: rp.user,
            userId: rp.userId,
            userEmail: rp.userEmail,
            comment: rp.comment,
            images: rp.images || [],
            createdAt: rp.createdAt,
            updatedAt: rp.updatedAt
        };
    });
    const doc = {
        _id: t.id,
        id: t.id,
        company: t.companyId,
        project: t.projectId,
        ticket: t.ticket,
        requested_from: t.requested_from,
        requested_from_email: t.requested_from_email,
        requested_to: t.requested_to,
        requested_to_email: t.requested_to_email,
        date: t.date,
        time: t.time,
        description: t.description,
        handler: handlerEmails || [],
        cc: ccEmails || [],
        status: t.status,
        priority: t.priority,
        comment: t.comment,
        end_date: t.end_date,
        images: imageUrls || [],
        replies,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        project: projectMini,
        allComments: buildAllComments(t, replies)
    };
    doc.toObject = () => ({ ...doc });
    return doc;
};

const loadTicketGraph = async (ticketId, companyId) => {
    const m = requireModels();
    const t = await m.Ticket.findOne({
        where: { id: String(ticketId), companyId: String(companyId) },
        include: [
            { model: m.Project, attributes: ['id', 'project_name', 'status'] },
            {
                model: m.TicketReply,
                as: 'replies',
                include: [{ model: m.TicketReplyImage, as: 'images' }]
            },
            { model: m.TicketHandler, as: 'handlers' },
            { model: m.TicketCc, as: 'cc' },
            { model: m.TicketImage, as: 'images' }
        ]
    });
    if (!t) return null;
    const plain = t.get({ plain: true });
    const proj = plain.Project
        ? { _id: plain.Project.id, project_name: plain.Project.project_name, status: plain.Project.status }
        : null;
    const replyRows = (plain.replies || []).map((r) => {
        const imgs = (r.images || []).map((i) => i.imageUrl);
        return {
            id: r.id,
            user: r.user,
            userId: r.userId,
            userEmail: r.userEmail,
            comment: r.comment,
            images: imgs,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt
        };
    });
    const handlers = (plain.handlers || []).map((h) => h.handlerEmail);
    const ccs = (plain.cc || []).map((c) => c.ccEmail);
    const timgs = (plain.images || []).map((i) => i.imageUrl);
    return assembleTicket(plain, proj, replyRows, handlers, ccs, timgs);
};

const findProjectInCompany = async (projectId, companyId) => {
    const m = requireModels();
    return m.Project.findOne({
        where: { id: String(projectId), companyId: String(companyId) }
    });
};

const findDuplicateTicket = async (ticketNumber, projectId, companyId) => {
    const m = requireModels();
    return m.Ticket.findOne({
        where: {
            ticket: String(ticketNumber).trim(),
            projectId: String(projectId),
            companyId: String(companyId)
        }
    });
};

const createTicketWithChildren = async (payload) => {
    const m = requireModels();
    const sql = getSequelize();
    const tid = newObjectIdString();
    const {
        companyId,
        projectId,
        ticket,
        requested_from,
        requested_from_email,
        requested_to,
        requested_to_email,
        date,
        time,
        description,
        handler,
        cc,
        status,
        priority,
        images,
        comment
    } = payload;

    await sql.transaction(async (tr) => {
        await m.Ticket.create(
            {
                id: tid,
                companyId: String(companyId),
                projectId: String(projectId),
                ticket: String(ticket).trim(),
                requested_from,
                requested_from_email: String(requested_from_email).toLowerCase(),
                requested_to,
                requested_to_email: String(requested_to_email).toLowerCase(),
                date: date || new Date(),
                time: time || null,
                description,
                status: status || 'open',
                priority: priority || null,
                comment: comment || null,
                end_date: null
            },
            { transaction: tr }
        );
        for (const h of handler || []) {
            await m.TicketHandler.create(
                {
                    id: newObjectIdString(),
                    ticketId: tid,
                    handlerEmail: String(h).toLowerCase().trim()
                },
                { transaction: tr }
            );
        }
        for (const c of cc || []) {
            await m.TicketCc.create(
                {
                    id: newObjectIdString(),
                    ticketId: tid,
                    ccEmail: String(c).toLowerCase().trim()
                },
                { transaction: tr }
            );
        }
        for (const img of images || []) {
            await m.TicketImage.create(
                {
                    id: newObjectIdString(),
                    ticketId: tid,
                    imageUrl: String(img)
                },
                { transaction: tr }
            );
        }
    });

    return loadTicketGraph(tid, companyId);
};

const ticketIncludes = (m) => [
    { model: m.Project, attributes: ['id', 'project_name', 'status'] },
    {
        model: m.TicketReply,
        as: 'replies',
        include: [{ model: m.TicketReplyImage, as: 'images' }]
    },
    { model: m.TicketHandler, as: 'handlers' },
    { model: m.TicketCc, as: 'cc' },
    { model: m.TicketImage, as: 'images' }
];

const instanceToDoc = (row) => {
    if (!row) return null;
    const plain = row.get({ plain: true });
    const proj = plain.Project
        ? { _id: plain.Project.id, project_name: plain.Project.project_name, status: plain.Project.status }
        : null;
    const replyRows = (plain.replies || []).map((r) => {
        const imgs = (r.images || []).map((i) => i.imageUrl);
        return {
            id: r.id,
            user: r.user,
            userId: r.userId,
            userEmail: r.userEmail,
            comment: r.comment,
            images: imgs,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt
        };
    });
    const handlers = (plain.handlers || []).map((h) => h.handlerEmail);
    const ccs = (plain.cc || []).map((c) => c.ccEmail);
    const timgs = (plain.images || []).map((i) => i.imageUrl);
    return assembleTicket(plain, proj, replyRows, handlers, ccs, timgs);
};

const findTicketsMany = async (where) => {
    const m = requireModels();
    const rows = await m.Ticket.findAll({ where, include: ticketIncludes(m) });
    return rows.map((r) => instanceToDoc(r));
};

const userAssignedProjectIds = async (userId, companyId) => {
    const m = requireModels();
    const links = await m.ProjectAssignee.findAll({
        where: { userId: String(userId) },
        attributes: ['projectId']
    });
    const projectIds = [...new Set(links.map((l) => l.projectId).filter(Boolean))];
    if (!projectIds.length) return [];
    const projects = await m.Project.findAll({
        where: { id: { [Op.in]: projectIds }, companyId: String(companyId) },
        attributes: ['id']
    });
    return projects.map((p) => p.id);
};

const replaceChildEmails = async (Model, ticketId, fieldName, values, factory) => {
    const m = requireModels();
    const sql = getSequelize();
    const tid = String(ticketId);
    await sql.transaction(async (tr) => {
        await Model.destroy({ where: { ticketId: tid }, transaction: tr });
        for (const v of values || []) {
            await Model.create(factory(v, tid), { transaction: tr });
        }
    });
};

const updateTicketSql = async (ticketId, companyId, updateData, imagesList) => {
    const m = requireModels();
    const tid = String(ticketId);
    const cid = String(companyId);
    const fields = { ...updateData };
    delete fields.handler;
    delete fields.cc;
    delete fields.images;
    await m.Ticket.update(fields, { where: { id: tid, companyId: cid } });

    if (updateData.handler !== undefined) {
        const list = Array.isArray(updateData.handler)
            ? updateData.handler.map((h) => String(h).toLowerCase().trim())
            : [String(updateData.handler).toLowerCase().trim()];
        await replaceChildEmails(
            m.TicketHandler,
            tid,
            'handlerEmail',
            list,
            (email, t) => ({
                id: newObjectIdString(),
                ticketId: t,
                handlerEmail: email
            })
        );
    }
    if (updateData.cc !== undefined) {
        const list = Array.isArray(updateData.cc)
            ? updateData.cc.map((c) => String(c).toLowerCase().trim())
            : updateData.cc
              ? [String(updateData.cc).toLowerCase().trim()]
              : [];
        await replaceChildEmails(
            m.TicketCc,
            tid,
            'ccEmail',
            list,
            (email, t) => ({
                id: newObjectIdString(),
                ticketId: t,
                ccEmail: email
            })
        );
    }
    if (imagesList !== undefined) {
        await replaceChildEmails(
            m.TicketImage,
            tid,
            'imageUrl',
            imagesList,
            (url, t) => ({
                id: newObjectIdString(),
                ticketId: t,
                imageUrl: String(url)
            })
        );
    }
    return loadTicketGraph(tid, cid);
};

const addReplySql = async (ticketId, companyId, { user, userId, userEmail, comment, imageUrls }) => {
    const m = requireModels();
    const sql = getSequelize();
    const rid = newObjectIdString();
    await sql.transaction(async (tr) => {
        await m.TicketReply.create(
            {
                id: rid,
                ticketId: String(ticketId),
                user,
                userId: String(userId),
                userEmail: String(userEmail).toLowerCase(),
                comment: String(comment).trim()
            },
            { transaction: tr }
        );
        for (const url of imageUrls || []) {
            await m.TicketReplyImage.create(
                {
                    id: newObjectIdString(),
                    ticketReplyId: rid,
                    imageUrl: String(url)
                },
                { transaction: tr }
            );
        }
    });
    return loadTicketGraph(ticketId, companyId);
};

module.exports = {
    buildAllComments,
    assembleTicket,
    loadTicketGraph,
    findProjectInCompany,
    findDuplicateTicket,
    createTicketWithChildren,
    findTicketsMany,
    userAssignedProjectIds,
    updateTicketSql,
    addReplySql,
    instanceToDoc,
    ticketIncludes
};
