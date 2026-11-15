const express = require('express');
const CourseBookingAdmin = require('../models/CourseBookingAdmin');
const CourseOrders = require('../models/CourseOrders');
const Profiles = require('../models/Profiles');
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
            if (req.query[key] === undefined) continue;
            managementQuery[key] = ['course', 'run'].includes(key) && req.query[key] === 'all' ? '' : req.query[key];
        }
        const registerQuery = { ...req.query };
        if (registerQuery.course === 'all') registerQuery.course = '';
        if (registerQuery.run === 'all') delete registerQuery.run;
        const allRegisterClasses = !management && req.query.view === 'register' && req.query.run === 'all';
        if (allRegisterClasses) registerQuery.view = 'search';
        const filters = CourseBookingAdmin.parseFilters(management ? managementQuery : registerQuery);
        const allowedFacilities = auth.isFacilityManager(req.profile) ? req.profile.managed_facility_guids || [] : null;
        if (allowedFacilities && filters.facility && !allowedFacilities.includes(filters.facility)) return res.sendStatus(403);
        if (allowedFacilities) filters.allowed_facilities = allowedFacilities;
        if (allRegisterClasses) filters.view = 'register';
        const searched = management && Object.keys(req.query).length > 0;
        const selectedCourse = req.query.course === 'all' ? 'all' : filters.course;
        const selectedRun = req.query.run === 'all' ? 'all' : filters.run;
        if (searched && (!filters.facility || !Object.hasOwn(req.query, 'course') || !Object.hasOwn(req.query, 'run') ||
            !selectedCourse || !selectedRun)) {
            return res.status(400).send('Choose a location, course and class in that order before searching.');
        }
        const courses = await CourseBookingAdmin.catalogue(allowedFacilities);
        let result = null;
        let registers = [];
        if (!management && filters.view === 'register') {
            if (allRegisterClasses) {
                if (!filters.facility || !selectedCourse) {
                    throw new RangeError('Choose a facility and course before selecting all classes.');
                }
                const runs = courses.filter(course => !filters.course || course.guid === filters.course)
                    .flatMap(course => course.runs.filter(run => run.facility_guid === filters.facility));
                registers = await Promise.all(runs.map(run =>
                    CourseBookingAdmin.register(run.guid, filters.session, { allowMissingSession: true, allowedFacilities })));
                if (registers.some(register => !register)) {
                    return res.status(409).send('A class was removed while loading the registers. Please search again.');
                }
                const dates = [...new Set(registers.flatMap(register => register.dates))].sort();
                if (filters.session && !dates.includes(filters.session)) {
                    throw new RangeError('Choose a session date from the selected classes.');
                }
                result = { dates };
                if (filters.session) registers = registers.filter(register => register.dates.includes(filters.session));
            } else {
                result = await CourseBookingAdmin.register(filters.run, filters.session, { allowedFacilities });
                if (!result) return res.sendStatus(404);
                if ((filters.facility && filters.facility !== result.facility_guid) ||
                    (filters.course && filters.course !== result.course_guid)) {
                    return res.status(400).send('Choose a class belonging to the selected facility and course.');
                }
                registers = [result];
            }
        }
        const results = searched ? await CourseBookingAdmin.search(filters) : null;
        const pageLink = page => '/admin/course-management?' + new URLSearchParams({
            ...Object.fromEntries(Object.entries(filters).filter(([key]) => key !== 'allowed_facilities')),
            course: selectedCourse || filters.course, run: selectedRun || filters.run, page: String(page)
        });
        return res.render('admin-course-bookings', {
            activePage: management ? 'course-management' : 'course-bookings', filters, courses, register: result, registers, results, searched,
            managementCourse: selectedCourse, managementRun: selectedRun, pageLink, dateTime
        });
    } catch (error) {
        if (error instanceof RangeError) return res.status(400).send(error.message);
        console.error('Unable to load course bookings:', error);
        return res.sendStatus(500);
    }
});

const manualCookie = 'activehub_course_manual';

router.get('/add', auth.requireAdministrator, async (req, res) => {
    try {
        const { q = '', profile = '', member = '', facility = '', course = '', run = '' } = req.query;
        if ([q, profile, member, facility, course, run].some(value => typeof value !== 'string') || q.length > 120) {
            return res.status(400).send('Choose a valid account holder, attendee and class.');
        }
        CourseBookingAdmin.parseFilters({ facility, course, run });
        if (profile && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile)) {
            return res.status(400).send('Choose a valid account.');
        }
        const profiles = q.trim() ? await Profiles.search(q.trim()) : [];
        const parent = profile ? await Profiles.findByGuid(profile) : null;
        if (profile && !parent) return res.status(404).send('Account not found.');
        const members = parent ? await CourseOrders.familyMembers(parent.guid) : [];
        const courses = parent ? await CourseBookingAdmin.catalogue() : [];
        if (run && (!parent || !member || !facility || !course ||
            !courses.some(item => item.guid === course && item.runs.some(classRun =>
                classRun.guid === run && classRun.facility_guid === facility && classRun.bookable)))) {
            return res.status(400).send('Choose an attendee and a class belonging to the selected facility and course.');
        }
        const quote = parent && member && run ? await CourseOrders.previewManual(parent.guid, member, run) : null;
        const token = quote ? crypto.randomUUID() : '';
        if (token) res.append('Set-Cookie', `${manualCookie}=${auth.createSessionValue(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=600${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
        return res.render('admin-course-add', { activePage: 'course-management', q, profiles, parent, members,
            courses, member, facility, course, run, quote, token, money, dateTime });
    } catch (error) {
        if (error instanceof CourseOrders.BasketError || error instanceof RangeError) return res.status(400).send(error.message);
        console.error('Unable to prepare manual course booking:', error);
        return res.sendStatus(500);
    }
});

router.post('/add', auth.requireAdministrator, async (req, res) => {
    const token = auth.readSessionValue(auth.parseCookies(req.headers.cookie)[manualCookie]);
    if (!token || token !== req.body.token) return res.status(403).send('Booking confirmation expired or is missing. Review the booking again.');
    try {
        const { profile, member, run, amount, available_credit, use_credit, confirm_full } = req.body;
        if (typeof amount !== 'string' || typeof available_credit !== 'string' ||
            !/^\d{1,10}$/.test(amount) || !/^\d{1,10}$/.test(available_credit) ||
            !['yes', 'no'].includes(use_credit) || ![undefined, 'yes'].includes(confirm_full)) {
            return res.status(400).send('Review the booking and choose whether to use credit.');
        }
        const order = await CourseOrders.createManual(profile, member, run, token, {
            amount: Number(amount), credit: use_credit === 'yes' ? Number(available_credit) : 0,
            useCredit: use_credit, confirmFull: confirm_full === 'yes'
        }, req.profile);
        return res.redirect('/admin/course-management/add/confirmed/' + order.guid);
    } catch (error) {
        if (error instanceof CourseOrders.BasketError) return res.status(409).send(error.message);
        if (error.code === 'INSUFFICIENT_CREDIT') return res.status(409).send('The available account credit changed. Review the booking again.');
        console.error('Unable to create manual course booking:', error);
        return res.sendStatus(500);
    }
});

router.get('/add/confirmed/:guid', auth.requireAdministrator, async (req, res) => {
    try {
        const order = await CourseOrders.manualOrder(req.params.guid);
        if (!order) return res.sendStatus(404);
        return res.render('admin-course-add-confirmed', { activePage: 'course-management', order, money });
    } catch (error) {
        console.error('Unable to load manual course booking:', error);
        return res.sendStatus(500);
    }
});

router.get('/:guid', async (req, res) => {
    try {
        const details = await CourseBookingAdmin.details(req.params.guid,
            auth.isFacilityManager(req.profile) ? req.profile.managed_facility_guids || [] : null);
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
        facility: query.facility,
        course: query.course === 'all' ? '' : query.course,
        run: query.run === 'all' ? '' : query.run,
        page: query.page
    });
    return {
        view: 'search', facility: filters.facility,
        course: query.course === 'all' ? 'all' : filters.course,
        run: query.run === 'all' ? 'all' : filters.run,
        page: String(filters.page)
    };
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
            remainingSessions: CourseBookingAdmin.remainingSessions(details.booking),
            defaultPence: CourseBookingAdmin.remainingValue(details.booking), paidPence: CourseBookingAdmin.paidValue(details.booking), money, dateTime,
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
