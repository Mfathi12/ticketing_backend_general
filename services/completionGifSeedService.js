const { CompletionGif } = require('../models');
const { isPostgresPrimary } = require('./sql/runtime');
const completionGifSql = require('./sql/completionGifSql');
const { DEFAULT_COMPLETION_GIFS } = require('./completionGifCatalog');

async function seedMongoIfEmpty() {
    const count = await CompletionGif.countDocuments();
    if (count > 0) return { inserted: 0, skipped: true };

    let inserted = 0;
    for (const entry of DEFAULT_COMPLETION_GIFS) {
        const exists = await CompletionGif.findOne({ url: entry.url }).lean();
        if (exists) continue;
        await CompletionGif.create({
            ...entry,
            weight: 1,
            isActive: true
        });
        inserted += 1;
    }
    return { inserted, skipped: false };
}

async function seedPostgresIfEmpty() {
    const existing = await completionGifSql.listAll();
    if (existing.length > 0) return { inserted: 0, skipped: true };

    let inserted = 0;
    for (const entry of DEFAULT_COMPLETION_GIFS) {
        await completionGifSql.create({
            url: entry.url,
            label: entry.label,
            tags: entry.tags,
            weight: 1
        });
        inserted += 1;
    }
    return { inserted, skipped: false };
}

/**
 * Inserts default completion GIFs when the catalog is empty.
 */
async function ensureCompletionGifsSeeded() {
    if (isPostgresPrimary()) {
        const result = await seedPostgresIfEmpty();
        if (result.inserted > 0) {
            console.log(`Completion GIFs: seeded ${result.inserted} default GIF(s) (PostgreSQL).`);
        }
        return result;
    }

    const result = await seedMongoIfEmpty();
    if (result.inserted > 0) {
        console.log(`Completion GIFs: seeded ${result.inserted} default GIF(s) (MongoDB).`);
    }
    return result;
}

module.exports = { ensureCompletionGifsSeeded, DEFAULT_COMPLETION_GIFS };
