const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const vm = require('node:vm');
const { Pool } = require('pg');
const Bookings = require('../models/Bookings');
const Credits = require('../models/Credits');
const AuditLog = require('../models/AuditLog');
const Settings = require('../models/Settings');
const router = require('../routes/front');
const guid = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';

test('search and clear update only results without navigation or scroll changes', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/booking-flow-script.ejs'));
    const script = html.slice(html.indexOf("    document.querySelectorAll('[data-facility-booking-search]')"), html.indexOf("    const resourceFormScrollKey"));
    assert.doesNotThrow(() => new vm.Script(script));
    assert.match(script, /event.preventDefault\(\)/);
    assert.match(script, /await fetch\(url\)/);
    assert.match(script, /url.hash = ''/);
    assert.match(script, /querySelector\('\[data-booking-search-results\]'\).replaceWith\(results\)/);
    assert.match(script, /initializeBookingCancellations\(\)/);
    assert.match(script, /window.history.replaceState/);
    assert.match(script, /error.hidden = false/);
    assert.doesNotMatch(script, /scrollIntoView|scrollTo|location.assign|sessionStorage/);
});

test('facility booking searches constrain SQL by facility, escaped filters, UK dates and limit', async t => {
    t.mock.method(Settings, 'getBookingSearchDays', async () => 30);
    let rows = Array.from({ length: 101 }, (_, index) => ({ guid: String(index) }));
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows }));
    t.mock.method(Credits, 'fundingForBookings', async bookings => bookings);
    const filters = { reference: 'BK_%', profile: 'Resident', from: '2026-03-29', to: '2026-03-30' };
    const result = await Bookings.searchFacilityBookings(guid, filters);
    assert.equal(result.bookings.length, 100);
    assert.equal(result.truncated, true);
    const [sql, values] = query.mock.calls[0].arguments;
    assert.deepEqual(values, [guid, null, null, '%BK\\_\\%%', '%Resident%', filters.from, filters.to, 101]);
    assert.match(sql, /WHERE bookings.facility_guid = \$1/);
    assert.match(sql, /profiles.name ILIKE \$5 OR profiles.email ILIKE \$5/);
    assert.match(sql, /Europe\/London/);
    assert.match(sql, /ORDER BY bookings.starts_at DESC, bookings.guid LIMIT \$8/);
    assert.ok(sql.indexOf('LIMIT $8') < sql.indexOf('LEFT JOIN booking_reservations'));
    assert.match(sql, /tstzrange\(bookings.starts_at, bookings.ends_at, '\[\)'\) && tstzrange/);
    rows = [];
    assert.deepEqual(await Bookings.searchFacilityBookings(guid, filters), { bookings: [], truncated: false });
    const calls = query.mock.callCount();
    for (const invalid of [{}, { from: '2026-01-01' }, { from: '2026-02-01', to: '2026-02-30' },
        { from: '2026-01-01', to: '2026-02-01' }, { from: '2026-01-02', to: '2026-01-01' }]) {
        await assert.rejects(Bookings.searchFacilityBookings(guid, invalid), RangeError);
    }
    assert.equal(query.mock.callCount(), calls);
    await Bookings.findBookings(guid, '2026-03-01', '2026-03-02');
    assert.deepEqual(query.mock.calls.at(-1).arguments[1], [guid, '2026-03-01', '2026-03-02']);
    assert.doesNotMatch(query.mock.calls.at(-1).arguments[0], /LIMIT \$8/);
});

test('booking search loads once with optional facility filtering and rejects invalid filters', async t => {
    t.mock.method(Settings, 'getBookingSearchDays', async () => 30);
    t.mock.method(Settings, 'getAll', async () => Settings.DEFAULTS);
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/booking-search').route.stack[0].handle;
    t.mock.method(Bookings, 'findBookingFacilities', async () => [{ guid }, { guid: other }]);
    t.mock.method(Bookings, 'findOptions', () => assert.fail('Search must not load calendar options'));
    t.mock.method(Bookings, 'findBookings', () => assert.fail('Must not load all bookings'));
    const search = t.mock.method(Bookings, 'searchBookings', async () => ({ bookings: [{ guid: 'booking' }], truncated: false }));
    async function render(query) {
        let locals;
        await handler({ path: '/booking-search', query }, {
            render(_view, value) { locals = value; }, sendStatus(status) { assert.fail(String(status)); }
        });
        return locals;
    }
    for (const query of [{}, { profile: 'Resident' }, { facility_guid: other + 'invalid', profile: 'Resident' },
        { facility_guid: guid }, { facility_guid: guid, from: '2026-02-30' },
        { facility_guid: guid, from: '0000-01-01' },
        { facility_guid: guid, profile: 'Resident' },
        { facility_guid: guid, from: '2026-01-01', to: '2026-02-01' },
        { facility_guid: guid, from: '2026-12-01', to: '2026-11-01' },
        { facility_guid: guid, reference: 'x'.repeat(101) }]) {
        const locals = await render(query);
        assert.equal(locals.searchResults.bookings.length, 0);
        if (Object.values(query).some(Boolean)) assert.ok(locals.searchResults.searchError);
        else {
            assert.equal(locals.searchResults.maxDays, 30);
            assert.equal((Date.parse(locals.searchResults.filters.to) - Date.parse(locals.searchResults.filters.from)) / 86400000, 30);
            assert.equal(locals.searchResults.searched, false);
        }
    }
    assert.equal(search.mock.callCount(), 0);
    const locals = await render({ facility_guid: guid, profile: ' Resident ', from: '2026-03-01', to: '2026-03-31' });
    assert.deepEqual(search.mock.calls[0].arguments, [{ facility_guid: guid, reference: '', profile: 'Resident', from: '2026-03-01', to: '2026-03-31' }]);
    assert.equal(locals.searchResults.bookings.length, 1);
    assert.equal(locals.searchResults.searched, true);
    await render({ from: '2026-03-01', to: '2026-03-31' });
    assert.deepEqual(search.mock.calls[1].arguments, [{ facility_guid: '', reference: '', profile: '', from: '2026-03-01', to: '2026-03-31' }]);
    assert.equal(search.mock.callCount(), 2);
    await render({ facility_guid: other + 'invalid', from: '2026-03-01', to: '2026-03-31' });
    assert.equal(search.mock.callCount(), 2);
    search.mock.mockImplementation(async () => { throw new Error('Database failed'); });
    let status;
    await handler({ path: '/booking-search', query: { facility_guid: guid, profile: 'Resident', from: '2026-03-29', to: '2026-03-29' } }, {
        sendStatus(value) { status = value; }
    });
    assert.equal(status, 500);
});

test('one search form renders an optional facility selector and empty or truncated feedback', async () => {
    for (const state of [{}, { searched: true }, { searched: true, truncated: true }, { searched: true, searchError: 'Enter at least one search filter.' }]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/partials/booking-search.ejs'), {
            results: { bookings: [], maxDays: 30, ...state },
            facilities: [{ guid, name: 'Test facility' }, { guid: other, name: 'Other facility' }],
            currentProfile: {}, isAdmin: true
        });
        assert.match(html, /method="GET" action="\/admin\/booking-search"/);
        assert.match(html, /<select[^>]+name="facility_guid"/);
        assert.match(html, /<option value="">All facilities<\/option>/);
        assert.equal((html.match(/data-facility-booking-search/g) || []).length, 1);
        assert.doesNotMatch(html, /<details/);
        for (const name of ['facility_guid', 'reference', 'profile', 'from', 'to']) {
            assert.ok(html.includes(`name="${name}"`));
        }
        for (const name of ['from', 'to']) {
            assert.match(html, new RegExp(`name="${name}"[^>]+required`));
        }
        assert.match(html, /To defaults to From \+30 days/);
        assert.match(html, /Booking dates <small class="text-muted">Required<\/small>/);
        assert.match(html, /Both dates are mandatory/);
        assert.match(html, /31 calendar dates including both ends/);
        assert.match(html, /Changing From resets To to the new maximum/);
        assert.match(html, /data-booking-date-range aria-live="polite"/);
        assert.match(html, /Narrow your search <small class="text-muted">Optional<\/small>/);
        assert.ok(html.indexOf('name="from"') < html.indexOf('name="facility_guid"'));
        assert.doesNotMatch(html, /<table/);
        assert.ok(html.indexOf('>Clear search</a>') < html.indexOf('>Search bookings</button>'));
        assert.match(html, /<section id="booking-search"[^>]+data-booking-search-panel/);
        assert.match(html, /<h2[^>]*>Search existing bookings<\/h2>/);
        assert.doesNotMatch(html, /<(?:div|form)\b[^>]+(?:data-booking-calendar|data-booking-form)/);
        if (!state.searched) assert.match(html, /Search to load existing bookings/);
        else if (state.searchError) assert.match(html, /role="alert">Enter at least one search filter/);
        else assert.match(html, /Search results: <span data-booking-count>0/);
        if (state.truncated) assert.match(html, /Showing the latest 100 matching bookings/);
    }
});

test('booking creation stays separate and legacy facility searches redirect to the search page', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings').route.stack[0].handle;
    t.mock.method(Bookings, 'findInAppFacilities', async () => [{ guid, name: 'Test facility' }]);
    t.mock.method(Bookings, 'findOptions', async () => [{ guid, name: 'Court', sport_name: 'Tennis' }]);
    t.mock.method(Bookings, 'searchFacilityBookings', () => assert.fail('Creation page must not search'));
    let locals;
    await handler({ path: '/bookings', query: {} }, {
        render(_view, value) { locals = value; }, sendStatus(status) { assert.fail(String(status)); }
    });

    assert.equal(locals.activePage, 'bookings');
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/booking-flow.ejs'), {
        facility: locals.facilities[0], currentProfile: {}, isAdmin: true, searching: false
    });
    assert.match(html, /data-booking-calendar/);
    assert.doesNotMatch(html, /data-facility-booking-search|Search existing bookings|data-cancel-booking/);
    let redirect;
    await handler({ path: '/bookings', query: { facility_guid: guid, from: '2026-03-01', to: '2026-03-31', profile: 'A & B' } }, {
        redirect(value) { redirect = value; }
    });
    const url = new URL(redirect, 'http://localhost');
    assert.equal(url.pathname, '/admin/booking-search');
    assert.equal(url.searchParams.get('profile'), 'A & B');
    assert.equal(url.searchParams.get('facility_guid'), guid);
});

test('search page renders results with cancellation links and its active navigation item', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/bookings.ejs'), {
        activePage: 'booking-search', area: 'admin', isAdmin: true, canSwitchRole: false,
        currentProfile: { name: 'Admin', role: 'Administrator' }, created: 0, error: '',
        moment: require('moment'),
        facilities: [{ guid, name: 'Test facility' }],
        searchResults: { maxDays: 30, searched: true, filters: { from: '2026-03-01', to: '2026-03-31', facility_guid: '' },
            bookings: [{ guid: other, facility_guid: guid, facility_name: 'Test facility', booking_ref: 'AH-TEST', option_name: 'Court', sport_name: 'Tennis',
                starts_at: '2026-03-01T12:00Z', ends_at: '2026-03-01T13:00Z', resource_names: [],
                payment_status: 'not_required' }] }
    });

    assert.match(html, /<title>Booking search \| ActiveHub<\/title>/);
    assert.match(html, /href="\/admin\/booking-search" aria-current="page"/);
    assert.match(html, /data-cancel-booking/);
    assert.match(html, /name="return_to" value="booking-search"/);
    assert.match(html, /name="from" value="2026-03-01"/);
    assert.match(html, /<th>Facility<\/th>/);
    assert.match(html, /name="facility_guid" value="123e4567-e89b-42d3-a456-426614174000"/);
    assert.match(html, /name="search_facility_guid" value=""/);
    assert.match(html, /name="to"[^>]+min="2026-03-01" max="2026-03-31"/);
    assert.doesNotMatch(html, /<(?:div|form)\b[^>]+(?:data-booking-calendar|data-booking-form)/);
});

test('booking search shows three separately gated cancellation actions', async () => {
    const booking = {
        guid: other, facility_guid: guid, facility_name: 'Test facility', booking_ref: 'AH-PAID',
        option_name: 'Court', sport_name: 'Tennis', starts_at: '2026-03-01T12:00Z',
        ends_at: '2026-03-01T13:00Z', resource_names: [], payment_status: 'paid',
        profile_guid: guid, profile_name: 'Rita Resident', amount_pence: 1000,
        amount_paid_pence: 1000, credit_applied_pence: 200, credited_at: null
    };
    const render = (overrides = {}, locals = {}) => ejs.renderFile(
        path.join(__dirname, '../views/partials/booking-search.ejs'),
        {
            results: {
                maxDays: 30, searched: true,
                filters: { from: '2026-03-01', to: '2026-03-31', facility_guid: '' },
                bookings: [{ ...booking, ...overrides }]
            },
            facilities: [{ guid, name: 'Test facility' }],
            moment: require('moment'), isAdmin: true, refundsEnabled: true, ...locals
        }
    );
    const eligible = await render();
    assert.match(eligible, /class="btn btn-primary btn-sm mb-1 w-100"[^>]+name="cancel_action" value="cancel">Cancel booking<\/button>/);
    assert.match(eligible, /class="btn btn-primary btn-sm mb-1 w-100"[^>]+name="cancel_action" value="credit">Cancel and credit £10\.00 — non-refundable<\/button>/);
    assert.match(eligible, /class="btn btn-primary btn-sm mb-1 w-100"[^>]+name="cancel_action" value="refundable-credit">Cancel and credit £10\.00 — bank refund available<\/button>/);
    assert.doesNotMatch(eligible, /type="checkbox"|name="refundable"/);

    for (const html of [
        await render({}, { refundsEnabled: false }),
        await render({ credit_applied_pence: 1000 }),
        await render({}, { isAdmin: false }),
        await render({ profile_guid: null, profile_name: null }),
        await render({ amount_paid_pence: 0 }),
        await render({ credited_at: '2026-03-02T12:00:00Z' })
    ]) {
        assert.match(html, /name="cancel_action" value="cancel"/);
    }
    assert.doesNotMatch(await render({}, { refundsEnabled: false }), /value="refundable-credit"/);
    assert.doesNotMatch(await render({ credit_applied_pence: 1000 }), /value="refundable-credit"/);
    for (const html of [
        await render({}, { isAdmin: false }),
        await render({ profile_guid: null, profile_name: null }),
        await render({ amount_paid_pence: 0 }),
        await render({ credited_at: '2026-03-02T12:00:00Z' })
    ]) {
        assert.doesNotMatch(html, /value="credit"|value="refundable-credit"/);
    }
});

test('non-JavaScript cancellation returns to booking search with filters and cannot redirect externally', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings/cancel').route.stack[0].handle;
    t.mock.method(Bookings, 'findBooking', async () => ({ booking_ref: 'AH-TEST' }));
    t.mock.method(Bookings, 'removeBooking', async () => true);
    t.mock.method(AuditLog, 'record', async () => {});
    for (const [returnTo, filterFacility] of [['booking-search', ''], ['booking-search', other], ['https://example.test', ''], [undefined, '']]) {
        let redirect;
        await handler({
            body: { facility_guid: guid, search_facility_guid: filterFacility, booking_guid: other, return_to: returnTo, from: '2026-03-01', to: '2026-03-31', profile: 'A & B' },
            profile: { name: 'Admin', role: 'Administrator' }, get() { return ''; }
        }, { redirect(value) { redirect = value; }, sendStatus(status) { assert.fail(String(status)); } });
        const url = new URL(redirect, 'http://localhost');
        assert.equal(url.origin, 'http://localhost');
        assert.equal(url.pathname, returnTo === 'booking-search' ? '/admin/booking-search' : '/admin/bookings');
        if (returnTo === 'booking-search') {
            assert.equal(url.searchParams.get('profile'), 'A & B');
            assert.equal(url.searchParams.get('from'), '2026-03-01');
            assert.equal(url.searchParams.get('facility_guid'), filterFacility);
        }
    }
});

test('cancellation actions enforce authorization and eligibility before mutation', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings/cancel').route.stack[0].handle;
    let booking = {
        facility_guid: guid, guid: other, booking_ref: 'AH-PAID', profile_guid: guid,
        profile_name: 'Rita Resident', amount_paid_pence: 1000, credit_applied_pence: 200,
        credited_at: null, option_name: 'Court', facility_name: 'Test facility'
    };
    t.mock.method(Bookings, 'findBooking', async () => booking);
    const remove = t.mock.method(Bookings, 'removeBooking', async () => true);
    const credit = t.mock.method(Bookings, 'removeBookingWithCredit', async () => true);
    t.mock.method(AuditLog, 'record', async () => {});
    let refundsEnabled = true;
    t.mock.method(Settings, 'getAll', async () => ({
        ...Settings.DEFAULTS, refunds_enabled: refundsEnabled ? '1' : '0'
    }));

    async function submit(cancelAction, role = 'Administrator') {
        const response = {};
        await handler({
            body: { facility_guid: guid, booking_guid: other, cancel_action: cancelAction },
            profile: { name: role, role },
            get() { return 'fetch'; }
        }, {
            sendStatus(status) { response.status = status; },
            status(status) { response.status = status; return this; },
            send(message) { response.message = message; },
            redirect() { assert.fail('Fetch cancellation must not redirect'); }
        });
        return response;
    }

    assert.equal((await submit('invalid')).status, 400);
    assert.equal((await submit('credit', 'Staff')).status, 403);
    booking = { ...booking, amount_paid_pence: 0 };
    assert.equal((await submit('credit')).status, 409);
    booking = { ...booking, amount_paid_pence: 1000, credit_applied_pence: 1000 };
    assert.equal((await submit('refundable-credit')).status, 409);
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(credit.mock.callCount(), 0);

    booking = { ...booking, credit_applied_pence: 200 };
    assert.equal((await submit('credit')).status, 204);
    assert.deepEqual(credit.mock.calls.at(-1).arguments, [guid, other, guid, 1000, 'Administrator', false]);
    assert.equal((await submit('refundable-credit')).status, 204);
    assert.deepEqual(credit.mock.calls.at(-1).arguments, [guid, other, guid, 1000, 'Administrator', true]);
    assert.equal((await submit('cancel', 'Staff')).status, 204);
    assert.deepEqual(remove.mock.calls.at(-1).arguments, [guid, other]);

    refundsEnabled = false;
    const disabled = await submit('refundable-credit');
    assert.equal(disabled.status, 403);
    assert.match(disabled.message, /disabled system-wide/);
    assert.equal(credit.mock.callCount(), 2);
});

test('bounded facility search preserves overlap, resource details and limits in PostgreSQL', {
    skip: !process.env.SEARCH_TEST_DATABASE_URL
}, async t => {
    t.mock.method(Settings, 'getBookingSearchDays', async () => 30);
    const db = new Pool({ connectionString: process.env.SEARCH_TEST_DATABASE_URL });
    const client = await db.connect();
    t.after(async () => {
        await client.query('ROLLBACK');
        client.release();
        await db.end();
    });
    await client.query('BEGIN');
    for (const table of ['facilities', 'bookings', 'profiles', 'bookable_options', 'sports', 'booking_resources']) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`);
    }
    await client.query(`CREATE TEMP TABLE booking_reservations (
        booking_guid uuid, resource_guid uuid, starts_at timestamptz, ends_at timestamptz
    ) ON COMMIT DROP`);
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [] }));
    t.mock.method(Credits, 'initialize', async () => {});
    await Bookings.initialize();
    const indexes = query.mock.calls.map(call => call.arguments[0]).filter(sql =>
        /CREATE INDEX IF NOT EXISTS (bookings_time_range_idx|bookings_facility_time_range_idx|bookings_facility_starts_idx|booking_reservations_booking_idx)/.test(sql));
    assert.equal(indexes.length, 4);
    for (const sql of indexes) await client.query(sql);
    query.mock.mockImplementation((sql, values) => client.query(sql, values));
    t.mock.method(Credits, 'fundingForBookings', async bookings => bookings);
    await client.query(`INSERT INTO facilities (guid, name, address, postcode, latitude, longitude, google_maps_url, description)
        VALUES ($1, 'First facility', '', '', 0, 0, '', ''), ($2, 'Second facility', '', '', 0, 0, '', '')`, [guid, other]);
    await client.query(`INSERT INTO profiles (guid, name, email, role) VALUES ($1, 'Test Resident', 'resident@example.test', 'Resident')`, [guid]);
    await client.query("INSERT INTO sports (guid, name) VALUES ($1, 'Test sport')", [guid]);
    await client.query("INSERT INTO bookable_options (guid, facility_guid, sport_guid, name) VALUES ($1, $1, $1, 'Test court')", [guid]);
    await client.query("INSERT INTO booking_resources (guid, facility_guid, name) VALUES ($1, $1, 'Court A'), ($2, $1, 'Court B')", [guid, other]);
    // The UK spring-clock-change day is 23 hours long: [00:00Z, 23:00Z).
    await client.query(`INSERT INTO bookings (facility_guid, option_guid, profile_guid, starts_at, ends_at, booking_ref)
        SELECT $1, $1, $1, '2026-03-29 00:00Z'::timestamptz + n * interval '1 minute',
            '2026-03-29 01:00Z'::timestamptz + n * interval '1 minute', 'TEST-' || n
        FROM generate_series(1, 101) AS n`, [guid]);
    const boundaryRows = [
        ['OVERLAP', guid, '2026-03-28 23:30Z', '2026-03-29 00:30Z'],
        ['ENDS-AT-START', guid, '2026-03-28 23:00Z', '2026-03-29 00:00Z'],
        ['LAST-HOUR', guid, '2026-03-29 22:30Z', '2026-03-29 23:30Z'],
        ['STARTS-AT-END', guid, '2026-03-29 23:00Z', '2026-03-30 00:00Z'],
        ['OTHER-FACILITY', other, '2026-03-29 01:00Z', '2026-03-29 02:00Z']
    ];
    for (const [reference, facility, starts, ends] of boundaryRows) {
        await client.query(`INSERT INTO bookings (facility_guid, option_guid, profile_guid, starts_at, ends_at, booking_ref)
            VALUES ($1, $2, $2, $3, $4, $5)`, [facility, guid, starts, ends, reference]);
    }
    await client.query(`INSERT INTO booking_reservations (booking_guid, resource_guid, starts_at, ends_at)
        SELECT bookings.guid, resources.guid, bookings.starts_at, bookings.ends_at
        FROM bookings CROSS JOIN booking_resources resources`);
    const dates = { from: '2026-03-29', to: '2026-03-29' };
    const result = await Bookings.searchFacilityBookings(guid, dates);
    assert.equal(result.bookings.length, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.bookings[0].booking_ref, 'LAST-HOUR');
    assert.ok(result.bookings.every(booking =>
        !['ENDS-AT-START', 'STARTS-AT-END', 'OTHER-FACILITY'].includes(booking.booking_ref)));
    assert.deepEqual(result.bookings[0].resource_names, ['Court A', 'Court B']);
    assert.deepEqual((await Bookings.searchFacilityBookings(guid, { ...dates, reference: 'OVERLAP' })).bookings.map(row => row.booking_ref), ['OVERLAP']);
    assert.equal((await Bookings.searchFacilityBookings(guid, { ...dates, profile: 'resident@example.test' })).bookings.length, 100);
    assert.equal((await Bookings.searchFacilityBookings(guid, { ...dates, profile: 'missing' })).bookings.length, 0);
    await client.query('SET LOCAL enable_seqscan = off');
    const [sql, values] = query.mock.calls.at(-1).arguments;
    const { rows: plan } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
    assert.match(JSON.stringify(plan), /bookings_facility_(time_range|starts)_idx/);
    assert.match(JSON.stringify(plan), /booking_reservations_booking_idx/);
    const global = await Bookings.searchBookings(dates);
    assert.equal(global.bookings.length, 100);
    assert.equal(global.truncated, true);
    assert.equal(global.bookings[0].booking_ref, 'LAST-HOUR');
    assert.ok(global.bookings.some(booking => booking.facility_guid === guid));
    assert.ok(global.bookings.some(booking => booking.facility_guid === other));
    const second = await Bookings.searchBookings({ ...dates, facility_guid: other });
    assert.deepEqual(second.bookings.map(row => [row.booking_ref, row.facility_guid, row.facility_name]),
        [['OTHER-FACILITY', other, 'Second facility']]);
    const globalReference = await Bookings.searchBookings({ ...dates, reference: 'OTHER-FACILITY' });
    assert.equal(globalReference.bookings[0].facility_guid, other);
    const [globalSql, globalValues] = query.mock.calls.at(-1).arguments;
    const { rows: globalPlan } = await client.query(`EXPLAIN (FORMAT JSON) ${globalSql}`, globalValues);
    assert.match(JSON.stringify(globalPlan), /bookings_time_range_idx/);
    // The autumn-clock-change day ends at midnight UTC, not 23:00 UTC.
    await client.query(`INSERT INTO bookings (facility_guid, option_guid, profile_guid, starts_at, ends_at, booking_ref)
        VALUES ($1, $1, $1, '2026-10-25 23:30Z', '2026-10-26 00:30Z', 'AUTUMN-LAST-HOUR'),
            ($1, $1, $1, '2026-10-26 00:00Z', '2026-10-26 01:00Z', 'AUTUMN-NEXT-DAY')`, [guid]);
    const autumn = await Bookings.searchFacilityBookings(guid, { from: '2026-10-25', to: '2026-10-25' });
    assert.deepEqual(autumn.bookings.map(row => row.booking_ref), ['AUTUMN-LAST-HOUR']);
    assert.equal(autumn.truncated, false);
});
