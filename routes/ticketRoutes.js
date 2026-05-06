const express = require('express');
const mongoose = require('mongoose');
const { Ticket, Project, User } = require('../models');
const { authenticateToken, getRequestDisplayName } = require('../middleware/auth');
const { sendTicketNotification } = require('../services/emailService');
const { processImages } = require('../utils/imageHelper');
const { createNotification } = require('../services/notificationService');
const { toAbsoluteMediaUrl, mapMediaUrls } = require('../utils/mediaUrl');

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

const hydrateTicketMediaUrls = (req, ticketDoc) => {
    if (!ticketDoc) return ticketDoc;
    const ticket = ticketDoc.toObject ? ticketDoc.toObject() : { ...ticketDoc };
    ticket.images = mapMediaUrls(ticket.images, req);

    if (Array.isArray(ticket.replies)) {
        ticket.replies = ticket.replies.map((reply) => ({
            ...reply,
            images: mapMediaUrls(reply.images, req)
        }));
    }

    if (Array.isArray(ticket.allComments)) {
        ticket.allComments = ticket.allComments.map((comment) => ({
            ...comment,
            images: mapMediaUrls(comment.images, req)
        }));
    }

    return ticket;
};


// 8. Add new ticket
// 8. Add new ticket
// 8. Add new ticket
router.post('/add-ticket', authenticateToken, async (req, res) => {
    // await Ticket.deleteMany({ project: "6926e5fadf443653770483c3" });
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const {
            project,
            ticket,
            requested_from,
            requested_from_email,
            requested_to_email,
            requested_to,
            date,
            cc,
            time,
            description,
            handler,
            status,
            priority,
            images
        } = req.body;

        // Validate required fields
        if (!ticket || !requested_from || !requested_to || !description || !project || !requested_from_email || !requested_to_email) {
            return res.status(400).json({ 
                message: 'Ticket ID, project, requested_from, requested_from_email, requested_to, requested_to_email, and description are required' 
            });
        }

        // Validate project ID format
        if (!mongoose.Types.ObjectId.isValid(project)) {
            return res.status(400).json({ message: 'Invalid project ID format' });
        }

        // Validate project exists
        const projectExists = await Project.findOne({ _id: project, company: activeCompanyId });
        if (!projectExists) {
            return res.status(400).json({ message: 'Project not found in active company' });
        }

        // Convert project to ObjectId for consistent querying
        const projectId = new mongoose.Types.ObjectId(project);

        // Check if ticket ID already exists in the same project
        const existingTicket = await Ticket.findOne({ 
            ticket: ticket.trim(), 
            company: activeCompanyId,
            project: projectId 
        });
        
        if (existingTicket) {
            return res.status(400).json({ 
                message: 'Ticket ID already exists in this project' + existingTicket.ticket  + projectId
            });
        }

        // Normalize handler and CC emails to lowercase arrays
        const normalizedHandler = handler 
            ? (Array.isArray(handler) ? handler.map(h => h.toLowerCase().trim()) : [handler.toLowerCase().trim()])
            : [];
        const normalizedCc = cc 
            ? (Array.isArray(cc) ? cc.map(c => c.toLowerCase().trim()) : [cc.toLowerCase().trim()])
            : [];

        // Create new ticket
        const processedImages = images
            ? (Array.isArray(images) ? processImages(images) : processImages([images]))
            : [];
        const newTicket = new Ticket({
            company: activeCompanyId,
            project: projectId,
            ticket: ticket.trim(),
            cc: normalizedCc,
            requested_from_email,
            requested_to_email,
            requested_from,
            requested_to,
            date: date || Date.now(),
            time,
            description,
            handler: normalizedHandler,
            status: status || 'open',
            priority: priority || undefined,
            images: mapMediaUrls(processedImages, req)
        });

        await newTicket.save();

        // Populate project details before sending notifications
        await newTicket.populate('project', 'project_name status');

        // Send email notification with cc emails
        console.log('Requested to email:', requested_to_email);
        console.log('Requested from email:', requested_from_email);
        console.log('Requested to:', requested_to);
        console.log('Requested from:', requested_from);
        console.log('CC emails:', cc);
        
        try {
            if (requested_to_email) {
                // Ensure cc is an array for CC
                const ccEmails = cc && Array.isArray(cc) ? cc : (cc ? [cc] : []);
                
                await sendTicketNotification(
                    requested_from_email, 
                    requested_to_email, 
                    {
                        ticket: newTicket.ticket,
                        project: projectExists.project_name, // Send project name for email
                        sender_title: requested_from,
                        receiver: requested_to,
                        description,
                        status: newTicket.status,
                        date_of_issue: newTicket.date
                    }, 
                    'created', 
                    ccEmails
                );
            }
        } catch (emailError) {
            console.error('Email notification error:', emailError);
            // Don't fail the request if email fails
        }

        // Send Socket.io and FCM notification to the receiver and CC/handler users
        try {
            const io = req.app.get('io');

            // Find receiver user
            const receiverUser = await User.findOne({ email: requested_to_email.toLowerCase() });

            if (receiverUser) {
                const payload = {
                    type: 'new_ticket',
                    ticket: {
                        _id: newTicket._id,
                        ticket: newTicket.ticket,
                        project: projectExists.project_name,
                        requested_from,
                        requested_to,
                        description,
                        status: newTicket.status,
                        priority: newTicket.priority,
                        date: newTicket.date
                    },
                    message: `New ticket ${newTicket.ticket} from ${requested_from}`,
                    timestamp: new Date()
                };

                // Socket.io event
                if (io) {
                    io.to(`user:${receiverUser._id}`).emit('new_ticket', payload);
                }

                // Persist + FCM push notification
                await createNotification(receiverUser._id, {
                    type: 'new_ticket',
                    title: `New ticket ${newTicket.ticket}`,
                    body: `From ${requested_from} - ${projectExists.project_name}`,
                    data: {
                        ticketId: String(newTicket._id),
                        ticketNumber: String(newTicket.ticket),
                        projectName: projectExists.project_name || '',
                        status: newTicket.status || 'open'
                    }
                });
            }

            // Notify handler users (assigned users)
            const handlerEmails = handler && Array.isArray(handler) ? handler : (handler ? [handler] : []);
            if (handlerEmails.length > 0) {
                for (const handlerEmail of handlerEmails) {
                    if (!handlerEmail) continue;

                    const handlerUser = await User.findOne({ email: handlerEmail.toLowerCase() });
                    if (!handlerUser) continue;

                    const payload = {
                        type: 'ticket_assigned',
                        ticket: {
                            _id: newTicket._id,
                            ticket: newTicket.ticket,
                            project: projectExists.project_name,
                            requested_from,
                            requested_to,
                            description,
                            status: newTicket.status,
                            priority: newTicket.priority,
                            date: newTicket.date
                        },
                        message: `You have been assigned to ticket ${newTicket.ticket}`,
                        timestamp: new Date()
                    };

                    if (io) {
                        io.to(`user:${handlerUser._id}`).emit('ticket_assigned', payload);
                    }

                    await createNotification(handlerUser._id, {
                        type: 'ticket_assigned',
                        title: `Ticket assigned: ${newTicket.ticket}`,
                        body: `Project ${projectExists.project_name} - from ${requested_from}`,
                        data: {
                            ticketId: String(newTicket._id),
                            ticketNumber: String(newTicket.ticket),
                            projectName: projectExists.project_name || '',
                            status: newTicket.status || 'open'
                        }
                    });
                }
            }

            // Also notify CC users
            const ccEmails = cc && Array.isArray(cc) ? cc : (cc ? [cc] : []);
            if (ccEmails.length > 0) {
                for (const ccEmail of ccEmails) {
                    if (!ccEmail) continue;

                    const ccUser = await User.findOne({ email: ccEmail.toLowerCase() });
                    if (!ccUser) continue;

                    const payload = {
                        type: 'ticket_cc',
                        ticket: {
                            _id: newTicket._id,
                            ticket: newTicket.ticket,
                            project: projectExists.project_name,
                            requested_from,
                            requested_to,
                            description,
                            status: newTicket.status,
                            priority: newTicket.priority,
                            date: newTicket.date
                        },
                        message: `You have been CC'd on ticket ${newTicket.ticket}`,
                        timestamp: new Date()
                    };

                    if (io) {
                        io.to(`user:${ccUser._id}`).emit('ticket_cc', payload);
                    }

                    await createNotification(ccUser._id, {
                        type: 'ticket_cc',
                        title: `Ticket CC: ${newTicket.ticket}`,
                        body: `Project ${projectExists.project_name} - from ${requested_from}`,
                        data: {
                            ticketId: String(newTicket._id),
                            ticketNumber: String(newTicket.ticket),
                            projectName: projectExists.project_name || '',
                            status: newTicket.status || 'open'
                        }
                    });
                }
            }
        } catch (socketError) {
            console.error('Socket/FCM notification error:', socketError);
            // Don't fail the request if notifications fail
        }

        res.status(201).json({
            message: 'Ticket created successfully',
            ticket: hydrateTicketMediaUrls(req, newTicket)
        });
    } catch (error) {
        console.error('Add ticket error:', error);
        
        // Handle duplicate key error (MongoDB E11000)
        if (error.code === 11000) {
            // Parse the duplicate key error to extract ticket ID
            let ticketId = 'this ticket ID';
            let errorMessage = error.message || '';
            
            // Extract ticket ID from error message if available
            const ticketMatch = errorMessage.match(/dup key:\s*{\s*ticket:\s*"([^"]+)"\s*/);
            if (ticketMatch && ticketMatch[1]) {
                ticketId = `"${ticketMatch[1]}"`;
            }
            
            // Check if it's the old single-field index or new compound index
            if (errorMessage.includes('index: ticket_1')) {
                return res.status(400).json({ 
                    message: `Ticket ID ${ticketId} already exists. Please run the database migration script to fix indexes.`,
                    error: 'database_index_migration_required'
                });
            } else {
                return res.status(400).json({ 
                    message: `Ticket ID ${ticketId} already exists in this project`
                });
            }
        }
        
        // Handle validation errors
        if (error.name === 'ValidationError') {
            const validationErrors = Object.values(error.errors).map(err => err.message).join(', ');
            return res.status(400).json({ 
                message: `Validation error: ${validationErrors}`
            });
        }
        
        // Handle other errors
        res.status(500).json({ 
            message: 'Internal server error',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Edit ticket
router.put('/edit-ticket/:ticketId', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { ticketId } = req.params;
        const { 
            project,
            requested_from_mail,
            requested_to_mail,
            requested_from,
            requested_to,
            contact,
            date,
            time,
            description,
            handler,
            status,
            priority,
            images,
            cc,
            comment,
            end_date
        } = req.body;

        const ticket = await Ticket.findOne({ _id: ticketId, company: activeCompanyId });
        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found' });
        }

        const updateData = {};
        if (requested_from_mail) updateData.requested_from_mail = requested_from_mail   ;
        if (requested_to) updateData.requested_to = requested_to;
        if (requested_to_mail) updateData.requested_to_mail = requested_to_mail;
        if (date) updateData.date = date;
        if (time) updateData.time = time;
        if (description) updateData.description = description;
        if (handler !== undefined) {
            updateData.handler = Array.isArray(handler) 
                ? handler.map(h => h.toLowerCase().trim()) 
                : [handler.toLowerCase().trim()];
        }
        if (status) updateData.status = status;
        if (priority !== undefined) updateData.priority = priority;
        if (images !== undefined) {
            // Process images - convert base64 to files if needed
            if (Array.isArray(images)) {
                updateData.images = mapMediaUrls(processImages(images), req);
            } else {
                updateData.images = mapMediaUrls(processImages([images]), req);
            }
        }
        if (cc !== undefined) {
            updateData.cc = Array.isArray(cc) 
                ? cc.map(c => c.toLowerCase().trim()) 
                : (cc ? [cc.toLowerCase().trim()] : []);
        }
        if (comment) updateData.comment = comment;
        if (end_date) updateData.end_date = end_date;
        
        // Auto set end_date if status is resolved or closed
        if (status === 'resolved' || status === 'closed') {
            updateData.end_date = end_date || new Date();
        }

        // Get old handler and CC values to detect changes
        const oldHandler = ticket.handler && Array.isArray(ticket.handler) ? ticket.handler.map(h => h.toLowerCase()) : [];
        const oldCc = ticket.cc && Array.isArray(ticket.cc) ? ticket.cc.map(c => c.toLowerCase()) : [];

        const updatedTicket = await Ticket.findOneAndUpdate(
            { _id: ticketId, company: activeCompanyId },
            updateData,
            { new: true }
        ).populate('project', 'project_name');

        // Get new handler and CC values
        const newHandler = updatedTicket.handler && Array.isArray(updatedTicket.handler) ? updatedTicket.handler.map(h => h.toLowerCase()) : [];
        const newCc = updatedTicket.cc && Array.isArray(updatedTicket.cc) ? updatedTicket.cc.map(c => c.toLowerCase()) : [];

        // Find newly assigned handlers (users in newHandler but not in oldHandler)
        const newlyAssignedHandlers = newHandler.filter(h => !oldHandler.includes(h));
        // Find newly CC'd users (users in newCc but not in oldCc)
        const newlyCcedUsers = newCc.filter(c => !oldCc.includes(c));

        const io = req.app.get('io');
        const editorName = getRequestDisplayName(req);
        const projectName = updatedTicket.project?.project_name || 'Unknown Project';
        const ticketPayload = {
            _id: updatedTicket._id,
            ticket: updatedTicket.ticket,
            project: projectName,
            requested_from: updatedTicket.requested_from,
            requested_to: updatedTicket.requested_to,
            description: updatedTicket.description,
            status: updatedTicket.status,
            priority: updatedTicket.priority,
            date: updatedTicket.date
        };

        // Send Socket.io + FCM for newly assigned handlers
        try {
            if (newlyAssignedHandlers.length > 0) {
                for (const handlerEmail of newlyAssignedHandlers) {
                    if (!handlerEmail) continue;
                    const handlerUser = await User.findOne({ email: handlerEmail.toLowerCase() });
                    if (!handlerUser) continue;
                    if (io) {
                        io.to(`user:${handlerUser._id}`).emit('ticket_assigned', {
                            type: 'ticket_assigned',
                            ticket: ticketPayload,
                            message: `You have been assigned to ticket ${updatedTicket.ticket}`,
                            timestamp: new Date()
                        });
                    }
                    await createNotification(handlerUser._id, {
                        type: 'ticket_assigned',
                        title: `Ticket assigned: ${updatedTicket.ticket}`,
                        body: `Project ${projectName} - from ${updatedTicket.requested_from}`,
                        data: {
                            ticketId: String(updatedTicket._id),
                            ticketNumber: String(updatedTicket.ticket),
                            projectName,
                            status: updatedTicket.status || 'open'
                        }
                    });
                }
            }
        } catch (err) {
            console.error('Socket/FCM notification error for handlers:', err);
        }

        // Send Socket.io + FCM for newly CC'd users
        try {
            if (newlyCcedUsers.length > 0) {
                for (const ccEmail of newlyCcedUsers) {
                    if (!ccEmail) continue;
                    const ccUser = await User.findOne({ email: ccEmail.toLowerCase() });
                    if (!ccUser) continue;
                    if (io) {
                        io.to(`user:${ccUser._id}`).emit('ticket_cc', {
                            type: 'ticket_cc',
                            ticket: ticketPayload,
                            message: `You have been CC'd on ticket ${updatedTicket.ticket}`,
                            timestamp: new Date()
                        });
                    }
                    await createNotification(ccUser._id, {
                        type: 'ticket_cc',
                        title: `Ticket CC: ${updatedTicket.ticket}`,
                        body: `Project ${projectName} - from ${updatedTicket.requested_from}`,
                        data: {
                            ticketId: String(updatedTicket._id),
                            ticketNumber: String(updatedTicket.ticket),
                            projectName,
                            status: updatedTicket.status || 'open'
                        }
                    });
                }
            }
        } catch (err) {
            console.error('Socket/FCM notification error for CC users:', err);
        }

        // Notify all ticket participants that the ticket was updated (edit) — exclude editor
        try {
            const editorIdStr = req.user._id.toString();
            const notifyTicketUpdated = async (userDoc) => {
                if (!userDoc || userDoc._id.toString() === editorIdStr) return;
                const payload = {
                    type: 'ticket_updated',
                    ticket: ticketPayload,
                    message: `Ticket ${updatedTicket.ticket} was updated by ${editorName}`,
                    timestamp: new Date()
                };
                if (io) io.to(`user:${userDoc._id}`).emit('ticket_updated', payload);
                await createNotification(userDoc._id, {
                    type: 'ticket_updated',
                    title: `Ticket updated: ${updatedTicket.ticket}`,
                    body: `Updated by ${editorName} - ${projectName}`,
                    data: {
                        ticketId: String(updatedTicket._id),
                        ticketNumber: String(updatedTicket.ticket),
                        projectName,
                        status: updatedTicket.status || ''
                    }
                });
            };

            const receiverUser = updatedTicket.requested_to_email
                ? await User.findOne({ email: updatedTicket.requested_to_email.toLowerCase() })
                : null;
            const senderUser = updatedTicket.requested_from_email
                ? await User.findOne({ email: updatedTicket.requested_from_email.toLowerCase() })
                : null;
            await notifyTicketUpdated(receiverUser);
            await notifyTicketUpdated(senderUser);

            const allHandlers = new Set([...(updatedTicket.handler || [])]);
            const allCc = new Set([...(updatedTicket.cc || [])]);
            for (const email of [...allHandlers, ...allCc]) {
                if (!email) continue;
                const u = await User.findOne({ email: email.toLowerCase() });
                await notifyTicketUpdated(u);
            }
        } catch (err) {
            console.error('Socket/FCM notification error for ticket_updated:', err);
        }

        // Send email notification for updates with CC
        try {
            if (updatedTicket.requested_from_email && updatedTicket.requested_to_email) {
                // Use cc field for email CC, ensure it's an array
                const ccEmails = updatedTicket.cc && Array.isArray(updatedTicket.cc) ? updatedTicket.cc : (updatedTicket.cc ? [updatedTicket.cc] : []);
                
                await sendTicketNotification(
                    updatedTicket.requested_from_email, 
                    updatedTicket.requested_to_email, 
                    {
                        ticket: updatedTicket.ticket,
                        sender_title: updatedTicket.requested_from,
                        receiver: updatedTicket.requested_to,
                        description: updatedTicket.description,
                        status: updatedTicket.status,
                        date_of_issue: updatedTicket.date,
                        receiver_comment: updatedTicket.comment
                    }, 
                    'updated',
                    ccEmails
                );
            }
        } catch (emailError) {
            console.error('Email notification error:', emailError);
        }

        res.json({
            message: 'Ticket updated successfully',
            ticket: hydrateTicketMediaUrls(req, updatedTicket)
        });
    } catch (error) {
        console.error('Edit ticket error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Add reply to ticket
router.post('/ticket/:ticketId/reply', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { ticketId } = req.params;
        const { comment, images } = req.body;

        if (!comment || !comment.trim()) {
            return res.status(400).json({ 
                message: 'Comment is required' 
            });
        }

        const ticket = await Ticket.findOne({ _id: ticketId, company: activeCompanyId });
        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found' });
        }

        // Process images if provided
        let processedImages = [];
        if (images) {
            if (Array.isArray(images)) {
                processedImages = processImages(images);
            } else {
                processedImages = processImages([images]);
            }
        }

        // Create new reply
        const newReply = {
            user: getRequestDisplayName(req),
            userId: req.user._id,
            userEmail: req.user.email,
            comment: comment.trim(),
            images: mapMediaUrls(processedImages, req)
        };

        // Add reply to ticket
        ticket.replies.push(newReply);
        await ticket.save();

        // Populate user info in reply
        await ticket.populate('replies.userId', 'name email title companies');

        // Get the newly added reply (last one)
        const addedReply = ticket.replies[ticket.replies.length - 1];
        const replyUserDisplayName = addedReply?.userId
            ? resolveMembershipDisplayName(addedReply.userId, activeCompanyId, req.activeCompanyName || null)
            : addedReply?.user || getRequestDisplayName(req);

        // Send email notification for new reply
        try {
            if (ticket.requested_from_email && ticket.requested_to_email) {
                // Combine CC emails from ticket
                const ccEmails = ticket.cc && Array.isArray(ticket.cc) ? [...ticket.cc] : (ticket.cc ? [ticket.cc] : []);
                
                // Also include handler emails in CC
                if (ticket.handler && Array.isArray(ticket.handler) && ticket.handler.length > 0) {
                    ticket.handler.forEach(handlerEmail => {
                        if (handlerEmail && !ccEmails.includes(handlerEmail.toLowerCase())) {
                            ccEmails.push(handlerEmail.toLowerCase());
                        }
                    });
                }

                // Remove reply author from CC if they're already the sender or receiver
                const replyAuthorEmail = req.user.email.toLowerCase();
                const recipients = [
                    ticket.requested_from_email.toLowerCase(),
                    ticket.requested_to_email.toLowerCase()
                ];

                // Filter out reply author from CC if they're already a recipient
                const finalCcEmails = ccEmails.filter(email => {
                    const emailLower = email.toLowerCase();
                    return emailLower !== replyAuthorEmail || !recipients.includes(emailLower);
                });

                // Send notification about the reply
                // The email will be sent to both sender and receiver, with CC to all handlers
                await sendTicketNotification(
                    ticket.requested_from_email, 
                    ticket.requested_to_email, 
                    {
                        ticket: ticket.ticket,
                        sender_title: `${getRequestDisplayName(req)} (Reply Author)`,
                        receiver: ticket.requested_to,
                        description: ticket.description,
                        status: ticket.status,
                        date_of_issue: ticket.date,
                        receiver_comment: `New Reply from ${getRequestDisplayName(req)}:\n\n${comment}` // New reply comment with author info
                    }, 
                    'replied',
                    finalCcEmails
                );
            }
        } catch (emailError) {
            console.error('Email notification error:', emailError);
            // Don't fail the request if email fails
        }

        // Send Socket.io and FCM notification for new reply
        try {
            const io = req.app.get('io');
            const replyAuthorName = getRequestDisplayName(req);
            const replyComment = comment.trim();

            const buildPayload = (isCc) => ({
                type: 'ticket_reply',
                ticket: {
                    _id: ticket._id,
                    ticket: ticket.ticket,
                    status: ticket.status
                },
                reply: {
                    user: replyAuthorName,
                    comment: replyComment
                },
                message: isCc
                    ? `New reply on ticket ${ticket.ticket} (CC)`
                    : `New reply on ticket ${ticket.ticket} from ${replyAuthorName}`,
                timestamp: new Date()
            });

            const sendToUser = async (userDoc, isCc = false) => {
                if (!userDoc) return;
                if (userDoc._id.toString() === req.user._id.toString()) return;

                const payload = buildPayload(isCc);

                if (io) {
                    io.to(`user:${userDoc._id}`).emit('ticket_reply', payload);
                }

                await createNotification(userDoc._id, {
                    type: 'ticket_reply',
                    title: `New reply on ticket ${ticket.ticket}`,
                    body: isCc
                        ? `You are CC on ticket ${ticket.ticket}`
                        : `From ${replyAuthorName}`,
                    data: {
                        ticketId: String(ticket._id),
                        ticketNumber: String(ticket.ticket),
                        status: ticket.status || ''
                    }
                });
            };

            // Notify ticket receiver
            const receiverUser = await User.findOne({ email: ticket.requested_to_email.toLowerCase() });
            await sendToUser(receiverUser, false);

            // Notify ticket sender
            const senderUser = await User.findOne({ email: ticket.requested_from_email.toLowerCase() });
            await sendToUser(senderUser, false);

            // Notify CC users
            const ccEmails = ticket.cc && Array.isArray(ticket.cc) ? ticket.cc : (ticket.cc ? [ticket.cc] : []);
            for (const ccEmail of ccEmails) {
                if (!ccEmail) continue;
                const ccUser = await User.findOne({ email: ccEmail.toLowerCase() });
                await sendToUser(ccUser, true);
            }

            // Notify handlers (assigned users) about new comment
            const handlerEmails = ticket.handler && Array.isArray(ticket.handler) ? ticket.handler : (ticket.handler ? [ticket.handler] : []);
            for (const handlerEmail of handlerEmails) {
                if (!handlerEmail) continue;
                const handlerUser = await User.findOne({ email: handlerEmail.toLowerCase() });
                await sendToUser(handlerUser, true);
            }
        } catch (socketError) {
            console.error('Socket/FCM notification error:', socketError);
        }

        res.status(201).json({
            message: 'Reply added successfully',
            reply: {
                ...addedReply.toObject(),
                userId: addedReply?.userId
                    ? {
                        ...(addedReply.userId.toObject ? addedReply.userId.toObject() : addedReply.userId),
                        name: replyUserDisplayName
                    }
                    : addedReply.userId,
                user: replyUserDisplayName,
                images: mapMediaUrls(addedReply.images, req)
            }
        });
    } catch (error) {
        console.error('Add reply error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// 9. Get all tickets
// 9. Get all tickets in assigned projects
router.get('/my-tickets', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { projectId } = req.query;
        let query = { company: activeCompanyId };

        // If projectId is provided, filter by that specific project
        if (projectId) {
            query.project = projectId;
        }

        let tickets;

        const m = req.companyMembership;
        const canViewAllCompanyTickets = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (canViewAllCompanyTickets) {
            // Admin and Manager can view all tickets (optionally filtered by projectId)
            tickets = await Ticket.find(query).populate('project', 'project_name status');
        } else {
            // Regular users can only view tickets from their assigned projects
            const userProjects = await Project.find({ assigned_users: req.user._id, company: activeCompanyId });
            const projectIds = userProjects.map(project => project._id);
            
            // If projectId is provided, verify user has access to that project
            if (projectId) {
                if (!projectIds.some(id => id.toString() === projectId.toString())) {
                    return res.status(403).json({ message: 'Access denied. You do not have access to this project' });
                }
                query.project = projectId;
            } else {
                query.project = { $in: projectIds };
            }
            
            tickets = await Ticket.find(query).populate('project', 'project_name status');
        }

        // Remove "images" from each ticket
        const ticketsWithoutImages = tickets.map(ticket => {
            const ticketObj = ticket.toObject();
            delete ticketObj.images;
            return ticketObj;
        });

        res.json({ tickets: ticketsWithoutImages });
    } catch (error) {
        console.error('Get tickets error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
// Get tickets where user is in CC (handler) or sendTo (requested_to_email) and status is not resolved or closed
router.get('/my-active-tickets', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const userEmail = req.user.email.toLowerCase();

        // Find tickets where:
        // 1. User email is in handler array (CC) OR user email equals requested_to_email (sendTo)
        // 2. Status is NOT 'resolved' or 'closed'
        const tickets = await Ticket.find({
            company: activeCompanyId,
            $and: [
                {
                    $or: [
                        { handler: userEmail },
                        { requested_to_email: userEmail }
                    ]
                },
                {
                    status: { $nin: ['resolved', 'closed'] }
                }
            ]
        }).populate('project', 'project_name status');

        res.json({ 
            tickets: tickets.map((ticket) => hydrateTicketMediaUrls(req, ticket)),
            count: tickets.length 
        });
    } catch (error) {
        console.error('Get my active tickets error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get tickets by ticket ID pattern
router.get('/search/:ticketPattern', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { ticketPattern } = req.params;

        const tickets = await Ticket.find({ 
            company: activeCompanyId,
            ticket: { $regex: ticketPattern, $options: 'i' } 
        });

        res.json({ tickets });
    } catch (error) {
        console.error('Get tickets by pattern error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get ticket with all comments (old + new replies) - MUST be before /:ticketId route
router.get('/ticket/:ticketId/comments', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { ticketId } = req.params;

        // Find ticket and populate safely (replies might not exist on old tickets)
        const ticket = await Ticket.findOne({ _id: ticketId, company: activeCompanyId })
            .populate('project', 'project_name status');
        
        // Only populate replies.userId if replies exist
        if (ticket && ticket.replies && ticket.replies.length > 0) {
            await ticket.populate('replies.userId', 'name email title role companies');
        }

        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found' });
        }

        // Get all comments (old comment + replies)
        // Handle both old tickets (without replies field) and new tickets
        let allComments = [];
        
        try {
            // Use virtual field if available
            allComments = ticket.allComments || [];
        } catch (virtualError) {
            // Fallback: manually build comments array if virtual fails
            console.log('Virtual field error, using fallback:', virtualError);
            
            // Add old comment if exists
            if (ticket.comment && ticket.comment.trim()) {
                allComments.push({
                    user: ticket.requested_to || 'System',
                    userEmail: ticket.requested_to_email || '',
                    comment: ticket.comment,
                    createdAt: ticket.updatedAt || ticket.createdAt,
                    isLegacy: true
                });
            }
            
            // Add replies if they exist
            if (ticket.replies && Array.isArray(ticket.replies) && ticket.replies.length > 0) {
                ticket.replies.forEach(reply => {
                    if (reply && reply.comment) {
                        allComments.push({
                            user: reply.user || 'Unknown',
                            userId: reply.userId || null,
                            userEmail: reply.userEmail || '',
                            comment: reply.comment,
                            images: (reply.images && Array.isArray(reply.images)) ? reply.images : [],
                            createdAt: reply.createdAt || new Date(),
                            isLegacy: false
                        });
                    }
                });
            }
        }

        res.json({
            ticket: {
                _id: ticket._id,
                ticket: ticket.ticket,
                project: ticket.project,
                status: ticket.status,
                priority: ticket.priority
            },
            comments: allComments.map((comment) => {
                const resolvedUserName = comment?.userId && typeof comment.userId === 'object'
                    ? resolveMembershipDisplayName(comment.userId, activeCompanyId, req.activeCompanyName || null)
                    : (comment?.user || 'Unknown');
                return {
                    ...comment,
                    user: resolvedUserName,
                    userId: comment?.userId && typeof comment.userId === 'object'
                        ? {
                            ...(comment.userId.toObject ? comment.userId.toObject() : comment.userId),
                            name: resolvedUserName
                        }
                        : comment?.userId,
                    images: mapMediaUrls(comment.images, req)
                };
            }),
            count: allComments.length
        });
    } catch (error) {
        console.error('Get comments error:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

// Get single ticket
router.get('/:ticketId', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { ticketId } = req.params;

        const ticket = await Ticket.findOne({ _id: ticketId, company: activeCompanyId });
        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found' });
        }

        res.json({ ticket: hydrateTicketMediaUrls(req, ticket) });
    } catch (error) {
        console.error('Get ticket error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get tickets by status
router.get('/filter/status/:status', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const { status } = req.params;
        let tickets;

        const m = req.companyMembership;
        const canViewAllCompanyTickets = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (canViewAllCompanyTickets) {
            tickets = await Ticket.find({ company: activeCompanyId, status });
        } else {
            tickets = await Ticket.find({ 
                company: activeCompanyId,
                status,
                $or: [
                    { requested_from: req.user.email },
                    { requested_to: req.user.email },
                    { handler: req.user.email }
                ]
            });
        }

        res.json({ tickets: tickets.map((ticket) => hydrateTicketMediaUrls(req, ticket)) });
    } catch (error) {
        console.error('Get tickets by status error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get all tickets (Admin/Manager only)
router.get('/', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const m = req.companyMembership;
        const canViewAllCompanyTickets = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canViewAllCompanyTickets) {
            return res.status(403).json({ message: 'Access denied. Owner/Admin/Manager role required in active company' });
        }

        const tickets = await Ticket.find({ company: activeCompanyId });
        res.json({ tickets: tickets.map((ticket) => hydrateTicketMediaUrls(req, ticket)) });
    } catch (error) {
        console.error('Get all tickets error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
