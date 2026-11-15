const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const databaseUrl = process.env.BASKET_TEST_DATABASE_URL;

test('administrator course bookings without payment (PostgreSQL)', { skip: !databaseUrl }, async t => {
    assert.ok(new URL(databaseUrl).pathname.endsWith('_test'));
    process.env.DATABASE_URL = databaseUrl;
    const pools = new Set();
    const connect = Pool.prototype.connect;
    t.mock.method(Pool.prototype, 'connect', function (...args) { pools.add(this); return connect.apply(this, args); });
    t.after(async () => Promise.all([...pools].map(pool => pool.end())));
    const db = new Pool({ connectionString: databaseUrl });
    for (const name of ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings', 'CourseOrders']) {
        await require(`../models/${name}`).initialize();
    }
    const Orders = require('../models/CourseOrders');
    const Admin = require('../models/CourseBookingAdmin');
    const Credits = require('../models/Credits');
    const { rows: [facility] } = await db.query(`INSERT INTO facilities
        (name, address, postcode, latitude, longitude, google_maps_url, description)
        VALUES ('Manual hall', 'Test', 'AB1 2CD', 0, 0, '', '') RETURNING guid`);
    const { rows: [course] } = await db.query("INSERT INTO courses (name) VALUES ('Manual course') RETURNING guid");
    const { rows: [run] } = await db.query(`INSERT INTO course_runs
        (course_guid, facility_guid, name, capacity, full_price_pence, published)
        VALUES ($1, $2, 'Manual class', 1, 1000, true) RETURNING guid`, [course.guid, facility.guid]);
    await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at) VALUES
        ($1, now() + interval '2 days', now() + interval '2 days 1 hour'),
        ($1, now() + interval '9 days', now() + interval '9 days 1 hour')`, [run.guid]);
    const { rows: [parent] } = await db.query(`INSERT INTO profiles (name, email, role)
        VALUES ('Manual parent', $1, 'Resident') RETURNING guid`, [`${crypto.randomUUID()}@example.test`]);
    const actor = { guid: parent.guid, name: 'Test administrator', role: 'Administrator' };
    const first = await Orders.addFamilyMember(parent.guid, 'First child');
    const second = await Orders.addFamilyMember(parent.guid, 'Second child');
    const third = await Orders.addFamilyMember(parent.guid, 'Third child');
    await db.query(`INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
        VALUES ($1, 'Credit source', 400, 400, true)`, [parent.guid]);
    await db.query('UPDATE profiles SET credit_pence = 400 WHERE guid = $1', [parent.guid]);

    await t.test('credit use is recorded, capacity is consumed and repeated submissions are idempotent', async () => {
        const quote = await Orders.previewManual(parent.guid, first.guid, run.guid);
        assert.equal(quote.amount, 1000);
        assert.equal(quote.availableCredit, 400);
        assert.equal(quote.run.spaces_remaining, 1);
        const token = crypto.randomUUID();
        const expected = { amount: 1000, credit: 400, useCredit: 'yes', confirmFull: false };
        const random = t.mock.method(crypto, 'randomInt', () => 0);
        let order, repeat;
        try {
            [order, repeat] = await Promise.all([
                Orders.createManual(parent.guid, first.guid, run.guid, token, expected, actor),
                Orders.createManual(parent.guid, first.guid, run.guid, token, expected, actor)
            ]);
        } finally {
            random.mock.restore();
        }
        assert.equal(order.guid, repeat.guid);
        const saved = await Orders.order(parent.guid, order.guid);
        assert.equal(saved.manual_booking, true);
        assert.equal(saved.items[0].booking_ref, 'AHC-AAAAAA');
        assert.equal(saved.credit_pence, 400);
        assert.equal(saved.items[0].amount_pence, 1000);
        assert.equal(saved.items[0].credit_applied_pence, 400);
        assert.equal((await Admin.register(run.guid)).booked, 1);
        assert.equal(Admin.remainingValue((await Admin.details(saved.items[0].guid)).booking), 400);
        assert.equal((await db.query('SELECT credit_pence FROM profiles WHERE guid = $1', [parent.guid])).rows[0].credit_pence, 0);
        await assert.rejects(Orders.previewManual(parent.guid, first.guid, run.guid), /already enrolled/);
        await assert.rejects(Admin.removeAttendee(saved.items[0].guid, 'refundable', '4.01', actor), RangeError);
        await Admin.removeAttendee(saved.items[0].guid, 'refundable', '4.00', actor);
        const returned = (await Credits.findForProfile(parent.guid)).find(item => item.booking_guid === saved.items[0].guid);
        assert.equal(returned.amount_pence, 400);
        assert.equal(returned.refundable, true);
        assert.equal(returned.card_paid_pence, 0);
        assert.equal((await Admin.register(run.guid)).booked, 0);
    });

    await t.test('no credit is used without consent, and full classes require confirmation', async () => {
        const expected = { amount: 1000, credit: 0, useCredit: 'no', confirmFull: false };
        await assert.rejects(Orders.createManual(parent.guid, second.guid, run.guid, crypto.randomUUID(),
            { ...expected, amount: 999 }, actor), /price or available credit changed/);
        let calls = 0;
        const random = t.mock.method(crypto, 'randomInt', () => Math.floor(calls++ / 6));
        let firstOrder;
        try {
            firstOrder = await Orders.createManual(parent.guid, second.guid, run.guid, crypto.randomUUID(), expected, actor);
        } finally {
            random.mock.restore();
        }
        const booking = (await Orders.order(parent.guid, firstOrder.guid)).items[0];
        assert.equal(booking.booking_ref, 'AHC-BBBBBB');
        assert.equal(calls, 12);
        assert.equal(Admin.remainingValue((await Admin.details(booking.guid)).booking), 0);
        await assert.rejects(Admin.removeAttendee(booking.guid, 'refundable', '1.00', actor), /No credit is available/);
        assert.equal((await Orders.previewManual(parent.guid, third.guid, run.guid)).run.spaces_remaining, 0);
        await assert.rejects(Orders.createManual(parent.guid, third.guid, run.guid, crypto.randomUUID(), expected, actor), /full/);
        const audit = require('../models/AuditLog');
        const failAudit = t.mock.method(audit, 'record', async () => { throw new Error('Audit failed'); });
        await assert.rejects(Orders.createManual(parent.guid, third.guid, run.guid, crypto.randomUUID(),
            { amount: 1000, credit: 400, useCredit: 'yes', confirmFull: true }, actor), /Audit failed/);
        failAudit.mock.restore();
        assert.equal((await Admin.register(run.guid)).booked, 1);
        assert.equal((await db.query('SELECT credit_pence FROM profiles WHERE guid = $1', [parent.guid])).rows[0].credit_pence, 400);
        await Orders.createManual(parent.guid, third.guid, run.guid, crypto.randomUUID(), { ...expected, confirmFull: true }, actor);
        assert.equal((await Admin.register(run.guid)).booked, 2);
        assert.equal((await db.query('SELECT credit_pence FROM profiles WHERE guid = $1', [parent.guid])).rows[0].credit_pence, 400);
    });

    await t.test('simultaneous bookings cannot fill the same last place without confirmation', async () => {
        const { rows: [anotherRun] } = await db.query(`INSERT INTO course_runs
            (course_guid, facility_guid, name, capacity, full_price_pence, published)
            VALUES ($1, $2, 'Concurrent class', 1, 1000, true) RETURNING guid`, [course.guid, facility.guid]);
        await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
            VALUES ($1, now() + interval '2 days', now() + interval '2 days 1 hour')`, [anotherRun.guid]);
        async function family() {
            const { rows: [profile] } = await db.query(`INSERT INTO profiles (name, email, role)
                VALUES ('Concurrent parent', $1, 'Resident') RETURNING guid`, [`${crypto.randomUUID()}@example.test`]);
            return { profile, child: await Orders.addFamilyMember(profile.guid, 'Child') };
        }
        const [one, two] = await Promise.all([family(), family()]);
        const expected = { amount: 1000, credit: 0, useCredit: 'no', confirmFull: false };
        const attempts = await Promise.allSettled([one, two].map(family =>
            Orders.createManual(family.profile.guid, family.child.guid, anotherRun.guid, crypto.randomUUID(), expected, actor)));
        assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
        assert.match(attempts.find(result => result.status === 'rejected').reason.message, /full/);
        assert.equal((await Admin.register(anotherRun.guid)).booked, 1);
    });

    await t.test('the account holder can be booked and duplicate rules apply to adults separately from children', async () => {
        const quote = await Orders.previewManual(parent.guid, 'self', run.guid);
        assert.equal(quote.member.guid, null);
        assert.equal(quote.member.name, 'Manual parent');
        const expected = { amount: 1000, credit: 400, useCredit: 'yes', confirmFull: true };
        const order = await Orders.createManual(parent.guid, 'self', run.guid, crypto.randomUUID(), expected, actor);
        const booking = (await Orders.order(parent.guid, order.guid)).items[0];
        assert.equal(booking.member_guid, null);
        assert.equal(booking.attendee_name, 'Manual parent');
        assert.equal(booking.credit_applied_pence, 400);
        assert.ok((await Admin.register(run.guid)).entries.some(entry => entry.guid === booking.guid && !entry.member_guid));
        await assert.rejects(Orders.previewManual(parent.guid, 'self', run.guid), /already enrolled/);
        await Admin.removeAttendee(booking.guid, 'refundable', '4.00', actor);
        assert.equal((await Admin.register(run.guid)).entries.some(entry => entry.guid === booking.guid), false);
    });
});
