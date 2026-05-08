const fsp = require('fs/promises');
const path = require('path');

// Map MIME subtype to file extension (handles svg+xml, jpeg, etc.)
const mimeToExt = (subtype) => {
    if (!subtype) return 'png';
    const s = subtype.toLowerCase().split(';')[0].trim();
    if (s === 'svg+xml' || s === 'svg') return 'svg';
    if (s === 'jpeg' || s === 'jpg') return 'jpeg';
    if (s === 'png' || s === 'gif' || s === 'webp') return s;
    return s.replace(/\+.*$/, '');
};

/**
 * Convert base64 data URL to file and save it
 * @param {string} base64Data - Base64 data URL (e.g., "data:image/png;base64,iVBORw0KG...")
 * @returns {string} - URL path to the saved file
 */
const saveBase64AsFile = async (base64Data) => {
    try {
        if (!base64Data || typeof base64Data !== 'string') {
            throw new Error('Invalid image data');
        }
        const trimmed = base64Data.trim();
        // If it's already a URL (not base64), return as is
        if (!trimmed.startsWith('data:image/')) {
            return trimmed;
        }

        // Extract mime type and base64 data (allow any subtype e.g. svg+xml; .* with [\s\S] for newlines)
        const matches = trimmed.match(/^data:image\/([^;]+);base64,([\s\S]+)$/);
        if (!matches) {
            throw new Error('Invalid base64 image format');
        }

        const mimeSubtype = matches[1].trim();
        // Normalize base64: remove whitespace/newlines (some clients send padded)
        const base64String = matches[2].replace(/\s/g, '');
        const buffer = Buffer.from(base64String, 'base64');

        // Create uploads directory if it doesn't exist
        const uploadsDir = path.join(__dirname, '../uploads/tickets');
        await fsp.mkdir(uploadsDir, { recursive: true });

        // Generate unique filename with correct extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = mimeToExt(mimeSubtype);
        const filename = `image-${uniqueSuffix}.${ext}`;
        const filePath = path.join(uploadsDir, filename);

        await fsp.writeFile(filePath, buffer);

        // Return URL path
        return `/uploads/tickets/${filename}`;
    } catch (error) {
        console.error('Error saving base64 image:', error);
        throw error;
    }
};

/**
 * Process images array - convert base64 to files if needed
 * @param {Array<string>} images - Array of image URLs or base64 data URLs
 * @returns {Array<string>} - Array of image URLs
 */
const processImages = async (images) => {
    if (!images || !Array.isArray(images)) {
        return [];
    }

    const out = await Promise.all(images.map(async (image) => {
        // Skip null, undefined, or non-string values
        if (!image || typeof image !== 'string') {
            console.warn('Skipping invalid image value:', image);
            return null;
        }

        // If it's a base64 data URL, convert it to a file
        if (image.startsWith('data:image/')) {
            return saveBase64AsFile(image);
        }

        // Otherwise, return as is (already a URL)
        return image;
    }));
    return out.filter((image) => image !== null);
};

module.exports = {
    saveBase64AsFile,
    processImages
};

