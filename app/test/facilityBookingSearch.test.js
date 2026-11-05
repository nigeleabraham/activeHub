const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const vm = require('node:vm');
const { Pool } = require('pg');
const Bookings = require('../models/Bookings');
const Credits = require('../models/Credits');
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
    assert.match(sql, /ORDER BY bookings.starts_at DESC LIMIT \$8/);
    rows = [];
    assert.deepEqual(await Bookings.searchFacilityBookings(guid, {}), { bookings: [], truncated: false });
    await Bookings.findBookings(guid, '2026-03-01', '2026-03-02');
    assert.deepEqual(query.mock.calls.at(-1).arguments[1], [guid, '2026-03-01', '2026-03-02']);
    assert.doesNotMatch(query.mock.calls.at(-1).arguments[0], /LIMIT \$8/);
});

test('booking page loads no records until a valid facility search and never searches other facilities', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings').route.stack[0].handle;
    t.mock.method(Bookings, 'findInAppFacilities', async () => [{ guid }, { guid: other }]);
    t.mock.method(Bookings, 'findOptions', async () => []);
    t.mock.method(Bookings, 'findBookings', () => assert.fail('Must not load all bookings'));
    const search = t.mock.method(Bookings, 'searchFacilityBookings', async () => ({ bookings: [{ guid: 'booking' }], truncated: false }));
    async function render(query) {
        let locals;
        await handler({ path: '/bookings', query }, {
            render(_view, value) { locals = value; }, sendStatus(status) { assert.fail(String(status)); }
        });
        return locals;
    }
    for (const query of [{}, { profile: 'Resident' }, { facility_guid: other + 'invalid', profile: 'Resident' },
        { facility_guid: guid }, { facility_guid: guid, from: '2026-02-30' },
        { facility_guid: guid, from: '0000-01-01' },
        { facility_guid: guid, from: '2026-12-01', to: '2026-11-01' },
        { facility_guid: guid, reference: 'x'.repeat(101) }]) {
        const locals = await render(query);
        assert.ok(locals.facilities.every(facility => !facility.bookings.length));
    }
    assert.equal(search.mock.callCount(), 0);
    const locals = await render({ facility_guid: guid, profile: ' Resident ' });
    assert.deepEqual(search.mock.calls[0].arguments, [guid, { reference: '', profile: 'Resident', from: '', to: '' }]);
    assert.equal(locals.facilities[0].bookings.length, 1);
    assert.equal(locals.facilities[1].bookings.length, 0);
    assert.equal(locals.facilities[0].searched, true);
    assert.equal(locals.facilities[1].searched, false);
    search.mock.mockImplementation(async () => { throw new Error('Database failed'); });
    let status;
    await handler({ path: '/bookings', query: { facility_guid: guid, profile: 'Resident' } }, {
        sendStatus(value) { status = value; }
    });
    assert.equal(status, 500);
});

test('facility search renders filters with no initial table and explicit empty or truncated feedback', async () => {
    for (const state of [{}, { searched: true }, { searched: true, truncated: true }, { searched: true, searchError: 'Enter at least one search filter.' }]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/partials/booking-flow.ejs'), {
            facility: { guid, options: [], bookings: [], ...state },
            currentProfile: {}, isAdmin: true
        });
        assert.match(html, /method="GET" action="\/admin\/bookings#booking-search-/);
        for (const name of ['facility_guid', 'reference', 'profile', 'from', 'to']) {
            assert.ok(html.includes(`name="${name}"`));
        }
        assert.doesNotMatch(html, /<table/);
        assert.ok(html.indexOf('>Clear search</a>') < html.indexOf('>Search bookings</button>'));
        const searchTag = html.match(/<details id="booking-search-[^>]+>/)[0];
        assert.equal(/\bopen\b/.test(searchTag), false);
        assert.match(html, /<summary class="admin-card-summary"><h3[^>]*>Search existing bookings<\/h3><\/summary>/);
        if (!state.searched) assert.match(html, /Search to load existing bookings/);
        else if (state.searchError) assert.match(html, /role="alert">Enter at least one search filter/);
        else assert.match(html, /Search results: <span data-booking-count>0/);
        if (state.truncated) assert.match(html, /Showing the latest 100 matching bookings/);
    }
});
