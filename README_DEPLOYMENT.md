# Deployment Guide

## Problem
When pulling new code to the VPS, the `uploads/` directory gets deleted, causing all uploaded images to be lost.

## Solution
Use the provided deployment scripts that automatically backup and restore the `uploads/` directory.

## Quick Deploy

### Option 1: Simple Deploy Script
```bash
chmod +x deploy.sh
./deploy.sh
```

### Option 2: Safe Deploy Script (Recommended)
```bash
chmod +x deploy-safe.sh
./deploy-safe.sh
```

## Manual Deployment Steps

If you prefer to deploy manually:

1. **Backup uploads directory:**
   ```bash
   cp -r uploads uploads_backup_$(date +%Y%m%d_%H%M%S)
   ```

2. **Pull latest code:**
   ```bash
   git pull origin main
   # or
   git pull origin master
   ```

3. **Restore uploads directory:**
   ```bash
   # If uploads was deleted, restore it
   if [ ! -d "uploads" ]; then
       mv uploads_backup_* uploads
   else
       # Merge backup with existing
       cp -rn uploads_backup_*/* uploads/
   fi
   ```

4. **Ensure directory structure exists:**
   ```bash
   mkdir -p uploads/tickets
   mkdir -p uploads/chat/image
   mkdir -p uploads/chat/video
   mkdir -p uploads/chat/voice
   mkdir -p uploads/chat/file
   ```

5. **Install dependencies:**
   ```bash
   npm install
   ```

6. **Restart application:**
   ```bash
   # PM2
   pm2 restart ticketing_backend
   
   # Systemd
   sudo systemctl restart ticketing_backend
   ```

## Preventing Future Issues

### 1. Add .gitkeep files (optional)
To ensure the directory structure is preserved in git:

```bash
touch uploads/tickets/.gitkeep
touch uploads/chat/image/.gitkeep
touch uploads/chat/video/.gitkeep
touch uploads/chat/voice/.gitkeep
touch uploads/chat/file/.gitkeep
```

Then update `.gitignore`:
```
node_modules/
.env
uploads/*
!uploads/.gitkeep
!uploads/*/.gitkeep
```

### 2. Use Git Hooks (Advanced)
Create a post-merge hook that automatically restores uploads:

```bash
# .git/hooks/post-merge
#!/bin/bash
if [ -d "uploads_backup" ]; then
    cp -rn uploads_backup/* uploads/ 2>/dev/null || true
fi
```

### 3. Store Uploads Outside Git Directory
For production, consider storing uploads in a separate location:

```javascript
// In your code, use an environment variable
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
```

Then set `UPLOADS_DIR=/var/www/uploads` in your production environment.

## Troubleshooting

### Images still not loading after deployment?
1. Check file permissions:
   ```bash
   chmod -R 755 uploads/
   chown -R www-data:www-data uploads/  # Adjust user/group as needed
   ```

2. Verify directory structure:
   ```bash
   ls -la uploads/
   ls -la uploads/tickets/
   ```

3. Check backend logs for file path issues

### Backup not working?
- Ensure you have write permissions in the script directory
- Check disk space: `df -h`
- Verify backup was created: `ls -la uploads_backup_*`

## Best Practices

1. **Always backup before deploying** - The scripts do this automatically
2. **Test deployment on staging first** - If you have a staging environment
3. **Monitor disk space** - Uploads can grow large over time
4. **Consider external storage** - For production, use S3, Google Cloud Storage, etc.
5. **Regular backups** - Set up automated backups of the uploads directory

