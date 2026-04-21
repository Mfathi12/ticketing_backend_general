# Real-time Notification System with Socket.io

## Overview
This system provides real-time notifications with sound alerts when new tickets are created or replies are added. It works on both desktop and mobile web apps.

## Backend Implementation

### 1. Socket.io Server Setup (`app.js`)
- Socket.io server is initialized and attached to the HTTP server
- JWT authentication middleware for socket connections
- User rooms for targeted notifications (`user:${userId}`)

### 2. Notification Events
- **New Ticket**: Emitted when a ticket is created
  - Notifies the receiver (`requested_to_email`)
  - Notifies all CC users
- **Ticket Reply**: Emitted when a reply is added
  - Notifies ticket receiver, sender, and CC users

### 3. Socket Authentication
- Uses JWT token from `socket.handshake.auth.token`
- Verifies token using the same JWT_SECRET as the REST API
- Stores user ID and email in socket session

## Frontend Implementation

### 1. Socket Service (`src/services/socketService.js`)
- Singleton service for Socket.io client
- Handles connection, reconnection, and event management
- Supports both WebSocket and polling transports (for mobile compatibility)

### 2. Notification Context (`src/contexts/NotificationContext.jsx`)
- Manages notification state
- Plays sound notifications (with beep fallback)
- Requests browser notification permissions
- Shows browser notifications on mobile devices

### 3. Notification Bell Component (`src/components/notifications/NotificationBell.jsx`)
- Displays notification count badge
- Shows notification dropdown
- Click to navigate to ticket
- Mark as read functionality

## Features

### Sound Notifications
- Tries to play `/notification-sound.mp3` from public folder
- Falls back to Web Audio API beep if file doesn't exist
- Volume set to 50% to avoid being too loud

### Browser Notifications (Mobile)
- Requests permission on first load
- Shows native browser notifications
- Works when app is in background on mobile

### Real-time Updates
- Instant notifications when tickets are created
- Instant notifications when replies are added
- No page refresh needed

## Setup Instructions

### 1. Add Notification Sound (Optional)
Add a notification sound file to:
```
public/notification-sound.mp3
```
Recommended: Short (0.5-1 second), pleasant sound
If not provided, the system will use a beep sound.

### 2. Environment Variables
Ensure `JWT_SECRET` is set in your `.env` file (backend):
```
JWT_SECRET=your-secret-key
```

### 3. Socket URL Configuration
Update the socket URL in `src/services/socketService.js` if needed:
```javascript
const SOCKET_URL = 'https://tickets.absai.dev';
```

## Usage

### For Users
1. Log in to the application
2. Socket connection is automatically established
3. When a new ticket is created for you, you'll:
   - Hear a notification sound
   - See a notification badge on the bell icon
   - Receive a browser notification (if permission granted)
4. Click the bell icon to view all notifications
5. Click a notification to navigate to the ticket

### For Developers

#### Adding New Notification Types
1. Emit event from backend:
```javascript
io.to(`user:${userId}`).emit('event_name', {
  type: 'event_name',
  message: 'Your message',
  data: { /* your data */ }
});
```

2. Listen in NotificationContext:
```javascript
socketService.on('event_name', (data) => {
  // Handle notification
});
```

## Mobile Web App Support

### Service Worker (Future Enhancement)
For better mobile support, consider adding a service worker for:
- Push notifications when app is closed
- Background sync
- Offline support

### Current Mobile Features
- ✅ Sound notifications work
- ✅ Browser notifications work
- ✅ Socket reconnection on network changes
- ✅ Works in mobile browsers

## Troubleshooting

### Notifications Not Working
1. Check browser console for socket connection errors
2. Verify JWT token is valid
3. Check backend logs for socket authentication errors
4. Ensure user email matches in database

### Sound Not Playing
1. Check browser audio permissions
2. Verify `/notification-sound.mp3` exists (or beep will be used)
3. Check browser console for audio errors

### Mobile Notifications Not Showing
1. Request notification permission manually
2. Check browser settings for notification permissions
3. Ensure HTTPS is used (required for notifications)

## Security Notes
- Socket connections are authenticated with JWT
- Users only receive notifications for tickets they're involved in
- CC users are verified before sending notifications

