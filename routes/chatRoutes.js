const express = require('express');
const { Conversation, Message } = require('../models/chat');
const { User, Project } = require('../models');
const { createNotification } = require('../services/notificationService');
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

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

// Get or create conversation between two users
router.post('/conversation', authenticateToken, async (req, res) => {
    try {
        const { participantId } = req.body;

        if (!participantId) {
            return res.status(400).json({ message: 'Participant ID is required' });
        }

        if (participantId === req.user._id.toString()) {
            return res.status(400).json({ message: 'Cannot create conversation with yourself' });
        }

        // Check if participant exists
        const participant = await User.findById(participantId);
        if (!participant) {
            return res.status(404).json({ message: 'Participant not found' });
        }

        // Find existing conversation
        let conversation = await Conversation.findOne({
            isGroup: false,
            participants: { $all: [req.user._id, participantId] }
        }).populate('participants', 'name email title role');

        // Create new conversation if doesn't exist
        if (!conversation) {
            conversation = new Conversation({
                participants: [req.user._id, participantId],
                isGroup: false
            });
            await conversation.save();
            await conversation.populate('participants', 'name email title role');
        }

        res.json({ conversation });
    } catch (error) {
        console.error('Get conversation error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get or create project conversation
router.get('/project/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;

        // Verify project exists
        const project = await Project.findById(projectId).populate('assigned_users', 'name email title role');
        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        // Check if user is assigned to project
        const isAssigned = project.assigned_users.some(
            user => user._id.toString() === req.user._id.toString()
        );

        // Admin can access any project
        const isAdmin = req.user.role === 'admin' || req.user.role === 'manager';

        if (!isAssigned && !isAdmin) {
            return res.status(403).json({ message: 'You are not assigned to this project' });
        }

        // Find or create project conversation
        let conversation = await Conversation.findOne({ project: projectId })
            .populate('participants', 'name email title role')
            .populate('lastMessage')
            .populate('project', 'project_name');

        if (!conversation) {
            // Create new project conversation
            conversation = new Conversation({
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

        res.json({
            conversation: {
                ...conversation.toObject(),
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
        const users = await User.find({
            _id: { $ne: req.user._id }
        }).select('name email title role').sort({ name: 1 });

        res.json({ users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get all conversations for the logged-in user
router.get('/conversations', authenticateToken, async (req, res) => {
    try {
        // First, ensure all projects the user is assigned to have conversations
        const userProjects = await Project.find({
            assigned_users: req.user._id
        }).populate('assigned_users');

        for (const project of userProjects) {
            let conversation = await Conversation.findOne({ project: project._id });

            if (!conversation) {
                // Create missing project conversation
                try {
                    conversation = new Conversation({
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

        // Now get all conversations for the user
        const conversations = await Conversation.find({
            participants: req.user._id
        })
            .populate('participants', 'name email title role')
            .populate('lastMessage')
            .populate('project', 'project_name')
            .sort({ lastMessageAt: -1 });

        // Get unread count for each conversation
        const conversationsWithUnread = conversations.map(conv => {
            const unread = conv.unreadCount.get(req.user._id.toString()) || 0;
            return {
                ...conv.toObject(),
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
router.get('/conversation/:conversationId/messages', authenticateToken, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { page = 1, limit = 50 } = req.query;

        // Verify user is part of the conversation
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!conversation.participants.includes(req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Get messages
        const messages = await Message.find({
            conversation: conversationId,
            isDeleted: false
        })
            .populate('sender', 'name email title role')
            .populate('replyTo')
            .populate('mentions', 'name email')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        // Mark messages as read
        await Message.updateMany(
            {
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

        res.json({
            messages: messages.reverse(), // Reverse to show oldest first
            hasMore: messages.length === limit
        });
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Send text message
router.post('/message', authenticateToken, async (req, res) => {
    try {
        const { conversationId, content, replyTo, mentions } = req.body;

        if (!conversationId || !content || !content.trim()) {
            return res.status(400).json({ message: 'Conversation ID and content are required' });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!conversation.participants.includes(req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Create message
        const message = new Message({
            conversation: conversationId,
            sender: req.user._id,
            senderName: req.user.name || req.user.email,
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
        const senderName = req.user.name || req.user.email;
        const textPreview = (content || '').slice(0, 100);

        if (io) {
            conversation.participants.forEach(participantId => {
                if (participantId.toString() !== req.user._id.toString()) {
                    io.to(`user:${participantId}`).emit('new_chat_message', {
                        type: 'new_chat_message',
                        conversationId: conversationId,
                        message: message, // Send fully populated message
                        timestamp: new Date()
                    });
                }
            });
        }

        // Send FCM push notification to other participants
        try {
            for (const participantId of conversation.participants) {
                if (participantId.toString() === req.user._id.toString()) continue;
                const participantUser = await User.findById(participantId);
                if (!participantUser) continue;

                await createNotification(participantUser._id, {
                    type: 'chat_message',
                    title: `New message from ${senderName}`,
                    body: textPreview || 'New chat message',
                    data: { conversationId: String(conversationId) }
                });
            }
        } catch (fcmError) {
            console.error('FCM error for chat text message:', fcmError);
        }

        res.status(201).json({ message });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Edit message
router.put('/message/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { content } = req.body;

        if (!content || !content.trim()) {
            return res.status(400).json({ message: 'Content is required' });
        }

        const message = await Message.findById(messageId);
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
        const conversation = await Conversation.findById(message.conversation);
        const io = req.app.get('io');
        if (io && conversation) {
            conversation.participants.forEach(participantId => {
                io.to(`user:${participantId}`).emit('message_updated', {
                    type: 'message_updated',
                    conversationId: message.conversation,
                    message: messageObj
                });
            });
        }

        res.json({ message });
    } catch (error) {
        console.error('Edit message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Delete message
router.delete('/message/:messageId', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;

        const message = await Message.findById(messageId);
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
        const conversation = await Conversation.findById(message.conversation);
        const io = req.app.get('io');
        if (io && conversation) {
            conversation.participants.forEach(participantId => {
                io.to(`user:${participantId}`).emit('message_deleted', {
                    type: 'message_deleted',
                    conversationId: message.conversation,
                    messageId: messageId
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
        const { messageId } = req.params;
        const { emoji } = req.body;

        if (!emoji) {
            return res.status(400).json({ message: 'Emoji is required' });
        }

        const message = await Message.findById(messageId);
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
        const conversation = await Conversation.findById(message.conversation);
        const io = req.app.get('io');
        if (io && conversation) {
            conversation.participants.forEach(participantId => {
                io.to(`user:${participantId}`).emit('message_reaction_updated', {
                    type: 'message_reaction_updated',
                    conversationId: message.conversation,
                    messageId: messageId,
                    reactions: message.reactions
                });
            });
        }

        res.json({
            messageId,
            reactions: message.reactions
        });
    } catch (error) {
        console.error('Reaction error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Create thread reply
router.post('/message/:messageId/thread', authenticateToken, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { content, type = 'text', fileUrl, fileName, fileSize, mimeType } = req.body;

        // Validate parent message exists
        const parentMessage = await Message.findById(messageId);
        if (!parentMessage) {
            return res.status(404).json({ message: 'Parent message not found' });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findById(parentMessage.conversation);
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!conversation.participants.includes(req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Create thread reply
        const threadReply = new Message({
            conversation: parentMessage.conversation,
            sender: req.user._id,
            senderName: req.user.name || req.user.email,
            senderEmail: req.user.email,
            type,
            content: content?.trim(),
            fileUrl,
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
            conversation.participants.forEach(participantId => {
                io.to(`user:${participantId}`).emit('thread_reply', {
                    type: 'thread_reply',
                    conversationId: parentMessage.conversation,
                    parentMessageId: messageId,
                    message: threadReply,
                    threadCount: parentMessage.threadCount
                });
            });
        }

        res.status(201).json({
            message: threadReply,
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
        const { messageId } = req.params;

        // Validate parent message exists
        const parentMessage = await Message.findById(messageId)
            .populate('sender', 'name email title role')
            .populate('replyTo')
            .populate('mentions', 'name email');

        if (!parentMessage) {
            return res.status(404).json({ message: 'Parent message not found' });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findById(parentMessage.conversation);
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!conversation.participants.includes(req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Fetch all thread replies
        const threadReplies = await Message.find({
            parentMessage: messageId,
            isDeleted: false
        })
            .populate('sender', 'name email title role')
            .populate('replyTo')
            .populate('mentions', 'name email')
            .populate('reactions.user', 'name email')
            .sort({ createdAt: 1 }); // Oldest first in threads

        res.json({
            parentMessage,
            threadReplies,
            threadCount: threadReplies.length
        });
    } catch (error) {
        console.error('Get thread replies error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Upload and send file message (voice, image, video, file)
// Use upload.any() to accept files with different fieldnames (voice, image, video, file)
router.post('/message/file', authenticateToken, upload.any(), async (req, res) => {
    try {
        const { conversationId } = req.body;
        const file = req.files && req.files[0]; // Get first file from array

        if (!conversationId || !file) {
            return res.status(400).json({ message: 'Conversation ID and file are required' });
        }

        // Use image type when mimetype is image (even if sent as "file") so UI displays as image
        const rawType = file.fieldname;
        const type = (rawType === 'file' && file.mimetype && file.mimetype.startsWith('image/')) ? 'image' : rawType;

        if (!['voice', 'image', 'video', 'file'].includes(type)) {
            return res.status(400).json({ message: 'Invalid message type' });
        }

        // Verify user is part of the conversation
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            return res.status(404).json({ message: 'Conversation not found' });
        }

        if (!conversation.participants.includes(req.user._id)) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // File is stored in folder by multer (image folder when type is image)
        const fileUrl = `/uploads/chat/${type}/${file.filename}`;

        // Create message
        const message = new Message({
            conversation: conversationId,
            sender: req.user._id,
            senderName: req.user.name || req.user.email,
            senderEmail: req.user.email,
            type: type,
            fileUrl: fileUrl,
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
            content: type === 'image' ? file.originalname : undefined, // Optional content for images
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
        const senderName = req.user.name || req.user.email;

        if (io) {
            conversation.participants.forEach(participantId => {
                const participantIdStr = participantId.toString();
                if (participantIdStr !== req.user._id.toString()) {
                    console.log(`Emitting new_chat_message (file) to user:${participantIdStr}`);
                    io.to(`user:${participantIdStr}`).emit('new_chat_message', {
                        type: 'new_chat_message',
                        conversationId: conversationId,
                        message: {
                            _id: message._id,
                            sender: {
                                _id: req.user._id,
                                name: req.user.name,
                                email: req.user.email
                            },
                            type: type,
                            fileUrl: fileUrl,
                            fileName: file.originalname,
                            fileSize: file.size,
                            mimeType: file.mimetype,
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

            for (const participantId of conversation.participants) {
                if (participantId.toString() === req.user._id.toString()) continue;
                const participantUser = await User.findById(participantId);
                if (!participantUser) continue;

                await createNotification(participantUser._id, {
                    type: 'chat_message',
                    title: `New ${fileLabel} from ${senderName}`,
                    body: file.originalname || fileLabel,
                    data: { conversationId: String(conversationId) }
                });
            }
        } catch (fcmError) {
            console.error('FCM error for chat file message:', fcmError);
        }

        res.status(201).json({ message });
    } catch (error) {
        console.error('Send file message error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Admin endpoint to create missing project conversations
router.post('/admin/create-project-conversations', authenticateToken, async (req, res) => {
    try {
        // Only admin can access this
        if (req.user.role !== 'admin' && req.user.role !== 'manager') {
            return res.status(403).json({ message: 'Access denied' });
        }

        const projects = await Project.find({}).populate('assigned_users');
        let created = 0;
        let updated = 0;
        let existing = 0;

        for (const project of projects) {
            let conversation = await Conversation.findOne({ project: project._id });

            if (!conversation) {
                // Create new conversation
                conversation = new Conversation({
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

