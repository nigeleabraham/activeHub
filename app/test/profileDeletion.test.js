const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Profiles = require('../models/Profiles');

test('profile deletion rolls back all cleanup and releases its connection on failure', async t => {
    const queries = [];
    let released = false;
    const failure = new Error('Cannot remove future bookings');
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, params) {
            queries.push({ sql, params });
            if (sql.startsWith('DELETE FROM bookings')) throw failure;
            if (sql.includes("role = 'Administrator'")) return { rows: [{ guid: 'admin' }] };
            return { rowCount: 1, rows: [{ guid: 'profile' }] };
        },
        release() { released = true; }
    }));
    await assert.rejects(Profiles.remove('profile', 'Admin'), error => error === failure);
    assert.equal(queries[0].sql, 'BEGIN');
    assert.ok(queries.some(query => query.sql.includes("status = 'cancelled'")));
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
    assert.equal(queries.some(query => query.sql === 'COMMIT'), false);
    assert.equal(released, true);
});
