/**
 * Calendar day boundaries for attendance (check-in date, midnight rollover).
 * Default timezone Africa/Cairo; override with ATTENDANCE_TIMEZONE (IANA), e.g. UTC.
 */

const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || 'Africa/Cairo';

function dateStrInTimeZone(isoDate, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(isoDate);
}

/** YYYY-MM-DD for "now" in attendance timezone */
function getAttendanceTodayString(d = new Date()) {
    return dateStrInTimeZone(d, ATTENDANCE_TIMEZONE);
}

/** First instant (UTC) where the attendance TZ calendar reads dateStr at 00:00:00 */
function startOfAttendanceDay(dateStr) {
    const tz = ATTENDANCE_TIMEZONE;
    const [y, m, d] = dateStr.split('-').map(Number);
    let low = Date.UTC(y, m - 1, d - 2, 0, 0, 0, 0);
    let high = Date.UTC(y, m - 1, d + 2, 0, 0, 0, 0);
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (dateStrInTimeZone(new Date(mid), tz) < dateStr) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return new Date(low);
}

function addOneCalendarDay(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().split('T')[0];
}

/** Last millisecond of attendance TZ calendar day dateStr */
function endOfAttendanceDay(dateStr) {
    const next = addOneCalendarDay(dateStr);
    return new Date(startOfAttendanceDay(next).getTime() - 1);
}

module.exports = {
    ATTENDANCE_TIMEZONE,
    getAttendanceTodayString,
    dateStrInTimeZone,
    startOfAttendanceDay,
    endOfAttendanceDay,
    addOneCalendarDay
};
