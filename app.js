const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns/promises');
dns.setServers(["1.1.1.1"]);
require('dotenv').config();

// Prefer public DNS resolvers for Atlas SRV lookups on some Windows setups.


// Atlas SRV lookups can intermittently fail on some Windows/DNS setups.
// Prefer IPv4 result ordering to reduce querySrv instability.


// Import routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const projectRoutes = require('./routes/projectRoutes');
const ticketRoutes = require('./routes/ticketRoutes');
const brofaRoutes = require('./routes/brofaRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const chatRoutes = require('./routes/chatRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const platformAdminRoutes = require('./routes/platformAdminRoutes');
const versionRoutes = require('./routes/versionRoutes');
const landingRoutes = require('./routes/landingRoutes');
const { languageMiddleware } = require('./middleware/language');
const {
    sendEightHourCheckoutReminders,
    processMidnightAttendanceRollover
} = require('./services/attendanceReminderService');
const { purgeStaleUnverifiedAccounts } = require('./services/unverifiedAccountPurgeService');


// Import database seeder
const { seedDefaultAdmin } = require('./utils/seedDatabase');

/** CORS: أضف في .env مثلاً CORS_ORIGINS=https://موقعك.netlify.app,http://localhost:5173 — فارغ أو * = السماح بأي Origin (مناسب للتطوير) */
const resolveCorsOrigin = () => {
    const raw = process.env.CORS_ORIGINS;
    if (raw == null || String(raw).trim() === '' || String(raw).trim() === '*') {
        return true;
    }
    const allowed = String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return (requestOrigin, callback) => {
        if (!requestOrigin) return callback(null, true);
        if (allowed.includes(requestOrigin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    };
};

const corsOrigin = resolveCorsOrigin();
const corsOptions = {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'x-lang',
        'Range',
        'Cache-Control',
        'Pragma'
    ],
    credentials: true
};

const app = express();
const port = process.env.PORT || 9091;

// Socket.io setup
const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);

const io = new Server(server, {
    path: '/socket.io/',
    cors: {
        // لا تستخدم origin: "*" مع credentials: true — غير صالح في المتصفحات
        origin: corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['polling', 'websocket'],
    allowEIO3: true
});

// Store user socket connections (userId -> socketId)
const userSockets = new Map();

// Socket.io authentication middleware
io.use(async (socket, next) => {
    try {
        console.log('Socket connection attempt - IP:', socket.handshake.address);
        console.log('Socket handshake auth:', socket.handshake.auth);

        const token = socket.handshake.auth?.token;

        if (!token) {
            console.log('Socket connection rejected: No token provided');
            const error = new Error('No token provided');
            error.data = { type: 'AUTH_ERROR', message: 'No token provided' };
            return next(error);
        }

        // Verify JWT token using the same logic as REST API
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
            console.log('Token decoded successfully:', { userId: decoded.userId, email: decoded.email });
        } catch (jwtError) {
            console.error('JWT verification failed:', jwtError.name, jwtError.message);
            const error = new Error('Invalid token');
            error.data = {
                type: 'AUTH_ERROR',
                message: jwtError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token',
                jwtError: jwtError.name
            };
            return next(error);
        }

        if (!decoded.userId) {
            console.log('Socket connection rejected: Invalid token structure - no userId');
            const error = new Error('Invalid token structure');
            error.data = { type: 'AUTH_ERROR', message: 'Invalid token structure' };
            return next(error);
        }

        // Verify user exists
        const { User } = require('./models');
        let user;
        try {
            user = await User.findById(decoded.userId);
        } catch (dbError) {
            console.error('Database error finding user:', dbError);
            const error = new Error('Database error');
            error.data = { type: 'AUTH_ERROR', message: 'Database error' };
            return next(error);
        }

        if (!user) {
            console.log(`Socket connection rejected: User not found (${decoded.userId})`);
            const error = new Error('User not found');
            error.data = { type: 'AUTH_ERROR', message: 'User not found' };
            return next(error);
        }

        if (user.registrationEmailPending === true) {
            const error = new Error('Email not verified');
            error.data = { type: 'AUTH_ERROR', message: 'Email not verified' };
            return next(error);
        }

        // Attach user info to socket
        socket.userId = decoded.userId;
        socket.userEmail = decoded.email || user.email;

        console.log(`✓ Socket authentication successful for user: ${decoded.userId} (${socket.userEmail})`);
        next();
    } catch (err) {
        console.error('Unexpected socket authentication error:', err);
        console.error('Error stack:', err.stack);
        const error = new Error('Authentication failed');
        error.data = {
            type: 'AUTH_ERROR',
            message: err.message || 'Authentication failed',
            errorName: err.name
        };
        return next(error);
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`✓ User connected: ${socket.userId} (${socket.userEmail}) - Socket ID: ${socket.id}`);

    // Store user socket connection
    if (socket.userId) {
        userSockets.set(socket.userId.toString(), socket.id);
        console.log(`  Stored socket mapping: ${socket.userId} -> ${socket.id}`);
    }

    // Join user's personal room
    const userRoom = `user:${socket.userId.toString()}`;
    socket.join(userRoom);
    console.log(`  User ${socket.userId} joined room: ${userRoom}`);

    // Handle disconnection
    socket.on('disconnect', (reason) => {
        console.log(`✗ User disconnected: ${socket.userId} - Reason: ${reason}`);
        if (socket.userId) {
            userSockets.delete(socket.userId.toString());
        }
    });

    // Handle connection errors
    socket.on('error', (error) => {
        console.error(`Socket error for user ${socket.userId}:`, error);
    });
});

// Export io for use in routes
app.set('io', io);
app.set('userSockets', userSockets);

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(languageMiddleware);

// Serve static files (uploaded images)
const path = require('path');
const fs = require('fs');

// Handle OPTIONS requests for CORS preflight
app.options('/uploads/tickets/:filename', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.status(200).end();
});

// Also handle /back/uploads/ in case Nginx doesn't strip /back
app.options('/back/uploads/tickets/:filename', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.status(200).end();
});

// Helper function to serve ticket images
const serveTicketImage = (req, res) => {
    // Decode URL-encoded filename
    let filename = decodeURIComponent(req.params.filename);

    // Fix common filename issues
    if (filename.endsWith('t') && filename.length > 4) {
        const ext = path.extname(filename);
        if (ext && ext.length > 1 && ext[ext.length - 1] === 't') {
            const baseExt = ext.slice(0, -1);
            const validExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
            if (validExts.includes(baseExt)) {
                console.log(`[Image Request] Fixing malformed extension: ${filename} -> ${filename.slice(0, -1)}`);
                filename = filename.slice(0, -1);
            }
        }
    }

    const filePath = path.join(__dirname, 'uploads', 'tickets', filename);

    console.log(`[Image Request] Original filename param: ${req.params.filename}`);
    console.log(`[Image Request] Processed filename: ${filename}`);
    console.log(`[Image Request] File path: ${filePath}`);

    // Function to serve the file
    const serveFile = (filePathToServe, fileNameToLog) => {
        // Check if file exists and get stats FIRST
        if (!fs.existsSync(filePathToServe)) {
            console.error(`[Image Request] File not found: ${filePathToServe}`);
            return false;
        }

        let stat;
        try {
            stat = fs.statSync(filePathToServe);

            // Verify file is readable and has content
            if (!stat.isFile() || stat.size === 0) {
                console.error(`[Image Request] Invalid file or empty: ${filePathToServe}`);
                return false;
            }
        } catch (error) {
            console.error(`[Image Request] Error reading file stats:`, error);
            return false;
        }

        const ext = path.extname(fileNameToLog).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml'
        };

        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');

        const range = req.headers.range;

        if (range) {
            // Parse range header
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            let end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

            // Validate range
            if (isNaN(start) || start < 0 || start >= stat.size) {
                console.error(`[Image Request] Invalid range start: ${start}`);
                res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
                return true;
            }

            // Ensure end is within bounds
            if (isNaN(end) || end >= stat.size) {
                end = stat.size - 1;
            }

            if (start > end) {
                console.error(`[Image Request] Invalid range: start(${start}) > end(${end})`);
                res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
                return true;
            }

            const chunksize = (end - start) + 1;

            console.log(`[Image Request] Serving range: ${start}-${end}/${stat.size} (${chunksize} bytes)`);

            // Set headers BEFORE creating stream
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
            res.setHeader('Content-Length', chunksize);

            // Create read stream with error handling
            const fileStream = fs.createReadStream(filePathToServe, {
                start,
                end,
                highWaterMark: 64 * 1024 // 64KB chunks for better performance
            });

            let streamErrorOccurred = false;

            fileStream.on('error', (error) => {
                streamErrorOccurred = true;
                console.error('[Image Request] Stream error:', error);

                // Destroy the stream
                fileStream.destroy();

                // Only send error if headers haven't been sent
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming file' });
                } else {
                    // Headers already sent, just end the response
                    res.end();
                }
            });

            // Handle client disconnection
            req.on('aborted', () => {
                console.log('[Image Request] Client aborted request');
                fileStream.destroy();
            });

            // Pipe with error handling
            fileStream.pipe(res).on('error', (error) => {
                console.error('[Image Request] Pipe error:', error);
                if (!streamErrorOccurred) {
                    fileStream.destroy();
                }
            });

        } else {
            // No range request - send full file
            console.log(`[Image Request] Serving full file: ${stat.size} bytes`);

            res.setHeader('Content-Length', stat.size);

            const fileStream = fs.createReadStream(filePathToServe, {
                highWaterMark: 64 * 1024 // 64KB chunks
            });

            let streamErrorOccurred = false;

            fileStream.on('error', (error) => {
                streamErrorOccurred = true;
                console.error('[Image Request] Stream error:', error);

                fileStream.destroy();

                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error streaming file' });
                } else {
                    res.end();
                }
            });

            req.on('aborted', () => {
                console.log('[Image Request] Client aborted request');
                fileStream.destroy();
            });

            fileStream.pipe(res).on('error', (error) => {
                console.error('[Image Request] Pipe error:', error);
                if (!streamErrorOccurred) {
                    fileStream.destroy();
                }
            });
        }

        return true;
    };

    // Try to serve the requested file
    if (serveFile(filePath, filename)) {
        return;
    }

    // File not found, try to find alternatives
    const dirPath = path.join(__dirname, 'uploads', 'tickets');
    let foundFile = null;

    if (fs.existsSync(dirPath)) {
        try {
            const files = fs.readdirSync(dirPath);

            // Try corrected filename (remove trailing 't')
            if (filename.endsWith('t')) {
                const correctedFilename = filename.slice(0, -1);
                if (files.includes(correctedFilename)) {
                    foundFile = correctedFilename;
                    console.log(`[Image Request] Found file with corrected extension: ${correctedFilename}`);
                }
            }

            // Try to find by various matching strategies
            if (!foundFile) {
                const baseName = filename.replace(/\.[^.]+$/, '');
                const ext = path.extname(filename);

                const similarFiles = files.filter(f => {
                    if (f === filename) return true;

                    try {
                        const decodedF = decodeURIComponent(f);
                        if (decodedF === filename) return true;
                    } catch (e) { }

                    const fBase = f.replace(/\.[^.]+$/, '');
                    const fExt = path.extname(f);
                    if (fBase === baseName && fExt === ext) return true;

                    try {
                        const decodedFBase = decodeURIComponent(f).replace(/\.[^.]+$/, '');
                        const decodedFExt = path.extname(decodeURIComponent(f));
                        if (decodedFBase === baseName && decodedFExt === ext) return true;
                    } catch (e) { }

                    const reqParts = baseName.split('-');
                    const fParts = fBase.split('-');
                    if (reqParts.length >= 2 && fParts.length >= 2) {
                        const reqSuffix = reqParts.slice(-2).join('-');
                        const fSuffix = fParts.slice(-2).join('-');
                        if (reqSuffix === fSuffix && fExt === ext) {
                            console.log(`[Image Request] Matched by timestamp suffix: ${reqSuffix}`);
                            return true;
                        }
                    }

                    return false;
                });

                if (similarFiles.length > 0) {
                    foundFile = similarFiles[0];
                    console.log(`[Image Request] Found similar file: ${foundFile}`);
                }
            }
        } catch (dirError) {
            console.error(`[Image Request] Error reading directory:`, dirError);
        }
    }

    // Try to serve the found file
    if (foundFile) {
        const foundFilePath = path.join(dirPath, foundFile);
        if (serveFile(foundFilePath, foundFile)) {
            return;
        }
    }

    // No file found
    console.error(`[Image Request] Image not found: ${filePath}`);
    res.status(404).json({
        error: 'Image not found',
        filename,
        filePath,
        attemptedCorrection: foundFile || null
    });
};
// Explicit route handler for ticket images (placed before static to take precedence)
// IMPORTANT: These routes must come BEFORE the static middleware
app.get('/uploads/tickets/:filename', serveTicketImage);

// Serve ticket images under /api/uploads/tickets so same base URL as API works (like chat files)
app.options('/api/uploads/tickets/:filename', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.status(200).end();
});
app.get('/api/uploads/tickets/:filename', serveTicketImage);

// Also handle /back/... in case Nginx proxies with /back prefix
app.get('/back/uploads/tickets/:filename', serveTicketImage);
app.get('/back/api/uploads/tickets/:filename', serveTicketImage);

// Handle OPTIONS requests for chat files CORS preflight
app.options('/uploads/chat/:type/:filename', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.status(200).end();
});

// Route handler for chat images/files
app.get('/uploads/chat/:type/:filename', (req, res) => {
    const { type } = req.params;
    // Decode URL-encoded filename (handles Arabic and other non-ASCII characters)
    let filename = decodeURIComponent(req.params.filename);

    const filePath = path.join(__dirname, 'uploads', 'chat', type, filename);

    console.log(`[Chat File Request] Type: ${type}`);
    console.log(`[Chat File Request] Original filename param: ${req.params.filename}`);
    console.log(`[Chat File Request] Decoded filename: ${filename}`);
    console.log(`[Chat File Request] File path: ${filePath}`);
    console.log(`[Chat File Request] File exists: ${fs.existsSync(filePath)}`);

    if (fs.existsSync(filePath)) {
        try {
            const stat = fs.statSync(filePath);
            const ext = path.extname(filename).toLowerCase();
            const mimeTypes = {
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml',
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.ogg': 'video/ogg',
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.pdf': 'application/pdf',
                '.doc': 'application/msword',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.zip': 'application/zip',
                '.rar': 'application/x-rar-compressed'
            };

            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            res.setHeader('Cache-Control', 'public, max-age=31536000');

            const fileStream = fs.createReadStream(filePath);
            fileStream.on('error', (error) => {
                console.error('Error streaming chat file:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Error serving file' });
                }
            });
            fileStream.pipe(res);
        } catch (error) {
            console.error('Error serving chat file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error serving file', message: error.message });
            }
        }
    } else {
        res.status(404).json({ error: 'File not found', filename });
    }
});

// Serve static files with proper MIME types (fallback for other uploads)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res, filePath) => {
        try {
            // Get file stats for Content-Length
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                res.setHeader('Content-Length', stat.size);
            }
        } catch (error) {
            console.error('Error getting file stats:', error);
        }

        // Set proper content type based on file extension
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.ogg': 'video/ogg',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.ogg': 'audio/ogg',
            '.pdf': 'application/pdf',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.xls': 'application/vnd.ms-excel',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.zip': 'application/zip',
            '.rar': 'application/x-rar-compressed'
        };
        if (mimeTypes[ext]) {
            res.setHeader('Content-Type', mimeTypes[ext]);
        }
        // Allow CORS for files
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
}));

// Test endpoint to verify server is running
app.get('/api/test', (req, res) => {
    res.json({
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        socketIo: 'Socket.io should be available at /socket.io/'
    });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/brofa', brofaRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/platform-admin', platformAdminRoutes);
app.use('/api/version', versionRoutes);
app.use('/api/landing', landingRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ message: 'ABSAI Ticket Management API is running!' });
});
app.get('/', (req, res) => {
    res.json({ message: 'ABSAI Ticket Management API is running!' });
});

// DB connection
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    console.error('MONGODB_URI is not set');
} else {
    mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 15000,
        socketTimeoutMS: 45000,
        family: 4,
        maxPoolSize: 10
    }).catch((error) => {
        console.error('MongoDB connection failed:', error.message);
    });
}

const db = mongoose.connection;
db.on('error', (error) => {
    console.log("Connection error:", error);
});

db.once('open', async () => {
    console.log("Connection successful to database!");

    const { refreshPlanCatalogCache } = require('./services/subscriptionService');
    await refreshPlanCatalogCache().catch((err) => console.error('Plan catalog cache (startup):', err));

    if (!process.env.VERCEL) {
        // Seed default admin user in persistent server only
        await seedDefaultAdmin();

        purgeStaleUnverifiedAccounts().catch((err) =>
            console.error('Unverified account purge (startup):', err)
        );

        // Start periodic attendance reminder job after DB is connected
        const intervalMinutes = parseInt(process.env.ATTENDANCE_REMINDER_INTERVAL_MINUTES || '15', 10);
        const intervalMs = Math.max(intervalMinutes, 5) * 60 * 1000; // minimum 5 minutes

        console.log(`Starting attendance reminder job every ${intervalMs / (60 * 1000)} minutes`);

        setInterval(() => {
            processMidnightAttendanceRollover()
                .catch(err => console.error('Attendance midnight rollover error:', err));
            sendEightHourCheckoutReminders()
                .catch(err => console.error('Attendance reminder interval error:', err));
            purgeStaleUnverifiedAccounts()
                .catch(err => console.error('Unverified account purge error:', err));
        }, intervalMs);
    }
});

if (!process.env.VERCEL) {
    server.listen(port, () => {
        console.log(`\n🚀 Server started on port: ${port}`);
        console.log(`📡 Socket.io server ready at http://localhost:${port}/socket.io/`);
        console.log(`🔗 Health check: http://localhost:${port}/health`);
        console.log(`🧪 Test endpoint: http://localhost:${port}/api/test`);
        console.log(`\n⏳ Waiting for socket connections...\n`);
    });
}

module.exports = app;
