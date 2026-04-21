const Attendance = require('../models/attendance');
const { createNotification } = require('./notificationService');
const {
    getAttendanceTodayString,
    startOfAttendanceDay,
    endOfAttendanceDay,
    addOneCalendarDay
} = require('./attendanceDateUtils');

// 8 hours in milliseconds
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/**
 * If a user stayed checked in past midnight, close the previous day at end of day
 * (hours recorded for that day), then auto create check-in at start of the next day.
 * Repeats until the open session is for "today".
 */
const processMidnightAttendanceRollover = async () => {
    try {
        const todayStr = getAttendanceTodayString();

        const openNoCheckout = {
            $or: [{ checkOut: { $exists: false } }, { checkOut: null }]
        };

        const usersWithStaleOpen = await Attendance.distinct('user', {
            ...openNoCheckout,
            date: { $lt: todayStr }
        });

        for (const userId of usersWithStaleOpen) {
            await rolloverUserUntilToday(userId, todayStr, openNoCheckout);
        }
    } catch (error) {
        console.error('Error in processMidnightAttendanceRollover:', error);
    }
};

async function rolloverUserUntilToday(userId, todayStr, openNoCheckout) {
    const AUTO_NOTE = 'Auto: session rolled over at midnight';

    for (let i = 0; i < 400; i++) {
        const open = await Attendance.findOne({
            user: userId,
            ...openNoCheckout
        });

        if (!open) return;

        if (open.date >= todayStr) return;

        const end = endOfAttendanceDay(open.date);
        const dayStart = startOfAttendanceDay(open.date);
        const sessionStart = new Date(open.continuousCheckIn || open.checkIn);
        const segmentStart = sessionStart > dayStart ? sessionStart : dayStart;
        const durationMins = Math.max(
            0,
            Math.floor((end.getTime() - segmentStart.getTime()) / 60000)
        );

        open.checkOut = end;
        open.duration = durationMins;
        if (!open.note || !open.note.includes('Auto:')) {
            open.note = open.note ? `${open.note} ${AUTO_NOTE}` : AUTO_NOTE;
        }
        await open.save();

        const closedDate = open.date;
        const hoursStr = (durationMins / 60).toFixed(1);
        try {
            await createNotification(userId, {
                type: 'attendance_day_rollover',
                title: `Attendance closed: ${closedDate}`,
                body: `Your day was closed automatically at midnight. Recorded time: ${hoursStr} h (${durationMins} min).`,
                data: {
                    attendanceId: String(open._id),
                    date: closedDate,
                    action: 'day_closed'
                }
            });
        } catch (nErr) {
            console.error('Attendance rollover notify (close):', nErr);
        }

        const nextDateStr = addOneCalendarDay(open.date);
        if (nextDateStr > todayStr) return;

        const existingNext = await Attendance.findOne({ user: userId, date: nextDateStr });
        if (existingNext) return;

        const anchor = open.continuousCheckIn || open.checkIn;
        const newAtt = await Attendance.create({
            user: userId,
            date: nextDateStr,
            checkIn: startOfAttendanceDay(nextDateStr),
            continuousCheckIn: anchor,
            status: 'present',
            note: 'Auto check-in (new day after midnight)'
        });

        try {
            await createNotification(userId, {
                type: 'attendance_day_rollover',
                title: `New attendance day: ${nextDateStr}`,
                body: 'A new day started and you were checked in automatically (session continued).',
                data: {
                    attendanceId: String(newAtt._id),
                    date: nextDateStr,
                    action: 'day_opened'
                }
            });
        } catch (nErr) {
            console.error('Attendance rollover notify (open):', nErr);
        }
    }
}

/**
 * Check for users who have been checked in for more than 8 hours
 * and send them a reminder notification to check out.
 *
 * This function is intended to be called periodically (e.g., every 10-15 minutes)
 * from app.js or an external scheduler.
 */
const sendEightHourCheckoutReminders = async () => {
    try {
        const now = new Date();

        // Find all attendance records for today where:
        // - user has checked in
        // - no checkOut yet
        // - checkIn is more than 8 hours ago
        const today = getAttendanceTodayString(now);

        const openToday = await Attendance.find({
            date: today,
            $or: [{ checkOut: { $exists: false } }, { checkOut: null }]
        }).populate('user', 'name email fcmTokens');

        const candidates = openToday.filter((a) => {
            const start = a.continuousCheckIn || a.checkIn;
            return start && new Date(start) <= new Date(now.getTime() - EIGHT_HOURS_MS);
        });

        if (!candidates || candidates.length === 0) {
            return;
        }

        for (const attendance of candidates) {
            const user = attendance.user;
            if (!user) continue;

            try {
                await createNotification(user._id, {
                    type: 'attendance_reminder',
                    title: 'Attendance reminder',
                    body: 'You have been checked in for more than 8 hours. Please remember to check out.',
                    data: {
                        attendanceId: String(attendance._id),
                        date: attendance.date
                    }
                });
            } catch (err) {
                console.error(
                    `Error sending 8-hour checkout reminder to user ${user._id}:`,
                    err
                );
            }
        }
    } catch (error) {
        console.error('Error in sendEightHourCheckoutReminders:', error);
    }
};

/** Run midnight split for one user (cheap; call from check-in / check-out / my-attendance). */
async function rolloverStaleOpenSessionsForUser(userId) {
    const todayStr = getAttendanceTodayString();
    const openNoCheckout = {
        $or: [{ checkOut: { $exists: false } }, { checkOut: null }]
    };
    await rolloverUserUntilToday(userId, todayStr, openNoCheckout);
}

module.exports = {
    sendEightHourCheckoutReminders,
    processMidnightAttendanceRollover,
    rolloverStaleOpenSessionsForUser
};

