# Socket.io Connection Debugging Checklist

## Current Status
- ✅ Frontend is attempting to connect (token is being sent)
- ❌ Backend is NOT receiving connection attempts (no logs appearing)

## Steps to Fix

### 1. Verify Backend Server is Running
```bash
# Check if backend is running on port 9090
netstat -tulpn | grep 9090
# or
ss -tulpn | grep 9090

# Check backend logs for startup message:
# "🚀 Server started on port: 9090"
# "📡 Socket.io server ready at http://localhost:9090/socket.io/"
```

### 2. Test Backend Directly
```bash
# Test if backend is accessible
curl http://localhost:9090/api/test
curl http://localhost:9090/health

# Test Socket.io handshake (should return Socket.io handshake response)
curl http://localhost:9090/socket.io/?EIO=4&transport=polling
```

### 3. Verify Nginx Configuration

**CRITICAL**: Add this to your Nginx config (`/etc/nginx/sites-available/tickets.absai.dev`):

```nginx
# WebSocket support for Socket.io - MUST be BEFORE /back/ location
location /socket.io/ {
    proxy_pass http://127.0.0.1:9090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    
    # Timeouts for long-lived connections
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
}

# Then your existing /back/ location...
location /back/ {
    proxy_pass http://127.0.0.1:9090/;
    # ... rest of config
}
```

### 4. Apply Nginx Changes
```bash
# Test configuration
sudo nginx -t

# If test passes, reload Nginx
sudo systemctl reload nginx

# Check Nginx error logs
sudo tail -f /var/log/nginx/tickets.absai.dev.error.log
```

### 5. Restart Backend Server
```bash
# Stop the backend
pm2 stop ticketing_backend
# or
pkill -f "node.*app.js"

# Start the backend
pm2 start app.js --name ticketing_backend
# or
node app.js

# Check logs for:
# "🚀 Server started on port: 9090"
# "📡 Socket.io server ready"
# "⏳ Waiting for socket connections..."
```

### 6. Test Connection Flow

**From Browser Console:**
```javascript
// Check if token exists
localStorage.getItem('token')

// Test Socket.io connection manually
import io from 'socket.io-client';
const socket = io('https://tickets.absai.dev', {
  path: '/socket.io/',
  auth: { token: localStorage.getItem('token') },
  transports: ['polling']
});
socket.on('connect', () => console.log('Connected!'));
socket.on('connect_error', (err) => console.error('Error:', err));
```

### 7. Check Backend Logs

When a connection attempt is made, you should see in backend console:
```
Socket connection attempt - IP: ::ffff:127.0.0.1
Socket handshake auth: { token: 'eyJhbGc...' }
Token decoded successfully: { userId: '...', email: '...' }
✓ Socket authentication successful for user: ...
✓ User connected: ... (Socket ID: ...)
```

### 8. Common Issues

**Issue**: No backend logs appearing
- **Solution**: Nginx `/socket.io/` location block is missing or incorrect
- **Check**: Nginx error logs for 404 or connection refused errors

**Issue**: "Connection refused" in Nginx logs
- **Solution**: Backend server is not running on port 9090
- **Check**: `netstat -tulpn | grep 9090`

**Issue**: "Authentication error" in backend logs
- **Solution**: Token is invalid or expired
- **Check**: Token in localStorage, try logging out and back in

**Issue**: "User not found" in backend logs
- **Solution**: User was deleted from database
- **Check**: Database for user with that ID

## Expected Behavior After Fix

1. Frontend attempts connection → Browser console shows "Attempting socket connection..."
2. Request reaches Nginx → Nginx proxies to backend
3. Backend receives connection → Console shows "Socket connection attempt..."
4. Authentication succeeds → Console shows "✓ Socket authentication successful"
5. Connection established → Browser console shows "Socket connected successfully"

## Quick Test Commands

```bash
# Test backend directly
curl http://localhost:9090/api/test

# Test through Nginx
curl https://tickets.absai.dev/api/test

# Test Socket.io handshake through Nginx
curl "https://tickets.absai.dev/socket.io/?EIO=4&transport=polling"

# Watch backend logs in real-time
tail -f /path/to/backend/logs
# or if using PM2
pm2 logs ticketing_backend
```

