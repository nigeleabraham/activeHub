const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const databaseUrl = process.env.ROLE_TEST_DATABASE_URL;

test('role deletion preserves archived assignments and optional seed decisions', { skip: !databaseUrl }, async t => {
    assert.ok(new URL(databaseUrl).pathname.endsWith('_test'), 'Use a dedicated database whose name ends in _test');
    process.env.DATABASE_URL = databaseUrl;
    const pools = new Set();
    const connect = Pool.prototype.connect;
    t.mock.method(Pool.prototype, 'connect', function (...args) {
        pools.add(this);
        return connect.apply(this, args);
    });
    t.after(async () => Promise.all([...pools].map(pool => pool.end())));

    const db = new Pool({ connectionString: databaseUrl });
    const Roles = require('../models/Roles');
    const Profiles = require('../models/Profiles');
    await require('../models/Facilities').initialize();
    await Roles.initialize();
    await Profiles.initialize();

    const coach = (await Roles.findAll()).find(role => role.name === 'Coach');
    const coachProfile = (await db.query("SELECT guid FROM profiles WHERE role = 'Coach'")).rows[0];
    assert.equal(coach.member_count, 1);
    await assert.rejects(Roles.remove(coach.guid), { code: 'ROLE_IN_USE' });
    assert.ok(await Roles.findByGuid(coach.guid));

    const additional = await Profiles.create({ name: 'Additional coach', email: 'additional@example.test', roles: ['Coach'] });
    await db.query('UPDATE profiles SET deleted_at = now() WHERE guid = ANY($1::uuid[])', [[coachProfile.guid, additional.guid]]);
    assert.equal((await Roles.findByGuid(coach.guid)).member_count, 0);
    assert.equal(await Roles.remove(coach.guid), true);
    assert.equal(await Roles.findByGuid(coach.guid), null);
    const archived = (await db.query(
        'SELECT profile_guid, role, was_default FROM deleted_profile_roles WHERE role = $1 ORDER BY was_default DESC', ['Coach']
    )).rows;
    assert.deepEqual(archived.map(row => [row.profile_guid, row.was_default]), [
        [coachProfile.guid, true], [additional.guid, false]
    ]);
    assert.equal((await db.query('SELECT role FROM profiles WHERE guid = $1', [coachProfile.guid])).rows[0].role, 'Resident');
    assert.equal((await db.query("SELECT 1 FROM profile_roles WHERE role = 'Coach'")).rowCount, 0);

    await Roles.initialize();
    await Profiles.initialize();
    assert.equal((await Roles.findAll()).some(role => role.name === 'Coach'), false);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM deleted_profile_roles')).rows[0].count, 2);

    const leader = (await Roles.findAll()).find(role => role.name === 'Course leader');
    await Roles.update(leader.guid, { name: 'Renamed leader', description: null, permissions: [] });
    await Roles.initialize();
    assert.equal((await Roles.findAll()).some(role => role.name === 'Course leader'), false);
    assert.ok((await Roles.findAll()).some(role => role.name === 'Renamed leader'));

    const recreated = await Roles.create({ name: 'Coach', description: null, permissions: [] });
    await Roles.initialize();
    assert.ok(await Roles.findByGuid(recreated.guid));
    assert.equal(await Roles.remove(recreated.guid), true);
    await Roles.initialize();
    assert.equal((await Roles.findAll()).some(role => role.name === 'Coach'), false);
    const resident = (await Roles.findAll()).find(role => role.name === 'Resident');
    assert.equal(await Roles.remove(resident.guid), false);
});
