#!/bin/bash

# Deployment script that preserves uploads directory
# Usage: ./deploy.sh

set -e  # Exit on error

echo "🚀 Starting deployment..."

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Backup uploads directory if it exists
if [ -d "uploads" ]; then
    echo "📦 Backing up uploads directory..."
    BACKUP_DIR="uploads_backup_$(date +%Y%m%d_%H%M%S)"
    cp -r uploads "$BACKUP_DIR"
    echo "✅ Backup created: $BACKUP_DIR"
else
    echo "⚠️  No uploads directory found to backup"
    BACKUP_DIR=""
fi

# Pull latest changes
echo "📥 Pulling latest changes from git..."
git pull origin main || git pull origin master

# Restore uploads directory
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    echo "📦 Restoring uploads directory..."
    if [ -d "uploads" ]; then
        # Merge backup with existing uploads (in case new structure was added)
        cp -rn "$BACKUP_DIR"/* uploads/ 2>/dev/null || true
        # Ensure subdirectories exist
        mkdir -p uploads/tickets
        mkdir -p uploads/chat/image
        mkdir -p uploads/chat/video
        mkdir -p uploads/chat/voice
        mkdir -p uploads/chat/file
    else
        # Restore entire directory
        mv "$BACKUP_DIR" uploads
    fi
    echo "✅ Uploads directory restored"
    
    # Optionally remove backup (uncomment if you want to auto-clean)
    # rm -rf "$BACKUP_DIR"
    # echo "🧹 Backup removed"
else
    # Create uploads directory structure if it doesn't exist
    echo "📁 Creating uploads directory structure..."
    mkdir -p uploads/tickets
    mkdir -p uploads/chat/image
    mkdir -p uploads/chat/video
    mkdir -p uploads/chat/voice
    mkdir -p uploads/chat/file
    echo "✅ Uploads directory structure created"
fi

# Install/update dependencies
echo "📦 Installing dependencies..."
npm install

# Restart the application (adjust based on your process manager)
echo "🔄 Restarting application..."
# For PM2:
# pm2 restart ticketing_backend || pm2 start app.js --name ticketing_backend

# For systemd:
# sudo systemctl restart ticketing_backend

# For manual:
echo "⚠️  Please restart your application manually"
echo "   Example: pm2 restart ticketing_backend"
echo "   Or: sudo systemctl restart ticketing_backend"

echo "✅ Deployment complete!"

