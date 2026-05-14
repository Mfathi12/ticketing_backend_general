const { Op } = require('sequelize');
const mongoose = require('mongoose');
const { getSequelizeModels, getSequelize } = require('../../db/postgres');
const authSql = require('./authSql');

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const loadUsersByIds = async (ids) => {
    const unique = [...new Set((ids || []).map(String).filter(Boolean))];
    if (!unique.length) return [];
    const m = requireModels();
    return m.User.findAll({
        where: { id: unique },
        attributes: ['id', 'name', 'email', 'title', 'role']
    });
};

const userToChatShape = (u) => {
    const p = u.get ? u.get({ plain: true }) : u;
    return {
        _id: p.id,
        id: p.id,
        name: p.name,
        email: p.email,
        title: p.title,
        role: p.role
    };
};


/** One-level reply snapshot (matches Mongoose .populate('replyTo') lean shape without deep chaining). */
const mapReplyToSnapshot = async (msgRow, m) => {
    const msg = msgRow.get ? msgRow.get({ plain: true }) : msgRow;
    const senderRows = await loadUsersByIds([msg.senderId]);
    const sender = senderRows[0] ? userToChatShape(senderRows[0]) : null;
    const mentionIds = await m.MessageMention.findAll({
        where: { messageId: msg.id },
        attributes: ['userId']
    });
    const mentionUsers = await loadUsersByIds(mentionIds.map((x) => x.userId));
    const reads = await m.MessageReadBy.findAll({ where: { messageId: msg.id } });
    const reactions = await m.MessageReaction.findAll({ where: { messageId: msg.id } });
    const reactUsers = await loadUsersByIds(reactions.map((x) => x.userId));
    const ruById = new Map(reactUsers.map((u) => [u.id, userToChatShape(u)]));
    return {
        _id: msg.id,
        id: msg.id,
        company: msg.companyId,
        conversation: msg.conversationId,
        sender,
        senderName: msg.senderName,
        senderEmail: msg.senderEmail,
        type: msg.type,
        content: msg.content,
        fileUrl: msg.fileUrl,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        mimeType: msg.mimeType,
        duration: msg.duration,
        thumbnail: msg.thumbnail,
        readBy: reads.map((rb) => ({
            user: rb.userId,
            readAt: rb.readAt
        })),
        replyTo: null,
        mentions: mentionUsers.map((u) => userToChatShape(u)),
        reactions: reactions.map((rx) => ({
            user: ruById.get(rx.userId) || { _id: rx.userId },
            emoji: rx.emoji,
            createdAt: rx.createdAt
        })),
        isEdited: msg.isEdited,
        editedAt: msg.editedAt,
        isDeleted: msg.isDeleted,
        deletedAt: msg.deletedAt,
        parentMessage: msg.parentMessageId,
        isThread: msg.isThread,
        threadCount: msg.threadCount,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt
    };
};

const mapMessageFull = async (msgRow, m) => {
    const msg = msgRow.get ? msgRow.get({ plain: true }) : msgRow;
    const senderRows = await loadUsersByIds([msg.senderId]);
    const sender = senderRows[0] ? userToChatShape(senderRows[0]) : null;
    let replyTo = null;
    if (msg.replyToId) {
        const r = await m.Message.findByPk(msg.replyToId);
        if (r) replyTo = await mapReplyToSnapshot(r, m);
    }
    const mentionIds = await m.MessageMention.findAll({
        where: { messageId: msg.id },
        attributes: ['userId']
    });
    const mentionUsers = await loadUsersByIds(mentionIds.map((x) => x.userId));
    const reads = await m.MessageReadBy.findAll({ where: { messageId: msg.id } });
    const reactions = await m.MessageReaction.findAll({ where: { messageId: msg.id } });
    const reactUsers = await loadUsersByIds(reactions.map((x) => x.userId));
    const ruById = new Map(reactUsers.map((u) => [u.id, userToChatShape(u)]));
    return {
        _id: msg.id,
        id: msg.id,
        company: msg.companyId,
        conversation: msg.conversationId,
        sender,
        senderName: msg.senderName,
        senderEmail: msg.senderEmail,
        type: msg.type,
        content: msg.content,
        fileUrl: msg.fileUrl,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        mimeType: msg.mimeType,
        duration: msg.duration,
        thumbnail: msg.thumbnail,
        readBy: reads.map((rb) => ({
            user: rb.userId,
            readAt: rb.readAt
        })),
        replyTo,
        mentions: mentionUsers.map((u) => userToChatShape(u)),
        reactions: reactions.map((rx) => ({
            user: ruById.get(rx.userId) || { _id: rx.userId },
            emoji: rx.emoji,
            createdAt: rx.createdAt
        })),
        isEdited: msg.isEdited,
        editedAt: msg.editedAt,
        isDeleted: msg.isDeleted,
        deletedAt: msg.deletedAt,
        parentMessage: msg.parentMessageId,
        isThread: msg.isThread,
        threadCount: msg.threadCount,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt
    };
};

const mapConversation = async (convRow, userIdForUnread, m) => {
    const c = convRow.get ? convRow.get({ plain: true }) : convRow;
    const parts = await m.ConversationParticipant.findAll({
        where: { conversationId: c.id },
        order: [['sortOrder', 'ASC']]
    });
    const users = await loadUsersByIds(parts.map((p) => p.userId));
    const participants = users.map((u) => userToChatShape(u));
    let lastMessage = null;
    if (c.lastMessageId) {
        const lm = await m.Message.findByPk(c.lastMessageId);
        if (lm) lastMessage = await mapMessageFull(lm, m);
    }
    let project = null;
    if (c.projectId) {
        const pr = await m.Project.findByPk(c.projectId, {
            attributes: ['id', 'project_name']
        });
        if (pr) {
            const pp = pr.get({ plain: true });
            project = { _id: pp.id, project_name: pp.project_name };
        }
    }
    const uc = c.unreadCount && typeof c.unreadCount === 'object' ? c.unreadCount : {};
    return {
        _id: c.id,
        id: c.id,
        company: c.companyId,
        participants,
        lastMessage,
        lastMessageAt: c.lastMessageAt,
        unreadCount: uc,
        isGroup: c.isGroup,
        groupName: c.groupName,
        groupDescription: c.groupDescription,
        groupAdmin: c.groupAdminId,
        project,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
    };
};

const participantUserIds = async (conversationId) => {
    const m = requireModels();
    const rows = await m.ConversationParticipant.findAll({
        where: { conversationId: String(conversationId) },
        order: [['sortOrder', 'ASC']]
    });
    return rows.map((r) => r.userId);
};

const isUserInConversation = async (conversationId, userId) => {
    const ids = await participantUserIds(conversationId);
    return ids.map(String).includes(String(userId));
};

const ensureDirectConversation = async (companyId, userIdA, userIdB, viewerUserId) => {
    const m = requireModels();
    const cid = String(companyId);
    const a = String(userIdA);
    const b = String(userIdB);
    const viewer = String(viewerUserId || userIdA);
    const all = await m.Conversation.findAll({
        where: { companyId: cid, isGroup: false }
    });
    for (const conv of all) {
        const pids = await participantUserIds(conv.id);
        const set = new Set(pids.map(String));
        if (set.has(a) && set.has(b) && set.size === 2) {
            return mapConversation(conv, viewer, m);
        }
    }
    const sql = getSequelize();
    const convId = newObjectIdString();
    await sql.transaction(async (t) => {
        await m.Conversation.create(
            {
                id: convId,
                companyId: cid,
                isGroup: false,
                unreadCount: {},
                lastMessageAt: new Date()
            },
            { transaction: t }
        );
        await m.ConversationParticipant.create(
            { id: newObjectIdString(), conversationId: convId, userId: a, sortOrder: 0 },
            { transaction: t }
        );
        await m.ConversationParticipant.create(
            { id: newObjectIdString(), conversationId: convId, userId: b, sortOrder: 1 },
            { transaction: t }
        );
    });
    const row = await m.Conversation.findByPk(convId);
    return mapConversation(row, viewer, m);
};

const getProjectConversationRow = async (companyId, projectId) => {
    const m = requireModels();
    return m.Conversation.findOne({
        where: { companyId: String(companyId), projectId: String(projectId) }
    });
};

/** Align project-linked conversation participants with ProjectAssignee; ensure viewer is a participant. */
const ensureProjectChatConversation = async (companyId, projectDoc, userId) => {
    const m = requireModels();
    const cid = String(companyId);
    const uid = String(userId);
    const pid = String(projectDoc._id || projectDoc.id);
    const name = projectDoc.project_name;
    const assignees = await m.ProjectAssignee.findAll({ where: { projectId: pid } });
    const pids = assignees.map((x) => x.userId);
    let convRow = await getProjectConversationRow(cid, pid);
    if (!convRow) {
        await createProjectConversationRow({
            companyId: cid,
            projectId: pid,
            participantIds: pids.length ? pids : [uid],
            groupName: name,
            groupAdminId: pids[0] || uid
        });
        convRow = await getProjectConversationRow(cid, pid);
    } else {
        if (!(await isUserInConversation(convRow.id, uid))) {
            const max = await m.ConversationParticipant.max('sortOrder', {
                where: { conversationId: convRow.id }
            });
            await m.ConversationParticipant.create({
                id: newObjectIdString(),
                conversationId: convRow.id,
                userId: uid,
                sortOrder: (max != null ? max : -1) + 1
            });
        }
        const cur = await participantUserIds(convRow.id);
        const curSet = new Set(cur.map(String));
        const setEq =
            pids.length === cur.length && pids.every((id) => curSet.has(String(id)));
        if (!setEq || String(convRow.groupName || '') !== String(name || '')) {
            await m.ConversationParticipant.destroy({ where: { conversationId: convRow.id } });
            let order = 0;
            for (const p of pids) {
                await m.ConversationParticipant.create({
                    id: newObjectIdString(),
                    conversationId: convRow.id,
                    userId: String(p),
                    sortOrder: order++
                });
            }
            await m.Conversation.update({ groupName: name }, { where: { id: convRow.id } });
        }
        convRow = await getProjectConversationRow(cid, pid);
    }
    return mapConversation(convRow, uid, m);
};

const createProjectConversationRow = async ({
    companyId,
    projectId,
    participantIds,
    groupName,
    groupAdminId
}) => {
    const m = requireModels();
    const sql = getSequelize();
    const convId = newObjectIdString();
    await sql.transaction(async (t) => {
        await m.Conversation.create(
            {
                id: convId,
                companyId: String(companyId),
                projectId: String(projectId),
                isGroup: true,
                groupName,
                groupAdminId: String(groupAdminId),
                unreadCount: {},
                lastMessageAt: new Date()
            },
            { transaction: t }
        );
        let order = 0;
        for (const uid of participantIds) {
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
    return m.Conversation.findByPk(convId);
};

const listUsersForChat = async (companyId, excludeUserId) => {
    const m = requireModels();
    const ucs = await m.UserCompany.findAll({
        where: { companyId: String(companyId) },
        attributes: ['userId']
    });
    const userIds = [...new Set(ucs.map((uc) => uc.userId).filter(Boolean))];
    const filteredIds = userIds.filter((id) => String(id) !== String(excludeUserId));
    const users = filteredIds.length
        ? await m.User.findAll({
              where: { id: filteredIds },
              attributes: ['id', 'name', 'email', 'title', 'role']
          })
        : [];
    const withMembership = await Promise.all(
        users.map(async (u) => {
            const lean = await authSql.findUserById(u.id);
            return lean || userToChatShape(u);
        })
    );
    return withMembership.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    );
};

const syncProjectConversationsAndList = async (companyId, userId, activeCompanyName) => {
    const m = requireModels();
    const cid = String(companyId);
    const uid = String(userId);
    const links = await m.ProjectAssignee.findAll({
        where: { userId: uid },
        attributes: ['projectId']
    });
    const projectIds = [...new Set(links.map((l) => l.projectId))];
    // Never return early: users with no project assignments still have direct (DM) chats.
    if (projectIds.length) {
        const assignedProjects = await m.Project.findAll({
            where: { id: { [Op.in]: projectIds }, companyId: cid }
        });
        for (const proj of assignedProjects) {
            const plain = proj.get ? proj.get({ plain: true }) : proj;
            let conv = await getProjectConversationRow(cid, plain.id);
            const assignees = await m.ProjectAssignee.findAll({ where: { projectId: plain.id } });
            const pids = assignees.map((x) => x.userId);
            if (!conv) {
                await createProjectConversationRow({
                    companyId: cid,
                    projectId: plain.id,
                    participantIds: pids.length ? pids : [uid],
                    groupName: plain.project_name,
                    groupAdminId: pids[0] || uid
                });
            } else {
                if (!(await isUserInConversation(conv.id, uid))) {
                    const max = await m.ConversationParticipant.max('sortOrder', {
                        where: { conversationId: conv.id }
                    });
                    await m.ConversationParticipant.create({
                        id: newObjectIdString(),
                        conversationId: conv.id,
                        userId: uid,
                        sortOrder: (max != null ? max : -1) + 1
                    });
                }
                const cur = await participantUserIds(conv.id);
                const setEq =
                    cur.length === pids.length && pids.every((id) => cur.map(String).includes(String(id)));
                if (!setEq || conv.groupName !== plain.project_name) {
                    await m.ConversationParticipant.destroy({ where: { conversationId: conv.id } });
                    let order = 0;
                    for (const pid of pids) {
                        await m.ConversationParticipant.create({
                            id: newObjectIdString(),
                            conversationId: conv.id,
                            userId: String(pid),
                            sortOrder: order++
                        });
                    }
                    await m.Conversation.update(
                        { groupName: plain.project_name },
                        { where: { id: conv.id } }
                    );
                }
            }
        }
    }

    const partRows = await m.ConversationParticipant.findAll({ where: { userId: uid } });
    const convIds = partRows.map((r) => r.conversationId);
    if (!convIds.length) return [];
    const convs = await m.Conversation.findAll({
        where: { id: { [Op.in]: convIds }, companyId: cid },
        order: [['lastMessageAt', 'DESC']]
    });
    const out = [];
    for (const c of convs) {
        const mapped = await mapConversation(c, uid, m);
        out.push(mapped);
    }
    return out;
};

const fetchMessagesPage = async ({ companyId, conversationId, page, limit, cursor }) => {
    const m = requireModels();
    const cap = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const where = {
        companyId: String(companyId),
        conversationId: String(conversationId),
        isDeleted: false
    };
    const cursorDate = cursor ? new Date(cursor) : null;
    const useCursor = cursorDate && Number.isFinite(cursorDate.getTime());
    let rows;
    let hasMore;
    let nextCursor = null;
    if (useCursor) {
        where.createdAt = { [Op.lt]: cursorDate };
        rows = await m.Message.findAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: cap + 1
        });
        hasMore = rows.length > cap;
        rows = hasMore ? rows.slice(0, cap) : rows;
        if (rows.length && hasMore) {
            const oldest = rows[rows.length - 1].get({ plain: true });
            nextCursor = new Date(oldest.createdAt).toISOString();
        }
    } else {
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        rows = await m.Message.findAll({
            where,
            order: [['createdAt', 'DESC']],
            limit: cap,
            offset: (pageNum - 1) * cap
        });
        hasMore = rows.length === cap;
    }
    const messages = [];
    for (const r of rows) {
        messages.push(await mapMessageFull(r, m));
    }
    messages.reverse();
    return { messages, hasMore, nextCursor: useCursor ? nextCursor : undefined, useCursor };
};

const markConversationMessagesRead = async (companyId, conversationId, readerUserId) => {
    const m = requireModels();
    const cid = String(conversationId);
    const msgs = await m.Message.findAll({
        where: {
            companyId: String(companyId),
            conversationId: cid,
            isDeleted: false,
            senderId: { [Op.ne]: String(readerUserId) }
        },
        attributes: ['id']
    });
    for (const msg of msgs) {
        await m.MessageReadBy.findOrCreate({
            where: { messageId: msg.id, userId: String(readerUserId) },
            defaults: { readAt: new Date() }
        });
    }
    const conv = await m.Conversation.findByPk(cid);
    if (conv) {
        const uc = { ...(conv.unreadCount || {}) };
        uc[String(readerUserId)] = 0;
        await conv.update({ unreadCount: uc });
    }
};

const bumpUnreadExceptSender = async (conversationId, senderId) => {
    const m = requireModels();
    const participants = await participantUserIds(conversationId);
    const conv = await m.Conversation.findByPk(String(conversationId));
    if (!conv) return;
    const uc = { ...(conv.unreadCount || {}) };
    for (const pid of participants) {
        if (String(pid) === String(senderId)) continue;
        const k = String(pid);
        uc[k] = (Number(uc[k]) || 0) + 1;
    }
    await conv.update({ unreadCount: uc });
};

const createTextMessage = async ({
    companyId,
    conversationId,
    senderId,
    senderName,
    senderEmail,
    content,
    replyToId,
    mentionIds
}) => {
    const m = requireModels();
    const sql = getSequelize();
    const mid = newObjectIdString();
    await sql.transaction(async (t) => {
        await m.Message.create(
            {
                id: mid,
                companyId: String(companyId),
                conversationId: String(conversationId),
                senderId: String(senderId),
                senderName,
                senderEmail: String(senderEmail).toLowerCase(),
                type: 'text',
                content: String(content).trim(),
                replyToId: replyToId ? String(replyToId) : null,
                isEdited: false,
                isDeleted: false,
                isThread: false,
                threadCount: 0
            },
            { transaction: t }
        );
        for (const men of mentionIds || []) {
            await m.MessageMention.create(
                { messageId: mid, userId: String(men) },
                { transaction: t }
            );
        }
        await m.Conversation.update(
            { lastMessageId: mid, lastMessageAt: new Date() },
            { where: { id: String(conversationId) }, transaction: t }
        );
    });
    const row = await m.Message.findByPk(mid);
    await bumpUnreadExceptSender(conversationId, senderId);
    return mapMessageFull(row, m);
};

const updateMessageContent = async (companyId, messageId, userId, content) => {
    const m = requireModels();
    const msg = await m.Message.findOne({
        where: { id: String(messageId), companyId: String(companyId) }
    });
    if (!msg) return { error: 'not_found' };
    if (String(msg.senderId) !== String(userId)) return { error: 'forbidden' };
    if (msg.type !== 'text') return { error: 'not_text' };
    await msg.update({
        content: String(content).trim(),
        isEdited: true,
        editedAt: new Date()
    });
    const row = await m.Message.findByPk(msg.id);
    return { message: await mapMessageFull(row, m), conversationId: msg.conversationId };
};

const softDeleteMessage = async (companyId, messageId, userId) => {
    const m = requireModels();
    const msg = await m.Message.findOne({
        where: { id: String(messageId), companyId: String(companyId) }
    });
    if (!msg) return { error: 'not_found' };
    if (String(msg.senderId) !== String(userId)) return { error: 'forbidden' };
    await msg.update({ isDeleted: true, deletedAt: new Date() });
    return { ok: true, conversationId: msg.conversationId };
};

const toggleReaction = async (companyId, messageId, userId, emoji) => {
    const m = requireModels();
    const msg = await m.Message.findOne({
        where: { id: String(messageId), companyId: String(companyId) }
    });
    if (!msg) return { error: 'not_found' };
    const e = String(emoji);
    const existing = await m.MessageReaction.findOne({
        where: { messageId: String(messageId), userId: String(userId), emoji: e }
    });
    if (existing) await existing.destroy();
    else {
        await m.MessageReaction.create({
            id: newObjectIdString(),
            messageId: String(messageId),
            userId: String(userId),
            emoji: e,
            createdAt: new Date()
        });
    }
    const reactions = await m.MessageReaction.findAll({ where: { messageId: String(messageId) } });
    const reactUsers = await loadUsersByIds(reactions.map((x) => x.userId));
    const ruById = new Map(reactUsers.map((u) => [u.id, userToChatShape(u)]));
    const reactionsOut = reactions.map((rx) => ({
        user: ruById.get(rx.userId) || { _id: rx.userId },
        emoji: rx.emoji,
        createdAt: rx.createdAt
    }));
    return {
        messageId: String(messageId),
        reactions: reactionsOut,
        conversationId: msg.conversationId
    };
};

const createThreadReply = async ({
    companyId,
    conversationId,
    parentMessageId,
    senderId,
    senderName,
    senderEmail,
    type,
    content,
    fileUrl,
    fileName,
    fileSize,
    mimeType
}) => {
    const m = requireModels();
    const sql = getSequelize();
    const mid = newObjectIdString();
    let newThreadCount = 0;
    let parentMissing = false;
    await sql.transaction(async (t) => {
        const parent = await m.Message.findOne({
            where: {
                id: String(parentMessageId),
                companyId: String(companyId),
                conversationId: String(conversationId)
            },
            transaction: t
        });
        if (!parent) {
            parentMissing = true;
            return;
        }
        await m.Message.create(
            {
                id: mid,
                companyId: String(companyId),
                conversationId: String(conversationId),
                senderId: String(senderId),
                senderName,
                senderEmail: String(senderEmail).toLowerCase(),
                type: type || 'text',
                content: content != null ? String(content).trim() : null,
                fileUrl: fileUrl || null,
                fileName: fileName || null,
                fileSize: fileSize != null ? fileSize : null,
                mimeType: mimeType || null,
                parentMessageId: String(parentMessageId),
                isThread: true,
                isDeleted: false,
                isEdited: false,
                threadCount: 0
            },
            { transaction: t }
        );
        newThreadCount = (parent.threadCount || 0) + 1;
        await parent.update({ threadCount: newThreadCount }, { transaction: t });
    });
    if (parentMissing) return { error: 'parent_not_found' };
    await bumpUnreadExceptSender(conversationId, senderId);
    const row = await m.Message.findByPk(mid);
    return { message: await mapMessageFull(row, m), threadCount: newThreadCount };
};

const getThreadPage = async (companyId, parentMessageId) => {
    const m = requireModels();
    const parentRow = await m.Message.findOne({
        where: { id: String(parentMessageId), companyId: String(companyId) }
    });
    if (!parentRow) return { error: 'not_found' };
    const parentMessage = await mapMessageFull(parentRow, m);
    const replies = await m.Message.findAll({
        where: {
            companyId: String(companyId),
            parentMessageId: String(parentMessageId),
            isDeleted: false
        },
        order: [['createdAt', 'ASC']]
    });
    const threadReplies = [];
    for (const r of replies) {
        threadReplies.push(await mapMessageFull(r, m));
    }
    return { parentMessage, threadReplies, threadCount: threadReplies.length };
};

const createFileMessage = async ({
    companyId,
    conversationId,
    senderId,
    senderName,
    senderEmail,
    type,
    fileUrl,
    fileName,
    fileSize,
    mimeType,
    content,
    replyToId
}) => {
    const m = requireModels();
    const sql = getSequelize();
    const mid = newObjectIdString();
    await sql.transaction(async (t) => {
        await m.Message.create(
            {
                id: mid,
                companyId: String(companyId),
                conversationId: String(conversationId),
                senderId: String(senderId),
                senderName,
                senderEmail: String(senderEmail).toLowerCase(),
                type,
                content: content != null ? String(content) : null,
                fileUrl,
                fileName,
                fileSize,
                mimeType,
                replyToId: replyToId ? String(replyToId) : null,
                isEdited: false,
                isDeleted: false,
                isThread: false,
                threadCount: 0
            },
            { transaction: t }
        );
        await m.Conversation.update(
            { lastMessageId: mid, lastMessageAt: new Date() },
            { where: { id: String(conversationId) }, transaction: t }
        );
    });
    const row = await m.Message.findByPk(mid);
    await bumpUnreadExceptSender(conversationId, senderId);
    return mapMessageFull(row, m);
};

const adminSyncProjectConversations = async (companyId, adminUserId) => {
    const m = requireModels();
    const projects = await m.Project.findAll({ where: { companyId: String(companyId) } });
    let created = 0;
    let updated = 0;
    let existing = 0;
    const aid = String(adminUserId);
    for (const proj of projects) {
        const plain = proj.get({ plain: true });
        const assignees = await m.ProjectAssignee.findAll({ where: { projectId: plain.id } });
        const pids = assignees.map((x) => x.userId);
        let conv = await getProjectConversationRow(companyId, plain.id);
        if (!conv) {
            await createProjectConversationRow({
                companyId: String(companyId),
                projectId: plain.id,
                participantIds: pids.length ? pids : [aid],
                groupName: plain.project_name,
                groupAdminId: pids[0] || aid
            });
            created++;
        } else {
            const participantIds = pids.map(String);
            const currentParticipantIds = await participantUserIds(conv.id);
            const curSet = new Set(currentParticipantIds.map(String));
            const needsUpdate =
                participantIds.length !== currentParticipantIds.length ||
                !participantIds.every((id) => curSet.has(String(id))) ||
                String(conv.groupName || '') !== String(plain.project_name || '');
            if (needsUpdate) {
                await m.ConversationParticipant.destroy({ where: { conversationId: conv.id } });
                let order = 0;
                for (const pid of pids) {
                    await m.ConversationParticipant.create({
                        id: newObjectIdString(),
                        conversationId: conv.id,
                        userId: String(pid),
                        sortOrder: order++
                    });
                }
                await m.Conversation.update(
                    { groupName: plain.project_name },
                    { where: { id: conv.id } }
                );
                updated++;
            } else {
                existing++;
            }
        }
    }
    return { created, updated, existing, total: projects.length };
};

module.exports = {
    requireModels,
    newObjectIdString,
    loadUsersByIds,
    userToChatShape,
    mapMessageFull,
    mapConversation,
    participantUserIds,
    isUserInConversation,
    ensureDirectConversation,
    getProjectConversationRow,
    ensureProjectChatConversation,
    createProjectConversationRow,
    listUsersForChat,
    syncProjectConversationsAndList,
    fetchMessagesPage,
    markConversationMessagesRead,
    createTextMessage,
    bumpUnreadExceptSender,
    updateMessageContent,
    softDeleteMessage,
    toggleReaction,
    createThreadReply,
    getThreadPage,
    createFileMessage,
    adminSyncProjectConversations
};

