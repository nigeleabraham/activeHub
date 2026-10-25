const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const AuditLog = require('../models/AuditLog');

test('audit purge runs immediately and schedules an unreferenced six-hour interval', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rowCount: 2 }));
    const log = t.mock.method(console, 'log', () => {});
    let scheduled;
    let unreferenced = false;
    t.mock.method(global, 'setInterval', (callback, delay) => {
        scheduled = callback;
        assert.equal(delay, 6 * 60 * 60 * 1000);
        return { unref() { unreferenced = true; } };
    });
    AuditLog.startPurgeSchedule();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(query.mock.callCount(), 1);
    assert.equal(log.mock.callCount(), 1);
    assert.equal(unreferenced, true);
    await scheduled();
    assert.equal(query.mock.callCount(), 2);
});

test('audit purge logs database failures without rejecting', async t => {
    const error = new Error('Database unavailable');
    t.mock.method(Pool.prototype, 'query', async () => { throw error; });
    const log = t.mock.method(console, 'error', () => {});
    let scheduled;
    t.mock.method(global, 'setInterval', callback => {
        scheduled = callback;
        return { unref() {} };
    });
    AuditLog.startPurgeSchedule();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(log.mock.calls[0].arguments, ['Audit purge failed:', error]);
    await assert.doesNotReject(scheduled);
    assert.equal(log.mock.callCount(), 2);
});
