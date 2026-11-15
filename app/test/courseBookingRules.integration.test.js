const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.BASKET_TEST_DATABASE_URL;

test('course and class booking rules (PostgreSQL)', { skip: !databaseUrl }, async t => {
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
    const Settings = require('../models/Settings');
    const { rows: [facility] } = await db.query(`INSERT INTO facilities
        (name, address, postcode, latitude, longitude, google_maps_url, description)
        VALUES ('Rule test hall', 'Test road', 'AB1 2CD', 0, 0, '', '') RETURNING guid`);
    const { rows: [course] } = await db.query("INSERT INTO courses (name) VALUES ('Rule test course') RETURNING guid");
    const { rows: [otherCourse] } = await db.query("INSERT INTO courses (name) VALUES ('Other course') RETURNING guid");
    async function run(courseGuid, name) {
        const { rows: [saved] } = await db.query(`INSERT INTO course_runs
            (course_guid, facility_guid, name, full_price_pence, capacity, published)
            VALUES ($1, $2, $3, 1000, 100, true) RETURNING guid`, [courseGuid, facility.guid, name]);
        await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
            VALUES ($1, now() + interval '2 days', now() + interval '2 days 1 hour')`, [saved.guid]);
        return saved.guid;
    }
    const first = await run(course.guid, 'First class');
    const second = await run(course.guid, 'Second class');
    const different = await run(otherCourse.guid, 'Other course class');
    async function person() {
        const { rows: [profile] } = await db.query(`INSERT INTO profiles (name, email, role)
            VALUES ('Rule test resident', $1, 'Resident') RETURNING guid`, [`${crypto.randomUUID()}@example.test`]);
        return profile.guid;
    }
    async function rules(duplicate, multiple) {
        await Settings.set('course_prevent_duplicate_class', duplicate ? '1' : '0');
        await Settings.set('course_prevent_overlapping_runs', multiple ? '1' : '0');
    }
    async function pay(owner, current = null) {
        current ||= await Basket.basket(owner);
        return Basket.pay(owner, current.revision, { total: current.total, credit: current.credit }, 'SIM-RULE');
    }
    async function buy(owner, runGuid, member = 'self') {
        await Basket.add(owner, runGuid, member, '/courses');
        return pay(owner);
    }
    async function count(table, owner) {
        return (await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE profile_guid = $1`, [owner])).rows[0].count;
    }

    await t.test('same-class and same-course checks isolate account holders, children and customers', async () => {
        await rules(true, true);
        const owner = await person();
        const child = await Basket.addFamilyMember(owner, 'First child');
        const sibling = await Basket.addFamilyMember(owner, 'Second child');
        await assert.rejects(Basket.add(await person(), first, child.guid, '/courses'), /saved family member/);
        await buy(owner, first, child.guid);
        await assert.rejects(Basket.add(owner, first, child.guid, '/courses'), /already enrolled on this class/);
        await assert.rejects(Basket.add(owner, second, child.guid, '/courses'), /dates overlapping/);
        assert.equal(await Basket.itemCount(owner), 0);
        await buy(owner, second, sibling.guid);
        await buy(owner, second);
        await buy(owner, different, child.guid);
        await buy(await person(), first);
        assert.equal(await count('course_enrolments', owner), 4);
    });

    await t.test('removed attendees free inventory and may repurchase with both duplicate rules enabled', async () => {
        await rules(true, true);
        const owner = await person();
        const placed = await buy(owner, first);
        const enrolment = (await Basket.order(owner, placed.guid)).items[0];
        const Courses = require('../models/Courses');
        const spaces = (await Courses.findRuns()).find(item => item.guid === first).spaces_remaining;
        await require('../models/CourseBookingAdmin').removeAttendee(enrolment.guid, 'none', undefined,
            { guid: owner, name: 'Test admin', role: 'Administrator' });
        assert.equal((await Courses.findRuns()).find(item => item.guid === first).spaces_remaining, spaces + 1);
        await buy(owner, first);
        assert.equal(await count('course_enrolments', owner), 2);
        assert.equal((await Basket.upcomingForProfile(owner)).length, 1);
        assert.equal((await Courses.findRuns()).find(item => item.guid === first).spaces_remaining, spaces);
    });

    await t.test('different classes in a basket conflict only for the same attendee and course', async () => {
        await rules(true, true);
        const owner = await person();
        await Basket.add(owner, first, 'self', '/courses');
        await assert.rejects(Basket.add(owner, first, 'self', '/courses'), /already has a place in your basket/);
        assert.equal(await Basket.itemCount(owner), 1);
        await assert.rejects(Basket.add(owner, second, 'self', '/courses'), /dates overlapping/);
        assert.equal(await Basket.itemCount(owner), 1);
        await Basket.add(owner, different, 'self', '/courses');
        assert.equal((await Basket.basket(owner)).valid, true);
        await pay(owner);
    });

    await t.test('each rule can be disabled independently and re-enabled without deleting history', async () => {
        const owner = await person();
        await rules(true, true);
        await buy(owner, first);
        await rules(false, true);
        await Basket.add(owner, first, 'self', '/courses');
        await Basket.add(owner, first, 'self', '/courses');
        assert.equal(await Basket.itemCount(owner), 1);
        await pay(owner);
        await assert.rejects(Basket.add(owner, second, 'self', '/courses'), /dates overlapping/);
        await rules(true, false);
        await assert.rejects(Basket.add(owner, first, 'self', '/courses'), /already enrolled/);
        await buy(owner, second);
        await rules(false, false);
        await buy(owner, first);
        assert.equal(await count('course_enrolments', owner), 4);
        await rules(true, true);
        await assert.rejects(Basket.add(owner, first, 'self', '/courses'), /already enrolled/);
        await assert.rejects(Basket.add(owner, second, 'self', '/courses'), /already enrolled/);
        assert.equal(await count('course_enrolments', owner), 4);
    });

    await t.test('completed non-overlapping runs do not prevent booking a later run', async () => {
        await rules(true, true);
        const owner = await person();
        const past = await run(course.guid, 'Completed class');
        await buy(owner, past);
        await db.query(`UPDATE course_sessions SET starts_at = starts_at - interval '1 year',
            ends_at = ends_at - interval '1 year' WHERE run_guid = $1`, [past]);
        await buy(owner, first);
    });

    await t.test('inclusive run ranges allow later runs and block touching or enclosed ranges', async () => {
        await rules(true, true);
        const owner = await person();
        const base = await run(course.guid, 'Range base');
        const touching = await run(course.guid, 'Range boundary');
        const enclosed = await run(course.guid, 'Enclosed range');
        const later = await run(course.guid, 'Later range');
        await db.query(`UPDATE course_runs SET start_date = current_date + 1, end_date = current_date + 10 WHERE guid = $1`, [base]);
        await db.query(`UPDATE course_runs SET start_date = current_date + 10, end_date = current_date + 20 WHERE guid = $1`, [touching]);
        await db.query(`UPDATE course_runs SET start_date = current_date + 3, end_date = current_date + 4 WHERE guid = $1`, [enclosed]);
        await db.query(`UPDATE course_runs SET start_date = current_date + 11, end_date = current_date + 20 WHERE guid = $1`, [later]);
        await buy(owner, base);
        await assert.rejects(Basket.add(owner, touching, 'self', '/courses'), /dates overlapping/);
        await assert.rejects(Basket.add(owner, enclosed, 'self', '/courses'), /dates overlapping/);
        await buy(owner, later);
        assert.equal(await count('course_enrolments', owner), 2);

        const basketOwner = await person();
        await Basket.add(basketOwner, base, 'self', '/courses');
        await Basket.add(basketOwner, later, 'self', '/courses');
        assert.equal((await Basket.basket(basketOwner)).valid, true);
        await assert.rejects(Basket.add(basketOwner, touching, 'self', '/courses'), /dates overlapping/);
    });

    await t.test('unknown original starts use earliest known UK session; unavailable dates are explained', async () => {
        await rules(true, true);
        const owner = await person();
        const imported = await run(course.guid, 'Imported history');
        const earlier = await run(course.guid, 'Earlier run');
        const overlap = await run(course.guid, 'Known session boundary');
        await db.query(`UPDATE course_runs SET incomplete_history = true, start_date = NULL,
            end_date = current_date + 10 WHERE guid = $1`, [imported]);
        const { rows: [date] } = await db.query(`SELECT (min(starts_at) AT TIME ZONE 'Europe/London')::date AS first_date
            FROM course_sessions WHERE run_guid = $1`, [imported]);
        await db.query(`UPDATE course_runs SET start_date = $2::date - 2, end_date = $2::date - 1 WHERE guid = $1`, [earlier, date.first_date]);
        await db.query(`UPDATE course_runs SET start_date = $2::date, end_date = $2::date + 1 WHERE guid = $1`, [overlap, date.first_date]);
        await buy(owner, imported);
        await assert.rejects(Basket.add(owner, overlap, 'self', '/courses'), /dates overlapping/);
        await buy(owner, earlier);
        await db.query(`UPDATE course_runs SET start_date = $2::date - 2 WHERE guid = $1`, [imported, date.first_date]);
        const ownerWithOriginalStart = await person();
        await buy(ownerWithOriginalStart, imported);
        await assert.rejects(Basket.add(ownerWithOriginalStart, earlier, 'self', '/courses'), /dates overlapping/);
        await db.query('UPDATE course_runs SET start_date = NULL WHERE guid = $1', [imported]);
        await db.query('DELETE FROM course_sessions WHERE run_guid = $1', [imported]);
        await assert.rejects(Basket.add(owner, overlap, 'self', '/courses'), /dates.*could not be checked/);
    });

    await t.test('manual booking and checkout recheck overlapping dates and preserve other attendees', async () => {
        await rules(true, true);
        const owner = await person();
        const actor = { guid: owner, name: 'Test administrator', role: 'Administrator' };
        const firstRun = await run(course.guid, 'Manual first');
        const secondRun = await run(course.guid, 'Manual second');
        const child = await Basket.addFamilyMember(owner, 'Child');
        const preview = await Basket.previewManual(owner, 'self', firstRun);
        const expected = { amount: preview.amount, credit: 0, useCredit: 'no', confirmFull: false };
        await Basket.createManual(owner, 'self', firstRun, crypto.randomUUID(), expected, actor);
        await assert.rejects(Basket.previewManual(owner, 'self', secondRun), /dates overlapping/);
        await assert.rejects(Basket.createManual(owner, 'self', secondRun, crypto.randomUUID(), expected, actor), /dates overlapping/);
        await Basket.createManual(owner, child.guid, secondRun, crypto.randomUUID(), expected, actor);
        await db.query(`UPDATE course_runs SET start_date = current_date + 10, end_date = current_date + 11 WHERE guid = $1`, [secondRun]);
        assert.ok(await Basket.previewManual(owner, 'self', secondRun));

        const basketOwner = await person();
        await Basket.add(basketOwner, firstRun, 'self', '/courses');
        await Basket.add(basketOwner, secondRun, 'self', '/courses');
        const quote = await Basket.basket(basketOwner);
        assert.equal(quote.valid, true);
        await db.query('UPDATE course_runs SET start_date = NULL, end_date = NULL WHERE guid = $1', [secondRun]);
        assert.equal((await Basket.basket(basketOwner)).valid, false);
        await assert.rejects(pay(basketOwner, quote), /changed/);
        assert.equal(await count('course_orders', basketOwner), 0);
    });

    await t.test('enabling rules invalidates stale baskets and payment without spending credit or creating an order', async () => {
        const owner = await person();
        await rules(false, false);
        await buy(owner, first);
        await Basket.add(owner, first, 'self', '/courses');
        await Basket.add(owner, second, 'self', '/courses');
        await db.query(`INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence)
            VALUES ($1, 'Rule test credit', 2000, 2000)`, [owner]);
        await db.query('UPDATE profiles SET credit_pence = 2000 WHERE guid = $1', [owner]);
        const current = await Basket.basket(owner);
        assert.equal(current.valid, true);
        await rules(true, true);
        const invalid = await Basket.basket(owner);
        assert.equal(invalid.valid, false);
        assert.ok(invalid.items.every(item => item.error));
        await assert.rejects(pay(owner, current), /changed/);
        assert.equal(await count('course_orders', owner), 1);
        assert.equal(await count('course_enrolments', owner), 1);
        assert.equal((await db.query('SELECT remaining_pence FROM credits WHERE profile_guid = $1', [owner])).rows[0].remaining_pence, 2000);
        const repeat = await Promise.allSettled([
            Basket.add(owner, first, 'self', '/courses'), Basket.add(owner, second, 'self', '/courses')
        ]);
        assert.ok(repeat.every(result => result.status === 'rejected'));
    });

    await t.test('simultaneous different-class additions are serialized for one attendee', async () => {
        await rules(true, true);
        const owner = await person();
        const results = await Promise.allSettled([
            Basket.add(owner, first, 'self', '/courses'), Basket.add(owner, second, 'self', '/courses')
        ]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BASKET_CONFLICT');
        const current = await Basket.basket(owner);
        const orders = await Promise.all([pay(owner, current), pay(owner, current)]);
        assert.equal(orders[0].guid, orders[1].guid);
        assert.equal(await count('course_enrolments', owner), 1);
    });

    await t.test('manual and customer booking of overlapping runs cannot both succeed concurrently', async () => {
        await rules(true, true);
        const owner = await person();
        const actor = { guid: owner, name: 'Test administrator', role: 'Administrator' };
        const preview = await Basket.previewManual(owner, 'self', second);
        await Basket.add(owner, first, 'self', '/courses');
        const current = await Basket.basket(owner);
        const expected = { amount: preview.amount, credit: 0, useCredit: 'no', confirmFull: false };
        const outcomes = await Promise.allSettled([
            pay(owner, current),
            Basket.createManual(owner, 'self', second, crypto.randomUUID(), expected, actor)
        ]);
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
        assert.equal(await count('course_enrolments', owner), 1);
    });

    await t.test('rule changes wait for booking transaction locks rather than taking effect mid-purchase', async () => {
        await rules(true, true);
        const booking = await db.connect();
        const editor = await db.connect();
        try {
            await booking.query('BEGIN');
            await Settings.getCourseBookingRules(booking);
            await editor.query('BEGIN');
            await editor.query("SET LOCAL lock_timeout = '100ms'");
            await assert.rejects(editor.query("UPDATE site_settings SET value = '0' WHERE key = 'course_prevent_duplicate_class'"),
                { code: '55P03' });
            await editor.query('ROLLBACK');
            await editor.query('BEGIN');
            await editor.query("SET LOCAL lock_timeout = '100ms'");
            await assert.rejects(editor.query("UPDATE site_settings SET value = '0' WHERE key = 'course_prevent_overlapping_runs'"),
                { code: '55P03' });
            await editor.query('ROLLBACK');
            await booking.query('COMMIT');
            await Settings.set('course_prevent_duplicate_class', '0');
            assert.equal(Settings.courseBookingRules(await Settings.getAll()).preventDuplicateClass, false);
            await rules(true, true);
        } finally {
            await booking.query('ROLLBACK');
            await editor.query('ROLLBACK');
            booking.release();
            editor.release();
        }
    });
});
