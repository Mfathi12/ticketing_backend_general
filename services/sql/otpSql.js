const { getSequelize } = require('../../db/postgres');

let tableEnsured = false;

const ensureTable = async () => {
    if (tableEnsured) return;
    const sequelize = getSequelize();
    if (!sequelize) {
        throw new Error('PostgreSQL is not initialized');
    }
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS auth_email_otps (
            email VARCHAR(320) NOT NULL,
            purpose VARCHAR(32) NOT NULL,
            code VARCHAR(16) NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (email, purpose)
        );
    `);
    tableEnsured = true;
};

/**
 * @param {string} email normalized lowercase
 * @param {'registration'|'forgot_password'} purpose
 * @param {string} code
 * @param {number} expiryTimeMs Date.now() + ttl
 */
const upsertOtp = async (email, purpose, code, expiryTimeMs) => {
    await ensureTable();
    const sequelize = getSequelize();
    const expiresAt = new Date(expiryTimeMs);
    await sequelize.query(
        `
        INSERT INTO auth_email_otps (email, purpose, code, expires_at)
        VALUES (:email, :purpose, :code, :expiresAt)
        ON CONFLICT (email, purpose) DO UPDATE SET
            code = EXCLUDED.code,
            expires_at = EXCLUDED.expires_at;
        `,
        { replacements: { email, purpose, code, expiresAt } }
    );
};

/**
 * @returns {Promise<{ otp: string, expiryTime: number } | null>}
 */
const getOtp = async (email, purpose) => {
    await ensureTable();
    const sequelize = getSequelize();
    const [rows] = await sequelize.query(
        `
        SELECT code, expires_at AS "expiresAt"
        FROM auth_email_otps
        WHERE email = :email AND purpose = :purpose
        LIMIT 1;
        `,
        { replacements: { email, purpose } }
    );
    if (!rows || !rows.length) return null;
    const row = rows[0];
    return {
        otp: String(row.code),
        expiryTime: new Date(row.expiresAt).getTime()
    };
};

const deleteOtp = async (email, purpose) => {
    await ensureTable();
    const sequelize = getSequelize();
    await sequelize.query(
        `DELETE FROM auth_email_otps WHERE email = :email AND purpose = :purpose;`,
        { replacements: { email, purpose } }
    );
};

module.exports = {
    upsertOtp,
    getOtp,
    deleteOtp
};
