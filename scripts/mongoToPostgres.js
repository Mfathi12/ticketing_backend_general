#!/usr/bin/env node
/**
 * ETL: copy MongoDB (Mongoose) data into PostgreSQL (Sequelize).
 *
 * Prerequisites: DATABASE_URL, MONGODB_URI in .env (or environment).
 *
 * Usage:
 *   node scripts/mongoToPostgres.js
 *   node scripts/mongoToPostgres.js --truncate        # TRUNCATE app tables first (destructive)
 *   node scripts/mongoToPostgres.js --sync            # sequelize.sync() — create missing tables
 *   node scripts/mongoToPostgres.js --sync-alter      # sequelize.sync({ alter: true }) before import
 *   node scripts/mongoToPostgres.js --verify          # after import, print Mongo vs Postgres counts
 *   node scripts/mongoToPostgres.js --verify-only     # no writes; compare counts only
 *
 * npm run migrate:mongo-to-pg:full   → --sync-alter --verify (recommended after schema changes)
 * npm run migrate:mongo-to-pg:fresh  → --truncate --sync-alter --verify (wipe Postgres app tables first)
 * npm run migrate:mongo-to-pg:verify → --verify-only
 *
 * Optional: POSTGRES_SSL=true, MIGRATE_SYNC_ALTER=true (same as --sync-alter)
 */

require('dotenv').config();
const dns = require('dns');
try {
    dns.setServers(['1.1.1.1', '8.8.8.8']);
} catch (_) {
    /* ignore */
}
const mongoose = require('mongoose');
const { Sequelize } = require('sequelize');
const { defineModels } = require('../db/sequelize/models');

const MongoUser = require('../models/user');
const MongoCompany = require('../models/company');
const MongoProject = require('../models/project');
const MongoTicket = require('../models/ticket');
const { Conversation: MongoConversation, Message: MongoMessage } = require('../models/chat');
const MongoNotification = require('../models/notification');
const MongoAttendance = require('../models/attendance');
const MongoVersion = require('../models/version');
const MongoSubscriptionPlanContent = require('../models/subscriptionPlanContent');
const MongoPlanCatalogOverride = require('../models/planCatalogOverride');
const MongoProjectPersonalNote = require('../models/projectPersonalNote');

const oid = (v) => {
    if (v == null) return null;
    if (typeof v === 'object' && v._id != null) return String(v._id);
    return String(v);
};

const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
};

const mongoMapToObject = (m) => {
    if (!m) return {};
    if (m instanceof Map) return Object.fromEntries(m.entries());
    if (typeof m === 'object' && !Array.isArray(m)) return { ...m };
    return {};
};

const parseBool = (v, d = false) => {
    if (v == null) return d;
    const x = String(v).trim().toLowerCase();
    return x === '1' || x === 'true' || x === 'yes';
};

const bulk = async (Model, rows, label) => {
    if (!rows.length) return;
    let n = 0;
    for (const part of chunk(rows, 250)) {
        await Model.bulkCreate(part, { ignoreDuplicates: true });
        n += part.length;
    }
    console.log(`  ${label}: ${n} rows`);
};

const pad = (s, w) => String(s).padEnd(w);
const rowLine = (a, b, c, d) =>
    `${pad(a, 28)} ${pad(b, 12)} ${pad(c, 12)} ${d || ''}`;

async function countPostgresRows(m) {
    const [
        users,
        companies,
        userFcmTokens,
        userCompanies,
        companyMembers,
        projects,
        projectAssignees,
        tickets,
        ticketHandlers,
        ticketCc,
        ticketImages,
        ticketReplies,
        ticketReplyImages,
        conversations,
        conversationParticipants,
        messages,
        messageReadBy,
        messageMentions,
        messageReactions,
        notifications,
        attendances,
        versions,
        subscriptionPlanContents,
        planCatalogOverrides,
        projectPersonalNotes
    ] = await Promise.all([
        m.User.count(),
        m.Company.count(),
        m.UserFcmToken.count(),
        m.UserCompany.count(),
        m.CompanyMember.count(),
        m.Project.count(),
        m.ProjectAssignee.count(),
        m.Ticket.count(),
        m.TicketHandler.count(),
        m.TicketCc.count(),
        m.TicketImage.count(),
        m.TicketReply.count(),
        m.TicketReplyImage.count(),
        m.Conversation.count(),
        m.ConversationParticipant.count(),
        m.Message.count(),
        m.MessageReadBy.count(),
        m.MessageMention.count(),
        m.MessageReaction.count(),
        m.Notification.count(),
        m.Attendance.count(),
        m.Version.count(),
        m.SubscriptionPlanContent.count(),
        m.PlanCatalogOverride.count(),
        m.ProjectPersonalNote.count()
    ]);
    return {
        users,
        companies,
        userFcmTokens,
        userCompanies,
        companyMembers,
        projects,
        projectAssignees,
        tickets,
        ticketHandlers,
        ticketCc,
        ticketImages,
        ticketReplies,
        ticketReplyImages,
        conversations,
        conversationParticipants,
        messages,
        messageReadBy,
        messageMentions,
        messageReactions,
        notifications,
        attendances,
        versions,
        subscriptionPlanContents,
        planCatalogOverrides,
        projectPersonalNotes
    };
}

async function verifyOnly() {
    const mongoUri = process.env.MONGODB_URI;
    const databaseUrl = process.env.DATABASE_URL;
    if (!mongoUri) {
        console.error('MONGODB_URI is required');
        process.exit(1);
    }
    if (!databaseUrl) {
        console.error('DATABASE_URL is required');
        process.exit(1);
    }
    const ssl = parseBool(process.env.POSTGRES_SSL, false);
    const sequelize = new Sequelize(databaseUrl, {
        dialect: 'postgres',
        logging: false,
        dialectOptions: ssl ? { ssl: { require: true, rejectUnauthorized: false } } : undefined
    });
    await sequelize.authenticate();
    const m = defineModels(sequelize);

    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        family: 4
    });

    const [
        mongoUsers,
        mongoCompanies,
        mongoProjects,
        mongoTicketsTotal,
        mongoTicketsWithProject,
        mongoConversations,
        mongoMessagesTotal,
        mongoMessagesMigratable,
        mongoNotifications,
        mongoAttendances,
        mongoVersions,
        mongoSubPlans,
        mongoPlanOverrides,
        mongoPersonalNotes
    ] = await Promise.all([
        MongoUser.countDocuments(),
        MongoCompany.countDocuments(),
        MongoProject.countDocuments(),
        MongoTicket.countDocuments(),
        MongoTicket.countDocuments({
            project: { $exists: true, $ne: null }
        }),
        MongoConversation.countDocuments(),
        MongoMessage.countDocuments(),
        MongoMessage.countDocuments({
            conversation: { $exists: true, $ne: null },
            sender: { $exists: true, $ne: null }
        }),
        MongoNotification.countDocuments(),
        MongoAttendance.countDocuments(),
        MongoVersion.countDocuments(),
        MongoSubscriptionPlanContent.countDocuments(),
        MongoPlanCatalogOverride.countDocuments(),
        MongoProjectPersonalNote.countDocuments()
    ]);

    const pg = await countPostgresRows(m);

    console.log('\n--- Verification (Mongo source vs PostgreSQL) ---');
    console.log(rowLine('entity', 'mongo', 'postgres', 'note'));
    console.log(rowLine('-'.repeat(26), '-'.repeat(10), '-'.repeat(10), ''));
    console.log(rowLine('users', mongoUsers, pg.users, mongoUsers === pg.users ? 'OK' : 'MISMATCH'));
    console.log(rowLine('companies', mongoCompanies, pg.companies, mongoCompanies === pg.companies ? 'OK' : 'MISMATCH'));
    console.log(rowLine('projects', mongoProjects, pg.projects, mongoProjects === pg.projects ? 'OK' : 'MISMATCH'));
    console.log(
        rowLine(
            'tickets (with project)',
            mongoTicketsWithProject,
            pg.tickets,
            mongoTicketsWithProject === pg.tickets ? 'OK' : 'CHECK'
        )
    );
    if (mongoTicketsTotal !== mongoTicketsWithProject) {
        console.log(
            rowLine(
                'tickets (skipped, no project)',
                mongoTicketsTotal - mongoTicketsWithProject,
                '—',
                'not imported'
            )
        );
    }
    console.log(
        rowLine(
            'conversations',
            mongoConversations,
            pg.conversations,
            mongoConversations === pg.conversations ? 'OK' : 'MISMATCH'
        )
    );
    console.log(
        rowLine(
            'messages (migratable)',
            mongoMessagesMigratable,
            pg.messages,
            mongoMessagesMigratable === pg.messages ? 'OK' : 'CHECK'
        )
    );
    if (mongoMessagesTotal !== mongoMessagesMigratable) {
        console.log(
            rowLine(
                'messages (skipped)',
                mongoMessagesTotal - mongoMessagesMigratable,
                '—',
                'no conv/sender'
            )
        );
    }
    console.log(rowLine('notifications', mongoNotifications, pg.notifications, ''));
    console.log(rowLine('attendances', mongoAttendances, pg.attendances, ''));
    console.log(rowLine('versions', mongoVersions, pg.versions, ''));
    console.log(rowLine('subscription_plan_contents', mongoSubPlans, pg.subscriptionPlanContents, ''));
    console.log(rowLine('plan_catalog_overrides', mongoPlanOverrides, pg.planCatalogOverrides, ''));
    console.log(rowLine('project_personal_notes', mongoPersonalNotes, pg.projectPersonalNotes, ''));
    console.log(rowLine('user_fcm_tokens', '(embedded)', pg.userFcmTokens, ''));
    console.log(rowLine('user_companies', '(embedded)', pg.userCompanies, ''));
    console.log(rowLine('company_members', '(embedded)', pg.companyMembers, ''));
    console.log(rowLine('project_assignees', '(embedded)', pg.projectAssignees, ''));
    console.log(rowLine('ticket_handlers', '(embedded)', pg.ticketHandlers, ''));
    console.log(rowLine('ticket_cc', '(embedded)', pg.ticketCc, ''));
    console.log(rowLine('ticket_images', '(embedded)', pg.ticketImages, ''));
    console.log(rowLine('ticket_replies', '(embedded)', pg.ticketReplies, ''));
    console.log(rowLine('ticket_reply_images', '(embedded)', pg.ticketReplyImages, ''));
    console.log(rowLine('conversation_participants', '(embedded)', pg.conversationParticipants, ''));
    console.log(rowLine('message_read_by', '(embedded)', pg.messageReadBy, ''));
    console.log(rowLine('message_mentions', '(embedded)', pg.messageMentions, ''));
    console.log(rowLine('message_reactions', '(embedded)', pg.messageReactions, ''));
    console.log('--- end verification ---\n');

    await mongoose.disconnect();
    await sequelize.close();
}

async function printVerificationAfterImport(m, stats) {
    const pg = await countPostgresRows(m);
    console.log('\n--- Post-import verification ---');
    console.log(rowLine('entity', 'expected', 'postgres', ''));
    console.log(rowLine('-'.repeat(26), '-'.repeat(10), '-'.repeat(10), ''));
    const checks = [
        ['users', stats.userRows, pg.users],
        ['companies', stats.companyRows, pg.companies],
        ['projects', stats.projectRows, pg.projects],
        ['tickets', stats.ticketRows, pg.tickets],
        ['conversations', stats.convRows, pg.conversations],
        ['messages', stats.msgRows, pg.messages],
        ['notifications', stats.notifRows, pg.notifications],
        ['attendances', stats.attRows, pg.attendances],
        ['versions', stats.verRows, pg.versions],
        ['subscription_plan_contents', stats.spRows, pg.subscriptionPlanContents],
        ['plan_catalog_overrides', stats.poRows, pg.planCatalogOverrides],
        ['project_personal_notes', stats.pnRows, pg.projectPersonalNotes]
    ];
    for (const [name, exp, got] of checks) {
        const ok = exp === got ? 'OK' : 'MISMATCH';
        console.log(rowLine(name, exp, got, ok));
    }
    if (stats.ticketsSkippedNoProject > 0) {
        console.log(
            rowLine('tickets skipped (no project)', stats.ticketsSkippedNoProject, '—', 'see Mongo')
        );
    }
    if (stats.messagesSkipped > 0) {
        console.log(rowLine('messages skipped', stats.messagesSkipped, '—', 'no conv/sender'));
    }
    console.log('--- end ---\n');
}

async function main() {
    const args = new Set(process.argv.slice(2));
    if (args.has('--verify-only')) {
        await verifyOnly();
        return;
    }

    const truncate = args.has('--truncate');
    const syncAlter = args.has('--sync-alter') || parseBool(process.env.MIGRATE_SYNC_ALTER, false);
    const syncCreate = args.has('--sync') || parseBool(process.env.MIGRATE_SYNC, false);
    const runVerify = args.has('--verify');

    const mongoUri = process.env.MONGODB_URI;
    const databaseUrl = process.env.DATABASE_URL;
    if (!mongoUri) {
        console.error('MONGODB_URI is required');
        process.exit(1);
    }
    if (!databaseUrl) {
        console.error('DATABASE_URL is required');
        process.exit(1);
    }

    const ssl = parseBool(process.env.POSTGRES_SSL, false);
    const sequelize = new Sequelize(databaseUrl, {
        dialect: 'postgres',
        logging: false,
        dialectOptions: ssl ? { ssl: { require: true, rejectUnauthorized: false } } : undefined
    });

    await sequelize.authenticate();
    console.log('PostgreSQL: connected');

    const m = defineModels(sequelize);

    if (syncAlter) {
        console.log('Running sequelize.sync({ alter: true })...');
        await sequelize.sync({ alter: true });
    } else if (syncCreate) {
        console.log('Running sequelize.sync()...');
        await sequelize.sync();
    }

    if (truncate) {
        console.log('Truncating app tables (CASCADE)...');
        await sequelize.query(`
            TRUNCATE TABLE
                message_reactions,
                message_mentions,
                message_read_by,
                messages,
                conversation_participants,
                conversations,
                notifications,
                attendances,
                ticket_cc,
                ticket_handlers,
                ticket_images,
                ticket_reply_images,
                ticket_replies,
                tickets,
                project_assignees,
                project_personal_notes,
                projects,
                user_fcm_tokens,
                user_companies,
                company_members,
                companies,
                users,
                versions,
                plan_catalog_overrides,
                subscription_plan_contents
            RESTART IDENTITY CASCADE;
        `);
    }

    console.log('Connecting MongoDB...');
    await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        family: 4
    });
    console.log('MongoDB: connected');

    console.log('Reading Mongo collections...');
    const users = await MongoUser.find({}).lean();
    const companies = await MongoCompany.find({}).lean();
    const projects = await MongoProject.find({}).lean();
    const tickets = await MongoTicket.find({}).lean();
    const conversations = await MongoConversation.find({}).lean();
    const messages = await MongoMessage.find({}).lean();
    const notifications = await MongoNotification.find({}).lean();
    const attendances = await MongoAttendance.find({}).lean();
    const versions = await MongoVersion.find({}).lean();
    const subPlans = await MongoSubscriptionPlanContent.find({}).lean();
    const planOverrides = await MongoPlanCatalogOverride.find({}).lean();
    const personalNotes = await MongoProjectPersonalNote.find({}).lean();

    console.log('Migrating users...');
    const userRows = users.map((u) => {
        const inv = u.invite || {};
        return {
            id: oid(u._id),
            name: u.name,
            title: u.title != null && String(u.title).trim() !== '' ? u.title : 'Member',
            email: u.email,
            emailVerified: u.emailVerified,
            registrationEmailPending: u.registrationEmailPending,
            password: u.password || null,
            role: u.role || 'user',
            accountStatus: u.accountStatus || 'active',
            lastLoginAt: u.lastLoginAt || null,
            inviteTokenHash: inv.tokenHash ?? null,
            inviteExpiresAt: inv.expiresAt ?? null,
            inviteAcceptedAt: inv.acceptedAt ?? null,
            inviteInvitedByUserId: inv.invitedBy != null ? oid(inv.invitedBy) : null,
            inviteCompanyId: inv.company != null ? oid(inv.company) : null,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt
        };
    });
    await bulk(m.User, userRows, 'users');

    console.log('Migrating companies...');
    const companyRows = companies.map((c) => {
        const s = c.subscription || {};
        return {
            id: oid(c._id),
            name: c.name,
            email: c.email,
            ownerUserId: oid(c.ownerUser),
            platformStatus: c.platformStatus || 'active',
            deletedAt: c.deletedAt || null,
            subscriptionPlanId: s.planId || 'free',
            subscriptionStatus: s.status || 'active',
            subscriptionIsTrial: Boolean(s.isTrial),
            subscriptionTrialEndsAt: s.trialEndsAt || null,
            subscriptionExpiresAt: s.expiresAt || null,
            subscriptionGraceEndsAt: s.graceEndsAt || null,
            subscriptionPendingPlanId: s.pendingPlanId || null,
            paymobOrderId: s.paymobOrderId != null ? String(s.paymobOrderId) : null,
            paymobTransactionId: s.paymobTransactionId != null ? String(s.paymobTransactionId) : null,
            paymobSubscriptionId: s.paymobSubscriptionId != null ? String(s.paymobSubscriptionId) : null,
            subscriptionUpdatedAt: s.updatedAt || c.updatedAt || new Date(),
            lastBillingFailureAt: s.lastBillingFailureAt || null,
            lastBillingFailureReason: s.lastBillingFailureReason || null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
        };
    });
    await bulk(m.Company, companyRows, 'companies');

    console.log('Migrating user_fcm_tokens + user_companies...');
    const fcmRows = [];
    const ucRows = [];
    const ucSeen = new Set();
    for (const u of users) {
        const uid = oid(u._id);
        for (const t of u.fcmTokens || []) {
            if (t && String(t).trim()) {
                fcmRows.push({
                    id: new mongoose.Types.ObjectId().toString(),
                    userId: uid,
                    token: String(t).trim(),
                    createdAt: u.updatedAt || new Date(),
                    updatedAt: u.updatedAt || new Date()
                });
            }
        }
        for (const entry of u.companies || []) {
            const cid = oid(entry.company);
            if (!cid) continue;
            const key = `${uid}:${cid}`;
            if (ucSeen.has(key)) continue;
            ucSeen.add(key);
            ucRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                userId: uid,
                companyId: cid,
                displayName: entry.displayName != null ? String(entry.displayName).trim() : null,
                companyRole: entry.companyRole || 'user',
                isOwner: Boolean(entry.isOwner),
                createdAt: u.updatedAt || new Date(),
                updatedAt: u.updatedAt || new Date()
            });
        }
    }
    await bulk(m.UserFcmToken, fcmRows, 'user_fcm_tokens');
    await bulk(m.UserCompany, ucRows, 'user_companies');

    console.log('Migrating company_members...');
    const cmRows = [];
    const cmSeen = new Set();
    for (const c of companies) {
        const cid = oid(c._id);
        for (const mem of c.members || []) {
            const uid = oid(mem.user);
            if (!uid) continue;
            const key = `${cid}:${uid}`;
            if (cmSeen.has(key)) continue;
            cmSeen.add(key);
            cmRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                companyId: cid,
                userId: uid,
                role: mem.role || 'user',
                isOwner: Boolean(mem.isOwner),
                createdAt: c.updatedAt || new Date(),
                updatedAt: c.updatedAt || new Date()
            });
        }
    }
    await bulk(m.CompanyMember, cmRows, 'company_members');

    console.log('Migrating projects...');
    const projectRows = projects.map((p) => ({
        id: oid(p._id),
        project_name: p.project_name,
        start_date: p.start_date,
        estimated_end_date: p.estimated_end_date,
        companyId: p.company != null ? oid(p.company) : null,
        status: p.status || 'active',
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    }));
    await bulk(m.Project, projectRows, 'projects');

    console.log('Migrating project_assignees...');
    const paRows = [];
    const paSeen = new Set();
    for (const p of projects) {
        const pid = oid(p._id);
        for (const uidRaw of p.assigned_users || []) {
            const uid = oid(uidRaw);
            if (!uid) continue;
            const key = `${pid}:${uid}`;
            if (paSeen.has(key)) continue;
            paSeen.add(key);
            paRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                projectId: pid,
                userId: uid,
                createdAt: p.updatedAt || new Date(),
                updatedAt: p.updatedAt || new Date()
            });
        }
    }
    await bulk(m.ProjectAssignee, paRows, 'project_assignees');

    console.log('Migrating tickets + children...');
    const ticketRows = [];
    const handlerRows = [];
    const ccRows = [];
    const tImgRows = [];
    const replyRows = [];
    const replyImgRows = [];
    let ticketsSkippedNoProject = 0;
    for (const t of tickets) {
        if (!t.project) {
            ticketsSkippedNoProject += 1;
            continue;
        }
        const tid = oid(t._id);
        ticketRows.push({
            id: tid,
            companyId: t.company != null ? oid(t.company) : null,
            projectId: oid(t.project),
            ticket: t.ticket,
            requested_from: t.requested_from,
            requested_from_email: t.requested_from_email,
            requested_to: t.requested_to,
            requested_to_email: t.requested_to_email,
            date: t.date || t.createdAt,
            time: t.time || null,
            description: t.description,
            status: t.status || 'open',
            priority: t.priority || null,
            comment: t.comment || null,
            end_date: t.end_date || null,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt
        });
        for (const h of t.handler || []) {
            if (!h) continue;
            handlerRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                ticketId: tid,
                handlerEmail: String(h).toLowerCase().trim(),
                createdAt: t.updatedAt || new Date(),
                updatedAt: t.updatedAt || new Date()
            });
        }
        for (const c of t.cc || []) {
            if (!c) continue;
            ccRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                ticketId: tid,
                ccEmail: String(c).toLowerCase().trim(),
                createdAt: t.updatedAt || new Date(),
                updatedAt: t.updatedAt || new Date()
            });
        }
        for (const img of t.images || []) {
            if (!img) continue;
            tImgRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                ticketId: tid,
                imageUrl: String(img),
                createdAt: t.updatedAt || new Date(),
                updatedAt: t.updatedAt || new Date()
            });
        }
        for (const r of t.replies || []) {
            if (!r.userId) continue;
            const rid = r._id != null ? oid(r._id) : new mongoose.Types.ObjectId().toString();
            replyRows.push({
                id: rid,
                ticketId: tid,
                userId: oid(r.userId),
                user: r.user,
                userEmail: r.userEmail,
                comment: r.comment,
                createdAt: r.createdAt || t.updatedAt,
                updatedAt: r.updatedAt || t.updatedAt
            });
            for (const img of r.images || []) {
                if (!img) continue;
                replyImgRows.push({
                    id: new mongoose.Types.ObjectId().toString(),
                    ticketReplyId: rid,
                    imageUrl: String(img),
                    createdAt: r.updatedAt || t.updatedAt,
                    updatedAt: r.updatedAt || t.updatedAt
                });
            }
        }
    }
    await bulk(m.Ticket, ticketRows, 'tickets');
    await bulk(m.TicketHandler, handlerRows, 'ticket_handlers');
    await bulk(m.TicketCc, ccRows, 'ticket_cc');
    await bulk(m.TicketImage, tImgRows, 'ticket_images');
    await bulk(m.TicketReply, replyRows, 'ticket_replies');
    await bulk(m.TicketReplyImage, replyImgRows, 'ticket_reply_images');

    console.log('Migrating conversations + participants...');
    const convRows = conversations.map((c) => ({
        id: oid(c._id),
        companyId: c.company != null ? oid(c.company) : null,
        lastMessageId: c.lastMessage != null ? oid(c.lastMessage) : null,
        lastMessageAt: c.lastMessageAt || c.updatedAt,
        unreadCount: mongoMapToObject(c.unreadCount),
        isGroup: Boolean(c.isGroup),
        groupName: c.groupName || null,
        groupDescription: c.groupDescription || null,
        groupAdminId: c.groupAdmin != null ? oid(c.groupAdmin) : null,
        projectId: c.project != null ? oid(c.project) : null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
    }));
    await bulk(m.Conversation, convRows, 'conversations');

    const partRows = [];
    let order = 0;
    for (const c of conversations) {
        const cid = oid(c._id);
        const parts = c.participants || [];
        parts.forEach((p, idx) => {
            const uid = oid(p);
            if (!uid) return;
            partRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                conversationId: cid,
                userId: uid,
                sortOrder: idx
            });
        });
    }
    await bulk(m.ConversationParticipant, partRows, 'conversation_participants');

    console.log('Migrating messages + read / mentions / reactions...');
    const msgRows = [];
    const readRows = [];
    const mentionRows = [];
    const reactRows = [];
    let messagesSkipped = 0;
    for (const msg of messages) {
        if (!msg.conversation || !msg.sender) {
            messagesSkipped += 1;
            continue;
        }
        const mid = oid(msg._id);
        msgRows.push({
            id: mid,
            companyId: msg.company != null ? oid(msg.company) : null,
            conversationId: oid(msg.conversation),
            senderId: oid(msg.sender),
            senderName: msg.senderName,
            senderEmail: msg.senderEmail,
            type: msg.type || 'text',
            content: msg.content || null,
            fileUrl: msg.fileUrl || null,
            fileName: msg.fileName || null,
            fileSize: msg.fileSize != null ? Number(msg.fileSize) : null,
            mimeType: msg.mimeType || null,
            duration: msg.duration != null ? Number(msg.duration) : null,
            thumbnail: msg.thumbnail || null,
            replyToId: msg.replyTo != null ? oid(msg.replyTo) : null,
            isEdited: Boolean(msg.isEdited),
            editedAt: msg.editedAt || null,
            isDeleted: Boolean(msg.isDeleted),
            deletedAt: msg.deletedAt || null,
            parentMessageId: msg.parentMessage != null ? oid(msg.parentMessage) : null,
            isThread: Boolean(msg.isThread),
            threadCount: Number(msg.threadCount || 0),
            createdAt: msg.createdAt,
            updatedAt: msg.updatedAt
        });
        for (const rb of msg.readBy || []) {
            const uid = oid(rb.user);
            if (!uid) continue;
            readRows.push({
                messageId: mid,
                userId: uid,
                readAt: rb.readAt || new Date()
            });
        }
        for (const men of msg.mentions || []) {
            const uid = oid(men);
            if (!uid) continue;
            mentionRows.push({ messageId: mid, userId: uid });
        }
        for (const rx of msg.reactions || []) {
            const uid = oid(rx.user);
            if (!uid) continue;
            reactRows.push({
                id: new mongoose.Types.ObjectId().toString(),
                messageId: mid,
                userId: uid,
                emoji: rx.emoji || null,
                createdAt: rx.createdAt || msg.updatedAt
            });
        }
    }
    await bulk(m.Message, msgRows, 'messages');
    await bulk(m.MessageReadBy, readRows, 'message_read_by');
    await bulk(m.MessageMention, mentionRows, 'message_mentions');
    await bulk(m.MessageReaction, reactRows, 'message_reactions');

    console.log('Migrating notifications...');
    const notifRows = notifications.map((n) => ({
        id: oid(n._id),
        companyId: n.company != null ? oid(n.company) : null,
        userId: oid(n.user),
        type: n.type,
        title: n.title,
        body: n.body != null ? n.body : '',
        data: n.data && typeof n.data === 'object' ? n.data : {},
        read: Boolean(n.read),
        readAt: n.readAt || null,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt
    }));
    await bulk(m.Notification, notifRows, 'notifications');

    console.log('Migrating attendances...');
    const attRows = attendances.map((a) => ({
        id: oid(a._id),
        companyId: a.company != null ? oid(a.company) : null,
        userId: oid(a.user),
        date: a.date,
        checkIn: a.checkIn,
        continuousCheckIn: a.continuousCheckIn || null,
        checkOut: a.checkOut || null,
        duration: Number(a.duration || 0),
        status: a.status || 'present',
        note: a.note || null,
        checkInLatitude: a.checkInLatitude != null ? Number(a.checkInLatitude) : null,
        checkInLongitude: a.checkInLongitude != null ? Number(a.checkInLongitude) : null,
        checkOutLatitude: a.checkOutLatitude != null ? Number(a.checkOutLatitude) : null,
        checkOutLongitude: a.checkOutLongitude != null ? Number(a.checkOutLongitude) : null,
        lastEditedByUserId: a.lastEditedBy != null ? oid(a.lastEditedBy) : null,
        lastEditedAt: a.lastEditedAt || null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt
    }));
    await bulk(m.Attendance, attRows, 'attendances');

    console.log('Migrating versions, plan content, overrides, personal notes...');
    const verRows = versions.map((v) => ({
        id: oid(v._id),
        version: v.version,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt
    }));
    await bulk(m.Version, verRows, 'versions');

    const spRows = subPlans.map((d) => ({
        id: oid(d._id),
        planId: d.planId,
        translations: d.translations || {},
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
    }));
    await bulk(m.SubscriptionPlanContent, spRows, 'subscription_plan_contents');

    const poRows = planOverrides.map((d) => ({
        id: oid(d._id),
        planId: d.planId,
        name: d.name || null,
        description: d.description || null,
        price: d.price != null ? Number(d.price) : null,
        currency: d.currency || null,
        billingPeriod: d.billingPeriod || null,
        features: d.features != null ? d.features : null,
        isActive: d.isActive,
        isPopular: d.isPopular,
        trialDays: d.trialDays != null ? Number(d.trialDays) : null,
        paymobIntegrationId: d.paymobIntegrationId != null ? Number(d.paymobIntegrationId) : null,
        paymobSubscriptionPlanId:
            d.paymobSubscriptionPlanId != null ? Number(d.paymobSubscriptionPlanId) : null,
        limits: d.limits != null ? d.limits : null,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
    }));
    await bulk(m.PlanCatalogOverride, poRows, 'plan_catalog_overrides');

    const pnRows = personalNotes.map((n) => ({
        id: oid(n._id),
        projectId: oid(n.project),
        userId: oid(n.user),
        content: n.content,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt
    }));
    await bulk(m.ProjectPersonalNote, pnRows, 'project_personal_notes');

    if (ticketsSkippedNoProject > 0) {
        console.log(`  Note: skipped ${ticketsSkippedNoProject} Mongo tickets with no project (not imported).`);
    }
    if (messagesSkipped > 0) {
        console.log(
            `  Note: skipped ${messagesSkipped} Mongo messages missing conversation or sender (not imported).`
        );
    }

    if (runVerify) {
        await printVerificationAfterImport(m, {
            userRows: userRows.length,
            companyRows: companyRows.length,
            projectRows: projectRows.length,
            ticketRows: ticketRows.length,
            convRows: convRows.length,
            msgRows: msgRows.length,
            notifRows: notifRows.length,
            attRows: attRows.length,
            verRows: verRows.length,
            spRows: spRows.length,
            poRows: poRows.length,
            pnRows: pnRows.length,
            ticketsSkippedNoProject,
            messagesSkipped
        });
    }

    console.log('Done.');
    await mongoose.disconnect();
    await sequelize.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
