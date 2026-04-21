// const express = require('express');
// const { Ticket, Project, User } = require('../models');
// const { authenticateToken } = require('../middleware/auth');
// const { sendTicketNotification } = require('../services/emailService');

// const router = express.Router();

// // 8. Add new ticket
// router.post('/add-ticket', authenticateToken, async (req, res) => {
//     try {
//         const {
//             project,
//             ticket,
//             requested_from,
//             requested_to,
//             date,
//             time,
//             description,
//             handler,
//             status
//         } = req.body;

//         if (!ticket || !requested_from || !requested_to || !description || !project) {
//             return res.status(400).json({ message: 'Ticket ID, requested_from, requested_to, and description are required' });
//         }

//         // Check if ticket ID already exists in the same project
//         const existingTicket = await Ticket.findOne({ ticket, project });
//         if (existingTicket) {
//             return res.status(400).json({ message: 'Ticket ID already exists in this project' });
//         }

//         const newTicket = new Ticket({
//             project,
//             ticket,
//             requested_from,
//             requested_to,
//             date: date || Date.now(),
//             time,
//             description,
//             handler,
//             status: status || 'open'
//         });

//         await newTicket.save();

//         // Send email notification if contact is provided
//         try {
//             if (contact) {
//                 await sendTicketNotification(contact, contact, {
//                     project,
//                     sender_title: requested_from,
//                     receiver: requested_to,
//                     description,
//                     status: newTicket.status,
//                     date_of_issue: newTicket.date
//                 }, 'created');
//             }
//         } catch (emailError) {
//             console.error('Email notification error:', emailError);
//             // Don't fail the request if email fails
//         }

//         res.status(201).json({
//             message: 'Ticket created successfully',
//             ticket: newTicket
//         });
//     } catch (error) {
//         console.error('Add ticket error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// // Edit ticket
// router.put('/edit-ticket/:ticketId', authenticateToken, async (req, res) => {
//     try {
//         const { ticketId } = req.params;
//         const { 
//             project,
//             requested_from,
//             requested_to,
//             contact,
//             date,
//             time,
//             description,
//             handler,
//             status,
//             comment,
//             end_date
//         } = req.body;

//         const ticket = await Ticket.findById(ticketId);
//         if (!ticket) {
//             return res.status(404).json({ message: 'Ticket not found' });
//         }

//         const updateData = {};
//         if (requested_from) updateData.requested_from = requested_from;
//         if (requested_to) updateData.requested_to = requested_to;
//         if (contact) updateData.contact = contact;
//         if (date) updateData.date = date;
//         if (time) updateData.time = time;
//         if (description) updateData.description = description;
//         if (handler) updateData.handler = handler;
//         if (status) updateData.status = status;
//         if (comment) updateData.comment = comment;
//         if (end_date) updateData.end_date = end_date;
        
//         // Auto set end_date if status is resolved or closed
//         if (status === 'resolved' || status === 'closed') {
//             updateData.end_date = end_date || new Date();
//         }

//         const updatedTicket = await Ticket.findByIdAndUpdate(
//             ticketId,
//             updateData,
//             { new: true }
//         );

//         // Send email notification for updates if contact is provided
//         try {
//             if (updatedTicket.contact) {
//                 await sendTicketNotification(updatedTicket.contact, updatedTicket.contact, {
//                     sender_title: updatedTicket.requested_from,
//                     receiver: updatedTicket.requested_to,
//                     description: updatedTicket.description,
//                     status: updatedTicket.status,
//                     date_of_issue: updatedTicket.date,
//                     receiver_comment: updatedTicket.comment
//                 }, 'updated');
//             }
//         } catch (emailError) {
//             console.error('Email notification error:', emailError);
//         }

//         res.json({
//             message: 'Ticket updated successfully',
//             ticket: updatedTicket
//         });
//     } catch (error) {
//         console.error('Edit ticket error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// // 9. Get all tickets
// router.get('/my-tickets', authenticateToken, async (req, res) => {
//     try {
//         let tickets;

//         if (req.user.role === 'admin' || req.user.role === 'manager') {
//             // Admin and Manager can view all tickets
//             tickets = await Ticket.find({});
//         } else {
//             // Regular users can view tickets they are involved in
//             tickets = await Ticket.find({
//                 $or: [
//                     { requested_from: req.user.email },
//                     { requested_to: req.user.email },
//                     { handler: req.user.email }
//                 ]
//             });
//         }

//         res.json({ tickets });
//     } catch (error) {
//         console.error('Get tickets error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// // Get tickets by ticket ID pattern
// router.get('/search/:ticketPattern', authenticateToken, async (req, res) => {
//     try {
//         const { ticketPattern } = req.params;

//         const tickets = await Ticket.find({ 
//             ticket: { $regex: ticketPattern, $options: 'i' } 
//         });

//         res.json({ tickets });
//     } catch (error) {
//         console.error('Get tickets by pattern error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// // Get single ticket
// router.get('/:ticketId', authenticateToken, async (req, res) => {
//     try {
//         const { ticketId } = req.params;

//         const ticket = await Ticket.findById(ticketId);
//         if (!ticket) {
//             return res.status(404).json({ message: 'Ticket not found' });
//         }

//         res.json({ ticket });
//     } catch (error) {
//         console.error('Get ticket error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// // Get tickets by status
// router.get('/filter/status/:status', authenticateToken, async (req, res) => {
//     try {
//         const { status } = req.params;
//         let tickets;

//         if (req.user.role === 'admin' || req.user.role === 'manager') {
//             tickets = await Ticket.find({ status });
//         } else {
//             tickets = await Ticket.find({ 
//                 status,
//                 $or: [
//                     { requested_from: req.user.email },
//                     { requested_to: req.user.email },
//                     { handler: req.user.email }
//                 ]
//             });
//         }

//         res.json({ tickets });
//     } catch (error) {
//         console.error('Get tickets by status error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// // Get all tickets (Admin/Manager only)
// router.get('/', authenticateToken, async (req, res) => {
//     try {
//         if (req.user.role !== 'admin' && req.user.role !== 'manager') {
//             return res.status(403).json({ message: 'Access denied. Admin or Manager role required' });
//         }

//         const tickets = await Ticket.find({});
//         res.json({ tickets });
//     } catch (error) {
//         console.error('Get all tickets error:', error);
//         res.status(500).json({ message: 'Internal server error' });
//     }
// });

// module.exports = router;
