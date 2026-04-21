# Ticket Model Changes

## Overview
The ticket model has been updated to match the new data structure requirements.

## New Ticket Model Structure

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| **ticket** | String | Yes | Unique ticket identifier (e.g., "project_001") |
| **requested_from** | String | Yes | Person who requested the ticket |
| **requested_to** | String | Yes | Person assigned to handle the ticket |
| **contact** | String | No | Contact email for notifications |
| **date** | Date | No | Date of ticket creation (defaults to now) |
| **time** | String | No | Time of ticket creation |
| **description** | String | Yes | Detailed description of the ticket |
| **handler** | String | No | Email of the person handling the ticket |
| **status** | String | No | Ticket status (defaults to "open") |
| **comment** | String | No | Comments on the ticket |
| **end_date** | Date | No | Date when ticket was closed/resolved |

## Status Values
- `open` - Ticket is new/open
- `in_progress` - Work has started
- `resolved` - Issue is resolved
- `closed` - Ticket is closed
- `pending` - Waiting for something

## API Endpoints Updated

### Create Ticket
```http
POST /api/tickets/add-ticket
Authorization: Bearer <token>

{
  "ticket": "project_001",
  "requested_from": "John Doe",
  "requested_to": "Jane Smith",
  "contact": "john@example.com",
  "date": "2024-01-01",
  "time": "10:00 AM",
  "description": "Ticket description",
  "handler": "jane@example.com",
  "status": "open"
}
```

### Update Ticket
```http
PUT /api/tickets/edit-ticket/:ticketId
Authorization: Bearer <token>

{
  "status": "in_progress",
  "comment": "Working on this",
  "handler": "jane@example.com"
}
```

### Get My Tickets
```http
GET /api/tickets/my-tickets
Authorization: Bearer <token>
```
- Regular users see tickets they are involved in
- Admin/Manager see all tickets

### Get All Tickets (Admin/Manager)
```http
GET /api/tickets/
Authorization: Bearer <token>
```

### Search Tickets
```http
GET /api/tickets/search/project_001
Authorization: Bearer <token>
```

### Get Tickets by Status
```http
GET /api/tickets/filter/status/open
Authorization: Bearer <token>
```

### Get Single Ticket
```http
GET /api/tickets/:ticketId
Authorization: Bearer <token>
```

## Key Changes from Previous Model

1. **Removed Project Reference**: No longer tied to specific projects
2. **Unique Ticket ID**: Each ticket has a unique identifier
3. **Simplified Structure**: More straightforward field names
4. **Flexible Access**: Users can see tickets they're involved in (requested_from, requested_to, or handler)
5. **Email Notifications**: Sent to contact email when provided
6. **Auto End Date**: Automatically set when status changes to "resolved" or "closed"

## Email Notifications
- Sent when ticket is created (if contact is provided)
- Sent when ticket is updated (if contact is provided)
- Notifications include all ticket details

## Security & Access Control
- **Admin/Manager**: Can view and edit all tickets
- **Regular Users**: Can view tickets they are involved in
- **Authentication**: All endpoints require JWT token
