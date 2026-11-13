const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const databaseUrl = process.env.BASKET_TEST_DATABASE_URL;

test('read-only course booking management (PostgreSQL)', { skip: !databaseUrl }, async t => {
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
    const Model = require('../models/CourseBookingAdmin');
    const Orders = require('../models/CourseOrders');
    const { rows: [facility] } = await db.query(`INSERT INTO facilities
        (name, address, postcode, latitude, longitude, google_maps_url, description)
        VALUES ('Register hall', 'Test', 'AB1 2CD', 0, 0, '', '') RETURNING guid`);
    const { rows: [sport] } = await db.query("SELECT guid FROM sports LIMIT 1");
    const { rows: [course] } = await db.query("INSERT INTO courses (name) VALUES ('Register gymnastics') RETURNING guid");
    await db.query('INSERT INTO course_sports (course_guid, sport_guid) VALUES ($1, $2)', [course.guid, sport.guid]);
    const { rows: [run] } = await db.query(`INSERT INTO course_runs
        (course_guid, facility_guid, name, capacity, full_price_pence, published)
        VALUES ($1, $2, 'Tuesday', 60, 1000, true) RETURNING guid`, [course.guid, facility.guid]);
    await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
        VALUES ($1, '2090-07-04T23:30:00Z', '2090-07-05T00:30:00Z')`, [run.guid]);
    const { rows: [parent] } = await db.query(`INSERT INTO profiles (name, email, role)
        VALUES ('Register parent', $1, 'Resident') RETURNING guid`, [`${crypto.randomUUID()}@example.test`]);
    const child = await Orders.addFamilyMember(parent.guid, 'Archived %_child');
    const lateChild = await Orders.addFamilyMember(parent.guid, 'Late child');
    child.name = 'Archived %_child';
    lateChild.name = 'Late child';
    const { rows: [order] } = await db.query(`INSERT INTO course_orders
        (profile_guid, checkout_token, total_pence, credit_pence, payment_reference, created_at)
        VALUES ($1, $2, 3000, 500, 'SIM-REGISTER', '2026-07-04T23:30:00Z') RETURNING guid`,
    [parent.guid, crypto.randomUUID()]);
    async function enrol(member, name, sessions) {
        const { rows: [saved] } = await db.query(`INSERT INTO course_enrolments
            (order_guid, run_guid, profile_guid, member_guid, attendee_name, course_name, run_name, facility_name,
             sessions, amount_pence, credit_applied_pence, booking_ref)
            VALUES ($1,$2,$3,$4,$5,'Purchased course','Purchased class','Purchased hall',$6,1000,$7,$8) RETURNING guid`,
        [order.guid, run.guid, parent.guid, member, name, JSON.stringify(sessions), member === child.guid ? 500 : 0,
            `AHC-${crypto.randomUUID()}`]);
        return saved;
    }
    const early = { starts_at: '2090-07-04T23:30:00Z', ends_at: '2090-07-05T00:30:00Z' };
    const late = { starts_at: '2090-07-11T23:30:00Z', ends_at: '2090-07-12T00:30:00Z' };
    const booking = await enrol(child.guid, child.name, [early, late]);
    await enrol(lateChild.guid, lateChild.name, [late]);
    await enrol(null, 'Register parent', [{ starts_at: '2020-01-01T18:00:00Z', ends_at: '2020-01-01T19:00:00Z' }]);
    await Orders.removeFamilyMember(parent.guid, child.guid);
    await db.query(`UPDATE profile_family_members SET medical_concern = true,
        medical_conditions = ARRAY['asthma', 'other'], medical_other = 'Needs assistance',
        activity_limitation = 'limited_a_lot' WHERE guid = $1`, [child.guid]);
    await db.query("UPDATE profiles SET telephone = '020 1111 2222' WHERE guid = $1", [parent.guid]);
    await db.query(`UPDATE profile_family_members SET inherit_parental_contact = false,
        parental_contact_name = 'Other parent', parental_contact_email = 'other@example.test',
        parental_contact_telephone = '020 3333 4444' WHERE guid = $1`, [lateChild.guid]);

    await t.test('catalogue includes assigned sports and historical classes', async () => {
        const found = (await Model.catalogue()).find(item => item.guid === course.guid);
        assert.equal(found.sports[0].guid, sport.guid);
        assert.equal(found.runs[0].guid, run.guid);
    });
    await t.test('session registers use purchased snapshots and UK dates, retaining archived attendees', async () => {
        const whole = await Model.register(run.guid);
        assert.equal(whole.booked, 3);
        assert.equal(whole.spaces, 57);
        assert.equal(whole.entries.length, 3);
        assert.deepEqual(whole.dates, ['2020-01-01', '2090-07-05', '2090-07-12']);
        const session = await Model.register(run.guid, '2090-07-05');
        assert.equal(session.entries.length, 1);
        assert.equal(session.entries[0].attendee_name, child.name);
        assert.equal(session.entries[0].medical_concern, true);
        assert.deepEqual(session.entries[0].medical_conditions, ['asthma', 'other']);
        assert.equal(session.entries[0].medical_other, 'Needs assistance');
        assert.equal(session.entries[0].activity_limitation, 'limited_a_lot');
        assert.equal(session.entries[0].parental_contact.parental_contact_name, 'Register parent');
        assert.equal(session.entries[0].parental_contact.parental_contact_telephone, '020 1111 2222');
        assert.ok(session.entries[0].parental_contact.parental_contact_email.endsWith('@example.test'));
        const lateRegister = await Model.register(run.guid, '2090-07-12');
        const ownContact = lateRegister.entries.find(entry => entry.member_guid === lateChild.guid).parental_contact;
        assert.equal(ownContact.parental_contact_name, 'Other parent');
        assert.equal(ownContact.parental_contact_email, 'other@example.test');
        assert.equal(ownContact.parental_contact_telephone, '020 3333 4444');
        assert.equal(whole.entries.find(entry => !entry.member_guid).parental_contact, null);
        assert.equal((await Model.register(run.guid, '2090-07-12')).entries.length, 2);
        await assert.rejects(Model.register(run.guid, '2090-07-04'), RangeError);
        assert.equal(await Model.register(crypto.randomUUID()), null);
    });
    await t.test('search matches literal names, account holders, references, status and inclusive UK purchase dates', async () => {
        const search = query => Model.search(Model.parseFilters({ view: 'search', ...query }));
        assert.equal((await search({ q: '%_', run: run.guid })).total, 1);
        assert.equal((await search({ q: 'Register parent', sport: sport.guid, course: course.guid, facility: facility.guid })).total, 3);
        assert.equal((await search({ run: run.guid, status: 'completed' })).total, 1);
        assert.equal((await search({ run: run.guid, status: 'upcoming' })).total, 2);
        assert.equal((await search({ run: run.guid, from: '2026-07-05', to: '2026-07-05' })).total, 3);
        assert.equal((await search({ run: run.guid, to: '2026-07-04' })).total, 0);
        const reference = (await Model.details(booking.guid)).booking.booking_ref;
        assert.equal((await search({ q: reference })).total, 1);
    });
    await t.test('details keep original attendee, schedule and per-place payment separate from the whole order', async () => {
        const found = await Model.details(booking.guid);
        assert.equal(found.booking.attendee_name, child.name);
        assert.equal(found.booking.course_name, 'Purchased course');
        assert.equal(found.booking.sessions.length, 2);
        assert.equal(found.booking.credit_applied_pence, 500);
        assert.equal(Object.hasOwn(found, 'order'), false);
        assert.equal(await Model.details(crypto.randomUUID()), null);
        assert.equal(await Model.details('invalid'), null);
    });
    await t.test('search pagination returns exactly 50 rows with deterministic non-overlapping pages', async () => {
        for (let i = 0; i < 49; i++) await enrol(null, `Page attendee ${i}`, [early]);
        const first = await Model.search(Model.parseFilters({ run: run.guid }));
        const second = await Model.search(Model.parseFilters({ run: run.guid, page: '2' }));
        assert.equal(first.total, 52);
        assert.equal(first.entries.length, 50);
        assert.equal(second.entries.length, 2);
        assert.equal(new Set([...first.entries, ...second.entries].map(item => item.guid)).size, 52);
        assert.equal((await Model.register(run.guid)).entries.length, 52);
    });
    const actor = { ...parent, name: 'Test admin', role: 'Administrator' };
    const Credits = require('../models/Credits');
    await t.test('partial refundable removal preserves funding, history and availability, and concurrent repeats award once', async () => {
        const saved = await enrol(null, 'Removal mixed funding', [early, late]);
        await db.query('UPDATE course_enrolments SET credit_applied_pence = 600 WHERE guid = $1', [saved.guid]);
        for (const [amount, refundable] of [[400, false], [200, true]]) {
            const { rows: [source] } = await db.query(`INSERT INTO credits
                (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
                VALUES ($1, 'Source hall', $2, 0, $3) RETURNING guid`, [parent.guid, amount, refundable]);
            await db.query(`INSERT INTO credit_spending (credit_guid, booking_guid, booking_ref, amount_pence, refundable)
                VALUES ($1, $2, 'SOURCE', $3, $4)`, [source.guid, saved.guid, amount, refundable]);
        }
        const before = (await db.query('SELECT credit_pence FROM profiles WHERE guid = $1', [parent.guid])).rows[0].credit_pence;
        const attempts = await Promise.allSettled([
            Model.removeAttendee(saved.guid, 'refundable', '5.00', actor),
            Model.removeAttendee(saved.guid, 'refundable', '5.00', actor)
        ]);
        assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
        assert.match(attempts.find(result => result.status === 'rejected').reason.message, /already been removed/);
        const credits = (await Credits.findForProfile(parent.guid)).filter(credit => credit.booking_guid === saved.guid);
        assert.equal(credits.length, 2);
        assert.equal(credits.find(credit => credit.refundable).amount_pence, 300);
        assert.equal(credits.find(credit => !credit.refundable).amount_pence, 200);
        assert.equal(credits.find(credit => credit.refundable).card_paid_pence, 200);
        assert.ok(credits.every(credit => credit.payment_reference === 'SIM-REGISTER'));
        assert.equal((await db.query('SELECT credit_pence FROM profiles WHERE guid=$1', [parent.guid])).rows[0].credit_pence, before + 500);
        const detail = (await Model.details(saved.guid)).booking;
        assert.equal(detail.status, 'Removed');
        assert.equal(detail.cancellation_credit_pence, 500);
        assert.equal(detail.sessions.length, 2);
        assert.equal((await Model.register(run.guid)).booked, 52);
        assert.ok(!(await Orders.upcomingForProfile(parent.guid)).some(entry => entry.guid === saved.guid));
        const found = await Model.search(Model.parseFilters({ q: detail.booking_ref }));
        assert.equal(found.entries[0].status, 'Removed');
        const audit = await db.query("SELECT details FROM audit_log WHERE entity_guid=$1 AND action='course-booking.cancel'", [saved.guid]);
        assert.equal(audit.rowCount, 1);
        assert.equal(audit.rows[0].details.refundable_pence, 300);
        assert.equal((await Orders.order(parent.guid, order.guid)).items.find(item => item.guid === saved.guid).cancelled_at instanceof Date, true);
        await require('../models/Settings').set('refunds_enabled', '1');
        const refundable = credits.find(credit => credit.refundable);
        const request = await Credits.requestRefund(parent.guid, refundable.guid);
        assert.ok(request.guid);
        await Credits.decideRefund(request.guid, true, actor.name);
        const { rows: [refund] } = await db.query('SELECT status, refunded_pence FROM credit_refund_requests WHERE guid=$1', [request.guid]);
        assert.equal(refund.status, 'approved');
        assert.equal(refund.refunded_pence, 300);
        assert.equal(await Credits.requestRefund(parent.guid, credits.find(credit => !credit.refundable).guid), null);
    });
    await t.test('no-credit and non-refundable removals, bounds and atomic rollback', async () => {
        const saved = await enrol(null, 'Removal no credit', [late]);
        await Model.removeAttendee(saved.guid, 'none', undefined, actor);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM credits WHERE booking_guid=$1', [saved.guid])).rows[0].count, 0);
        const paid = await enrol(null, 'Removal non-refundable', [late]);
        await assert.rejects(Model.removeAttendee(paid.guid, 'non-refundable', '10.01', actor), RangeError);
        assert.equal((await Model.details(paid.guid)).booking.cancelled_at, null);
        const audit = require('../models/AuditLog');
        const record = t.mock.method(audit, 'record', async () => { throw new Error('Audit write failed'); });
        await assert.rejects(Model.removeAttendee(paid.guid, 'non-refundable', '4.00', actor), /Audit write failed/);
        record.mock.restore();
        assert.equal((await Model.details(paid.guid)).booking.cancelled_at, null);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM credits WHERE booking_guid=$1', [paid.guid])).rows[0].count, 0);
        await Model.removeAttendee(paid.guid, 'non-refundable', '4.00', actor);
        const credit = (await Credits.findForProfile(parent.guid)).find(item => item.booking_guid === paid.guid);
        assert.equal(credit.refundable, false);
        assert.equal(credit.amount_pence, 400);
    });
});
