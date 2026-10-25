const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBookingMonths } = require('../validation');
const Bookings = require('../models/Bookings');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('stale court-month forms redirect to sport settings without changing availability', () => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/bookings/options/months').route.stack[0].handle;
    let destination;
    handler({ body: { facility_guid: GUID, option_guid: GUID, allowed_months: ['1'] } }, {
        redirect(location) { destination = location; }
    });
    assert.equal(destination, '/admin/bookings?error=sport-months-moved');
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
    assert.equal(await submit({ facility_guid: GUID, sport_guid: GUID, allowed_months: ['1', '7'] }), '/admin/bookings');
    assert.deepEqual(update.mock.calls[0].arguments, [GUID, GUID, [1, 7]]);
    assert.deepEqual(audit.mock.calls[0].arguments[1].details.allowed_months, [1, 7]);
    assert.equal(await submit({ facility_guid: GUID, sport_guid: GUID }), '/admin/bookings');
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
    assert.equal(await submit(['9', '4', '4']), '/admin/bookings');
    assert.equal(create.mock.calls[0].arguments[0].allowed_months, undefined);
    assert.equal(await submit(undefined), '/admin/bookings');
    assert.equal(create.mock.calls[1].arguments[0].allowed_months, undefined);
    assert.equal(create.mock.callCount(), 2);
});
