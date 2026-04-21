# Nginx WebSocket Configuration for Socket.io

The WebSocket connection is failing because Nginx needs to be configured to support WebSocket upgrades. 

## Update your Nginx configuration

Add or update the `/back/` location block in your Nginx config file (`/etc/nginx/sites-available/tickets.absai.dev` or similar) to include WebSocket support:

```nginx
server {
    server_name tickets.absai.dev;

    access_log /var/log/nginx/tickets.absai.dev.access.log;
    error_log /var/log/nginx/tickets.absai.dev.error.log;

    root /var/www/app/build;
    index index.html;

    # WebSocket support for Socket.io - MUST be before the general /back/ location
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

    location / {
        try_files $uri /index.html;
    }

    location /back/ {
        proxy_pass http://127.0.0.1:9090/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ... rest of your config (SSL, etc.)
}
```

## Important Notes:

1. **Order matters**: The `/socket.io/` location block MUST come before the general `/back/` location block
2. **WebSocket headers**: The `Upgrade` and `Connection` headers are essential for WebSocket support
3. **Timeouts**: Long timeouts are needed for WebSocket connections to stay alive
4. **After updating**: Run `sudo nginx -t` to test the configuration, then `sudo systemctl reload nginx` to apply changes

## Alternative: If Socket.io path is different

If your Socket.io is served from a different path, you can also proxy all Socket.io requests through the `/back/` location by ensuring it has WebSocket support (which it should already have based on your current config).

The issue is likely that the `/socket.io/` path needs explicit WebSocket support, or the `/back/` location needs to handle it properly.

