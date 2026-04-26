const express = require('express');
const router = express.Router();
const Attendance = require('../models/attendance');
const { Company } = require('../models');
const { authenticateToken } = require('../middleware/auth');
const { getCompanyPlan } = require('../services/subscriptionService');
const {
    generateMonthlyReport,
    generateMonthlyReportXlsx,
    getMonthYearDateRange
} = require('../services/attendanceReportService');
const { createNotification } = require('../services/notificationService');
const { getAttendanceTodayString } = require('../services/attendanceDateUtils');
const { rolloverStaleOpenSessionsForUser } = require('../services/attendanceReminderService');

/** Open session = checked in but not checked out yet (multiple sessions per day allowed after checkout) */
const openSessionFilter = {
    $or: [{ checkOut: { $exists: false } }, { checkOut: null }]
};

const ensureAttendanceEditAllowed = async (companyId) => {
    const company = await Company.findById(companyId).select('subscription');
    if (!company) {
        return { allowed: false, reason: 'Company not found', status: 404 };
    }
    const plan = getCompanyPlan(company);
    if (!plan?.limits?.canEditAttendance) {
        return {
            allowed: false,
            reason: 'Attendance editing is not available on Free plan. Please upgrade your subscription.',
            status: 403
        };
    }
    return { allowed: true };
};

const ensureAttendanceDownloadAllowed = async (companyId) => {
    const company = await Company.findById(companyId).select('subscription');
    if (!company) {
        return { allowed: false, reason: 'Company not found', status: 404 };
    }
    const plan = getCompanyPlan(company);
    if (!plan?.limits?.canDownloadAttendanceReport) {
        return {
            allowed: false,
            reason: 'Attendance report download is not available on Free plan. Please upgrade your subscription.',
            status: 403
        };
    }
    return { allowed: true };
};


// POST /check-in
router.post('/check-in', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        await rolloverStaleOpenSessionsForUser(userId, activeCompanyId);
        const date = getAttendanceTodayString();

        const openAny = await Attendance.findOne({
            company: activeCompanyId,
            user: userId,
            ...openSessionFilter
        });

        if (openAny) {
            return res.status(400).json({
                message: 'You already have an open check-in. Check out first.',
                attendance: openAny
            });
        }

        const attendance = new Attendance({
            company: activeCompanyId,
            user: userId,
            date,
            checkIn: new Date(),
            status: 'present'
        });

        await attendance.save();

        res.status(201).json({
            message: 'Check-in successful',
            attendance
        });
    } catch (error) {
        console.error('Check-in error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// POST /check-out
router.post('/check-out', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        await rolloverStaleOpenSessionsForUser(userId, activeCompanyId);

        const attendance = await Attendance.findOne({
            company: activeCompanyId,
            user: userId,
            ...openSessionFilter
        }).sort({ checkIn: -1 });

        if (!attendance) {
            return res.status(404).json({ message: 'No open check-in found.' });
        }

        const checkOutTime = new Date();
        const durationMs = checkOutTime - new Date(attendance.checkIn);
        const durationMins = Math.max(0, Math.floor(durationMs / 60000));

        attendance.checkOut = checkOutTime;
        attendance.duration = durationMins;

        // Optional logic: Mark as half-day if duration is less than X hours (e.g., 4 hours = 240 mins)
        // Leaving it as 'present' by default unless logic is strictly defined, or admin changes it.

        await attendance.save();

        res.json({
            message: 'Check-out successful',
            attendance
        });
    } catch (error) {
        console.error('Check-out error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /my-attendance
router.get('/my-attendance', authenticateToken, async (req, res) => {
    try {
        const userId = req.user._id;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        await rolloverStaleOpenSessionsForUser(userId, activeCompanyId);
        // Optional: Pagination or limit
        const limit = parseInt(req.query.limit) || 30; // Default last 30 entries

        const logs = await Attendance.find({ company: activeCompanyId, user: userId })
            .sort({ date: -1, checkIn: -1 }) // Newest day first; multiple sessions same day by latest check-in
            .limit(limit);

        res.json({ logs });
    } catch (error) {
        console.error('Get my-attendance error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// PUT /admin/record/:attendanceId — Admin & Manager: edit check-in / check-out / status / note
router.put(
    '/admin/record/:attendanceId',
    authenticateToken,
    async (req, res) => {
        try {
            const { attendanceId } = req.params;
            const { checkIn, checkOut, status, note } = req.body;
            const activeCompanyId = req.companyId ? req.companyId.toString() : null;
            if (!activeCompanyId) {
                return res.status(400).json({ message: 'Active company required' });
            }
            const m = req.companyMembership;
            const canEdit = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
            if (!canEdit) {
                return res.status(403).json({ message: 'Insufficient permissions' });
            }
            const editAllowed = await ensureAttendanceEditAllowed(activeCompanyId);
            if (!editAllowed.allowed) {
                return res.status(editAllowed.status).json({ message: editAllowed.reason });
            }

            const attendance = await Attendance.findOne({ _id: attendanceId, company: activeCompanyId });
            if (!attendance) {
                return res.status(404).json({ message: 'Attendance record not found' });
            }

            let unsetCheckOut = false;
            let unsetContinuousCheckIn = false;

            if (checkIn !== undefined) {
                const d = new Date(checkIn);
                if (Number.isNaN(d.getTime())) {
                    return res.status(400).json({ message: 'Invalid checkIn date' });
                }
                attendance.checkIn = d;
                unsetContinuousCheckIn = true;
            }

            if (checkOut !== undefined) {
                if (checkOut === null || checkOut === '') {
                    unsetCheckOut = true;
                } else {
                    const d = new Date(checkOut);
                    if (Number.isNaN(d.getTime())) {
                        return res.status(400).json({ message: 'Invalid checkOut date' });
                    }
                    attendance.checkOut = d;
                }
            }

            if (status !== undefined) {
                if (!['present', 'half-day', 'absent'].includes(status)) {
                    return res.status(400).json({ message: 'Invalid status' });
                }
                attendance.status = status;
            }

            if (note !== undefined) {
                attendance.note = note;
            }

            const cin = new Date(attendance.checkIn);
            if (unsetCheckOut) {
                attendance.duration = 0;
            } else if (attendance.checkOut) {
                const cout = new Date(attendance.checkOut);
                if (cout <= cin) {
                    return res.status(400).json({
                        message: 'checkOut must be after checkIn'
                    });
                }
                attendance.duration = Math.floor((cout - cin) / 60000);
            } else {
                attendance.duration = 0;
            }

            attendance.lastEditedBy = req.user._id;
            attendance.lastEditedAt = new Date();

            await attendance.save();

            if (unsetCheckOut) {
                await Attendance.updateOne(
                    { _id: attendance._id },
                    { $unset: { checkOut: 1 } }
                );
                attendance.checkOut = undefined;
            }

            if (unsetContinuousCheckIn) {
                await Attendance.updateOne(
                    { _id: attendance._id },
                    { $unset: { continuousCheckIn: 1 } }
                );
                attendance.continuousCheckIn = undefined;
            }

            const editorName = req.user.name || req.user.email;
            const employeeId = attendance.user;
            if (employeeId && employeeId.toString() !== req.user._id.toString()) {
                try {
                    await createNotification(employeeId, {
                        company: activeCompanyId,
                        type: 'attendance_admin_edit',
                        title: 'Attendance updated',
                        body: `Your attendance for ${attendance.date} was updated by ${editorName}.`,
                        data: {
                            attendanceId: String(attendance._id),
                            date: attendance.date,
                            durationMinutes: attendance.duration
                        }
                    });
                } catch (nErr) {
                    console.error('Attendance admin edit notification:', nErr);
                }
            }

            await attendance.populate('user', 'name email title role');
            await attendance.populate('lastEditedBy', 'name email');

            res.json({
                message: 'Attendance updated successfully',
                attendance
            });
        } catch (error) {
            console.error('Admin edit attendance error:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
);

// GET /all-attendance (Admin & Manager Only)
// Optional: month + year (1–12, YYYY) filters `date` to that calendar month (same logic as report export).
// Optional: date=YYYY-MM-DD for a single day (ignored if month+year are sent).
router.get('/all-attendance', authenticateToken, async (req, res) => {
    try {
        const { date, user, month, year } = req.query;
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const m = req.companyMembership;
        const canReadAll = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canReadAll) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }
        let query = { company: activeCompanyId };

        const hasMonth = month !== undefined && month !== null && String(month).trim() !== '';
        const hasYear = year !== undefined && year !== null && String(year).trim() !== '';

        if (hasMonth && hasYear) {
            try {
                const { startDate, endDate } = getMonthYearDateRange(month, year);
                query.date = { $gte: startDate, $lt: endDate };
            } catch (e) {
                return res.status(400).json({ message: e.message || 'Invalid month or year' });
            }
        } else if (hasMonth || hasYear) {
            return res.status(400).json({
                message: 'Send both month (1–12) and year together, or omit both.'
            });
        } else if (date) {
            query.date = date;
        }

        if (user) {
            query.user = user;
        }

        // Default limit to 100 to avoid huge payloads, allow pagination
        const limit = parseInt(req.query.limit) || 100;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;

        const logs = await Attendance.find(query)
            .populate('user', 'name email title role')
            .sort({ date: -1, checkIn: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Attendance.countDocuments(query);

        res.json({
            logs,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get all-attendance error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /admin/report (Admin & Manager Only) — format=xlsx (default) or format=csv
router.get('/admin/report', authenticateToken, async (req, res) => {
    try {
        const activeCompanyId = req.companyId ? req.companyId.toString() : null;
        if (!activeCompanyId) {
            return res.status(400).json({ message: 'Active company required' });
        }
        const m = req.companyMembership;
        const canReadAll = m && (m.isOwner || ['admin', 'manager'].includes(m.companyRole));
        if (!canReadAll) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }
        const downloadAllowed = await ensureAttendanceDownloadAllowed(activeCompanyId);
        if (!downloadAllowed.allowed) {
            return res.status(downloadAllowed.status).json({ message: downloadAllowed.reason });
        }
        const { month, year } = req.query;
        const format = String(req.query.format || 'xlsx').toLowerCase();

        if (month === undefined || month === null || String(month).trim() === '' || year === undefined || year === null || String(year).trim() === '') {
            return res.status(400).json({ message: 'Month (1–12) and year are required.' });
        }

        let monthPadded;
        try {
            monthPadded = String(parseInt(month, 10)).padStart(2, '0');
            getMonthYearDateRange(month, year);
        } catch (e) {
            return res.status(400).json({ message: e.message || 'Invalid month or year' });
        }

        if (format === 'csv') {
            const csv = await generateMonthlyReport(month, year, activeCompanyId);
            res.header('Content-Type', 'text/csv; charset=utf-8');
            res.attachment(`attendance_report_${year}_${monthPadded}.csv`);
            res.send(csv);
            return;
        }

        if (format !== 'xlsx') {
            return res.status(400).json({ message: 'Invalid format. Use xlsx or csv.' });
        }

        // SpreadsheetML (Excel 2003 XML) — opens in Excel; .xls extension
        const buffer = await generateMonthlyReportXlsx(month, year, activeCompanyId);
        res.header('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
        res.attachment(`attendance_report_${year}_${monthPadded}.xls`);
        res.send(buffer);
    } catch (error) {
        console.error('Generate report error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

module.exports = router;
