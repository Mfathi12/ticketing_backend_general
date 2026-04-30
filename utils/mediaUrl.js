const getRequestBaseUrl = (req) => {
    if (!req) return '';
    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = req.get ? req.get('host') : '';
    return host ? `${protocol}://${host}` : '';
};

const normalizeBaseUrl = (raw) => String(raw || '').trim().replace(/\/+$/, '');

const getConfiguredMediaBaseUrl = () => normalizeBaseUrl(
    process.env.MEDIA_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_BASE_URL
);

const resolveMediaBaseUrl = (req) => getConfiguredMediaBaseUrl() || normalizeBaseUrl(getRequestBaseUrl(req));

const toAbsoluteMediaUrl = (rawUrl, req) => {
    const input = String(rawUrl || '').trim();
    if (!input) return '';
    if (/^https?:\/\//i.test(input)) return input;
    const base = resolveMediaBaseUrl(req);
    if (!base) return input;
    const normalizedPath = input.startsWith('/') ? input : `/${input}`;
    return `${base}${normalizedPath}`;
};

const mapMediaUrls = (urls, req) => {
    if (!Array.isArray(urls)) return [];
    return urls
        .map((url) => toAbsoluteMediaUrl(url, req))
        .filter(Boolean);
};

module.exports = {
    resolveMediaBaseUrl,
    toAbsoluteMediaUrl,
    mapMediaUrls
};
