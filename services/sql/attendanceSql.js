const { Op } = require('sequelize');
const mongoose = require('mongoose');
const { getSequelizeModels } = require('../../db/postgres');
const authSql = require('./authSql');
const { createNotification } = require('../notificationService');
const {
    getAttendanceTodayString,
    startOfAttendanceDay,
    endOfAttendanceDay,
    addOneCalendarDay
} = require('../attendanceDateUtils');

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

const requireModels = () => {
    const m = getSequelizeModels();
    if (!m) throw new Error('PostgreSQL models are not ready');
    return m;
};

const newObjectIdString = () => new mongoose.Types.ObjectId().toString();

const openCheckoutWhere = { checkOut: null };

const rowPlain = (row) => (row.get ? row.get({ plain: true }) : row);

const toAttendanceApi = (plain, userLean = null, lastEditedLean = null) => {
    const p = plain;
    return {
        _id: p.id,
        id: p.id,
        company: p.companyId,
        user: userLean || { _id: p.userId },
        date: p.date,
        checkIn: p.checkIn,
        continuousCheckIn: p.continuousCheckIn,
        checkOut: p.checkOut,
        duration: p.duration,
        status: p.status,
        note: p.note,
        checkInLatitude: p.checkInLatitude,
        checkInLongitude: p.checkInLongitude,
        checkOutLatitude: p.checkOutLatitude,
        checkOutLongitude: p.checkOutLongitude,
        lastEditedBy: lastEditedLean || (p.lastEditedByUserId ? { _id: p.lastEditedByUserId } : undefined),
        lastEditedAt: p.lastEditedAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
    };
};

const hydrateAttendance = async (row) => {
    if (!row) return null;
    const p = rowPlain(row);
    const [userLean, editorLean] = await Promise.all([
        authSql.findUserById(p.userId),
        p.lastEditedByUserId ? authSql.findUserById(p.lastEditedByUserId) : Promise.resolve(null)
    ]);
    return toAttendanceApi(p, userLean, editorLean);
};

const findOpenSession = async (companyId, userId) => {
    const m = requireModels();
    return m.Attendance.findOne({
        where: {
            companyId: String(companyId),
            userId: String(userId),
            ...openCheckoutWhere
        }
    });
};

const createCheckIn = async ({ companyId, userId, date, checkInAt, lat, lng }) => {
    const m = requireModels();
    const row = await m.Attendance.create({
        id: newObjectIdString(),
        companyId: String(companyId),
        userId: String(userId),
        date,
        checkIn: checkInAt,
        status: 'present',
        checkInLatitude: lat != null ? lat : null,
        checkInLongitude: lng != null ? lng : null
    });
    return hydrateAttendance(row);
};

const findLatestOpenForCheckout = async (companyId, userId) => {
    const m = requireModels();
    return m.Attendance.findOne({
        where: {
            companyId: String(companyId),
            userId: String(userId),
            ...openCheckoutWhere
        },
        order: [['checkIn', 'DESC']]
    });
};

const listMyLogs = async (companyId, userId, limit) => {
    const m = requireModels();
    const rows = await m.Attendance.findAll({
        where: { companyId: String(companyId), userId: String(userId) },
        order: [
            ['date', 'DESC'],
            ['checkIn', 'DESC']
        ],
        limit
    });
    return Promise.all(rows.map((r) => hydrateAttendance(r)));
};

const getById = async (companyId, attendanceId) => {
    const m = requireModels();
    const row = await m.Attendance.findOne({
        where: { id: String(attendanceId), companyId: String(companyId) }
    });
    return row;
};

const countForQuery = async (companyId, filters) => {
    const m = requireModels();
    return m.Attendance.count({ where: { companyId: String(companyId), ...filters } });
};

const findAllPaginated = async (companyId, filters, skip, limit) => {
    const m = requireModels();
    const rows = await m.Attendance.findAll({
        where: { companyId: String(companyId), ...filters },
        order: [
            ['date', 'DESC'],
            ['checkIn', 'DESC']
        ],
        offset: skip,
        limit
    });
    return Promise.all(rows.map((r) => hydrateAttendance(r)));
};

/** @param {{ startDate: string, endDate: string }} range - endDate exclusive (next month first day) */
const getAttendancesForMonthRange = async (companyId, startDate, endDate) => {
    const m = requireModels();
    const rows = await m.Attendance.findAll({
        where: {
            companyId: String(companyId),
            date: { [Op.gte]: startDate, [Op.lt]: endDate }
        },
        order: [
            ['date', 'ASC'],
            ['checkIn', 'ASC']
        ]
    });
    return Promise.all(rows.map((r) => hydrateAttendance(r)));
};

async function rolloverUserUntilTodaySql(userId, companyId, todayStr) {
    const m = requireModels();
    const AUTO_NOTE = 'Auto: session rolled over at midnight';

    for (let i = 0; i < 400; i++) {
        const where = {
            userId: String(userId),
            ...openCheckoutWhere
        };
        if (companyId) where.companyId = String(companyId);

        const open = await m.Attendance.findOne({ where });
        if (!open) return;
        const o = rowPlain(open);
        if (o.date >= todayStr) return;

        const end = endOfAttendanceDay(o.date);
        const dayStart = startOfAttendanceDay(o.date);
        const sessionStart = new Date(o.continuousCheckIn || o.checkIn);
        const segmentStart = sessionStart > dayStart ? sessionStart : dayStart;
        const durationMins = Math.max(0, Math.floor((end.getTime() - segmentStart.getTime()) / 60000));

        const note = o.note && String(o.note).includes('Auto:') ? o.note : o.note ? `${o.note} ${AUTO_NOTE}` : AUTO_NOTE;
        await open.update({
            checkOut: end,
            duration: durationMins,
            note
        });

        const closedDate = o.date;
        const hoursStr = (durationMins / 60).toFixed(1);
        try {
            await createNotification(userId, {
                company: o.companyId,
                type: 'attendance_day_rollover',
                title: `Attendance closed: ${closedDate}`,
                body: `Your day was closed automatically at midnight. Recorded time: ${hoursStr} h (${durationMins} min).`,
                data: {
                    attendanceId: String(o.id),
                    date: closedDate,
                    action: 'day_closed'
                }
            });
        } catch (nErr) {
            console.error('Attendance rollover notify (close):', nErr);
        }

        const nextDateStr = addOneCalendarDay(o.date);
        if (nextDateStr > todayStr) return;

        const existingNext = await m.Attendance.findOne({
            where: {
                userId: String(userId),
                ...(companyId ? { companyId: String(companyId) } : {}),
                date: nextDateStr
            }
        });
        if (existingNext) return;

        const anchor = o.continuousCheckIn || o.checkIn;
        const newAtt = await m.Attendance.create({
            id: newObjectIdString(),
            ...(companyId ? { companyId: String(companyId) } : { companyId: o.companyId }),
            userId: String(userId),
            date: nextDateStr,
            checkIn: startOfAttendanceDay(nextDateStr),
            continuousCheckIn: anchor,
            status: 'present',
            note: 'Auto check-in (new day after midnight)'
        });
        const na = rowPlain(newAtt);
        try {
            await createNotification(userId, {
                company: na.companyId,
                type: 'attendance_day_rollover',
                title: `New attendance day: ${nextDateStr}`,
                body: 'A new day started and you were checked in automatically (session continued).',
                data: {
                    attendanceId: String(na.id),
                    date: nextDateStr,
                    action: 'day_opened'
                }
            });
        } catch (nErr) {
            console.error('Attendance rollover notify (open):', nErr);
        }
    }
}

const rolloverStaleOpenSessionsForUser = async (userId, companyId = null) => {
    const todayStr = getAttendanceTodayString();
    await rolloverUserUntilTodaySql(userId, companyId, todayStr);
};

const processMidnightAttendanceRollover = async () => {
    try {
        const todayStr = getAttendanceTodayString();
        const m = requireModels();
        const rows = await m.Attendance.findAll({
            where: {
                date: { [Op.lt]: todayStr },
                ...openCheckoutWhere
            },
            attributes: ['userId'],
            raw: true
        });
        const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))];
        for (const uid of userIds) {
            await rolloverUserUntilTodaySql(uid, null, todayStr);
        }
    } catch (error) {
        console.error('Error in processMidnightAttendanceRollover (SQL):', error);
    }
};

const sendEightHourCheckoutReminders = async () => {
    try {
        const now = new Date();
        const today = getAttendanceTodayString(now);
        const m = requireModels();
        const openToday = await m.Attendance.findAll({
            where: {
                date: today,
                ...openCheckoutWhere
            }
        });
        const candidates = openToday.filter((a) => {
            const p = rowPlain(a);
            const start = p.continuousCheckIn || p.checkIn;
            return start && new Date(start) <= new Date(now.getTime() - EIGHT_HOURS_MS);
        });
        if (!candidates.length) return;
        for (const attendance of candidates) {
            const p = rowPlain(attendance);
            const user = await authSql.findUserById(p.userId);
            if (!user) continue;
            try {
                await createNotification(user._id, {
                    company: p.companyId,
                    type: 'attendance_reminder',
                    title: 'Attendance reminder',
                    body: 'You have been checked in for more than 8 hours. Please remember to check out.',
                    data: {
                        attendanceId: String(p.id),
                        date: p.date
                    }
                });
            } catch (err) {
                console.error(`Error sending 8-hour checkout reminder to user ${p.userId}:`, err);
            }
        }
    } catch (error) {
        console.error('Error in sendEightHourCheckoutReminders (SQL):', error);
    }
};

module.exports = {
    requireModels,
    newObjectIdString,
    toAttendanceApi,
    hydrateAttendance,
    findOpenSession,
    createCheckIn,
    findLatestOpenForCheckout,
    listMyLogs,
    getById,
    countForQuery,
    findAllPaginated,
    getAttendancesForMonthRange,
    rolloverStaleOpenSessionsForUser,
    processMidnightAttendanceRollover,
    sendEightHourCheckoutReminders
};
