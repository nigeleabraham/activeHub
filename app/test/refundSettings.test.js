const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Settings = require('../models/Settings');
const Credits = require('../models/Credits');
const Bookings = require('../models/Bookings');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');
const ejs = require('ejs');
const path = require('node:path');

const GUID = '123e4567-e89b-42d3-a456-426614174000';
const admin = router.stack.find(layer => layer.handle.stack).handle;
const adminHandler = route => admin.stack.find(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;

function database(t, enabled) {
    const calls = [];
    const client = {
        async query(sql) {
            calls.push(sql);
            if (sql.includes("key = 'refunds_enabled'")) return { rows: [{ value: enabled }], rowCount: 1 };
            if (sql.includes('SELECT c.profile_guid')) return { rows: [{ profile_guid: GUID }], rowCount: 1 };
            if (sql.includes('SELECT r.credit_guid')) return { rows: [{ credit_guid: GUID, remaining_pence: 600, booking_ref: 'AH-TEST' }], rowCount: 1 };
            if (sql.includes('INSERT INTO credit_refund_requests')) return { rows: [{ guid: GUID, requested_pence: 600 }], rowCount: 1 };
            return { rows: [{ guid: GUID }], rowCount: 1 };
        },
        release() {}
    };
    t.mock.method(Pool.prototype, 'connect', async () => client);
    return calls;
}

test('master refunds default on, reject corrupt values and lock the persisted setting during refunds', async t => {
    assert.equal(Settings.refundsEnabled(Settings.DEFAULTS), true);
    assert.equal(Settings.refundsEnabled({ refunds_enabled: '0' }), false);
    assert.throws(() => Settings.refundsEnabled({ refunds_enabled: 'false' }), /Invalid configured/);
    const calls = database(t, '1');
    assert.ok(await Credits.requestRefund(GUID, GUID));
    assert.ok(await Credits.decideRefund(GUID, true, 'Admin'));
    assert.equal(await Bookings.cancelWithExternalRefund(GUID, GUID, 600, 'Admin'), true);
    assert.equal(calls.filter(sql => sql.includes("key = 'refunds_enabled' FOR SHARE")).length, 3);
    assert.equal(calls.filter(sql => sql === 'COMMIT').length, 3);
});

test('disabled refunds block all three model entry points before any balance or booking mutations', async t => {
    const calls = database(t, '0');
    for (const action of [
        () => Credits.requestRefund(GUID, GUID),
        () => Credits.decideRefund(GUID, true, 'Admin'),
        () => Bookings.cancelWithExternalRefund(GUID, GUID, 600, 'Admin')
    ]) await assert.rejects(action(), { code: 'REFUNDS_DISABLED' });
    assert.equal(calls.filter(sql => sql === 'ROLLBACK').length, 3);
    assert.ok(calls.every(sql => ['BEGIN', 'ROLLBACK'].includes(sql) || sql.includes("key = 'refunds_enabled'")));
    calls.length = 0;
    await assert.rejects(Credits.decideRefund(GUID, false, 'Admin', 'Bank transfer not available'), /cannot be declined/);
    assert.equal(calls.length, 0);
});

test('settings save validates, persists and audits both master-switch states', async t => {
    const save = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const handler = adminHandler('/settings/refunds');
    const res = { status(code) { this.code = code; return this; }, send() {}, redirect(url) { this.url = url; } };
    for (const enabled of [undefined, 'yes', ['0'], '']) {
        await handler({ body: { enabled } }, res);
        assert.equal(res.code, 400);
    }
    assert.equal(save.mock.callCount(), 0);
    for (const enabled of ['0', '1']) {
        await handler({ body: { enabled }, profile: { guid: GUID, name: 'Admin' } }, res);
        assert.deepEqual(save.mock.calls.at(-1).arguments, ['refunds_enabled', enabled]);
        assert.equal(audit.mock.calls.at(-1).arguments[1].action, 'settings.refunds_enabled');
        assert.equal(audit.mock.calls.at(-1).arguments[1].details.enabled, enabled === '1');
        assert.equal(res.url, '/admin/settings?saved=1');
    }
});

test('stale or direct refund submissions return explicit 403 and never report success', async t => {
    database(t, '0');
    t.mock.method(Bookings, 'findBooking', async () => ({ amount_paid_pence: 1000, credit_applied_pence: 0 }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const resident = router.stack.find(layer => Array.isArray(layer.route?.path) &&
        layer.route.path.includes('/profile/credit-refunds')).route.stack[0].handle;
    for (const [handler, body] of [
        [resident, { credit_guid: GUID }],
        [adminHandler('/credit-refunds/decide'), { request_guid: GUID, decision: 'approve' }],
        [adminHandler('/refunds/refund'), { facility_guid: GUID, booking_guid: GUID, method: 'external' }]
    ]) {
        const res = { status(code) { this.code = code; return this; }, send(message) { this.message = message; } };
        await handler({ body, profile: { guid: GUID, name: 'Admin' } }, res);
        assert.equal(res.code, 403);
        assert.match(res.message, /disabled system-wide/);
    }
    assert.equal(audit.mock.callCount(), 0);
});

test('disabled refund queue keeps requests visible but blocks completion and has no decline controls', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/credit-refunds.ejs'), {
        refundsEnabled: false, currentProfile: null, isAdmin: false, canSwitchRole: false,
        activePage: 'credit-refunds', decision: '', declineError: false, error: false,
        requests: [{ guid: GUID, status: 'pending', remaining_pence: 600, requested_pence: 1000,
            profile_name: 'Resident', profile_email: 'resident@example.test', facility_name: 'Hall' }],
        history: { entries: [], total: 0, pageSize: 50 }, filters: { from: '', to: '' }, searched: false, page: 1
    });
    assert.match(html, /disabled system-wide/);
    assert.match(html, /value="approve" disabled/);
    assert.doesNotMatch(html, /value="decline"|name="decline_comment"/);
    assert.match(html, /1 awaiting action/);
    assert.match(html, /Search history/);
});
