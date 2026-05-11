/**
 * Ensures the `personal_tasks` table exists (matches Sequelize PersonalTask model).
 * Run once at Postgres startup so deployments without POSTGRES_SYNC_ALTER still work.
 */
let ensured = false;

const ensurePersonalTasksTable = async (sequelize) => {
    if (!sequelize || ensured) return;
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "personal_tasks" (
            "id" VARCHAR(24) PRIMARY KEY,
            "userId" VARCHAR(24) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
            "title" VARCHAR(500) NOT NULL,
            "estimatedMinutes" INTEGER NOT NULL,
            "column" VARCHAR(32) NOT NULL DEFAULT 'backlog',
            "completedAt" TIMESTAMPTZ,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "personal_tasks_column_chk" CHECK ("column" IN ('backlog', 'this_week', 'today', 'done'))
        );
    `);
    await sequelize.query(`
        CREATE INDEX IF NOT EXISTS "personal_tasks_user_id_column_idx"
        ON "personal_tasks" ("userId", "column");
    `);
    ensured = true;
};

module.exports = { ensurePersonalTasksTable };
