const MAX_URL_LENGTH = 2048;

/**
 * Validates a single HTTPS URL for completion GIF catalog entries.
 * @param {unknown} raw
 * @returns {string}
 */
function validateCompletionGifUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error('url must be a non-empty string');
    }
    const url = raw.trim();
    if (url.length > MAX_URL_LENGTH) {
        throw new Error('url is too long');
    }
    if (!/^https:\/\//i.test(url)) {
        throw new Error('url must be a valid https URL');
    }
    return url;
}

function normalizeTags(raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) {
        throw new Error('tags must be an array');
    }
    return raw
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 20);
}

function normalizeWeight(raw, fallback = 1) {
    if (raw == null || raw === '') return fallback;
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(100, n);
}

module.exports = {
    MAX_URL_LENGTH,
    validateCompletionGifUrl,
    normalizeTags,
    normalizeWeight
};
