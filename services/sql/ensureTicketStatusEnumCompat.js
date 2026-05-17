/**
 * Frontend and API docs use ticket status `pending`; older Postgres ENUMs may omit it.
 * Safe to run on every boot.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
const ensureTicketStatusEnumCompat = async (sequelize) => {
    if (!sequelize) return;

    const enumName = 'enum_tickets_status';
    const value = 'pending';

    try {
        const [existing] = await sequelize.query(
            `SELECT 1 AS ok
             FROM pg_enum e
             JOIN pg_type t ON e.enumtypid = t.oid
             WHERE t.typname = :enumName AND e.enumlabel = :value
             LIMIT 1`,
            { replacements: { enumName, value } }
        );
        if (existing && existing.length) return;

        const [typeRows] = await sequelize.query(
            `SELECT 1 AS ok FROM pg_type WHERE typname = :enumName LIMIT 1`,
            { replacements: { enumName } }
        );
        if (!typeRows || !typeRows.length) return;

        await sequelize.query(`ALTER TYPE "${enumName}" ADD VALUE '${value}'`);
        console.log(`PostgreSQL: added '${value}' to ${enumName}.`);
    } catch (err) {
        const msg = err?.message || String(err);
        if (/already exists|duplicate/i.test(msg)) return;
        console.error('PostgreSQL: ticket status enum compat failed:', msg);
    }
};

module.exports = { ensureTicketStatusEnumCompat };
