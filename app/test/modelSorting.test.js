const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Bookings = require('../models/Bookings');
const Profiles = require('../models/Profiles');

test('booking transactions lock distinct profiles in consistent UUID order', async t => {
    const locked = [];
    const stop = new Error('Stop before inserting bookings');
    let released = false;
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, params) {
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
            if (sql === 'SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE') {
                locked.push(params[0]);
                return { rowCount: 1, rows: [{ guid: params[0] }] };
            }
            throw stop;
        },
        release() { released = true; }
    }));
    const first = '00000000-0000-4000-8000-000000000001';
    const second = 'a0000000-0000-4000-8000-000000000001';
    await assert.rejects(Bookings.createBookings([second, first, second].map(profile_guid => ({ profile_guid }))),
        error => error === stop);
    assert.deepEqual(locked, [first, second]);
    assert.equal(released, true);
});

test('profile saves deduplicate roles and retain alphabetical ordering', async t => {
    let savedRoles;
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, params) {
            if (sql.startsWith('INSERT INTO profiles ')) {
                return { rows: [{ guid: 'profile', name: 'Test', email: 'test@example.test', role: 'Resident' }] };
            }
            if (sql.startsWith('INSERT INTO profile_roles ')) savedRoles = params[1];
            return { rows: [] };
        },
        release() {}
    }));
    const profile = await Profiles.create({
        name: 'Test', email: 'test@example.test', roles: ['Resident', 'Coach', 'Administrator', 'Coach']
    });
    assert.deepEqual(savedRoles, ['Administrator', 'Coach', 'Resident']);
    assert.deepEqual(profile.roles, savedRoles);
});
