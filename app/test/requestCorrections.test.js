const test = require('node:test');
const assert = require('node:assert/strict');
const Bookings = require('../models/Bookings');
const Credits = require('../models/Credits');
const AuditLog = require('../models/AuditLog');
const auth = require('../middleware/auth');
const router = require('../routes/front');
const GUID = '123e4567-e89b-42d3-a456-426614174000';
const admin = router.stack.find(layer => layer.handle.stack).handle;
const handler = path => admin.stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack[0].handle;

test('all correction endpoints remain Administrator-only', () => {
    for (const path of ['/credit-requests/reopen', '/credit-refunds/reopen', '/credit-requests/refundability']) {
        assert.equal(auth.canAccessAdmin({ role: 'Administrator' }, path), true);
        for (const role of ['Resident', 'Coach', 'Receptionist']) {
            assert.equal(auth.canAccessAdmin({ role, permissions: ['manage_bookings', 'manage_facilities'] }, path), false);
        }
    }
});

test('corrections validate, audit and preserve bounded history filters on the fixed destination', async t => {
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    for (const [route, model, method, extra, expected] of [
        ['/credit-requests/reopen', Bookings, 'reopenCreditRequest', {}, [GUID]],
        ['/credit-refunds/reopen', Credits, 'reopenRefund', {}, [GUID]],
        ['/credit-requests/refundability', Credits, 'changeRequestRefundability', { refundable: '0' }, [GUID, false]]
    ]) {
        const change = t.mock.method(model, method, async () => ({ booking_ref: 'AH-TEST', booking_guid: GUID, credit_guid: GUID, changed_pence: 400 }));
        const response = { status(code) { this.code = code; return this; }, send() {}, sendStatus(code) { this.code = code; }, redirect(url) { this.url = url; } };
        await handler(route)({ body: { request_guid: 'bad', ...extra } }, response);
        assert.equal(response.code, 400);
        assert.equal(change.mock.callCount(), 0);
        await handler(route)({ profile: { guid: GUID }, body: {
            request_guid: GUID, ...extra, from: '2026-11-01', to: '2026-11-05', page: '2', profile: GUID, return_to: '//evil.test'
        } }, response);
        assert.deepEqual(change.mock.calls[0].arguments, expected);
        const url = new URL(response.url, 'https://activehub.test');
        assert.equal(url.origin, 'https://activehub.test');
        assert.equal(url.pathname, route.startsWith('/credit-refunds') ? '/admin/credit-refunds' : '/admin/credit-requests');
        assert.equal(url.searchParams.get('profile'), GUID);
        assert.equal(url.searchParams.get('page'), '2');
        assert.equal(url.searchParams.get('corrected'), '1');
        assert.ok(audit.mock.calls.at(-1).arguments[1].action);
        change.mock.mockImplementation(async () => { const error = new Error('Pending refund blocks change'); error.code = 'CREDIT_CORRECTION_CONFLICT'; throw error; });
        await handler(route)({ body: { request_guid: GUID, ...extra } }, response);
        assert.equal(response.code, 409);
    }
});
