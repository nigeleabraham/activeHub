const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.BASKET_TEST_DATABASE_URL;

test('mixed court and course checkout (PostgreSQL)', { skip: !databaseUrl }, async t => {
    assert.ok(new URL(databaseUrl).pathname.endsWith('_test'), 'Use a dedicated database ending in _test');
    process.env.DATABASE_URL = databaseUrl;
    const pools = new Set();
    const connect = Pool.prototype.connect;
    t.mock.method(Pool.prototype, 'connect', function (...args) {
        pools.add(this);
        return connect.apply(this, args);
    });
    t.after(async () => Promise.all([...pools].map(pool => pool.end())));
    const db = new Pool({ connectionString: databaseUrl });
    for (const name of ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings', 'CourseOrders']) {
        await require(`../models/${name}`).initialize();
    }
    const Basket = require('../models/CourseOrders');
    const Bookings = require('../models/Bookings');
    const OpeningHours = require('../models/OpeningHours');
    const { rows: [facility] } = await db.query(`INSERT INTO facilities
        (name, address, postcode, latitude, longitude, google_maps_url, description, max_resident_bookings)
        VALUES ('Basket test park', 'Test road', 'AB1 2CD', 0, 0, '', '', 3) RETURNING *`);
    const { rows: [sport] } = await db.query('SELECT guid FROM sports LIMIT 1');
    await db.query('INSERT INTO facility_sports (facility_guid, sport_guid) VALUES ($1, $2)', [facility.guid, sport.guid]);
    const resource = await Bookings.createResource(facility.guid, 'Basket test court');
    const option = await Bookings.createOption({
        facility_guid: facility.guid, sport_guid: sport.guid, name: 'Tennis', price_pence: 500,
        resource_guids: [resource.guid]
    });
    const { rows: [course] } = await db.query("INSERT INTO courses (name) VALUES ('Swimming') RETURNING guid");
    const { rows: [run] } = await db.query(`INSERT INTO course_runs
        (course_guid, facility_guid, name, full_price_pence, capacity, published)
        VALUES ($1, $2, 'Tuesday', 1000, 20, true) RETURNING guid`, [course.guid, facility.guid]);
    await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
        VALUES ($1, now() + interval '2 days', now() + interval '2 days 1 hour')`, [run.guid]);
    async function person() {
        const { rows: [profile] } = await db.query(`INSERT INTO profiles (name, email, role)
            VALUES ('Basket resident', $1, 'Resident') RETURNING guid`, [`${crypto.randomUUID()}@example.test`]);
        return profile.guid;
    }
    let offset = 0;
    function slot() {
        const start = new Date();
        start.setUTCDate(start.getUTCDate() + 2);
        start.setUTCHours(8 + offset++, 0, 0, 0);
        return { option_guid: option.guid, starts_at: start.toISOString(),
            ends_at: new Date(start.getTime() + 3600000).toISOString() };
    }
    async function checkout(owner, current = null) {
        current ||= await Basket.basket(owner);
        return Basket.pay(owner, current.revision, { total: current.total, credit: current.credit }, 'SIM-TEST');
    }
    async function count(table, owner) {
        const { rows: [row] } = await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE profile_guid = $1`, [owner]);
        return row.count;
    }

    await t.test('mixed order, shared credit, duplicate submissions and immutable confirmation', async () => {
        const owner = await person();
        await db.query(`INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence)
            VALUES ($1, 'Credit source', 1200, 1200)`, [owner]);
        await db.query('UPDATE profiles SET credit_pence = 1200 WHERE guid = $1', [owner]);
        const selected = slot();
        await Basket.addCourts(owner, [selected]);
        await Basket.addCourts(owner, [selected]);
        await Basket.add(owner, run.guid, 'self', '/courses');
        const current = await Basket.basket(owner);
        assert.equal(current.items.length, 2);
        assert.equal(await Basket.itemCount(owner), 2);
        assert.equal(current.total, 1500);
        assert.equal(current.credit, 1200);
        assert.equal(current.due, 300);
        assert.equal(current.valid, true);
        const [order, repeated] = await Promise.all([checkout(owner, current), checkout(owner, current)]);
        assert.equal(order.guid, repeated.guid);
        assert.equal(await count('bookings', owner), 1);
        assert.equal(await count('course_enrolments', owner), 1);
        assert.equal(await Basket.itemCount(owner), 0);
        const { rows: [spent] } = await db.query(`SELECT sum(amount_pence)::int AS pence FROM credit_spending
            WHERE credit_guid IN (SELECT guid FROM credits WHERE profile_guid = $1)`, [owner]);
        assert.equal(spent.pence, 1200);
        const confirmation = await Basket.order(owner, order.guid);
        assert.equal(confirmation.items.length, 2);
        assert.equal(await Basket.order(await person(), order.guid), null);
        await db.query('DELETE FROM booking_reservations WHERE booking_guid IN (SELECT guid FROM bookings WHERE profile_guid = $1)', [owner]);
        await db.query('DELETE FROM bookings WHERE profile_guid = $1', [owner]);
        assert.equal((await Basket.order(owner, order.guid)).items.length, 2);
    });

    await t.test('prices and lost availability reject the whole order without spending credit', async () => {
        const owner = await person();
        const competitor = await person();
        const selected = slot();
        await Basket.addCourts(owner, [selected]);
        await Basket.add(owner, run.guid, 'self', '/courses');
        const current = await Basket.basket(owner);
        await db.query('UPDATE bookable_options SET price_pence = 600 WHERE guid = $1', [option.guid]);
        await assert.rejects(checkout(owner, current), /prices, availability or credit changed/);
        assert.equal(await count('course_orders', owner), 0);
        await db.query('UPDATE bookable_options SET price_pence = 500 WHERE guid = $1', [option.guid]);
        await Bookings.createBooking({ ...selected, facility_guid: facility.guid, profile_guid: competitor });
        assert.equal((await Basket.basket(owner)).valid, false);
        await assert.rejects(checkout(owner, current), /prices, availability or credit changed/);
        assert.equal(await count('course_enrolments', owner), 0);
        assert.equal(await count('bookings', owner), 0);
        assert.equal(await Basket.itemCount(owner), 2);
    });

    await t.test('failed court reservation rolls back course enrolment, order and credit', async () => {
        const owner = await person();
        await Basket.add(owner, run.guid, 'self', '/courses');
        await Basket.addCourts(owner, [slot()]);
        await db.query(`INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence)
            VALUES ($1, 'Credit source', 1500, 1500)`, [owner]);
        await db.query('UPDATE profiles SET credit_pence = 1500 WHERE guid = $1', [owner]);
        const insert = t.mock.method(Bookings, 'insertBooking', async () => {
            const error = new Error('Concurrent reservation');
            error.code = '23P01';
            throw error;
        });
        try {
            await assert.rejects(checkout(owner), /Concurrent reservation/);
            assert.equal(await count('course_orders', owner), 0);
            assert.equal(await count('course_enrolments', owner), 0);
            const { rows: [credit] } = await db.query('SELECT remaining_pence FROM credits WHERE profile_guid = $1', [owner]);
            assert.equal(credit.remaining_pence, 1500);
            assert.equal(await Basket.itemCount(owner), 2);
        } finally {
            insert.mock.restore();
        }
    });

    await t.test('simultaneous purchases cannot double-book a court or partly enrol the losing basket', async () => {
        const owners = [await person(), await person()];
        const selected = slot();
        for (const owner of owners) {
            await Basket.addCourts(owner, [selected]);
            await Basket.add(owner, run.guid, 'self', '/courses');
        }
        const quoted = await Promise.all(owners.map(owner => Basket.basket(owner)));
        const results = await Promise.allSettled(owners.map((owner, index) => checkout(owner, quoted[index])));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);
        const loser = owners[results.findIndex(result => result.status === 'rejected')];
        assert.equal(await count('course_orders', loser), 0);
        assert.equal(await count('course_enrolments', loser), 0);
        assert.equal(await count('bookings', loser), 0);
        assert.equal(await Basket.itemCount(loser), 2);
    });

    await t.test('limits, overlaps, stale dates, months, opening hours and ownership', async () => {
        const owner = await person();
        const selected = slot();
        const another = { ...selected, ends_at: new Date(Date.parse(selected.ends_at) + 3600000).toISOString() };
        await assert.rejects(Basket.addCourts(owner, [selected, another]), /conflicts/);
        assert.equal(await Basket.itemCount(owner), 0);
        await db.query('UPDATE facilities SET max_resident_bookings = 0 WHERE guid = $1', [facility.guid]);
        await assert.rejects(Basket.addCourts(owner, [selected]), /booking limit/);
        await Basket.addCourts(owner, [selected], 'Administrator');
        assert.equal((await Basket.basket(owner, 'Resident')).valid, false);
        assert.equal((await Basket.basket(owner, 'Administrator')).valid, true);
        const current = await Basket.basket(owner, 'Administrator');
        await assert.rejects(checkout(owner, current), /prices, availability or credit changed/);
        const item = current.items[0];
        await Basket.remove(await person(), item.guid);
        assert.equal(await Basket.itemCount(owner), 1);
        await Basket.remove(owner, item.guid);
        assert.equal(await Basket.itemCount(owner), 0);
        await db.query('UPDATE facilities SET max_resident_bookings = 3 WHERE guid = $1', [facility.guid]);
        await assert.rejects(Basket.addCourts(owner, [{ ...selected, starts_at: '2000-01-01', ends_at: '2000-01-02' }]), /future/);
        await db.query('UPDATE facility_sports SET allowed_months = ARRAY[]::int[] WHERE facility_guid = $1', [facility.guid]);
        await assert.rejects(Basket.addCourts(owner, [selected]), /selected month/);
        await db.query('UPDATE facility_sports SET allowed_months = ARRAY[1,2,3,4,5,6,7,8,9,10,11,12] WHERE facility_guid = $1', [facility.guid]);
        const opening = t.mock.method(OpeningHours, 'isBookingWithinHours', async () => false);
        try {
            await assert.rejects(Basket.addCourts(owner, [selected]), /outside opening hours/);
        } finally {
            opening.mock.restore();
        }
    });
});
