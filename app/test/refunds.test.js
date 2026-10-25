const test = require('node:test');
const assert = require('node:assert/strict');
const Bookings = require('../models/Bookings');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

const admin = router.stack.find(layer => layer.handle.stack).handle;
const refund = admin.stack.find(layer => layer.route?.path === '/refunds/refund').route.stack[0].handle;
const GUID = '123e4567-e89b-42d3-a456-426614174000';
const booking = {
    profile_guid: GUID,
    booking_ref: 'AH-123',
    amount_paid_pence: 1000,
    credit_applied_pence: 200
};

async function redirectFor(returnTo, method = 'credit') {
    let location;
    await refund({
        body: { facility_guid: GUID, booking_guid: GUID, method, return_to: returnTo },
        profile: { name: 'Administrator' }
    }, {
        redirect(value) { location = value; },
        sendStatus(code) { assert.fail(`Unexpected status ${code}`); }
    });
    assert.ok(location);
    const url = new URL(location, 'https://activehub.test');
    assert.equal(url.origin, 'https://activehub.test');
    assert.equal(url.pathname, '/admin/refunds');
    assert.equal(url.hash, '');
    return url.searchParams;
}

test('all seven refund outcomes redirect to the fixed refunds page with search filters', async t => {
    t.mock.method(AuditLog, 'record', async () => {});
    const scenarios = [
        { method: 'credit', found: null, expected: { error: 'not-found' } },
        { method: 'external', found: { ...booking, credited_at: new Date() }, expected: { error: 'not-refundable' } },
        { method: 'external', found: booking, cancelled: false, expected: { error: 'not-found' } },
        { method: 'external', found: booking, cancelled: true, expected: { done: 'external', ref: 'AH-123', amount: '\u00a38.00' } },
        { method: 'credit', found: { ...booking, credited_at: new Date() }, expected: { error: 'not-refundable' } },
        { method: 'credit', found: booking, credited: 0, expected: { error: 'not-refundable' } },
        { method: 'credit', found: booking, credited: 1000, expected: { done: 'credit', ref: 'AH-123', amount: '\u00a310.00' } }
    ];
    for (const scenario of scenarios) {
        t.mock.method(Bookings, 'findBooking', async () => scenario.found);
        t.mock.method(Bookings, 'cancelWithExternalRefund', async () => scenario.cancelled);
        t.mock.method(Bookings, 'addCreditToBooking', async () => scenario.credited);
        const filters = { reference: 'AH-123', profile: 'Person & Co', location: 'Hall', from: '2026-10-01', to: '2026-10-31' };
        const query = await redirectFor(`/admin/refunds?${new URLSearchParams({ ...filters, done: 'stale', error: 'stale' })}#results`, scenario.method);
        assert.deepEqual(Object.fromEntries(query), { ...filters, ...scenario.expected });
    }
});

test('untrusted return destinations cannot change the redirect origin or path', async t => {
    t.mock.method(Bookings, 'findBooking', async () => null);
    for (const returnTo of [
        undefined, ['//evil.test'], 'https://evil.test', '//evil.test', '/\\evil.test',
        '/admin/refunds/../elsewhere', '/admin/refunds?next=https://evil.test',
        '/admin/refunds?profile=%0D%0ALocation%3A%20https%3A%2F%2Fevil.test',
        '/admin/refunds?location=%2F%2Fevil.test%23fragment'
    ]) {
        const query = await redirectFor(returnTo);
        assert.equal(query.get('error'), 'not-found');
        assert.equal(query.has('next'), false);
    }
});
