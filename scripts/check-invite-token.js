/**
 * One-off: verify invite raw token against Postgres users.inviteTokenHash.
 * Usage: node scripts/check-invite-token.js <64-char-hex-raw-token>
 */
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');

const normalizeInviteToken = (token) =>
    String(token)
        .trim()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .toLowerCase();

const hashInviteToken = (token) =>
    crypto.createHash('sha256').update(normalizeInviteToken(token)).digest('hex');

const raw = process.argv[2];
if (!raw) {
    console.error('Usage: node scripts/check-invite-token.js <raw-invite-token>');
    process.exit(1);
}

const tokenHash = hashInviteToken(raw);
console.log('Normalized raw length:', normalizeInviteToken(raw).length);
console.log('Expected inviteTokenHash (SHA256 of normalized raw):', tokenHash);

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL not set');
        process.exit(1);
    }
    const c = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false
    });
    await c.connect();

    const { rows: inviteCols } = await c.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name ILIKE '%invite%'
        ORDER BY column_name
    `);
    console.log('users.invite* columns:', inviteCols.map((r) => r.column_name));

    const candidates = inviteCols.map((r) => r.column_name).filter((n) => /hash/i.test(n));
    for (const col of candidates.length ? candidates : ['inviteTokenHash']) {
        const q = `SELECT id, email, "${col}" AS hash, "inviteExpiresAt" AS exp
                   FROM users WHERE "${col}" = $1 LIMIT 5`;
        try {
            const res = await c.query(q, [tokenHash]);
            if (res.rows.length) {
                console.log(`MATCH using column "${col}":`, res.rows);
            } else {
                console.log(`No row for hash in "${col}"`);
            }
        } catch (e) {
            console.log(`Query failed for "${col}":`, e.message);
        }
    }

    const anyInvite = await c.query(
        `SELECT id, email FROM users WHERE "inviteTokenHash" IS NOT NULL LIMIT 10`
    );
    console.log('Sample users with non-null inviteTokenHash (up to 10):', anyInvite.rows.length);

    await c.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
