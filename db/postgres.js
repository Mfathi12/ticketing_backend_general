const { Sequelize } = require('sequelize');
const { defineModels } = require('./sequelize/models');
const { ensurePersonalTasksTable } = require('../services/sql/personalTasksTable');
const { ensureCompletionGifsTable } = require('../services/sql/completionGifsTable');
const { ensurePostgresRoleColumnsCompat } = require('../services/sql/ensurePostgresRoleColumnsCompat');
const { ensureTicketStatusEnumCompat } = require('../services/sql/ensureTicketStatusEnumCompat');

let sequelize = null;
let sequelizeModels = null;
let initPromise = null;

const parseBoolean = (value, fallback = false) => {
    if (value == null) return fallback;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const isPostgresEnabled = () => parseBoolean(process.env.POSTGRES_ENABLED, false);

const createSequelizeInstance = () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when POSTGRES_ENABLED=true');
    }

    const sslEnabled = parseBoolean(process.env.POSTGRES_SSL, false);

    return new Sequelize(databaseUrl, {
        dialect: 'postgres',
        logging: false,
        dialectOptions: sslEnabled
            ? {
                ssl: {
                    require: true,
                    rejectUnauthorized: false
                }
            }
            : undefined,
        pool: {
            max: Number(process.env.POSTGRES_POOL_MAX || 10),
            min: Number(process.env.POSTGRES_POOL_MIN || 0),
            idle: Number(process.env.POSTGRES_POOL_IDLE_MS || 10000),
            acquire: Number(process.env.POSTGRES_POOL_ACQUIRE_MS || 30000)
        }
    });
};

const runSyncIfConfigured = async (sql) => {
    if (parseBoolean(process.env.POSTGRES_SYNC_ALTER, false)) {
        await sql.sync({ alter: true });
        console.log('PostgreSQL: sequelize.sync({ alter: true }) completed.');
    } else if (parseBoolean(process.env.POSTGRES_SYNC, false)) {
        await sql.sync();
        console.log('PostgreSQL: sequelize.sync() completed.');
    }
};

const initPostgres = async () => {
    if (!isPostgresEnabled()) {
        return { enabled: false, sequelize: null, models: null };
    }

    sequelize = createSequelizeInstance();
    await sequelize.authenticate();
    sequelizeModels = defineModels(sequelize);
    await runSyncIfConfigured(sequelize);
    await ensurePostgresRoleColumnsCompat(sequelize).catch((err) => {
        console.error('PostgreSQL: ensurePostgresRoleColumnsCompat failed:', err.message);
    });
    await ensureTicketStatusEnumCompat(sequelize).catch((err) => {
        console.error('PostgreSQL: ensureTicketStatusEnumCompat failed:', err.message);
    });
    await ensurePersonalTasksTable(sequelize).catch((err) => {
        console.error('PostgreSQL: ensure personal_tasks table failed:', err.message);
    });
    await ensureCompletionGifsTable(sequelize).catch((err) => {
        console.error('PostgreSQL: ensure completion_gifs table failed:', err.message);
    });
    return { enabled: true, sequelize, models: sequelizeModels };
};

/**
 * Single shared init promise so routes can await the same connection + models.
 */
const startPostgresInit = () => {
    if (!isPostgresEnabled()) {
        return Promise.resolve({ enabled: false, sequelize: null, models: null });
    }
    if (!initPromise) {
        initPromise = initPostgres().catch((err) => {
            initPromise = null;
            sequelize = null;
            sequelizeModels = null;
            throw err;
        });
    }
    return initPromise;
};

const waitForPostgres = async (timeoutMs = 15000) => {
    const p = startPostgresInit();
    return Promise.race([
        p.then((r) => {
            if (!r.enabled) {
                throw new Error('POSTGRES_ENABLED is not true');
            }
            return r.models;
        }),
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error('PostgreSQL init timeout')), timeoutMs)
        )
    ]);
};

const getSequelize = () => sequelize;
const getSequelizeModels = () => sequelizeModels;

const closePostgres = async () => {
    if (!sequelize) return;
    await sequelize.close();
    sequelize = null;
    sequelizeModels = null;
    initPromise = null;
};

module.exports = {
    initPostgres,
    startPostgresInit,
    waitForPostgres,
    getSequelize,
    getSequelizeModels,
    closePostgres,
    isPostgresEnabled
};
