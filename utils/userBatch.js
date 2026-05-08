const mongoose = require('mongoose');
const { User } = require('../models');

const normalizeEmail = (email) => {
    if (!email || typeof email !== 'string') return null;
    const n = email.toLowerCase().trim();
    return n || null;
};

/**
 * Unique lowercase emails for `$in` queries.
 * @param {Iterable<string>} emails
 * @returns {string[]}
 */
const uniqueNormalizedEmails = (emails) => {
    const set = new Set();
    for (const e of emails) {
        const n = normalizeEmail(e);
        if (n) set.add(n);
    }
    return [...set];
};

/**
 * @param {Iterable<string>} emails
 * @returns {Promise<Map<string, import('mongoose').Document>>} map: lowercased email -> User doc
 */
const fetchUsersByEmailMap = async (emails) => {
    const list = uniqueNormalizedEmails(emails);
    if (!list.length) return new Map();
    const users = await User.find({ email: { $in: list } });
    const map = new Map();
    for (const u of users) {
        map.set(String(u.email).toLowerCase(), u);
    }
    return map;
};

/**
 * @param {Iterable<string|import('mongoose').Types.ObjectId>} ids
 * @returns {Promise<Map<string, import('mongoose').Document>>} map: String(_id) -> User doc
 */
const fetchUsersByIdMap = async (ids) => {
    const unique = [...new Set(
        [...ids]
            .map((id) => (id != null ? String(id) : ''))
            .filter((s) => s && mongoose.Types.ObjectId.isValid(s))
    )];
    if (!unique.length) return new Map();
    const objectIds = unique.map((id) => new mongoose.Types.ObjectId(id));
    const users = await User.find({ _id: { $in: objectIds } });
    const map = new Map();
    for (const u of users) {
        map.set(String(u._id), u);
    }
    return map;
};

module.exports = {
    normalizeEmail,
    uniqueNormalizedEmails,
    fetchUsersByEmailMap,
    fetchUsersByIdMap
};
