const express = require('express');
const CourseBookingAdmin = require('../models/CourseBookingAdmin');
const crypto = require('node:crypto');
const auth = require('../middleware/auth');

const router = express.Router();
const money = pence => `£${(pence / 100).toFixed(2)}`;
const dateTime = value => new Date(value).toLocaleString('en-GB', {
    timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short'
});

router.get('/', async (req, res) => {
    try {
        const management = req.baseUrl === '/admin/course-management';
        if (!management && req.query.view === 'search') {
            return res.redirect('/admin/course-management?' + new URLSearchParams(req.query));
        }
        const managementQuery = { view: 'search' };
        for (const key of ['facility', 'course', 'run', 'page']) {
            if (req.query[key] !== undefined) managementQuery[key] = req.query[key];
        }
        const filters = CourseBookingAdmin.parseFilters(management ? managementQuery : req.query);
        const courses = await CourseBookingAdmin.catalogue();
        const result = !management && filters.view === 'register' ? await CourseBookingAdmin.register(filters.run, filters.session) : null;
        if (filters.view === 'register' && !result) return res.sendStatus(404);
        if (result && ((filters.facility && filters.facility !== result.facility_guid) ||
            (filters.course && filters.course !== result.course_guid))) {
            return res.status(400).send('Choose a class belonging to the selected facility and course.');
        }
        const searched = management && Object.keys(req.query).length > 0;
        const results = searched ? await CourseBookingAdmin.search(filters) : null;
        const pageLink = page => '/admin/course-management?' + new URLSearchParams({
            ...filters, page: String(page)
        });
        return res.render('admin-course-bookings', {
            activePage: management ? 'course-management' : 'course-bookings', filters, courses, register: result, results, searched, pageLink, dateTime
        });
    } catch (error) {
        if (error instanceof RangeError) return res.status(400).send(error.message);
        console.error('Unable to load course bookings:', error);
        return res.sendStatus(500);
    }
});

router.get('/:guid', async (req, res) => {
    try {
        const details = await CourseBookingAdmin.details(req.params.guid);
        if (!details) return res.sendStatus(404);
        return res.render('admin-course-booking', { activePage: 'course-bookings', ...details, money, dateTime });
    } catch (error) {
        console.error('Unable to load course booking details:', error);
        return res.sendStatus(500);
    }
});

const removalLabels = {
    none: 'Remove attendee (no credit)',
    refundable: 'Remove attendee (refundable credit)',
    'non-refundable': 'Remove attendee (non-refundable credit)'
};
const confirmationCookie = 'activehub_course_removal';
function returnFilters(query) {
    const filters = CourseBookingAdmin.parseFilters({
        facility: query.facility, course: query.course, run: query.run, page: query.page
    });
    return { view: 'search', facility: filters.facility, course: filters.course, run: filters.run, page: String(filters.page) };
}

router.get('/:guid/remove', auth.requireAdministrator, async (req, res) => {
    try {
        if (req.query.mode !== undefined && !Object.hasOwn(removalLabels, req.query.mode)) return res.status(400).send('Choose a valid removal action.');
        const details = await CourseBookingAdmin.details(req.params.guid);
        if (!details) return res.sendStatus(404);
        if (details.booking.cancelled_at) return res.status(409).send('This attendee has already been removed.');
        const filters = returnFilters(req.query);
        const token = crypto.randomUUID();
        res.append('Set-Cookie', `${confirmationCookie}=${auth.createSessionValue(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=600${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
        return res.render('admin-course-removal', {
            activePage: 'course-management', ...details, mode: req.query.mode || '',
            token, filters,
            defaultPence: CourseBookingAdmin.remainingValue(details.booking), money,
            returnUrl: '/admin/course-management?' + new URLSearchParams(filters)
        });
    } catch (error) {
        if (error instanceof RangeError) return res.status(400).send(error.message);
        console.error('Unable to prepare attendee removal:', error);
        return res.sendStatus(500);
    }
});

router.post('/:guid/remove', auth.requireAdministrator, async (req, res) => {
    const token = auth.readSessionValue(auth.parseCookies(req.headers.cookie)[confirmationCookie]);
    if (!token || token !== req.body.token) {
        return res.status(403).send('Removal confirmation expired or is missing. Open the removal action again.');
    }
    try {
        const filters = returnFilters(req.body);
        await CourseBookingAdmin.removeAttendee(req.params.guid, req.body.mode, req.body.amount, req.profile);
        return res.redirect('/admin/course-management?' + new URLSearchParams(filters));
    } catch (error) {
        if (error instanceof RangeError) return res.status(400).send(error.message);
        console.error('Unable to remove course attendee:', error);
        return res.sendStatus(500);
    }
});

module.exports = router;
