const { normalizeLang, translateRawMessage } = require('../utils/i18n');

const languageMiddleware = (req, _res, next) => {
    const fromHeader = req.headers['x-lang'] || req.headers['accept-language'];
    const fromQuery = req.query?.lang;
    req.lang = normalizeLang(fromQuery || fromHeader || 'en');
    const originalJson = _res.json.bind(_res);
    _res.json = (payload) => {
        if (payload && typeof payload === 'object') {
            if (typeof payload.message === 'string') {
                payload.message = translateRawMessage(req.lang, payload.message);
            }
            if (payload.error && typeof payload.error.message === 'string') {
                payload.error.message = translateRawMessage(req.lang, payload.error.message);
            }
        }
        return originalJson(payload);
    };
    next();
};

module.exports = {
    languageMiddleware
};
