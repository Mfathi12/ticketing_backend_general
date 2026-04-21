# Test Socket.io Connection

## Current Status
✅ Backend is running and waiting for connections
❌ No connection attempts are reaching the backend

This means Nginx is not routing `/socket.io/` requests to the backend.

## Quick Test

### 1. Test Backend Directly (should work)
```bash
curl http://localhost:9090/socket.io/?EIO=4&transport=polling
```
You should get a Socket.io handshake response.

### 2. Test Through Nginx (might fail)
```bash
curl https://tickets.absai.dev/socket.io/?EIO=4&transport=polling
```
If this fails or returns 404, Nginx is not configured correctly.

## Nginx Configuration Required

Add this to your Nginx config file (`/etc/nginx/sites-available/tickets.absai.dev`):

```nginx
server {
    server_name tickets.absai.dev;
    
    # ... existing config ...
    
    # ⚠️ ADD THIS BLOCK - MUST be BEFORE /back/ location
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
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
    
    location / {
        try_files $uri /index.html;
    }
    
    location /back/ {
        proxy_pass http://127.0.0.1:9090/;
        # ... existing config ...
    }
    
    # ... rest of config ...
}
```

## After Adding Nginx Config

1. Test Nginx config:
   ```bash
   sudo nginx -t
   ```

2. Reload Nginx:
   ```bash
   sudo systemctl reload nginx
   ```

3. Test the connection again:
   ```bash
   curl https://tickets.absai.dev/socket.io/?EIO=4&transport=polling
   ```

4. Refresh your frontend and check backend logs - you should now see:
   ```
   Socket connection attempt - IP: ...
   Socket handshake auth: { token: '...' }
   ```

## Verify It's Working

Once configured, when you refresh the frontend, you should see in backend logs:
```
Socket connection attempt - IP: ::ffff:127.0.0.1
Socket handshake auth: { token: 'eyJhbGc...' }
Token decoded successfully: { userId: '...', email: '...' }
✓ Socket authentication successful for user: ...
✓ User connected: ... (Socket ID: ...)
```

