const parseBoolean = (value, fallback = false) => {
    if (value == null) return fallback;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

/** When true, User/Company auth paths use PostgreSQL (see services/sql/authSql.js). */
const isPostgresPrimary = () =>
    parseBoolean(process.env.POSTGRES_PRIMARY, false) &&
    parseBoolean(process.env.POSTGRES_ENABLED, false);

module.exports = {
    parseBoolean,
    isPostgresPrimary
};
