/**
 * Attendance service: index-aware reads.
 *
 * NOTE: This service is purely additive. The existing
 * `routes/attendanceRoutes.js` handlers contain domain logic (rollover,
 * notifications, monthly date range parsing, etc.) that must stay in
 * place. These helpers exist for new endpoints, scripts, and admin tools
 * that want to read attendance with the new compound indexes without
 * duplicating query bodies.
 */
const Attendance = require('../models/attendance');
const { fetchUsersByIdMap } = require('../utils/userBatch');

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 200;

const clampLimit = (raw, fallback = DEFAULT_HISTORY_LIMIT, ceiling = MAX_HISTORY_LIMIT) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(ceiling, n);
};

/**
 * All attendance records for a company on a single calendar day.
 * Uses the new `{ company, date }` index.
 *
 * @param {string|import('mongoose').Types.ObjectId} companyId
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<object[]>}
 */
const getDailyCompanyAttendance = (companyId, date) => {
    if (!companyId || !date) return Promise.resolve([]);
    return Attendance.find({ company: companyId, date })
        .sort({ checkIn: 1 })
        .lean();
};

/**
 * Attendance records for a company/day filtered by status. Uses the new
 * `{ company, date, status }` index.
 *
 * @param {string|import('mongoose').Types.ObjectId} companyId
 * @param {string} date - YYYY-MM-DD
 * @param {'present'|'half-day'|'absent'} status
 */
const getDailyByStatus = (companyId, date, status) => {
    if (!companyId || !date || !status) return Promise.resolve([]);
    return Attendance.find({ company: companyId, date, status })
        .sort({ checkIn: 1 })
        .lean();
};

/**
 * Cursor-paginated employee attendance history. Cursor is the last `date`
 * string (YYYY-MM-DD) of the previous page. Uses the new
 * `{ company, user, date:-1 }` index.
 *
 * @param {object} args
 * @param {string|import('mongoose').Types.ObjectId} args.companyId
 * @param {string|import('mongoose').Types.ObjectId} args.userId
 * @param {number} [args.limit]
 * @param {string|null} [args.cursor]
 * @returns {Promise<{ records: object[], nextCursor: string|null, hasMore: boolean }>}
 */
const getEmployeeHistory = async ({ companyId, userId, limit, cursor = null } = {}) => {
    if (!companyId || !userId) {
        return { records: [], nextCursor: null, hasMore: false };
    }
    const cap = clampLimit(limit);
    const filter = { company: companyId, user: userId };
    if (cursor) filter.date = { $lt: cursor };

    const rows = await Attendance.find(filter)
        .sort({ date: -1, checkIn: -1 })
        .limit(cap + 1)
        .lean();

    const hasMore = rows.length > cap;
    const records = hasMore ? rows.slice(0, cap) : rows;
    const nextCursor = records.length && hasMore ? records[records.length - 1].date : null;
    return { records, nextCursor, hasMore };
};

/**
 * Date-range attendance for a single user. Uses `{ company, user, date }`.
 *
 * @param {object} args
 * @param {string|import('mongoose').Types.ObjectId} args.companyId
 * @param {string|import('mongoose').Types.ObjectId} args.userId
 * @param {string} args.startDate - YYYY-MM-DD inclusive
 * @param {string} args.endDate - YYYY-MM-DD inclusive
 */
const getDateRangeForUser = ({ companyId, userId, startDate, endDate } = {}) => {
    if (!companyId || !userId || !startDate || !endDate) return Promise.resolve([]);
    return Attendance.find({
        company: companyId,
        user: userId,
        date: { $gte: startDate, $lte: endDate }
    })
        .sort({ date: 1, checkIn: 1 })
        .lean();
};

/**
 * Today's check-ins for a company. Uses `{ company, date, checkIn }`.
 *
 * @param {string|import('mongoose').Types.ObjectId} companyId
 * @param {string} [date] - YYYY-MM-DD; defaults to today (UTC).
 */
const getTodayCheckIns = (companyId, date) => {
    if (!companyId) return Promise.resolve([]);
    const day = date || new Date().toISOString().split('T')[0];
    return Attendance.find({
        company: companyId,
        date: day,
        checkIn: { $exists: true }
    })
        .sort({ checkIn: 1 })
        .lean();
};

/**
 * Resolve user metadata for a list of attendance rows in one round-trip.
 *
 * @param {object[]} attendanceRows
 * @returns {Promise<Map<string, import('mongoose').Document>>}
 */
const loadUsersForAttendance = (attendanceRows) => {
    if (!Array.isArray(attendanceRows) || !attendanceRows.length) return Promise.resolve(new Map());
    const ids = attendanceRows.map((r) => (r ? r.user : null)).filter(Boolean);
    return fetchUsersByIdMap(ids);
};

/**
 * Aggregate stats for a date-range of attendance rows.
 *
 * @param {object[]} rows
 */
const summarizeAttendance = (rows) => {
    const records = Array.isArray(rows) ? rows : [];
    return {
        totalDays: records.length,
        presentDays: records.filter((r) => r.status === 'present').length,
        halfDays: records.filter((r) => r.status === 'half-day').length,
        absentDays: records.filter((r) => r.status === 'absent').length,
        totalMinutes: records.reduce((sum, r) => sum + (Number(r.duration) || 0), 0)
    };
};

module.exports = {
    DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT,
    clampLimit,
    getDailyCompanyAttendance,
    getDailyByStatus,
    getEmployeeHistory,
    getDateRangeForUser,
    getTodayCheckIns,
    loadUsersForAttendance,
    summarizeAttendance
};
