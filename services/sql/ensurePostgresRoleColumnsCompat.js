/**
 * Older DBs used PostgreSQL ENUMs for membership roles without `owner`.
 * Registration can still set `users.role` = owner while `user_companies` / `company_members`
 * reject `owner` → 500 on PUT /update-user. This migrates those columns to VARCHAR when needed.
 *
 * Safe to run on every boot: skips columns that are already varchar/text.
 */
const quoteIdent = (id) => `"${String(id).replace(/"/g, '""')}"`;

const findColumnMeta = async (sequelize, tableName, attNameCandidates) => {
    for (const attname of attNameCandidates) {
        const [rows] = await sequelize.query(
            `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS typ
             FROM pg_attribute a
             JOIN pg_class c ON a.attrelid = c.oid
             JOIN pg_namespace n ON c.relnamespace = n.oid
             WHERE n.nspname = 'public'
               AND c.relname = :table
               AND a.attname = :attname
               AND a.attnum > 0
               AND NOT a.attisdropped`,
            { replacements: { table: tableName, attname } }
        );
        if (rows && rows.length) {
            return rows[0];
        }
    }
    return null;
};

const needsEnumToVarchar = (typ) => {
    const t = String(typ || '').toLowerCase();
    if (!t) return false;
    return t.includes('enum');
};

const alterToVarchar = async (sequelize, tableName, attname) => {
    const qt = quoteIdent(tableName);
    const qc = quoteIdent(attname);
    try {
        await sequelize.query(`ALTER TABLE ${qt} ALTER COLUMN ${qc} DROP DEFAULT`);
    } catch (_) {
        /* ignore */
    }
    await sequelize.query(
        `ALTER TABLE ${qt} ALTER COLUMN ${qc} TYPE VARCHAR(64) USING (${qc}::text)`
    );
    await sequelize.query(`ALTER TABLE ${qt} ALTER COLUMN ${qc} SET DEFAULT 'user'`);
};

/**
 * @param {import('sequelize').Sequelize} sequelize
 */
const ensurePostgresRoleColumnsCompat = async (sequelize) => {
    if (!sequelize) return;

    const tasks = [
        { table: 'user_companies', candidates: ['companyRole', 'companyrole'] },
        { table: 'company_members', candidates: ['role', 'Role'] },
        { table: 'users', candidates: ['role', 'Role'] }
    ];

    let migrated = false;

    for (const { table, candidates } of tasks) {
        try {
            const meta = await findColumnMeta(sequelize, table, candidates);
            if (!meta || !needsEnumToVarchar(meta.typ)) continue;
            await alterToVarchar(sequelize, table, meta.attname);
            migrated = true;
            console.log(
                `PostgreSQL: migrated ${table}.${meta.attname} from enum-like type to VARCHAR(64).`
            );
        } catch (e) {
            console.error(`PostgreSQL: role column compat skipped for ${table}:`, e.message);
        }
    }

    if (migrated) {
        console.log(
            'PostgreSQL: role column compatibility complete (owner role updates should work).'
        );
    }
};

module.exports = { ensurePostgresRoleColumnsCompat };
