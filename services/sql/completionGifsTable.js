/**
 * Ensures the `completion_gifs` table exists (matches Sequelize CompletionGif model).
 * Run once at Postgres startup so deployments without POSTGRES_SYNC_ALTER still work.
 */
let ensured = false;

const ensureCompletionGifsTable = async (sequelize) => {
    if (!sequelize || ensured) return;
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "completion_gifs" (
            "id" VARCHAR(24) PRIMARY KEY,
            "url" VARCHAR(2048) NOT NULL,
            "label" VARCHAR(200),
            "tags" JSONB NOT NULL DEFAULT '[]'::jsonb,
            "weight" INTEGER NOT NULL DEFAULT 1,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS "completion_gifs_is_active_idx"
        ON "completion_gifs" ("isActive");
    `);
    ensured = true;
};

module.exports = { ensureCompletionGifsTable };
