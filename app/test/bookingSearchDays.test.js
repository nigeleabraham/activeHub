const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const ejs = require('ejs');
const { Pool } = require('pg');
const Settings = require('../models/Settings');
const Bookings = require('../models/Bookings');
const Credits = require('../models/Credits');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

test('booking search range initializes to 30 without overwriting configuration', async t => {
    assert.equal(Settings.DEFAULTS.booking_search_days, '30');
    for (const value of ['', '0', '366', '-1', '1.5', ' 30 ', undefined]) {
        assert.equal(Settings.parseBookingSearchDays(value), null);
    }
    for (const value of ['1', '30', '365']) assert.equal(Settings.parseBookingSearchDays(value), Number(value));
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [] }));
    await Settings.initialize();
    assert.ok(query.mock.calls.some(call =>
        call.arguments[0].includes("('booking_search_days', '30') ON CONFLICT (key) DO NOTHING")));
});

test('booking search settings save valid days with an audit and surface errors', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/settings/booking-search-days').route.stack[0].handle;
    t.mock.method(Settings, 'getBookingSearchDays', async () => 30);
    const save = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    for (const days of ['0', '366', '1.5', '7']) {
        let location;
        await handler({ body: { days }, profile: { name: 'Admin' } }, {
            redirect(value) { location = value; }
        });
        assert.equal(location, days === '7' ? '/admin/settings?saved=1' : '/admin/settings?error=booking-search-days');
    }
    assert.deepEqual(save.mock.calls[0].arguments, ['booking_search_days', '7']);
    assert.deepEqual(audit.mock.calls[0].arguments[1].details, { from: 30, to: 7 });
    save.mock.mockImplementation(async () => { throw new Error('Database failed'); });
    let status;
    await handler({ body: { days: '7' } }, { sendStatus(value) { status = value; } });
    assert.equal(status, 500);
});

test('model applies configured offset, including shortened and same-day searches', async t => {
    t.mock.method(Settings, 'getBookingSearchDays', async () => 7);
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [] }));
    t.mock.method(Credits, 'fundingForBookings', async rows => rows);
    for (const to of ['2026-03-01', '2026-03-04', '2026-03-08']) {
        await Bookings.searchBookings({ from: '2026-03-01', to });
    }
    assert.equal(query.mock.callCount(), 3);
    for (const to of ['2026-03-09', '2026-02-28']) {
        await assert.rejects(Bookings.searchBookings({ from: '2026-03-01', to }), RangeError);
    }
    assert.equal(query.mock.callCount(), 3);
});

test('invalid database configuration fails explicitly', async t => {
    t.mock.method(Pool.prototype, 'query', async () => ({ rows: [{ key: 'booking_search_days', value: 'invalid' }] }));
    await assert.rejects(Settings.getBookingSearchDays(), /Invalid configured booking search/);
});

test('page defaults and server validation use a non-default configured range', async t => {
    t.mock.method(Settings, 'getBookingSearchDays', async () => 7);
    t.mock.method(Bookings, 'findBookingFacilities', async () => []);
    const search = t.mock.method(Bookings, 'searchBookings', async () => ({ bookings: [], truncated: false }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/booking-search').route.stack[0].handle;
    async function render(query) {
        let locals;
        await handler({ path: '/booking-search', query }, {
            render(_view, value) { locals = value; }, sendStatus(value) { assert.fail(String(value)); }
        });
        return locals.searchResults;
    }
    const initial = await render({});
    assert.equal(initial.maxDays, 7);
    assert.equal((Date.parse(initial.filters.to) - Date.parse(initial.filters.from)) / 86400000, 7);
    assert.equal(initial.searched, false);
    assert.equal(search.mock.callCount(), 0);
    const invalid = await render({ from: '2026-03-01', to: '2026-03-09' });
    assert.match(invalid.searchError, /From \+7 days/);
    assert.equal(search.mock.callCount(), 0);
    await render({ from: '2026-03-01', to: '2026-03-08' });
    assert.equal(search.mock.callCount(), 1);
});

test('date controls default To on From changes using calendar arithmetic and keep shortened dates on load', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/booking-flow-script.ejs'));
    const script = html.slice(html.indexOf('        const fromDate ='), html.indexOf('        let busy ='));
    const listeners = {};
    const from = { value: '2026-03-01', validity: { valid: true },
        addEventListener(event, callback) { listeners[event] = callback; } };
    const to = { value: '2026-03-05' };
    const hint = {};
    vm.runInNewContext(script, {
        form: { dataset: { bookingSearchDays: '30' }, querySelector(selector) {
            return selector === '[name="from"]' ? from : selector === '[name="to"]' ? to : hint;
        } },
        Date, Intl
    });
    assert.equal(to.value, '2026-03-05');
    assert.equal(to.min, '2026-03-01');
    assert.equal(to.max, '2026-03-31');
    assert.equal(hint.textContent, 'Allowed To date: 1 March 2026 to 31 March 2026, inclusive. You may shorten this range.');
    for (const [start, expected] of [['2026-03-29', '2026-04-28'], ['2026-10-25', '2026-11-24'], ['2026-12-15', '2027-01-14']]) {
        from.value = start;
        listeners.input();
        assert.equal(to.min, start);
        assert.equal(to.value, expected);
        assert.equal(to.max, expected);
    }
    assert.match(hint.textContent, /15 December 2026 to 14 January 2027/);
    from.value = '';
    from.validity.valid = false;
    listeners.input();
    assert.equal(to.max, '');
    assert.match(hint.textContent, /Choose a valid From date/);
});
