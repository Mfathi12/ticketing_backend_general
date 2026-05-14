const express = require('express');
const { Conversation, Message } = require('../models/chat');
const { User, Project, Company } = require('../models');
const { fetchUsersByIdMap } = require('../utils/userBatch');
const { createNotification } = require('../services/notificationService');
const { authenticateToken, canBypassProjectAssignment, getRequestDisplayName } = require('../middleware/auth');
const { getCompanyPlan } = require('../services/subscriptionService');
const { toAbsoluteMediaUrl } = require('../utils/mediaUrl');
const { isPostgresPrimary } = require('../services/sql/runtime');
const chatSql = require('../services/sql/chatSql');
const authSql = require('../services/sql/authSql');
const projectSql = require('../services/sql/projectSql');
const multer = require('multer');
const path = require('path');
const fs = require('fs');


const router = express.Router();
const membershipCompanyId = (entry) => {
    if (!entry) return null;
    const raw = entry.companyId ?? entry.company;
    if (!raw) return null;
    if (typeof raw === 'object' && raw._id) return String(raw._id);
    return String(raw);
};

/** Tell both users to refetch chat list (e.g. new DM created). */
const emitChatConversationsRefresh = (req, userIds = []) => {
    const io = req.app.get('io');
    if (!io || !Array.isArray(userIds) || !userIds.length) return;
    const payload = { type: 'chat_conversations_changed', timestamp: new Date().toISOString() };
    const seen = new Set();
    for (const raw of userIds) {
        if (raw == null) continue;
        const id = String(raw);
        if (seen.has(id)) continue;
        seen.add(id);
        io.to(`user:${id}`).emit('chat_conversations_changed', payload);
    }
};

/** Socket rooms are `user:<jwt user id>` — normalize ObjectId / populated user / string. */
const socketUserId = (raw) => {
    if (raw == null) return '';
    if (typeof raw === 'object' && raw._id != null) return String(raw._id);
    return String(raw);
};

const emitToUserRoom = (io, rawUserId, event, payload) => {
    const uid = socketUserId(rawUserId);
    if (!io || !uid) return;
    io.to(`user:${uid}`).emit(event, payload);
};

/** Mongoose participant ids are ObjectIds; Array#includes fails across instances with the same id */
const isConversationParticipant = (conversation, userId) => {
    if (!conversation?.participants?.length || !userId) return false;
    const uid = String(userId);
    return conversation.participants.some((p) => String(p) === uid);
};

const normalizeIncomingFileUrl = (req, rawUrl) => {
    const input = String(rawUrl || '').trim();
    if (!input) return '';
    return toAbsoluteMediaUrl(input, req);
};

const hydrateMessageFileUrl = (req, messageDoc) => {
    if (!messageDoc || !messageDoc.fileUrl) return messageDoc;
    const message = messageDoc.toObject ? messageDoc.toObject() : { ...messageDoc };
    message.fileUrl = toAbsoluteMediaUrl(message.fileUrl, req);
    return message;
};

const hydrateMessagesFileUrls = (req, messages = []) => messages.map((message) => hydrateMessageFileUrl(req, message));
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
const attachUserDisplayName = (userDoc, companyId, fallbackCompanyName = null) => {
    if (!userDoc) return userDoc;
    const base = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
    return {
        ...base,
        name: resolveMembershipDisplayName(userDoc, companyId, fallbackCompanyName)
    };
};
const attachConversationDisplayNames = (conversationDoc, companyId, fallbackCompanyName = null) => {
    if (!conversationDoc) return conversationDoc;
    const conversation = conversationDoc.toObject ? conversationDoc.toObject() : { ...conversationDoc };
    if (Array.isArray(conversation.participants)) {
        conversation.participants = conversation.participants.map((p) =>
            attachUserDisplayName(p, companyId, fallbackCompanyName)
        );
    }
    return conversation;
};
const attachMessageDisplayName = (messageDoc, companyId, fallbackCompanyName = null) => {
    if (!messageDoc) return messageDoc;
    const message = messageDoc.toObject ? messageDoc.toObject() : { ...messageDoc };
    if (message.sender && typeof message.sender === 'object') {
        message.sender = attachUserDisplayName(message.sender, companyId, fallbackCompanyName);
    }
    if (Array.isArray(message.mentions)) {
        message.mentions = message.mentions.map((u) =>
            attachUserDisplayName(u, companyId, fallbackCompanyName)
        );
    }
    if (Array.isArray(message.reactions)) {
        message.reactions = message.reactions.map((reaction) => ({
            ...reaction,
            user: reaction?.user && typeof reaction.user === 'object'
                ? attachUserDisplayName(reaction.user, companyId, fallbackCompanyName)
                : reaction?.user
        }));
    }
    return message;
};
const attachMessagesDisplayName = (messages = [], companyId, fallbackCompanyName = null) =>
    messages.map((message) => attachMessageDisplayName(message, companyId, fallbackCompanyName));

// Derive file extension from mimetype when missing (e.g. images from some clients)
const getExtFromMimetype = (mimetype, fieldname) => {
    if (!mimetype) return '';
    if (fieldname === 'voice') return '.webm';
    if (mimetype.startsWith('image/')) {
        const map = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp' };
        return map[mimetype.toLowerCase()] || ('.' + mimetype.split('/')[1].split(';')[0].replace('+xml', ''));
    }
    if (mimetype.startsWith('video/')) return path.extname('.mp4') || '.mp4';
    return '';
};

// Configure multer for chat file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Put images in 'image' folder even when sent as field 'file'
        const isImage = file.mimetype && file.mimetype.startsWith('image/');
        const uploadType = (file.fieldname === 'file' && isImage) ? 'image' : (file.fieldname || 'file');
        const uploadDir = path.join(__dirname, '../uploads/chat', uploadType);

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        let ext = path.extname(file.originalname);
        if (!ext) ext = getExtFromMimetype(file.mimetype, file.fieldname);
        cb(null, `file-${uniqueSuffix}${ext}`);
    }
});

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;

const fileFilter = (req, file, cb) => {
    const fieldname = file.fieldname;
    const mimetype = file.mimetype || '';
    const isImageMime = mimetype.startsWith('image/');
    const hasImageExt = file.originalname && IMAGE_EXTENSIONS.test(file.originalname);

    if (fieldname === 'voice') {
        if (mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Only audio files are allowed for voice messages'), false);
        }
    } else if (fieldname === 'image') {
        // Allow image MIME or unknown MIME with image extension (some clients send wrong mimetype)
        if (isImageMime || (mimetype === 'application/octet-stream' && hasImageExt)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    } else if (fieldname === 'video') {
        // Allow video files (limit to short videos)
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'), false);
        }
    } else if (fieldname === 'file') {
        // Allow any file; images sent as "file" will be stored as type "image" in route
        cb(null, true);
    } else {
        cb(new Error('Invalid file type'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB max file size
    }
});

const ensureChatAttachmentAllowed = async (req, res, next) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }

        let company;
        if (isPostgresPrimary()) {
            company = await authSql.loadCompanyForSubscription(activeCompanyId);
        } else {
            company = await Company.findById(activeCompanyId).select('subscription');
        }
        if (!company) {
            return res.status(404).json({ message: 'Company not found' });
        }

        const plan = getCompanyPlan(company);
        if (!plan?.limits?.canUploadChatAttachments) {
            return res.status(403).json({
                message: 'Chat attachments are not available on Free plan. Please upgrade your subscription.',
                planId: plan.id
            });
        }

        next();
    } catch (error) {
        console.error('Chat attachment subscription check error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Get or create conversation between two users
router.post('/conversation', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { participantId } = req.body;

        if (!participantId) {
            return res.status(400).json({ message: 'Participant ID is required' });
        }

        if (participantId === req.user._id.toString()) {
            return res.status(400).json({ message: 'Cannot create conversation with yourself' });
        }

        if (isPostgresPrimary()) {
            const participant = await authSql.findUserById(participantId);
            if (!participant) {
                return res.status(404).json({ message: 'Participant not found' });
            }
            const participantInCompany = (participant.companies || []).some(
                (m) => membershipCompanyId(m) === activeCompanyId
            );
            if (!participantInCompany) {
                return res.status(403).json({ message: 'Participant is not in active company' });
            }
            const conversation = await chatSql.ensureDirectConversation(
                activeCompanyId,
                req.user._id,
                participantId,
                req.user._id
            );
            const convOut = attachConversationDisplayNames(
                conversation,
                activeCompanyId,
                req.activeCompanyName || null
            );
            emitChatConversationsRefresh(req, [req.user._id, participantId]);
            return res.json({
                conversation: convOut
            });
        }

        // Check if participant exists
        const participant = await User.findById(participantId);
        if (!participant) {
            return res.status(404).json({ message: 'Participant not found' });
        }
        const participantInCompany = (participant.companies || []).some(
            (m) => membershipCompanyId(m) === activeCompanyId
        );
        if (!participantInCompany) {
            return res.status(403).json({ message: 'Participant is not in active company' });
        }

        // Find existing conversation
        let conversation = await Conversation.findOne({
            company: activeCompanyId,
            isGroup: false,
            participants: { $all: [req.user._id, participantId] }
        }).populate('participants', 'name email title role');

        // Create new conversation if doesn't exist
        if (!conversation) {
            conversation = new Conversation({
                company: activeCompanyId,
                participants: [req.user._id, participantId],
                isGroup: false
            });
            await conversation.save();
            await conversation.populate('participants', 'name email title role');
        }

        emitChatConversationsRefresh(req, [req.user._id, participantId]);
        res.json({
            conversation: attachConversationDisplayNames(
                conversation,
                activeCompanyId,
                req.activeCompanyName || null
            )
        });
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get or create project conversation
router.get('/project/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }

        if (isPostgresPrimary()) {
            const project = await projectSql.getProjectByIdWithAssignees(projectId);
            if (!project || String(project.company) !== String(activeCompanyId)) {
                return res.status(404).json({ message: 'Project not found' });
            }
            const isAssigned = project.assigned_users.some(
                (user) => String(user._id || user.id) === req.user._id.toString()
            );
            if (!isAssigned && !canBypassProjectAssignment(req)) {
                return res.status(403).json({ message: 'You are not assigned to this project' });
            }
            const conversation = await chatSql.ensureProjectChatConversation(
                activeCompanyId,
                project,
                req.user._id
            );
            const userIdKey = req.user._id.toString();
            const readUnread = (raw) => {
                if (raw == null) return 0;
                if (typeof raw.get === 'function') return Number(raw.get(userIdKey)) || 0;
                return Number(raw[userIdKey]) || 0;
            };
            const unread = readUnread(conversation.unreadCount);
            const conversationWithDisplayNames = attachConversationDisplayNames(
                conversation,
                activeCompanyId,
                req.activeCompanyName || null
            );
            return res.json({
                conversation: {
                    ...conversationWithDisplayNames,
                    unreadCount: unread
                }
            });
        }

        // Verify project exists
        const project = await Project.findOne({ _id: projectId, company: activeCompanyId }).populate('assigned_users', 'name email title role');
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        // Check if user is assigned to project
        const isAssigned = project.assigned_users.some(
            user => user._id.toString() === req.user._id.toString()
        );

        if (!isAssigned && !canBypassProjectAssignment(req)) {
            return res.status(403).json({ message: 'You are not assigned to this project' });
        }

        // Find or create project conversation
        let conversation = await Conversation.findOne({ project: projectId })
            .where({ company: activeCompanyId })
            .populate('participants', 'name email title role')
            .populate('lastMessage')
            .populate('project', 'project_name');

        if (!conversation) {
            // Create new project conversation
            conversation = new Conversation({
                company: activeCompanyId,
                participants: project.assigned_users.map(u => u._id),
                isGroup: true,
                groupName: project.project_name,
                project: projectId,
                groupAdmin: req.user._id
            });
            await conversation.save();
            await conversation.populate('participants', 'name email title role');
            await conversation.populate('project', 'project_name');
        } else {
            // Ensure current user is in participants (in case they were just assigned)
            if (!conversation.participants.some(p => p._id.toString() === req.user._id.toString())) {
                conversation.participants.push(req.user._id);
                await conversation.save();
                await conversation.populate('participants', 'name email title role');
            }
        }

        // Get unread count
        const unread = conversation.unreadCount.get(req.user._id.toString()) || 0;

        const conversationWithDisplayNames = attachConversationDisplayNames(
            conversation,
            activeCompanyId,
            req.activeCompanyName || null
        );
        res.json({
            conversation: {
                ...conversationWithDisplayNames,
                unreadCount: unread
            }
        });
    } catch (error) {
        console.error('Get project conversation error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get all users for starting a new conversation - MUST be before parameterized routes
router.get('/users', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }

        if (isPostgresPrimary()) {
            const users = await chatSql.listUsersForChat(activeCompanyId, req.user._id);
            const company = await authSql.findCompanyById(activeCompanyId);
            return res.json({
                users: users.map((u) => attachUserDisplayName(u, activeCompanyId, company?.name || null))
            });
        }

        const users = await User.find({
            _id: { $ne: req.user._id },
            'companies.company': activeCompanyId
        })
            .select('name email title role companies')
            .sort({ name: 1 })
            .lean();

        const company = await Company.findById(activeCompanyId).select('name').lean();
        res.json({
            users: users.map((u) => attachUserDisplayName(u, activeCompanyId, company?.name || null))
        });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get all conversations for the logged-in user
router.get('/conversations', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }

        if (isPostgresPrimary()) {
            const conversations = await chatSql.syncProjectConversationsAndList(
                activeCompanyId,
                req.user._id,
                req.activeCompanyName || null
            );
            const userIdKey = req.user._id.toString();
            const readUnread = (raw) => {
                if (raw == null) return 0;
                if (typeof raw.get === 'function') return Number(raw.get(userIdKey)) || 0;
                return Number(raw[userIdKey]) || 0;
            };
            const conversationsWithUnread = conversations.map((conv) => {
                const unread = readUnread(conv.unreadCount);
                const conversationObj = attachConversationDisplayNames(
                    conv,
                    activeCompanyId,
                    req.activeCompanyName || null
                );
                if (conversationObj.lastMessage?.fileUrl) {
                    conversationObj.lastMessage.fileUrl = toAbsoluteMediaUrl(
                        conversationObj.lastMessage.fileUrl,
                        req
                    );
                }
                return {
                    ...conversationObj,
                    unreadCount: unread
                };
            });
            return res.json({ conversations: conversationsWithUnread });
        }

        // First, ensure all projects the user is assigned to have conversations
        const userProjects = await Project.find({
            assigned_users: req.user._id,
            company: activeCompanyId
        }).populate('assigned_users');

        for (const project of userProjects) {
            let conversation = await Conversation.findOne({ project: project._id, company: activeCompanyId });

            if (!conversation) {
                // Create missing project conversation
                try {
                    conversation = new Conversation({
                        company: activeCompanyId,
                        participants: project.assigned_users.map(u => u._id),
                        isGroup: true,
                        groupName: project.project_name,
                        project: project._id,
                        groupAdmin: project.assigned_users[0]?._id || req.user._id
                    });
                    await conversation.save();
                    console.log(`Auto-created conversation for project: ${project.project_name}`);
                } catch (convError) {
                    console.error(`Error creating conversation for project ${project.project_name}:`, convError);
                }
            } else {
                // Ensure user is in participants (in case they were just assigned)
                const participantIds = conversation.participants.map(p => p.toString());
                const userId = req.user._id.toString();

                if (!participantIds.includes(userId)) {
                    conversation.participants.push(req.user._id);
                    await conversation.save();
                    console.log(`Added user to project conversation: ${project.project_name}`);
                }

                // Update participants if project participants changed
                const projectParticipantIds = project.assigned_users.map(u => u._id.toString());
                const needsUpdate = projectParticipantIds.length !== participantIds.length ||
                    !projectParticipantIds.every(id => participantIds.includes(id)) ||
                    conversation.groupName !== project.project_name;

                if (needsUpdate) {
                    conversation.participants = project.assigned_users.map(u => u._id);
                    conversation.groupName = project.project_name;
                    await conversation.save();
                    console.log(`Updated project conversation: ${project.project_name}`);
                }
            }
        }

        // Now get all conversations for the user.
        // .lean() returns plain JS objects (no Mongoose hydration). NOTE:
        // under .lean() the `unreadCount` Map is delivered as a plain object,
        // so we read it via index access (works for both Map and plain
        // object, keeping JSON output identical via res.json).
        const conversations = await Conversation.find({
            company: activeCompanyId,
            participants: req.user._id
        })
            .populate('participants', 'name email title role')
            .populate('lastMessage')
            .populate('project', 'project_name')
            .sort({ lastMessageAt: -1 })
            .lean();

        // Get unread count for each conversation (Map-or-plain-object safe)
        const userIdKey = req.user._id.toString();
        const readUnread = (raw) => {
            if (raw == null) return 0;
            if (typeof raw.get === 'function') return Number(raw.get(userIdKey)) || 0;
            return Number(raw[userIdKey]) || 0;
        };
        const conversationsWithUnread = conversations.map((conv) => {
            const unread = readUnread(conv.unreadCount);
            const conversationObj = attachConversationDisplayNames(
                conv,
                activeCompanyId,
                req.activeCompanyName || null
            );
            if (conversationObj.lastMessage?.fileUrl) {
                conversationObj.lastMessage.fileUrl = toAbsoluteMediaUrl(conversationObj.lastMessage.fileUrl, req);
            }
            return {
                ...conversationObj,
                unreadCount: unread
            };
        });

        res.json({ conversations: conversationsWithUnread });
    } catch (error) {
        console.error('Get conversations error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get messages for a conversation
//
// Pagination modes (both supported, backward compatible):
//   1) Legacy:  ?page=N&limit=M           -> { messages, hasMore }     (existing contract)
//   2) Cursor:  ?cursor=<ISO ts>&limit=M  -> { messages, hasMore, nextCursor }
//
// The legacy response shape is preserved exactly when ?cursor is not supplied.
// `nextCursor` is only added when ?cursor is provided, so existing clients
// remain unaffected.
router.get('/conversation/:conversationId/messages', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { conversationId } = req.params;
        const { page = 1, limit = 50, cursor } = req.query;

        if (isPostgresPrimary()) {
            const m = chatSql.requireModels();
            const convRow = await m.Conversation.findOne({
                where: { id: String(conversationId), companyId: String(activeCompanyId) }
            });
            if (!convRow) {
                return res.status(404).json({ message: 'Conversation not found' });
            }
            if (!(await chatSql.isUserInConversation(conversationId, req.user._id))) {
                return res.status(403).json({ message: 'Access denied' });
            }
            const cursorDate = cursor ? new Date(cursor) : null;
            const useCursor = cursorDate && Number.isFinite(cursorDate.getTime());
            const { messages, hasMore, nextCursor } = await chatSql.fetchMessagesPage({
                companyId: activeCompanyId,
                conversationId,
                page,
                limit,
                cursor
            });
            await chatSql.markConversationMessagesRead(
                activeCompanyId,
                conversationId,
                req.user._id
            );
            const messagesWithDisplayNames = attachMessagesDisplayName(
                messages,
                activeCompanyId,
                req.activeCompanyName || null
            );
            const payload = {
                messages: hydrateMessagesFileUrls(req, messagesWithDisplayNames),
                hasMore
            };
            if (useCursor) {
                payload.nextCursor = nextCursor;
            }
            return res.json(payload);
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findOne({ _id: conversationId, company: activeCompanyId });
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!isConversationParticipant(conversation, req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const cap = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
        const cursorDate = cursor ? new Date(cursor) : null;
        const useCursor = cursorDate && Number.isFinite(cursorDate.getTime());

        const baseQuery = {
            company: activeCompanyId,
            conversation: conversationId,
            isDeleted: false
        };

        let messages;
        let hasMore;
        let nextCursor = null;

        if (useCursor) {
            // Cursor mode: pull cap+1 strictly older than cursor; uses
            // { conversation, createdAt:-1 } index, no skip cost.
            // .lean() returns plain JS objects (no Mongoose hydration),
            // which dominates per-message latency for large pages.
            const docs = await Message.find({ ...baseQuery, createdAt: { $lt: cursorDate } })
                .populate('sender', 'name email title role')
                .populate('replyTo')
                .populate('mentions', 'name email')
                .sort({ createdAt: -1 })
                .limit(cap + 1)
                .lean();

            hasMore = docs.length > cap;
            messages = hasMore ? docs.slice(0, cap) : docs;
            if (messages.length && hasMore) {
                const oldest = messages[messages.length - 1];
                if (oldest && oldest.createdAt) {
                    nextCursor = new Date(oldest.createdAt).toISOString();
                }
            }
        } else {
            // Legacy skip/limit mode (preserved exactly).
            // .lean() returns plain JS objects (no Mongoose hydration).
            const pageNum = Math.max(1, parseInt(page, 10) || 1);
            messages = await Message.find(baseQuery)
                .populate('sender', 'name email title role')
                .populate('replyTo')
                .populate('mentions', 'name email')
                .sort({ createdAt: -1 })
                .limit(cap)
                .skip((pageNum - 1) * cap)
                .lean();
            hasMore = messages.length === cap;
        }

        // Mark messages as read
        await Message.updateMany(
            {
                company: activeCompanyId,
                conversation: conversationId,
                sender: { $ne: req.user._id },
                'readBy.user': { $ne: req.user._id }
            },
            {
                $push: {
                    readBy: {
                        user: req.user._id,
                        readAt: new Date()
                    }
                }
            }
        );

        // Reset unread count
        conversation.unreadCount.set(req.user._id.toString(), 0);
        await conversation.save();

        const messagesWithDisplayNames = attachMessagesDisplayName(
            messages.reverse(),
            activeCompanyId,
            req.activeCompanyName || null
        );

        const payload = {
            messages: hydrateMessagesFileUrls(req, messagesWithDisplayNames), // Reverse to show oldest first
            hasMore
        };
        if (useCursor) {
            payload.nextCursor = nextCursor;
        }
        res.json(payload);
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Send text message
router.post('/message', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { conversationId, content, replyTo, mentions } = req.body;

        if (!conversationId || !content || !content.trim()) {
            return res.status(400).json({ message: 'Conversation ID and content are required' });
        }

        if (isPostgresPrimary()) {
            const m = chatSql.requireModels();
            const convRow = await m.Conversation.findOne({
                where: { id: String(conversationId), companyId: String(activeCompanyId) }
            });
            if (!convRow) {
                return res.status(404).json({ message: 'Conversation not found' });
            }
            if (!(await chatSql.isUserInConversation(conversationId, req.user._id))) {
                return res.status(403).json({ message: 'Access denied' });
            }
            const messagePayload = await chatSql.createTextMessage({
                companyId: activeCompanyId,
                conversationId,
                senderId: req.user._id,
                senderName: getRequestDisplayName(req),
                senderEmail: req.user.email,
                content,
                replyToId: replyTo || null,
                mentionIds: mentions || []
            });
            const io = req.app.get('io');
            const senderName = getRequestDisplayName(req);
            const textPreview = (content || '').slice(0, 100);
            const participantIds = await chatSql.participantUserIds(conversationId);
            if (io) {
                const convIdStr = String(conversationId);
                for (const participantId of participantIds) {
                    if (String(participantId) !== req.user._id.toString()) {
                        emitToUserRoom(io, participantId, 'new_chat_message', {
                            type: 'new_chat_message',
                            conversationId: convIdStr,
                            message: messagePayload,
                            timestamp: new Date()
                        });
                    }
                }
            }
            try {
                const otherParticipantIds = participantIds.filter(
                    (pid) => String(pid) !== req.user._id.toString()
                );
                const participantMap = await fetchUsersByIdMap(otherParticipantIds);
                for (const participantId of otherParticipantIds) {
                    const participantUser = participantMap.get(String(participantId));
                    if (!participantUser) continue;
                    await createNotification(
                        participantUser._id,
                        {
                            company: activeCompanyId,
                            type: 'chat_message',
                            title: `New message from ${senderName}`,
                            body: textPreview || 'New chat message',
                            data: { conversationId: String(conversationId) }
                        },
                        { userDoc: participantUser }
                    );
                }
            } catch (fcmError) {
                console.error('FCM error for chat text message:', fcmError);
            }
            return res.status(201).json({
                message: attachMessageDisplayName(
                    messagePayload,
                    activeCompanyId,
                    req.activeCompanyName || null
                )
            });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findOne({ _id: conversationId, company: activeCompanyId });
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!isConversationParticipant(conversation, req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Create message
        const message = new Message({
            company: activeCompanyId,
            conversation: conversationId,
            sender: req.user._id,
            senderName: getRequestDisplayName(req),
            senderEmail: req.user.email,
            type: 'text',
            content: content.trim(),
            replyTo: replyTo || undefined,
            mentions: mentions || []
        });

        await message.save();
        await message.populate('sender', 'name email title role');
        if (replyTo) await message.populate('replyTo');
        if (mentions && mentions.length > 0) await message.populate('mentions', 'name email');

        // Update conversation
        conversation.lastMessage = message._id;
        conversation.lastMessageAt = new Date();

        // Increment unread count for other participants
        conversation.participants.forEach(participantId => {
            if (participantId.toString() !== req.user._id.toString()) {
                const currentUnread = conversation.unreadCount.get(participantId.toString()) || 0;
                conversation.unreadCount.set(participantId.toString(), currentUnread + 1);
            }
        });

        await conversation.save();

        // Emit socket event and FCM notifications
        const io = req.app.get('io');
        const senderName = getRequestDisplayName(req);
        const textPreview = (content || '').slice(0, 100);

        if (io) {
            const convIdStr = String(conversationId);
            conversation.participants.forEach(participantId => {
                if (participantId.toString() !== req.user._id.toString()) {
                    emitToUserRoom(io, participantId, 'new_chat_message', {
                        type: 'new_chat_message',
                        conversationId: convIdStr,
                        message: message, // Send fully populated message
                        timestamp: new Date()
                    });
                }
            });
        }

        // Send FCM push notification to other participants
        try {
            const otherParticipantIds = conversation.participants.filter(
                (participantId) => participantId.toString() !== req.user._id.toString()
            );
            const participantMap = await fetchUsersByIdMap(otherParticipantIds);
            for (const participantId of otherParticipantIds) {
                const participantUser = participantMap.get(participantId.toString());
                if (!participantUser) continue;

                await createNotification(participantUser._id, {
                    company: activeCompanyId,
                    type: 'chat_message',
                    title: `New message from ${senderName}`,
                    body: textPreview || 'New chat message',
                    data: { conversationId: String(conversationId) }
                }, { userDoc: participantUser });
            }
        } catch (fcmError) {
            console.error('FCM error for chat text message:', fcmError);
        }

        res.status(201).json({
            message: attachMessageDisplayName(message, activeCompanyId, req.activeCompanyName || null)
        });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Edit message
router.put('/message/:messageId', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { messageId } = req.params;
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ message: 'Content is required' });
        }

        if (isPostgresPrimary()) {
            const result = await chatSql.updateMessageContent(
                activeCompanyId,
                messageId,
                req.user._id,
                content
            );
            if (result.error === 'not_found') {
                return res.status(404).json({ message: 'Message not found' });
            }
            if (result.error === 'forbidden') {
                return res.status(403).json({ message: 'You can only edit your own messages' });
            }
            if (result.error === 'not_text') {
                return res.status(400).json({ message: 'Only text messages can be edited' });
            }
            const messageObj = result.message;
            const participantIds = await chatSql.participantUserIds(result.conversationId);
            const io = req.app.get('io');
            if (io) {
                const convIdStr = String(result.conversationId);
                for (const participantId of participantIds) {
                    emitToUserRoom(io, participantId, 'message_updated', {
                        type: 'message_updated',
                        conversationId: convIdStr,
                        message: messageObj
                    });
                }
            }
            return res.json({
                message: attachMessageDisplayName(
                    messageObj,
                    activeCompanyId,
                    req.activeCompanyName || null
                )
            });
        }

        const message = await Message.findOne({ _id: messageId, company: activeCompanyId });
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        if (message.sender.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'You can only edit your own messages' });
        }

        if (message.type !== 'text') {
            return res.status(400).json({ message: 'Only text messages can be edited' });
        }

        message.content = content.trim();
        message.isEdited = true;
        message.editedAt = new Date();
        await message.save();

        await message.populate('sender', 'name email title role');
        await message.populate('replyTo');
        await message.populate('mentions', 'name email');

        // Emit socket event
        const messageObj = message.toObject ? message.toObject() : message;
        const conversation = await Conversation.findOne({ _id: message.conversation, company: activeCompanyId });
        const io = req.app.get('io');
        if (io && conversation) {
            const convIdStr = String(message.conversation);
            conversation.participants.forEach(participantId => {
                emitToUserRoom(io, participantId, 'message_updated', {
                    type: 'message_updated',
                    conversationId: convIdStr,
                    message: messageObj
                });
            });
        }

        res.json({
            message: attachMessageDisplayName(message, activeCompanyId, req.activeCompanyName || null)
        });
    } catch (error) {
        console.error('Edit message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Delete message
router.delete('/message/:messageId', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { messageId } = req.params;

        if (isPostgresPrimary()) {
            const result = await chatSql.softDeleteMessage(activeCompanyId, messageId, req.user._id);
            if (result.error === 'not_found') {
                return res.status(404).json({ message: 'Message not found' });
            }
            if (result.error === 'forbidden') {
                return res.status(403).json({ message: 'You can only delete your own messages' });
            }
            const participantIds = await chatSql.participantUserIds(result.conversationId);
            const io = req.app.get('io');
            if (io) {
                const convIdStr = String(result.conversationId);
                const msgIdStr = String(messageId);
                for (const participantId of participantIds) {
                    emitToUserRoom(io, participantId, 'message_deleted', {
                        type: 'message_deleted',
                        conversationId: convIdStr,
                        messageId: msgIdStr
                    });
                }
            }
            return res.json({ message: 'Message deleted successfully' });
        }

        const message = await Message.findOne({ _id: messageId, company: activeCompanyId });
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        if (message.sender.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'You can only delete your own messages' });
        }

        message.isDeleted = true;
        message.deletedAt = new Date();
        await message.save();

        // Emit socket event
        const conversation = await Conversation.findOne({ _id: message.conversation, company: activeCompanyId });
        const io = req.app.get('io');
        if (io && conversation) {
            const convIdStr = String(message.conversation);
            const msgIdStr = String(messageId);
            conversation.participants.forEach(participantId => {
                emitToUserRoom(io, participantId, 'message_deleted', {
                    type: 'message_deleted',
                    conversationId: convIdStr,
                    messageId: msgIdStr
                });
            });
        }

        res.json({ message: 'Message deleted successfully' });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Add/Remove Reaction
router.post('/message/:messageId/reaction', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { messageId } = req.params;
        const { emoji } = req.body;

        if (!emoji) {
            return res.status(400).json({ message: 'Emoji is required' });
        }

        if (isPostgresPrimary()) {
            const result = await chatSql.toggleReaction(activeCompanyId, messageId, req.user._id, emoji);
            if (result.error === 'not_found') {
                return res.status(404).json({ message: 'Message not found' });
            }
            const participantIds = await chatSql.participantUserIds(result.conversationId);
            const io = req.app.get('io');
            if (io) {
                const convIdStr = String(result.conversationId);
                const msgIdStr = String(messageId);
                for (const participantId of participantIds) {
                    emitToUserRoom(io, participantId, 'message_reaction_updated', {
                        type: 'message_reaction_updated',
                        conversationId: convIdStr,
                        messageId: msgIdStr,
                        reactions: result.reactions
                    });
                }
            }
            return res.json({
                messageId: result.messageId,
                reactions: attachMessageDisplayName(
                    { reactions: result.reactions },
                    activeCompanyId,
                    req.activeCompanyName || null
                ).reactions
            });
        }

        const message = await Message.findOne({ _id: messageId, company: activeCompanyId });
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        // Check if user already reacted with this emoji
        const existingReactionIndex = message.reactions.findIndex(
            r => r.user.toString() === req.user._id.toString() && r.emoji === emoji
        );

        if (existingReactionIndex > -1) {
            // Remove reaction
            message.reactions.splice(existingReactionIndex, 1);
        } else {
            // Add reaction
            message.reactions.push({
                user: req.user._id,
                emoji,
                createdAt: new Date()
            });
        }

        await message.save();
        await message.populate('reactions.user', 'name email');

        // Emit socket event
        const conversation = await Conversation.findOne({ _id: message.conversation, company: activeCompanyId });
        const io = req.app.get('io');
        if (io && conversation) {
            const convIdStr = String(message.conversation);
            const msgIdStr = String(messageId);
            conversation.participants.forEach(participantId => {
                emitToUserRoom(io, participantId, 'message_reaction_updated', {
                    type: 'message_reaction_updated',
                    conversationId: convIdStr,
                    messageId: msgIdStr,
                    reactions: message.reactions
                });
            });
        }

        res.json({
            messageId,
            reactions: attachMessageDisplayName(
                { reactions: message.reactions },
                activeCompanyId,
                req.activeCompanyName || null
            ).reactions
        });
    } catch (error) {
        console.error('Reaction error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Create thread reply
router.post('/message/:messageId/thread', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { messageId } = req.params;
        const { content, type = 'text', fileUrl, fileName, fileSize, mimeType } = req.body;

        if (isPostgresPrimary()) {
            const m = chatSql.requireModels();
            const parentRow = await m.Message.findOne({
                where: { id: String(messageId), companyId: String(activeCompanyId) }
            });
            if (!parentRow) {
                return res.status(404).json({ message: 'Parent message not found' });
            }
            const convId = parentRow.conversationId;
            const convRow = await m.Conversation.findOne({
                where: { id: String(convId), companyId: String(activeCompanyId) }
            });
            if (!convRow) {
                return res.status(404).json({ message: 'Conversation not found' });
            }
            if (!(await chatSql.isUserInConversation(convId, req.user._id))) {
                return res.status(403).json({ message: 'Access denied' });
            }
            const threadResult = await chatSql.createThreadReply({
                companyId: activeCompanyId,
                conversationId: convId,
                parentMessageId: messageId,
                senderId: req.user._id,
                senderName: getRequestDisplayName(req),
                senderEmail: req.user.email,
                type,
                content,
                fileUrl: toAbsoluteMediaUrl(fileUrl, req),
                fileName,
                fileSize,
                mimeType
            });
            if (threadResult.error === 'parent_not_found') {
                return res.status(404).json({ message: 'Parent message not found' });
            }
            const io = req.app.get('io');
            if (io) {
                const participantIds = await chatSql.participantUserIds(convId);
                const convIdStr = String(convId);
                const parentIdStr = String(messageId);
                for (const participantId of participantIds) {
                    emitToUserRoom(io, participantId, 'thread_reply', {
                        type: 'thread_reply',
                        conversationId: convIdStr,
                        parentMessageId: parentIdStr,
                        message: threadResult.message,
                        threadCount: threadResult.threadCount
                    });
                }
            }
            return res.status(201).json({
                message: hydrateMessageFileUrl(
                    req,
                    attachMessageDisplayName(
                        threadResult.message,
                        activeCompanyId,
                        req.activeCompanyName || null
                    )
                ),
                threadCount: threadResult.threadCount
            });
        }

        // Validate parent message exists
        const parentMessage = await Message.findOne({ _id: messageId, company: activeCompanyId });
        if (!parentMessage) {
            return res.status(404).json({ message: 'Parent message not found' });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findOne({ _id: parentMessage.conversation, company: activeCompanyId });
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!isConversationParticipant(conversation, req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Create thread reply
        const threadReply = new Message({
            company: activeCompanyId,
            conversation: parentMessage.conversation,
            sender: req.user._id,
            senderName: getRequestDisplayName(req),
            senderEmail: req.user.email,
            type,
            content: content?.trim(),
            fileUrl: toAbsoluteMediaUrl(fileUrl, req),
            fileName,
            fileSize,
            mimeType,
            parentMessage: messageId,
            isThread: true
        });

        await threadReply.save();
        await threadReply.populate('sender', 'name email title role');

        // Update parent message thread count
        parentMessage.threadCount = (parentMessage.threadCount || 0) + 1;
        await parentMessage.save();

        // Emit socket event for thread reply
        const io = req.app.get('io');
        if (io) {
            const convIdStr = String(parentMessage.conversation);
            const parentIdStr = String(messageId);
            conversation.participants.forEach(participantId => {
                emitToUserRoom(io, participantId, 'thread_reply', {
                    type: 'thread_reply',
                    conversationId: convIdStr,
                    parentMessageId: parentIdStr,
                    message: threadReply,
                    threadCount: parentMessage.threadCount
                });
            });
        }

        res.status(201).json({
            message: hydrateMessageFileUrl(
                req,
                attachMessageDisplayName(threadReply, activeCompanyId, req.activeCompanyName || null)
            ),
            threadCount: parentMessage.threadCount
        });
    } catch (error) {
        console.error('Create thread reply error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get thread replies
router.get('/message/:messageId/thread', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { messageId } = req.params;

        if (isPostgresPrimary()) {
            const page = await chatSql.getThreadPage(activeCompanyId, messageId);
            if (page.error === 'not_found') {
                return res.status(404).json({ message: 'Parent message not found' });
            }
            const convId = page.parentMessage.conversation;
            const convRow = await chatSql.requireModels().Conversation.findOne({
                where: { id: String(convId), companyId: String(activeCompanyId) }
            });
            if (!convRow) {
                return res.status(404).json({ message: 'Conversation not found' });
            }
            if (!(await chatSql.isUserInConversation(convId, req.user._id))) {
                return res.status(403).json({ message: 'Access denied' });
            }
            const parentWithDisplayName = attachMessageDisplayName(
                page.parentMessage,
                activeCompanyId,
                req.activeCompanyName || null
            );
            const threadWithDisplayNames = attachMessagesDisplayName(
                page.threadReplies,
                activeCompanyId,
                req.activeCompanyName || null
            );
            return res.json({
                parentMessage: hydrateMessageFileUrl(req, parentWithDisplayName),
                threadReplies: hydrateMessagesFileUrls(req, threadWithDisplayNames),
                threadCount: page.threadCount
            });
        }

        // Validate parent message exists
        const parentMessage = await Message.findOne({ _id: messageId, company: activeCompanyId })
            .populate('sender', 'name email title role')
            .populate('replyTo')
            .populate('mentions', 'name email');

        if (!parentMessage) {
            return res.status(404).json({ message: 'Parent message not found' });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findOne({ _id: parentMessage.conversation, company: activeCompanyId });
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!isConversationParticipant(conversation, req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Fetch all thread replies
        const threadReplies = await Message.find({
            company: activeCompanyId,
            parentMessage: messageId,
            isDeleted: false
        })
            .populate('sender', 'name email title role')
            .populate('replyTo')
            .populate('mentions', 'name email')
            .populate('reactions.user', 'name email')
            .sort({ createdAt: 1 }); // Oldest first in threads

        const parentWithDisplayName = attachMessageDisplayName(
            parentMessage,
            activeCompanyId,
            req.activeCompanyName || null
        );
        const threadWithDisplayNames = attachMessagesDisplayName(
            threadReplies,
            activeCompanyId,
            req.activeCompanyName || null
        );
        res.json({
            parentMessage: hydrateMessageFileUrl(req, parentWithDisplayName),
            threadReplies: hydrateMessagesFileUrls(req, threadWithDisplayNames),
            threadCount: threadReplies.length
        });
    } catch (error) {
        console.error('Get thread replies error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Upload and send file message (voice, image, video, file)
// Use upload.any() to accept files with different fieldnames (voice, image, video, file)
router.post('/message/file', authenticateToken, ensureChatAttachmentAllowed, upload.any(), async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { conversationId } = req.body;
        const file = req.files && req.files[0]; // Get first file from array
        const bodyType = String(req.body?.type || '').trim().toLowerCase();
        const bodyFileUrl = normalizeIncomingFileUrl(req, req.body?.fileUrl);
        const bodyFileName = String(req.body?.fileName || '').trim();
        const bodyFileSize = req.body?.fileSize != null ? (Number(req.body.fileSize) || undefined) : undefined;
        const bodyMimeType = String(req.body?.mimeType || '').trim() || undefined;

        if (!conversationId) {
            return res.status(400).json({ message: 'Conversation ID is required' });
        }

        // Supports 2 modes:
        // 1) multipart upload with real file (existing behavior)
        // 2) JSON body with fileUrl + fileName (Flutter/remote-storage behavior)
        let type = bodyType;
        let fileUrl = bodyFileUrl;
        let fileName = bodyFileName;
        let fileSize = bodyFileSize;
        let mimeType = bodyMimeType;

        if (file) {
            // Use image type when mimetype is image (even if sent as "file") so UI displays as image
            const rawType = file.fieldname;
            type = (rawType === 'file' && file.mimetype && file.mimetype.startsWith('image/')) ? 'image' : rawType;
            fileUrl = toAbsoluteMediaUrl(`/uploads/chat/${type}/${file.filename}`, req);
            fileName = file.originalname;
            fileSize = file.size;
            mimeType = file.mimetype;
        }

        if (!['voice', 'image', 'video', 'file'].includes(type)) {
            return res.status(400).json({ message: 'Invalid message type' });
        }
        if (!fileUrl || !fileName) {
            return res.status(400).json({ message: 'fileUrl and fileName are required when sending file metadata' });
        }

        if (isPostgresPrimary()) {
            const m = chatSql.requireModels();
            const convRow = await m.Conversation.findOne({
                where: { id: String(conversationId), companyId: String(activeCompanyId) }
            });
            if (!convRow) {
                return res.status(404).json({ message: 'Conversation not found' });
            }
            if (!(await chatSql.isUserInConversation(conversationId, req.user._id))) {
                return res.status(403).json({ message: 'Access denied' });
            }
            const replyToRaw = req.body.replyTo;
            const messagePayload = await chatSql.createFileMessage({
                companyId: activeCompanyId,
                conversationId,
                senderId: req.user._id,
                senderName: getRequestDisplayName(req),
                senderEmail: req.user.email,
                type,
                fileUrl,
                fileName,
                fileSize,
                mimeType,
                content: type === 'image' ? fileName : undefined,
                replyToId: replyToRaw || null
            });
            const io = req.app.get('io');
            const senderName = getRequestDisplayName(req);
            const participantIds = await chatSql.participantUserIds(conversationId);
            if (io) {
                const convIdStr = String(conversationId);
                for (const participantId of participantIds) {
                    const participantIdStr = String(participantId);
                    if (participantIdStr !== req.user._id.toString()) {
                        emitToUserRoom(io, participantIdStr, 'new_chat_message', {
                            type: 'new_chat_message',
                            conversationId: convIdStr,
                            message: {
                                _id: messagePayload.id,
                                sender: {
                                    _id: req.user._id,
                                    name: senderName,
                                    email: req.user.email
                                },
                                type: type,
                                fileUrl: toAbsoluteMediaUrl(fileUrl, req),
                                fileName: fileName,
                                fileSize: fileSize,
                                mimeType: mimeType,
                                createdAt: messagePayload.createdAt
                            },
                            timestamp: new Date()
                        });
                    }
                }
            }
            try {
                const fileLabel =
                    type === 'voice'
                        ? 'Voice message'
                        : type === 'image'
                          ? 'Image'
                          : type === 'video'
                            ? 'Video'
                            : 'File';

                const otherParticipantIdsFile = participantIds.filter(
                    (pid) => String(pid) !== req.user._id.toString()
                );
                const participantMapFile = await fetchUsersByIdMap(otherParticipantIdsFile);
                for (const participantId of otherParticipantIdsFile) {
                    const participantUser = participantMapFile.get(String(participantId));
                    if (!participantUser) continue;

                    await createNotification(
                        participantUser._id,
                        {
                            company: activeCompanyId,
                            type: 'chat_message',
                            title: `New ${fileLabel} from ${senderName}`,
                            body: fileName || fileLabel,
                            data: { conversationId: String(conversationId) }
                        },
                        { userDoc: participantUser }
                    );
                }
            } catch (fcmError) {
                console.error('FCM error for chat file message:', fcmError);
            }

            return res.status(201).json({
                message: hydrateMessageFileUrl(
                    req,
                    attachMessageDisplayName(
                        messagePayload,
                        activeCompanyId,
                        req.activeCompanyName || null
                    )
                )
            });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findOne({ _id: conversationId, company: activeCompanyId });
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!isConversationParticipant(conversation, req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Create message
        const message = new Message({
            company: activeCompanyId,
            conversation: conversationId,
            sender: req.user._id,
            senderName: getRequestDisplayName(req),
            senderEmail: req.user.email,
            type: type,
            fileUrl: fileUrl,
            fileName: fileName,
            fileSize: fileSize,
            mimeType: mimeType,
            content: type === 'image' ? fileName : undefined, // Optional content for images
            replyTo: req.body.replyTo || undefined, // Support replies for files too
        });

        await message.save();
        await message.populate('sender', 'name email title role');
        if (message.replyTo) await message.populate('replyTo');

        // Update conversation
        conversation.lastMessage = message._id;
        conversation.lastMessageAt = new Date();

        // Increment unread count for other participants
        conversation.participants.forEach(participantId => {
            if (participantId.toString() !== req.user._id.toString()) {
                const currentUnread = conversation.unreadCount.get(participantId.toString()) || 0;
                conversation.unreadCount.set(participantId.toString(), currentUnread + 1);
            }
        });

        await conversation.save();

        // Emit socket event
        const io = req.app.get('io');
        const senderName = getRequestDisplayName(req);

        if (io) {
            const convIdStr = String(conversationId);
            conversation.participants.forEach(participantId => {
                const participantIdStr = participantId.toString();
                if (participantIdStr !== req.user._id.toString()) {
                    emitToUserRoom(io, participantIdStr, 'new_chat_message', {
                        type: 'new_chat_message',
                        conversationId: convIdStr,
                        message: {
                            _id: message._id,
                            sender: {
                                _id: req.user._id,
                                name: senderName,
                                email: req.user.email
                            },
                            type: type,
                            fileUrl: toAbsoluteMediaUrl(fileUrl, req),
                            fileName: fileName,
                            fileSize: fileSize,
                            mimeType: mimeType,
                            createdAt: message.createdAt
                        },
                        timestamp: new Date()
                    });
                }
            });
        }

        // FCM notification for file messages
        try {
            const fileLabel = type === 'voice'
                ? 'Voice message'
                : type === 'image'
                    ? 'Image'
                    : type === 'video'
                        ? 'Video'
                        : 'File';

            const otherParticipantIdsFile = conversation.participants.filter(
                (participantId) => participantId.toString() !== req.user._id.toString()
            );
            const participantMapFile = await fetchUsersByIdMap(otherParticipantIdsFile);
            for (const participantId of otherParticipantIdsFile) {
                const participantUser = participantMapFile.get(participantId.toString());
                if (!participantUser) continue;

                await createNotification(participantUser._id, {
                    company: activeCompanyId,
                    type: 'chat_message',
                    title: `New ${fileLabel} from ${senderName}`,
                    body: fileName || fileLabel,
                    data: { conversationId: String(conversationId) }
                }, { userDoc: participantUser });
            }
        } catch (fcmError) {
            console.error('FCM error for chat file message:', fcmError);
        }

        res.status(201).json({
            message: hydrateMessageFileUrl(
                req,
                attachMessageDisplayName(message, activeCompanyId, req.activeCompanyName || null)
            )
        });
    } catch (error) {
        console.error('Send file message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Admin endpoint to create missing project conversations
router.post('/admin/create-project-conversations', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const m = req.companyMembership;
        const canManage = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canManage) {
            return res.status(403).json({ message: 'Access denied' });
        }

        if (isPostgresPrimary()) {
            const stats = await chatSql.adminSyncProjectConversations(activeCompanyId, req.user._id);
            return res.json({
                message: 'Project conversations processed',
                created: stats.created,
                updated: stats.updated,
                existing: stats.existing,
                total: stats.total
            });
        }

        const projects = await Project.find({ company: activeCompanyId }).populate('assigned_users');
        let created = 0;
        let updated = 0;
        let existing = 0;

        for (const project of projects) {
            let conversation = await Conversation.findOne({ company: activeCompanyId, project: project._id });

            if (!conversation) {
                // Create new conversation
                conversation = new Conversation({
                    company: activeCompanyId,
                    participants: project.assigned_users.map(u => u._id),
                    isGroup: true,
                    groupName: project.project_name,
                    project: project._id,
                    groupAdmin: project.assigned_users[0]?._id || req.user._id
                });
                await conversation.save();
                created++;
            } else {
                // Update participants if needed
                const participantIds = project.assigned_users.map(u => u._id.toString());
                const currentParticipantIds = conversation.participants.map(p => p.toString());

                const needsUpdate = participantIds.length !== currentParticipantIds.length ||
                    !participantIds.every(id => currentParticipantIds.includes(id)) ||
                    conversation.groupName !== project.project_name;

                if (needsUpdate) {
                    conversation.participants = project.assigned_users.map(u => u._id);
                    conversation.groupName = project.project_name;
                    await conversation.save();
                    updated++;
                } else {
                    existing++;
                }
            }
        }

        res.json({
            message: 'Project conversations processed',
            created,
            updated,
            existing,
            total: projects.length
        });
    } catch (error) {
        console.error('Create project conversations error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;

