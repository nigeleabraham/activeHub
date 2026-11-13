const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const path = require('node:path');
const ejs = require('ejs');
const Model = require('../models/CourseBookingAdmin');
const routes = require('../routes/courseBookingAdmin');
const auth = require('../middleware/auth');

const guid = '123e4567-e89b-42d3-a456-426614174000';

test('read-only course booking permission gates dashboard, search, registers and details separately from editing and courts', () => {
    const viewer = { role: 'Staff', permissions: ['course_bookings.view'] };
    for (const target of ['/', '/course-bookings', '/course-management', `/course-bookings/${guid}`]) assert.equal(auth.canAccessAdmin(viewer, target), true);
    for (const target of ['/courses', '/bookings', '/credit-refunds', '/settings']) assert.equal(auth.canAccessAdmin(viewer, target), false);
    assert.equal(auth.canAccessAdmin({ role: 'Staff', permissions: ['courses.manage'] }, '/course-bookings'), false);
    assert.equal(auth.canAccessAdmin({ role: 'Resident', permissions: [] }, '/course-bookings'), false);
});

test('course booking filters validate IDs, scalar values, dates and pages', () => {
    assert.equal(Model.parseFilters({}).view, 'search');
    assert.equal(Model.parseFilters({ view: 'register', run: guid, session: '2027-02-01' }).run, guid);
    assert.equal(Model.parseFilters({ from: '2027-01-01', to: '2027-01-01' }).page, 1);
    for (const query of [{ q: [] }, { run: 'bad' }, { status: 'cancelled' }, { view: 'register' }, { session: '2027-02-30' },
        { from: '2027-01-02', to: '2027-01-01' }, { page: '0' }, { page: '1.5' }, { q: 'x'.repeat(121) }]) {
        assert.throws(() => Model.parseFilters(query), RangeError);
    }
});

test('removal amounts are exact pence, bounded by payment, and default to unstarted purchased sessions', () => {
    assert.equal(Model.removalAmount('12.3', 2000), 1230);
    for (const value of ['0', '-1', '1.234', '1e2', '', [], '21']) {
        assert.throws(() => Model.removalAmount(value, 2000), RangeError);
    }
    const booking = { amount_pence: 1001, sessions: [
        { starts_at: '2020-01-01T10:00:00Z' }, { starts_at: '2027-01-01T10:00:00Z' },
        { starts_at: '2027-01-08T10:00:00Z' }
    ] };
    assert.equal(Model.remainingValue(booking, Date.parse('2027-01-01T10:00:00Z')), 334);
    assert.equal(Model.remainingValue({ ...booking, sessions: [] }), 0);
});

test('removal routes require active Administrator and signed token, but no confirmation checkbox', async t => {
    const route = routes.stack.find(layer => layer.route?.path === '/:guid/remove' && layer.route.methods.post).route;
    let passed = false;
    const res = { sendStatus(code) { this.code = code; }, status(code) { this.code = code; return this; },
        send(message) { this.message = message; }, render() {}, redirect(url) { this.url = url; } };
    route.stack[0].handle({ profile: { role: 'Staff', permissions: ['course_bookings.view'] }, headers: {}, path: '/test' },
        res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.code, 403);
    const remove = t.mock.method(Model, 'removeAttendee', async () => ({}));
    const handler = route.stack[1].handle;
    await handler({ headers: {}, body: {} }, res);
    assert.equal(res.code, 403);
    assert.equal(remove.mock.callCount(), 0);
    const cookie = `activehub_course_removal=${auth.createSessionValue(guid)}`;
    const req = { headers: { cookie }, params: { guid }, profile: { guid, role: 'Administrator', name: 'Admin' },
        body: { token: guid, mode: 'refundable', amount: '5.00', run: guid } };
    req.body.token = 'invalid';
    await handler(req, res);
    assert.equal(remove.mock.callCount(), 0);
    req.body.token = guid;
    await handler(req, res);
    assert.equal(remove.mock.callCount(), 1);
    assert.match(res.url, /^\/admin\/course-management\?/);
    remove.mock.mockImplementation(async () => { throw new RangeError('Already removed'); });
    await handler(req, res);
    assert.equal(res.code, 400);
    assert.equal(res.message, 'Already removed');
});

test('credit removal rejects free and completed places before writing credit or cancellation', async t => {
    const statements = [];
    let booking;
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql) {
            statements.push(sql);
            if (sql.includes('SELECT profile_guid')) return { rows: [{ profile_guid: guid, run_guid: guid }] };
            if (sql.includes('SELECT e.*')) return { rows: [booking] };
            return { rows: [] };
        },
        release() {}
    }));
    for (booking of [
        { amount_pence: 0, sessions: [{ starts_at: '2090-01-01T10:00:00Z' }] },
        { amount_pence: 1000, sessions: [{ starts_at: '2020-01-01T10:00:00Z' }] }
    ]) {
        for (const mode of ['refundable', 'non-refundable']) {
            await assert.rejects(Model.removeAttendee(guid, mode, '1.00', { name: 'Admin' }), /No credit is available/);
        }
    }
    assert.equal(statements.filter(sql => sql === 'ROLLBACK').length, 4);
    assert.ok(!statements.some(sql => /INSERT|UPDATE/.test(sql.replace(/FOR UPDATE/g, ''))));
});

test('search escapes literal wildcards, binds filters and paginates without interpolating input', async t => {
    const calls = [];
    t.mock.method(Pool.prototype, 'query', async (sql, values) => {
        calls.push({ sql, values });
        return { rows: sql.includes('AS total') ? [{ total: 51 }] : [] };
    });
    const result = await Model.search(Model.parseFilters({ view: 'search', q: "O'%_", sport: guid,
        course: guid, run: guid, facility: guid, status: 'completed', page: '2', from: '2027-01-01', to: '2027-02-01' }));
    assert.equal(result.total, 51);
    assert.equal(calls[1].values.at(-1), 50);
    assert.ok(calls[1].values.includes("%O'\\%\\_%"));
    assert.doesNotMatch(calls[1].sql, /O'/);
    assert.match(calls[1].sql, /Europe\/London/);
    assert.match(calls[1].sql, /LIMIT 50 OFFSET/);
    assert.match(calls[1].sql, /last_end <= statement_timestamp/);
});

test('admin routes surface validation, missing bookings and unexpected failures', async t => {
    const handler = route => routes.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
    const res = { status(code) { this.code = code; return this; }, send(message) { this.message = message; },
        sendStatus(code) { this.code = code; }, render(_view, locals) { this.locals = locals; } };
    const catalogue = t.mock.method(Model, 'catalogue', async () => []);
    const search = t.mock.method(Model, 'search', async () => ({ entries: [], total: 0, pageSize: 50 }));
    await handler('/')({ query: {} }, res);
    assert.equal(search.mock.callCount(), 0);
    res.redirect = url => { res.url = url; };
    await handler('/')({ query: { view: 'search', q: 'Child' } }, res);
    assert.match(res.url, /^\/admin\/course-management\?/);
    assert.equal(search.mock.callCount(), 0);
    await handler('/')({ baseUrl: '/admin/course-management', query: {
        view: 'search', q: 'Hidden filter', status: 'completed', from: '2020-01-01', session: '2020-01-01'
    } }, res);
    assert.equal(search.mock.callCount(), 1);
    for (const key of ['q', 'status', 'from', 'to', 'session', 'sport']) {
        assert.equal(search.mock.calls[0].arguments[0][key], '');
    }
    await handler('/')({ query: { view: 'register' } }, res);
    assert.equal(res.code, 400);
    t.mock.method(Model, 'register', async () => null);
    await handler('/')({ query: { view: 'register', run: guid } }, res);
    assert.equal(res.code, 404);
    t.mock.method(Model, 'details', async () => null);
    await handler('/:guid')({ params: { guid } }, res);
    assert.equal(res.code, 404);
    catalogue.mock.mockImplementation(async () => { throw new Error('Database unavailable'); });
    t.mock.method(console, 'error', () => {});
    await handler('/')({ query: {} }, res);
    assert.equal(res.code, 500);
});

test('register and booking details render safe snapshots, read-only actions and print-safe registers', async () => {
    const entry = { guid, attendee_name: '<Child>', member_guid: guid, account_name: 'Parent', booking_ref: 'AHC-TEST',
        course_name: 'Gymnastics', run_name: 'Tuesday', facility_name: 'Hall', created_at: new Date(), status: 'Upcoming',
        sessions: [{ starts_at: '2027-01-05T18:00:00Z', ends_at: '2027-01-05T19:00:00Z' }] };
    Object.assign(entry, { medical_concern: true, medical_conditions: ['asthma', 'epipen', 'other'],
        medical_other: '<script>Needs assistance</script>', activity_limitation: 'limited_a_little' });
    entry.parental_contact = { parental_contact_name: '<Parent>', parental_contact_email: 'parent@example.test',
        parental_contact_telephone: '020 1234 5678' };
    const shared = { activePage: 'course-bookings', currentProfile: null, isAdmin: false, canSwitchRole: false };
    const html = await ejs.renderFile(path.join(__dirname, '../views/admin-course-bookings.ejs'), {
        ...shared, filters: Model.parseFilters({ view: 'register', run: guid }), courses: [],
        register: { name: 'Tuesday', course_name: 'Gymnastics', facility_name: 'Hall', capacity: 12, booked: 1, spaces: 11,
            dates: ['2027-01-05'], entries: [entry] }, results: null, pageLink: () => '', dateTime: String
    });
    assert.match(html, /&lt;Child&gt;/);
    assert.match(html, /Print register/);
    assert.match(html, /@media print/);
    assert.match(html, /Spaces remaining: 11/);
    assert.match(html, /<th scope="col">Parental contact details<\/th>/);
    assert.match(html, /Name: &lt;Parent&gt;/);
    assert.match(html, /Email: parent@example.test/);
    assert.match(html, /Telephone: 020 1234 5678/);
    assert.match(html, /id="register-location" name="facility" data-location-filter required/);
    assert.match(html, /<label for="register-location">Facility<\/label>/);
    assert.match(html, /Choose a facility/);
    assert.match(html, /id="register-course" name="course" data-course-filter required/);
    assert.doesNotMatch(html, /id="register-sport"/);
    assert.match(html, /<title>Course\/Class register \| ActiveHub<\/title>/);
    assert.match(html, /<h1 class="h2">Course\/Class register<\/h1>/);
    assert.doesNotMatch(html, /id="course-booking-search-heading"/);
    const managementHtml = await ejs.renderFile(path.join(__dirname, '../views/admin-course-bookings.ejs'), {
        ...shared, activePage: 'course-management', filters: Model.parseFilters({ view: 'search' }), courses: [],
        register: null, results: null, pageLink: () => '', dateTime: String
    });
    assert.match(managementHtml, /<title>Course management \| ActiveHub<\/title>/);
    assert.match(managementHtml, /action="\/admin\/course-management"/);
    assert.ok(managementHtml.indexOf('>Clear filters</a>') < managementHtml.indexOf('>Search bookings</button>'));
    assert.match(managementHtml, /<label for="search-facility">Location<\/label>/);
    assert.match(managementHtml, /id="search-facility" name="facility" data-location-filter/);
    assert.doesNotMatch(managementHtml, /id="search-sport"/);
    assert.doesNotMatch(managementHtml, /id="booking-query"|id="search-status"|id="search-from"|id="search-to"/);
    assert.doesNotMatch(managementHtml, /id="register-select-heading"/);
    const renderResults = isAdmin => ejs.renderFile(path.join(__dirname, '../views/admin-course-bookings.ejs'), {
        ...shared, isAdmin, activePage: 'course-management', filters: Model.parseFilters({ run: guid }), courses: [],
        register: null, results: { total: 1, pageSize: 50, entries: [entry] }, pageLink: () => '', dateTime: String
    });
    const actions = await renderResults(true);
    assert.doesNotMatch(actions, /<th scope="col">(?:Course \/ class|Purchased|Status|Booking)<\/th>|AHC-TEST/);
    assert.match(actions, /<th scope="col">Attendee<\/th><th scope="col">Booked by<\/th><th scope="col">Actions<\/th>/);
    assert.equal((actions.match(/>Remove attendee<\/a>/g) || []).length, 1);
    assert.doesNotMatch(actions, /Remove attendee \(/);
    assert.doesNotMatch(await renderResults(false), />Remove attendee<\/a>/);
    entry.cancelled_at = new Date();
    assert.doesNotMatch(await renderResults(true), />Remove attendee<\/a>/);
    delete entry.cancelled_at;
    const removal = await ejs.renderFile(path.join(__dirname, '../views/admin-course-removal.ejs'), {
        ...shared, booking: { ...entry, amount_pence: 1000 }, actionLabel: 'Remove attendee (refundable credit)',
        mode: 'refundable', token: guid, filters: {}, returnUrl: '/admin/course-management',
        defaultPence: 500, money: String
    });
    assert.match(removal, /name="amount"[\s\S]*value="5.00"/);
    assert.doesNotMatch(removal, /name="confirm"|confirm-removal|I confirm/);
    assert.match(removal, /original non-refundable credit stays non-refundable/);
    assert.equal((removal.match(/type="radio" name="mode"/g) || []).length, 3);
    assert.doesNotMatch(removal, /type="hidden" name="mode"/);
    const noCredit = await ejs.renderFile(path.join(__dirname, '../views/admin-course-removal.ejs'), {
        ...shared, booking: { ...entry, amount_pence: 0 }, mode: '', token: guid,
        filters: {}, returnUrl: '/admin/course-management', defaultPence: 0, money: String
    });
    assert.equal((noCredit.match(/type="radio" name="mode"/g) || []).length, 1);
    assert.match(noCredit, /value="none" required checked/);
    assert.doesNotMatch(noCredit, /value="refundable"|value="non-refundable"|name="amount"/);
    assert.match(noCredit, /Only removal without credit is available/);
    assert.match(html, /<th scope="col">Medical \/ additional info<\/th>/);
    assert.match(html, /Allergy requiring EpiPen/);
    assert.match(html, /Asthma/);
    assert.match(html, /&lt;script&gt;Needs assistance&lt;\/script&gt;/);
    assert.match(html, /Day-to-day activities limited a little/);
    assert.doesNotMatch(html, />Attendance<|Mark attendance|________/);
    assert.doesNotMatch(html, /Status \/ purchased/);
    assert.doesNotMatch(html, /<th scope="col">Reference<\/th>|AHC-TEST/);
    assert.doesNotMatch(html, /Payment reference|Account email|Card-paid portion|method="POST"/);
    const detail = await ejs.renderFile(path.join(__dirname, '../views/admin-course-booking.ejs'), {
        ...shared, booking: { ...entry, run_guid: guid, account_email: 'parent@example.test', amount_pence: 1500,
            credit_applied_pence: 500, payment_reference: 'SIM-TEST' },
        order: { guid, total_pence: 2000, credit_pence: 500, items: [
            { ...entry, amount_pence: 1500 }, { kind: 'court', option_name: 'Tennis', facility_name: 'Park',
                starts_at: '2027-01-06T18:00:00Z', ends_at: '2027-01-06T19:00:00Z', amount_pence: 500 }
        ] }, money: pence => `GBP ${(pence / 100).toFixed(2)}`, dateTime: String
    });
    assert.match(detail, /GBP 10\.00/);
    assert.doesNotMatch(detail, /Original order confirmation|order-heading|GBP 20\.00|Tennis/);
    assert.match(detail, /Purchased sessions/);
    assert.doesNotMatch(detail, /action="[^"]*(?:cancel|refund)|method="POST"[^>]*action="\/admin\/course-bookings/);
});
