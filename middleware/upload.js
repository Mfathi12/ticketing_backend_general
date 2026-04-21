const multer = require('multer');
const path = require('path');
const fs = require('fs');

const isVercel = Boolean(process.env.VERCEL);
const uploadsDir = process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : (isVercel ? '/tmp/uploads/tickets' : path.join(__dirname, '../uploads/tickets'));

// Create uploads directory if it doesn't exist
try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
} catch (error) {
    console.error('Failed to initialize uploads directory:', uploadsDir, error.message);
}

// Configure storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        let ext = path.extname(file.originalname);
        // Some clients don't send extension; derive from mimetype for images
        if (!ext && file.mimetype && file.mimetype.startsWith('image/')) {
            const m = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp' };
            ext = m[file.mimetype.toLowerCase()] || ('.' + file.mimetype.split('/')[1].split(';')[0].replace('+xml', ''));
        }
        const name = path.basename(file.originalname, path.extname(file.originalname)) || 'image';
        cb(null, `${name}-${uniqueSuffix}${ext || '.png'}`);
    }
});

// File filter - only allow images (some clients send image as application/octet-stream)
const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;
const fileFilter = (req, file, cb) => {
    const isImageMime = file.mimetype && file.mimetype.startsWith('image/');
    const hasImageExt = file.originalname && IMAGE_EXTENSIONS.test(file.originalname);
    if (isImageMime || (file.mimetype === 'application/octet-stream' && hasImageExt)) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed!'), false);
    }
};

// Configure multer
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB per file
    },
    fileFilter: fileFilter
});

// Middleware for multiple images
const uploadMultiple = upload.array('images', 10); // Max 10 images

module.exports = {
    uploadsDir,
    uploadMultiple,
    uploadSingle: upload.single('image')
};

