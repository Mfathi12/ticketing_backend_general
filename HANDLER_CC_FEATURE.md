# Handler CC Feature - Implementation Guide

## Overview
The ticket system now supports multiple handler email addresses that are automatically added as CC recipients when sending email notifications.

## Changes Made

### 1. Ticket Model Updates (`models/ticket.js`)

#### Added Fields:
- **`requested_from_email`**: Email of the person requesting the ticket (required)
- **`requested_to_email`**: Email of the person assigned to the ticket (required)
- **`handler`**: Array of email addresses for handlers (optional)

#### Handler Field Structure:
```javascript
handler: [{
    type: String,
    trim: true,
    lowercase: true
}]
```

### 2. Email Service Updates (`services/emailService.js`)

#### Enhanced `sendEmail` Function:
- Added optional `cc` parameter
- Supports both single email string and array of emails
- Automatically formats CC emails for nodemailer

```javascript
const sendEmail = async (to, subject, text, html, cc = null) => {
    // CC emails are automatically added if provided
}
```

#### Enhanced `sendTicketNotification` Function:
- Added `ccEmails` parameter (default: empty array)
- Sends emails to sender and receiver with handlers in CC
- Email includes handler information in the body

### 3. Ticket Routes Updates (`routes/ticketRoutes.js`)

#### Add Ticket API (`POST /api/tickets/add-ticket`):
- Accepts `handler` as single string or array
- Automatically converts to array format for CC
- Passes handler emails to notification function

#### Edit Ticket API (`PUT /api/tickets/edit-ticket/:ticketId`):
- Updates handler array
- Sends notifications with updated handler list in CC

## API Usage

### Create Ticket with Multiple Handlers

```http
POST /api/tickets/add-ticket
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "project": "64abc123def456789",
  "ticket": "TICKET-001",
  "requested_from": "John Doe",
  "requested_from_email": "john@example.com",
  "requested_to": "Jane Smith",
  "requested_to_email": "jane@example.com",
  "description": "Fix login bug",
  "handler": [
    "handler1@example.com",
    "handler2@example.com",
    "handler3@example.com"
  ],
  "date": "2024-01-15",
  "time": "10:30 AM",
  "status": "open"
}
```

### Create Ticket with Single Handler

```http
POST /api/tickets/add-ticket
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "project": "64abc123def456789",
  "ticket": "TICKET-002",
  "requested_from": "John Doe",
  "requested_from_email": "john@example.com",
  "requested_to": "Jane Smith",
  "requested_to_email": "jane@example.com",
  "description": "Update dashboard",
  "handler": "handler@example.com",
  "status": "open"
}
```

### Update Ticket Handlers

```http
PUT /api/tickets/edit-ticket/64abc123def456789
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "handler": [
    "newhandler1@example.com",
    "newhandler2@example.com"
  ],
  "status": "in_progress",
  "comment": "Assigned new handlers"
}
```

## Email Notification Behavior

### When Ticket is Created:
1. Email sent to `requested_from_email` (TO)
2. Email sent to `requested_to_email` (TO)
3. All emails in `handler` array added as CC to both emails

### When Ticket is Updated:
1. Email sent to `requested_from_email` (TO)
2. Email sent to `requested_to_email` (TO)
3. All emails in `handler` array added as CC to both emails
4. Email includes update information and comments

### Email Format:

**Subject:** `Ticket created - John Doe` or `Ticket updated - John Doe`

**Body includes:**
- Ticket Number
- From (requested_from)
- To (requested_to)
- Description
- Status
- Date
- Comments (if any)
- Handlers (CC) - displayed in email body

## Benefits

1. **Multiple Stakeholders**: Keep multiple team members informed
2. **Transparency**: All handlers receive the same information
3. **Flexibility**: Support both single and multiple handlers
4. **Automatic CC**: No manual intervention needed
5. **Email Trail**: All handlers have complete communication history

## Field Requirements

### Required Fields:
- `project` - Project ID reference
- `ticket` - Unique ticket identifier
- `requested_from` - Requester name
- `requested_from_email` - Requester email
- `requested_to` - Assigned person name
- `requested_to_email` - Assigned person email
- `description` - Ticket description

### Optional Fields:
- `handler` - Single email or array of handler emails
- `date` - Ticket date (defaults to now)
- `time` - Ticket time
- `status` - Ticket status (defaults to "open")
- `comment` - Comments
- `end_date` - Completion date

## Notes

- Handler emails are automatically converted to lowercase
- If handler is provided as a string, it's converted to an array internally
- Empty handler arrays are handled gracefully (no CC sent)
- Email failures don't block ticket creation/updates
- All email operations are logged to console

## Example Response

```json
{
  "message": "Ticket created successfully",
  "ticket": {
    "_id": "64abc123def456789",
    "project": "64xyz789abc123456",
    "ticket": "TICKET-001",
    "requested_from": "John Doe",
    "requested_from_email": "john@example.com",
    "requested_to": "Jane Smith",
    "requested_to_email": "jane@example.com",
    "description": "Fix login bug",
    "handler": [
      "handler1@example.com",
      "handler2@example.com"
    ],
    "status": "open",
    "date": "2024-01-15T00:00:00.000Z",
    "time": "10:30 AM",
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

