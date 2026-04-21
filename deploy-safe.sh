#!/bin/bash

# Safe deployment script that preserves uploads directory
# This version uses rsync for better handling of existing files
# Usage: ./deploy-safe.sh

set -e  # Exit on error

echo "🚀 Starting safe deployment..."

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Create temporary backup location
TEMP_BACKUP="/tmp/uploads_backup_$(date +%Y%m%d_%H%M%S)"

# Backup uploads directory if it exists
if [ -d "uploads" ]; then
    echo "📦 Backing up uploads directory to $TEMP_BACKUP..."
    mkdir -p "$TEMP_BACKUP"
    rsync -av uploads/ "$TEMP_BACKUP/" || cp -r uploads/* "$TEMP_BACKUP/" 2>/dev/null || true
    echo "✅ Backup created"
    HAS_BACKUP=true
else
    echo "⚠️  No uploads directory found to backup"
    HAS_BACKUP=false
fi

# Stash any local changes (optional - uncomment if needed)
# git stash

# Pull latest changes
echo "📥 Pulling latest changes from git..."
git pull origin main || git pull origin master || git pull

# Ensure uploads directory exists
mkdir -p uploads/tickets
mkdir -p uploads/chat/image
mkdir -p uploads/chat/video
mkdir -p uploads/chat/voice
mkdir -p uploads/chat/file

# Restore uploads directory from backup
if [ "$HAS_BACKUP" = true ] && [ -d "$TEMP_BACKUP" ]; then
    echo "📦 Restoring uploads directory..."
    # Use rsync to merge files (preserves existing, adds new)
    rsync -av "$TEMP_BACKUP/" uploads/ || cp -rn "$TEMP_BACKUP"/* uploads/ 2>/dev/null || true
    echo "✅ Uploads directory restored"
    
    # Clean up backup
    rm -rf "$TEMP_BACKUP"
    echo "🧹 Temporary backup removed"
fi

# Set proper permissions (adjust as needed)
chmod -R 755 uploads/ 2>/dev/null || true

# Install/update dependencies
echo "📦 Installing dependencies..."
npm install --production

# Restart the application
echo "🔄 Please restart your application:"
echo "   PM2: pm2 restart ticketing_backend"
echo "   Systemd: sudo systemctl restart ticketing_backend"
echo "   Manual: node app.js"

echo "✅ Safe deployment complete!"

