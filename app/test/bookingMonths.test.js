const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBookingMonths } = require('../validation');
const Bookings = require('../models/Bookings');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('booking management and court configuration load and render only their own tools', async t => {
    const ejs = require('ejs');
    const path = require('node:path');
    const facility = { guid: GUID, name: 'Hall', address: 'High Street', postcode: 'AB1 2CD' };
    const sports = [{ guid: GUID, name: 'Tennis', allowed_months: [1, 2] }];
    const resources = [{ guid: GUID, name: 'Court resource', claim_count: 0 }];
    const options = [{ guid: GUID, name: 'Court one', sport_guid: GUID, sport_name: 'Tennis', resources }];
    t.mock.method(Bookings, 'findInAppFacilities', async () => [facility]);
    const sportQuery = t.mock.method(Bookings, 'findFacilitySports', async () => sports);
    const resourceQuery = t.mock.method(Bookings, 'findResources', async () => resources);
    t.mock.method(Bookings, 'findOptions', async () => options);
    const bookingQuery = t.mock.method(Bookings, 'findBookings', async () => []);
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const profile = { guid: GUID, name: 'Admin', role: 'Administrator', email: 'admin@example.test' };
    for (const url of ['/bookings', '/court-configuration']) {
        const handler = admin.stack.find(layer => layer.route?.path === url && layer.route.methods.get).route.stack[0].handle;
        let view;
        let data;
        const before = [sportQuery.mock.callCount(), resourceQuery.mock.callCount(), bookingQuery.mock.callCount()];
        await handler({ path: url, query: {} }, {
            render(name, values) { view = name; data = values; },
            sendStatus(status) { assert.fail(`Unexpected HTTP ${status}`); }
        });
        const configuring = url === '/court-configuration';
        assert.equal(data.activePage, configuring ? 'court-configuration' : 'bookings');
        assert.equal(sportQuery.mock.callCount() - before[0], configuring ? 1 : 0);
        assert.equal(resourceQuery.mock.callCount() - before[1], configuring ? 1 : 0);
        assert.equal(bookingQuery.mock.callCount() - before[2], configuring ? 0 : 1);
        const html = await ejs.renderFile(path.join(__dirname, `../views/${view}.ejs`), {
            ...data, currentProfile: profile, isAdmin: true, area: 'admin',
            canSwitchRole: false, viewingAs: null, switchableRoles: []
        });
        assert.match(html, /href="\/admin\/court-configuration"/);
        if (configuring) {
            assert.match(html, /<h1[^>]*>Court configuration<\/h1>/);
            assert.match(html, /action="\/admin\/bookings\/resources"/);
            assert.match(html, /action="\/admin\/bookings\/options"/);
            assert.match(html, /action="\/admin\/bookings\/sports\/months"/);
            assert.doesNotMatch(html, /<(?:div|form)[^>]*\s(?:data-booking-calendar|data-booking-form|data-cancel-booking|data-calendar-slots)(?:\s|>)/);
        } else {
            assert.match(html, /<h1[^>]*>Bookings management<\/h1>/);
            assert.match(html, /data-booking-calendar/);
            assert.match(html, /action="\/admin\/bookings\/create-batch"/);
            assert.doesNotMatch(html, /action="\/admin\/bookings\/(?:resources|options|sports\/months)/);
        }
    }
});

test('stale court-month forms redirect to sport settings without changing availability', () => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings/options/months').route.stack[0].handle;
    let destination;
    handler({ body: { facility_guid: GUID, option_guid: GUID, allowed_months: ['1'] } }, {
        redirect(location) { destination = location; }
    });
    assert.equal(destination, '/admin/court-configuration?error=sport-months-moved');
});

test('booking months accept an empty season or normalized valid month selections', () => {
    assert.deepEqual(parseBookingMonths(undefined), []);
    assert.deepEqual(parseBookingMonths([]), []);
    assert.deepEqual(parseBookingMonths('12'), [12]);
    assert.deepEqual(parseBookingMonths(['12', '1', '1']), [1, 12]);
    for (const input of [null, 1, {}, ['0'], ['13'], ['01'], ['1.5'], [' 1'], ['1', null], Array(13).fill('1')]) {
        assert.equal(parseBookingMonths(input), null);
    }
});

test('administrator saves sport months for a site and audits the selection', async t => {
    const update = t.mock.method(Bookings, 'updateSportMonths', async () => true);
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings/sports/months').route.stack[0].handle;
    async function submit(body) {
        let result;
        await handler({ body, profile: { guid: GUID, name: 'Admin' } }, {
            redirect(location) { result = location; },
            sendStatus(status) { result = status; }
        });
        return result;
    }
    assert.equal(await submit({ facility_guid: GUID, sport_guid: GUID, allowed_months: ['1', '7'] }), '/admin/court-configuration');
    assert.deepEqual(update.mock.calls[0].arguments, [GUID, GUID, [1, 7]]);
    assert.deepEqual(audit.mock.calls[0].arguments[1].details.allowed_months, [1, 7]);
    assert.equal(await submit({ facility_guid: GUID, sport_guid: GUID }), '/admin/court-configuration');
    assert.deepEqual(update.mock.calls[1].arguments, [GUID, GUID, []]);
    assert.equal(await submit({ facility_guid: GUID, sport_guid: GUID, allowed_months: '13' }), 400);
    assert.equal(await submit({ facility_guid: 'invalid', sport_guid: GUID }), 400);
    assert.equal(await submit({ facility_guid: GUID, sport_guid: 'invalid' }), 400);
    update.mock.mockImplementation(async () => false);
    assert.equal(await submit({ facility_guid: GUID, sport_guid: GUID, allowed_months: '1' }), 404);
});

test('creating a court does not override the site sport season', async t => {
    const create = t.mock.method(Bookings, 'createOption', async () => ({ guid: GUID }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/bookings/options').route.stack[0].handle;
    const body = { facility_guid: GUID, sport_guid: GUID, name: 'Seasonal court', resource_guids: [GUID] };
    async function submit(months) {
        let result;
        await handler({ body: { ...body, allowed_months: months } }, {
            redirect(location) { result = location; },
            sendStatus(status) { result = status; }
        });
        return result;
    }
    assert.equal(await submit(['9', '4', '4']), '/admin/court-configuration');
    assert.equal(create.mock.calls[0].arguments[0].allowed_months, undefined);
    assert.equal(await submit(undefined), '/admin/court-configuration');
    assert.equal(create.mock.calls[1].arguments[0].allowed_months, undefined);
    assert.equal(create.mock.callCount(), 2);
});
