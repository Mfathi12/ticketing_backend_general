/**
 * Manual seed for completion GIF catalog.
 * Usage: node scripts/seedCompletionGifs.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const CompletionGif = require('../models/completionGif');
const { validateCompletionGifUrl } = require('../utils/completionGifUrl');
const { initPostgres, isPostgresEnabled, closePostgres } = require('../db/postgres');
const completionGifSql = require('../services/sql/completionGifSql');
const { DEFAULT_COMPLETION_GIFS } = require('../services/completionGifCatalog');

function resolveEntries() {
    const envUrls = String(process.env.SEED_COMPLETION_GIF_URLS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    if (envUrls.length > 0) {
        return envUrls.map((url, i) => ({
            url: validateCompletionGifUrl(url),
            label: `seed-${i + 1}`,
            tags: ['work-safe']
        }));
    }
    return DEFAULT_COMPLETION_GIFS;
}

async function seedMongo(entries) {
    const uri = String(process.env.MONGODB_URI || '').trim();
    if (!uri) {
        return { skipped: true, inserted: 0 };
    }
    await mongoose.connect(uri);
    let inserted = 0;
    for (const entry of entries) {
        const exists = await CompletionGif.findOne({ url: entry.url }).lean();
        if (exists) continue;
        await CompletionGif.create({
            ...entry,
            weight: 1,
            isActive: true
        });
        inserted += 1;
    }
    await mongoose.disconnect();
    return { skipped: false, inserted };
}

async function seedPostgres(entries) {
    if (!isPostgresEnabled()) {
        return { skipped: true, inserted: 0 };
    }
    await initPostgres();
    const existing = await completionGifSql.listAll();
    const urls = new Set(existing.map((r) => r.url));
    let inserted = 0;
    for (const entry of entries) {
        if (urls.has(entry.url)) continue;
        await completionGifSql.create({
            url: entry.url,
            label: entry.label,
            tags: entry.tags,
            weight: 1
        });
        urls.add(entry.url);
        inserted += 1;
    }
    await closePostgres();
    return { skipped: false, inserted };
}

async function main() {
    const entries = resolveEntries();
    const results = { mongo: null, postgres: null };

    try {
        results.mongo = await seedMongo(entries);
    } catch (err) {
        console.warn('Mongo seed skipped or failed:', err.message);
        results.mongo = { skipped: true, inserted: 0, error: err.message };
    }

    try {
        results.postgres = await seedPostgres(entries);
    } catch (err) {
        console.warn('Postgres seed skipped or failed:', err.message);
        results.postgres = { skipped: true, inserted: 0, error: err.message };
    }

    const totalInserted =
        (results.mongo?.inserted || 0) + (results.postgres?.inserted || 0);

    if (
        results.mongo?.skipped &&
        results.postgres?.skipped &&
        totalInserted === 0
    ) {
        console.error(
            'No database available. Set MONGODB_URI and/or POSTGRES_ENABLED=true with DATABASE_URL.'
        );
        process.exit(1);
    }

    console.log(
        `Completion GIF seed done. Inserted ${totalInserted} new row(s) ` +
            `(mongo: ${results.mongo?.inserted ?? 0}, postgres: ${results.postgres?.inserted ?? 0}).`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
