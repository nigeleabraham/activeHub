const test = require('node:test');
const assert = require('node:assert/strict');
const Settings = require('../models/Settings');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

test('organisation name defaults to Peckem and saves validated, normalized names', async t => {
    assert.equal(Settings.DEFAULTS.organisation_name, "Peck'em");
    t.mock.method(Settings, 'getAll', async () => ({ organisation_name: "Peck'em" }));
    const save = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/settings/organisation').route.stack[0].handle;
    for (const name of [undefined, [], '', '   ', 'x'.repeat(61), '  Example   Council  ']) {
        let location;
        await handler({ body: { organisation_name: name }, profile: { name: 'Admin' } }, {
            redirect(value) { location = value; }
        });
        assert.equal(location, name === '  Example   Council  ' ? '/admin/settings?saved=1' : '/admin/settings?error=organisation');
    }
    assert.deepEqual(save.mock.calls.map(call => call.arguments), [['organisation_name', 'Example Council']]);
    assert.deepEqual(audit.mock.calls[0].arguments[1].details, { from: "Peck'em", to: 'Example Council' });
});

test('credit lifetime accepts bounded whole days and defaults to 365', () => {
    for (const value of [undefined, null, [], '', '0', '-1', '36501', '1.5', '1e2', ' 7 ']) {
        assert.equal(Settings.parseCreditLifetimeDays(value), null);
    }
    for (const value of ['1', '30', '365', '730', '36500']) {
        assert.equal(Settings.parseCreditLifetimeDays(value), Number(value));
    }
    assert.equal(Settings.DEFAULTS.credit_lifetime_days, '365');
});

test('credit lifetime setting saves only valid days and audits the change', async t => {
    t.mock.method(Settings, 'getAll', async () => ({ credit_lifetime_days: '365' }));
    const save = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/settings/credit-lifetime').route.stack[0].handle;
    for (const days of ['0', '36501', '1.5', '730']) {
        let location;
        await handler({ body: { days }, profile: { name: 'Admin' } }, {
            redirect(value) { location = value; }
        });
        assert.equal(location, days === '730' ? '/admin/settings?saved=1' : '/admin/settings?error=lifetime');
    }
    assert.equal(save.mock.callCount(), 1);
    assert.deepEqual(save.mock.calls[0].arguments, ['credit_lifetime_days', '730']);
    assert.deepEqual(audit.mock.calls[0].arguments[1].details, { from: '365', to: 730 });
});

test('credit request period accepts whole days from 1 to 365 only', () => {
    for (const value of [undefined, null, [], '', '0', '-1', '366', '1.5', '1e2', ' 7 ']) {
        assert.equal(Settings.parseCreditRequestDays(value), null);
    }
    for (const days of ['1', '7', '30', '365']) {
        assert.equal(Settings.parseCreditRequestDays(days), Number(days));
    }
    assert.equal(Settings.DEFAULTS.credit_request_days, '30');
});

test('administrator saves a validated period and records the change', async t => {
    t.mock.method(Settings, 'getCreditRequestDays', async () => 30);
    const save = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/settings/credit-request-period').route.stack[0].handle;
    for (const days of ['0', '366', '1.5', '7']) {
        let location;
        await handler({ body: { days }, profile: { name: 'Admin' } }, {
            redirect(value) { location = value; }
        });
        assert.equal(location, days === '7' ? '/admin/settings?window_saved=1' : '/admin/settings?error=days');
    }
    assert.equal(save.mock.callCount(), 1);
    assert.deepEqual(save.mock.calls[0].arguments, ['credit_request_days', '7']);
    assert.deepEqual(audit.mock.calls[0].arguments[1].details, { from: 30, to: 7 });
});
