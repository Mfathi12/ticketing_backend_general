const { Parser } = require('json2csv');
const Attendance = require('../models/attendance');

function normalizeMonthYear(month, year) {
    const mi = parseInt(month, 10);
    const yi = parseInt(year, 10);
    if (!Number.isFinite(mi) || !Number.isFinite(yi)) {
        throw new Error('Invalid month or year');
    }
    if (mi < 1 || mi > 12) {
        throw new Error('Month must be between 1 and 12');
    }
    if (yi < 1970 || yi > 2100) {
        throw new Error('Year must be between 1970 and 2100');
    }
    const m = String(mi).padStart(2, '0');
    const y = String(yi);
    return { monthStr: m, yearStr: y };
}

function monthRangeBounds(month, year) {
    const { monthStr, yearStr } = normalizeMonthYear(month, year);
    const startDate = `${yearStr}-${monthStr}-01`;
    let nextM = parseInt(monthStr, 10) + 1;
    let nextY = parseInt(yearStr, 10);
    if (nextM > 12) {
        nextM = 1;
        nextY += 1;
    }
    const endDate = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
    return { startDate, endDate };
}

/** Same range as monthly report — for GET /all-attendance?month=&year= */
function getMonthYearDateRange(month, year) {
    return monthRangeBounds(month, year);
}

async function getAttendancesForMonth(month, year, companyId) {
    const { startDate, endDate } = monthRangeBounds(month, year);
    const query = {
        date: { $gte: startDate, $lt: endDate }
    };
    if (companyId) query.company = companyId;
    return Attendance.find(query)
        .populate('user', 'name email title role')
        .sort({ date: 1, checkIn: 1 });
}

const fmtCoord = (n) =>
    n != null && Number.isFinite(Number(n)) ? String(Number(n)) : '';

function rowToPlain(a) {
    const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString() : '-');
    const u = a.user || {};
    return {
        name: u.name || '-',
        email: u.email || '-',
        title: u.title || '-',
        role: u.role || '-',
        date: a.date || '-',
        checkIn: fmtTime(a.checkIn),
        checkOut: fmtTime(a.checkOut),
        sessionStart: a.continuousCheckIn ? fmtTime(a.continuousCheckIn) : '',
        durationMins: a.duration != null ? String(a.duration) : '',
        durationHhMm:
            a.duration != null
                ? `${Math.floor(a.duration / 60)}h ${a.duration % 60}m`
                : '',
        status: a.status || '-',
        note: a.note || '',
        checkInLat: fmtCoord(a.checkInLatitude),
        checkInLng: fmtCoord(a.checkInLongitude),
        checkOutLat: fmtCoord(a.checkOutLatitude),
        checkOutLng: fmtCoord(a.checkOutLongitude)
    };
}

function xmlEscape(s) {
    return String(s)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
        .replace(/\]\]>/g, ' ')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function spreadsheetMlRow(cells) {
    const cellsXml = cells
        .map((c) => `<Cell><Data ss:Type="String">${xmlEscape(c)}</Data></Cell>`)
        .join('');
    return `<Row>${cellsXml}</Row>`;
}

/** Excel 2003 XML (SpreadsheetML) — opens in Microsoft Excel / LibreOffice; no extra npm deps. */
function buildSpreadsheetMlBuffer(rows) {
    const headers = [
        'Name',
        'Email',
        'Title',
        'Role',
        'Date',
        'Check In',
        'Check Out',
        'Session start (split)',
        'Duration (mins)',
        'Duration',
        'Status',
        'Note',
        'Check-in lat',
        'Check-in lng',
        'Check-out lat',
        'Check-out lng'
    ];

    const headerRow = spreadsheetMlRow(headers);
    const dataRows = rows
        .map((r) =>
            spreadsheetMlRow([
                r.name,
                r.email,
                r.title,
                r.role,
                r.date,
                r.checkIn,
                r.checkOut,
                r.sessionStart,
                r.durationMins,
                r.durationHhMm,
                r.status,
                r.note,
                r.checkInLat,
                r.checkInLng,
                r.checkOutLat,
                r.checkOutLng
            ])
        )
        .join('\n');

    const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<?mso-application progid="Excel.Sheet"?>\n' +
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
        'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
        '<Worksheet ss:Name="Attendance">\n' +
        '<Table>\n' +
        `${headerRow}\n${dataRows}\n` +
        '</Table>\n' +
        '</Worksheet>\n' +
        '</Workbook>';

    return Buffer.from(`\uFEFF${xml}`, 'utf8');
}

const generateMonthlyReport = async (month, year, companyId) => {
    const attendances = await getAttendancesForMonth(month, year, companyId);
    const rows = attendances.map(rowToPlain);

    const fields = [
        { label: 'Name', value: 'name' },
        { label: 'Email', value: 'email' },
        { label: 'Title', value: 'title' },
        { label: 'Role', value: 'role' },
        { label: 'Date', value: 'date' },
        { label: 'Check In', value: 'checkIn' },
        { label: 'Check Out', value: 'checkOut' },
        { label: 'Session start (split)', value: 'sessionStart' },
        { label: 'Duration (mins)', value: 'durationMins' },
        { label: 'Duration', value: 'durationHhMm' },
        { label: 'Status', value: 'status' },
        { label: 'Note', value: 'note' },
        { label: 'Check-in lat', value: 'checkInLat' },
        { label: 'Check-in lng', value: 'checkInLng' },
        { label: 'Check-out lat', value: 'checkOutLat' },
        { label: 'Check-out lng', value: 'checkOutLng' }
    ];

    const json2csvParser = new Parser({ fields });
    return json2csvParser.parse(rows);
};

const generateMonthlyReportXlsx = async (month, year, companyId) => {
    const attendances = await getAttendancesForMonth(month, year, companyId);
    const rows = attendances.map(rowToPlain);
    return buildSpreadsheetMlBuffer(rows);
};

module.exports = {
    generateMonthlyReport,
    generateMonthlyReportXlsx,
    getMonthYearDateRange
};
