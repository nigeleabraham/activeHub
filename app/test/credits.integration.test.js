const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.CREDIT_TEST_DATABASE_URL;

test('booking credit ledger and bank refunds (PostgreSQL)', { skip: !databaseUrl }, async t => {
    const url = new URL(databaseUrl);
    assert.ok(url.pathname.endsWith('_test'), 'Use a dedicated database whose name ends in _test');
    process.env.DATABASE_URL = databaseUrl;
    const pools = new Set();
    const originalConnect = Pool.prototype.connect;
    t.mock.method(Pool.prototype, 'connect', function (...args) {
        pools.add(this);
        return originalConnect.apply(this, args);
    });
    t.after(async () => {
        await Promise.all([...pools].map(pool => pool.end()));
    });
    const db = new Pool({ connectionString: databaseUrl });
    const Bookings = require('../models/Bookings');
    const Credits = require('../models/Credits');
    for (const name of ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings', 'CourseOrders']) {
        await require(`../models/${name}`).initialize();
    }
    const { rows: [facility] } = await db.query(`
        INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
        VALUES ('Credit test hall', 'Test road', 'AB1 2CD', 0, 0, '', 'Credit tests') RETURNING guid`);
    const { rows: [sport] } = await db.query('SELECT guid FROM sports LIMIT 1');
    await db.query('INSERT INTO facility_sports (facility_guid, sport_guid) VALUES ($1, $2)', [facility.guid, sport.guid]);
    const resource = await Bookings.createResource(facility.guid, 'Test court');
    const option = await Bookings.createOption({
        facility_guid: facility.guid, sport_guid: sport.guid, name: 'Test option', resource_guids: [resource.guid]
    });
    async function person(balance = 0) {
        const { rows: [profile] } = await db.query(`
            INSERT INTO profiles (name, email, role, credit_pence) VALUES ('Test resident', $1, 'Resident', $2) RETURNING guid`,
        [`${crypto.randomUUID()}@example.test`, balance]);
        return profile;
    }
    let slot = 0;
    function bookingInput(profile) {
        const starts = Date.now() + (++slot) * 3600000;
        return {
            facility_guid: facility.guid, option_guid: option.guid, profile_guid: profile.guid,
            starts_at: new Date(starts).toISOString(), ends_at: new Date(starts + 3600000).toISOString(),
            amount_paid_pence: 1000, amount_pence: 1000, payment_status: 'paid', payment_reference: 'PAY-' + crypto.randomUUID()
        };
    }
    async function granted(profile, refundable = true) {
        const booking = await Bookings.createBooking(bookingInput(profile));
        assert.equal(await Bookings.addCreditToBooking(facility.guid, booking.guid, 'Test admin', refundable), 1000);
        const credits = await Credits.findForProfile(profile.guid);
        const { rows: [source] } = await db.query('SELECT payment_reference FROM bookings WHERE guid = $1', [booking.guid]);
        assert.equal(credits.find(credit => credit.booking_guid === booking.guid).payment_reference, source.payment_reference);
        return { booking, credit: credits.find(credit => credit.booking_guid === booking.guid) };
    }
    async function spend(profile, pence) {
        const input = { ...bookingInput(profile), credit_applied_pence: pence };
        return Bookings.createBookings([input], { profile_guid: profile.guid, pence });
    }
    async function balance(profile) {
        const { rows: [row] } = await db.query('SELECT credit_pence FROM profiles WHERE guid = $1', [profile.guid]);
        const credits = await Credits.findForProfile(profile.guid);
        assert.equal(credits.reduce((sum, credit) => sum + credit.remaining_pence, 0), row.credit_pence);
        return row.credit_pence;
    }
    async function requestRow(guid) {
        const { rows: [row] } = await db.query('SELECT * FROM credit_refund_requests WHERE guid = $1', [guid]);
        return row;
    }

    async function profileDeletion() {
        const Profiles = require('../models/Profiles');
        const resident = await person();
        const other = await person();
        const source = await granted(resident);
        const refund = await Credits.requestRefund(resident.guid, source.credit.guid);
        const past = await Bookings.createBooking(bookingInput(resident));
        await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '2 days', ends_at = now() - INTERVAL '1 day' WHERE guid = $1", [past.guid]);
        const request = await Bookings.requestCredit(resident.guid, past.guid, 'discretionary', 'Test request');
        const ongoing = await Bookings.createBooking(bookingInput(resident));
        await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '1 minute', ends_at = now() + INTERVAL '1 hour' WHERE guid = $1", [ongoing.guid]);
        const future = await Bookings.createBooking(bookingInput(resident));
        const unaffected = await Bookings.createBooking({ ...bookingInput(other), booked_by_guid: resident.guid });
        const { rows: [stored] } = await db.query('SELECT email FROM profiles WHERE guid = $1', [resident.guid]);
        assert.equal(await Profiles.remove(resident.guid, 'Deletion admin'), true);
        assert.equal(await Profiles.findByGuid(resident.guid), null);
        assert.equal((await Profiles.findAll()).some(p => p.guid === resident.guid), false);
        assert.deepEqual(await Profiles.search(stored.email), []);
        const { rows: [archived] } = await db.query('SELECT deleted_at, credit_pence FROM profiles WHERE guid = $1', [resident.guid]);
        assert.ok(archived.deleted_at);
        assert.equal(archived.credit_pence, 0);
        const { rows: [credit] } = await db.query('SELECT * FROM credits WHERE guid = $1', [source.credit.guid]);
        assert.equal(credit.remaining_pence, 0);
        assert.equal(credit.voided_pence, 1000);
        assert.ok(credit.voided_at);
        assert.equal((await requestRow(refund.guid)).status, 'cancelled');
        assert.equal((await requestRow(refund.guid)).decided_by_name, 'Deletion admin');
        assert.equal((await Bookings.findCreditRequests()).find(r => r.guid === request.guid).status, 'cancelled');
        for (const booking of [source.booking, future]) {
            assert.equal((await db.query('SELECT 1 FROM bookings WHERE guid = $1', [booking.guid])).rowCount, 0);
            assert.equal((await db.query('SELECT 1 FROM booking_reservations WHERE booking_guid = $1', [booking.guid])).rowCount, 0);
        }
        for (const booking of [past, ongoing, unaffected]) {
            assert.equal((await db.query('SELECT 1 FROM bookings WHERE guid = $1', [booking.guid])).rowCount, 1);
        }
        assert.equal(await Profiles.remove(resident.guid, 'Deletion admin'), false);
        assert.equal(await Profiles.update(resident.guid, { name: 'Restored', email: stored.email, roles: ['Resident'] }), null);
        assert.equal(await Credits.requestRefund(resident.guid, source.credit.guid), null);
        assert.equal(await Credits.decideRefund(refund.guid, true, 'Admin'), null);
        assert.equal(await Bookings.decideCreditRequest(request.guid, true, 'Admin', true), null);
        assert.equal(await Bookings.requestCredit(resident.guid, past.guid, 'weather', null), null);
        await assert.rejects(Bookings.createBooking(bookingInput(resident)), /profile no longer exists/);
        await assert.rejects(Bookings.addCreditToBooking(facility.guid, past.guid, 'Admin', true), /recipient no longer exists/);
        const replacement = await Bookings.createBooking({
            ...bookingInput(other), starts_at: future.starts_at, ends_at: future.ends_at
        });
        assert.ok(replacement.guid, 'Deleted future booking releases the slot');
    }

    await t.test('daylight template flags persist and generated schedules enforce limits for each facility', async () => {
        const Hours = require('../models/OpeningHours');
        const location = { latitude: 51.5074, longitude: -0.1278 };
        const rules = Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, opens_at: '06:00', closes_at: '22:00' }));
        const template = await Hours.create({ name: 'Daylight integration', rules, dawn_override: true, dusk_override: true });
        const stored = (await Hours.findAll()).find(t => t.guid === template.guid);
        assert.equal(stored.dawn_override, true);
        assert.equal(stored.dusk_override, true);
        const [schedule] = await Hours.getSchedules(template.guid, '2026-12-21T12:00:00Z', 1, location);
        assert.ok(schedule.opens_at >= '08:00' && schedule.opens_at <= '08:10');
        assert.equal(schedule.closes_at, '16:00');
        assert.equal(await Hours.isBookingWithinHours(template.guid, '2026-12-21T07:00:00Z', '2026-12-21T08:00:00Z', location), false);
        assert.equal(await Hours.isBookingWithinHours(template.guid, '2026-12-21T09:00:00Z', '2026-12-21T10:00:00Z', location), true);
        assert.equal(await Hours.isBookingWithinHours(template.guid, '2026-12-21T16:00:00Z', '2026-12-21T17:00:00Z', location), false);
        assert.deepEqual(await Hours.getToday(template.guid, new Date('2026-12-21T12:00:00Z'), location), schedule);
        await Hours.update(template.guid, { name: 'Daylight integration', rules, dawn_override: false, dusk_override: true });
        assert.equal((await Hours.getSchedules(template.guid, '2026-12-21T12:00:00Z', 1, location))[0].opens_at, '06:00');
        await Hours.update(template.guid, { name: 'Daylight integration', rules });
        const [disabled] = await Hours.getSchedules(template.guid, '2026-12-21T12:00:00Z');
        assert.equal(disabled.opens_at, '06:00');
        assert.equal(disabled.closes_at, '22:00');
        await Hours.remove(template.guid);
    });

    await t.test('site sport months apply to every court, isolate sites and sports, and migrate the court union once', async () => {
        const resident = await person();
        const alternative = await Bookings.createOption({
            facility_guid: facility.guid, sport_guid: sport.guid, name: 'Seasonal alternative',
            resource_guids: [resource.guid]
        });
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === option.guid).allowed_months,
            [1,2,3,4,5,6,7,8,9,10,11,12]);
        const { rows: [otherSport] } = await db.query("INSERT INTO sports (name) VALUES ('Season test sport') RETURNING guid");
        await db.query('INSERT INTO facility_sports (facility_guid, sport_guid) VALUES ($1, $2)', [facility.guid, otherSport.guid]);
        const otherOption = await Bookings.createOption({
            facility_guid: facility.guid, sport_guid: otherSport.guid, name: 'Other sport', resource_guids: [resource.guid]
        });
        const { rows: [otherSite] } = await db.query(`
            INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
            VALUES ('Season test site', 'Test road', 'AB1 2CD', 0, 0, '', '') RETURNING guid`);
        await db.query('INSERT INTO facility_sports (facility_guid, sport_guid) VALUES ($1, $2)', [otherSite.guid, sport.guid]);
        await Bookings.updateSportMonths(facility.guid, sport.guid, [4]);
        assert.ok((await Bookings.findOptions(facility.guid)).filter(o => o.sport_guid === sport.guid)
            .every(o => JSON.stringify(o.allowed_months) === '[4]'));
        assert.deepEqual((await Bookings.findFacilitySports(otherSite.guid))[0].allowed_months, [1,2,3,4,5,6,7,8,9,10,11,12]);
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === otherOption.guid).allowed_months,
            [1,2,3,4,5,6,7,8,9,10,11,12]);
        const input = {
            ...bookingInput(resident), starts_at: '2027-03-31T23:00:00Z', ends_at: '2027-04-01T00:00:00Z'
        };
        // UK summer time makes this interval entirely April.
        const aprilBooking = await Bookings.createBooking({ ...input, option_guid: alternative.guid });
        assert.ok(aprilBooking);
        await Bookings.updateSportMonths(facility.guid, sport.guid, [3]);
        await assert.rejects(Bookings.createBooking({ ...input, option_guid: alternative.guid }),
            { code: 'OPTION_MONTH_UNAVAILABLE' });
        await assert.rejects(Bookings.createBooking(input), { code: 'OPTION_MONTH_UNAVAILABLE' });
        assert.ok(await Bookings.findBooking(facility.guid, aprilBooking.guid), 'Existing booking is retained');
        const marchInput = { ...input, starts_at: '2027-03-15T10:00:00Z', ends_at: '2027-03-15T11:00:00Z' };
        assert.ok(await Bookings.createBooking({ ...marchInput, option_guid: alternative.guid }));
        assert.equal(await Bookings.updateSportMonths(crypto.randomUUID(), sport.guid, []), false);
        await assert.rejects(Bookings.updateSportMonths(facility.guid, sport.guid, [13]), /Invalid allowed/);
        await Bookings.updateSportMonths(facility.guid, sport.guid, []);
        const newOption = await Bookings.createOption({
            facility_guid: facility.guid, sport_guid: sport.guid, name: 'New court inherits season', resource_guids: [resource.guid]
        });
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === newOption.guid).allowed_months, []);
        await assert.rejects(Bookings.createBooking({ ...input, option_guid: newOption.guid }), { code: 'OPTION_MONTH_UNAVAILABLE' });
        const countBefore = (await db.query('SELECT COUNT(*)::int AS count FROM bookings')).rows[0].count;
        await assert.rejects(Bookings.createBookings([
            { ...input, option_guid: otherOption.guid, starts_at: '2027-04-02T10:00:00Z', ends_at: '2027-04-02T11:00:00Z' },
            { ...input, option_guid: alternative.guid, starts_at: '2027-04-02T12:00:00Z', ends_at: '2027-04-02T13:00:00Z' }
        ]), { code: 'OPTION_MONTH_UNAVAILABLE' });
        assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM bookings')).rows[0].count, countBefore);
        // The other sport sharing the resource remains available.
        assert.ok(await Bookings.createBooking({ ...input, option_guid: otherOption.guid, starts_at: '2027-04-03T10:00:00Z', ends_at: '2027-04-03T11:00:00Z' }));
        await Bookings.updateSportMonths(facility.guid, sport.guid, [3,5]);
        await assert.rejects(Bookings.createBooking({
            ...input, option_guid: alternative.guid, starts_at: '2027-03-31T22:00:00Z', ends_at: '2027-05-01T01:00:00Z'
        }), { code: 'OPTION_MONTH_UNAVAILABLE' });
        await Bookings.initialize();
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === alternative.guid).allowed_months, [3,5]);
        await db.query('ALTER TABLE bookable_options ADD COLUMN allowed_months integer[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]');
        await db.query('UPDATE bookable_options SET allowed_months = ARRAY[]::integer[] WHERE facility_guid = $1', [facility.guid]);
        await db.query('UPDATE bookable_options SET allowed_months = $2 WHERE guid = $1', [option.guid, [3]]);
        await db.query('UPDATE bookable_options SET allowed_months = $2 WHERE guid = $1', [alternative.guid, [4]]);
        await Bookings.initialize();
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === option.guid).allowed_months, [3,4]);
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === otherOption.guid).allowed_months, []);
        assert.deepEqual((await Bookings.findFacilitySports(otherSite.guid))[0].allowed_months, [1,2,3,4,5,6,7,8,9,10,11,12]);
        await Bookings.updateSportMonths(facility.guid, sport.guid, [7]);
        await Bookings.initialize();
        assert.deepEqual((await Bookings.findOptions(facility.guid)).find(o => o.guid === alternative.guid).allowed_months, [7]);
        await Bookings.updateSportMonths(facility.guid, sport.guid, [1,2,3,4,5,6,7,8,9,10,11,12]);
    });

    await t.test('migration links historical credits, preserves totals, labels unmatched balances and is idempotent', async () => {
        const { rows: [existing] } = await db.query('SELECT COUNT(*)::int AS count FROM credits');
        assert.equal(existing.count, 0, 'Use a fresh, empty test database');
        const profile = await person(1300);
        const old = await Bookings.createBooking(bookingInput(profile));
        await db.query(`
            UPDATE bookings SET credited_pence = 1000, credited_at = now() - INTERVAL '2 days' WHERE guid = $1`, [old.guid]);
        await db.query(`
            INSERT INTO booking_refunds (guid, booking_ref, facility_name, starts_at, ends_at, profile_guid,
                                         refunded_pence, refunded_at)
            VALUES (gen_random_uuid(), 'AH-LEGACY', 'Deleted booking', now(), now(), $1, 1000, now() - INTERVAL '1 day')`,
        [profile.guid]);
        const unmatched = await person(250);
        await db.query("DELETE FROM credit_migrations WHERE name = 'opening-balances'");
        await Credits.initialize();
        const credits = await Credits.findForProfile(profile.guid);
        assert.equal(credits.length, 2);
        assert.ok(credits.every(credit => !credit.refundable));
        assert.equal(credits.find(credit => credit.booking_guid === old.guid).remaining_pence, 300);
        assert.equal(credits.find(credit => credit.booking_ref === 'AH-LEGACY').remaining_pence, 1000);
        assert.equal(await balance(profile), 1300);
        assert.equal(await balance(unmatched), 250);
        assert.match((await Credits.findForProfile(unmatched.guid))[0].facility_name, /Opening balance/);
        await Credits.initialize();
        assert.equal((await Credits.findForProfile(profile.guid)).length, 2);
        assert.equal(await balance(profile), 1300);
    });

    await t.test('course section inheritance persists live defaults, independent overrides and appended sections', async () => {
        const Sports = require('../models/Sports');
        const Courses = require('../models/Courses');
        const { randomUUID } = require('node:crypto');
        const age = { id: randomUUID(), heading: 'Age', text: 'Default age' };
        const refunds = { id: randomUUID(), heading: 'Refunds', text: 'Default refunds' };
        const extra = { id: randomUUID(), heading: 'Extra', text: 'Course only' };
        const source = await Sports.create('Section inheritance fixture', [age, refunds]);
        const details = { name: 'Section course', description: 'Original retained',
            sport_guids: [source.guid, sport.guid], description_sport_guid: source.guid,
            description_overrides: { [age.id]: { heading: 'Course age', text: 'Unique age' } },
            description_sections: [extra] };
        const course = await Courses.create(details);
        const read = async () => (await Courses.findAll()).find(c => c.guid === course.guid);
        assert.deepEqual((await read()).resolved_sections.map(s => s.text), ['Unique age', 'Default refunds', 'Course only']);
        await Sports.update(source.guid, source.name, [refunds, { ...age, text: 'Changed age default' }]);
        assert.deepEqual((await read()).resolved_sections.map(s => s.text), ['Default refunds', 'Unique age', 'Course only']);
        assert.equal((await read()).description, 'Original retained');
        await assert.rejects(Courses.update(course.guid, { ...details, sport_guids: [sport.guid] }), /assigned sport/);
        await assert.rejects(Courses.update(course.guid, { ...details, description_overrides: { [randomUUID()]: age } }), /current sport sections/);
        assert.equal((await read()).resolved_sections.length, 3);
        await Courses.update(course.guid, { ...details, description_sport_guid: null, description_overrides: {} });
        assert.deepEqual((await read()).resolved_sections, [extra]);
        await Courses.remove(course.guid);
        await Sports.remove(source.guid);
    });

    await t.test('course run prices count only future session starts and hide completed or draft runs', async () => {
        const Courses = require('../models/Courses');
        const course = await Courses.create({ name: 'Session price test', sport_guids: [sport.guid] });
        const { rows: [run] } = await db.query(`INSERT INTO course_runs
            (course_guid, facility_guid, name, full_price_pence, capacity, published)
            VALUES ($1,$2,'Tuesday',1000,12,true) RETURNING guid`, [course.guid, facility.guid]);
        await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
            VALUES ($1, now()-interval '30 minutes', now()+interval '30 minutes'),
                   ($1, now()+interval '1 day', now()+interval '1 day 1 hour'),
                   ($1, now()+interval '2 days', now()+interval '2 days 1 hour')`, [run.guid]);
        const visible = (await Courses.findAll({ availableOnly: true })).find(item => item.guid === course.guid);
        assert.equal(visible.runs[0].current_price_pence, 667);
        assert.equal(visible.runs[0].remaining_sessions, 2);
        assert.equal(visible.runs[0].total_sessions, 3);
        assert.equal(visible.runs[0].sessions.length, 2);
        const adminRun = (await Courses.findAll()).find(item => item.guid === course.guid).runs[0];
        assert.equal(adminRun.sessions.length, 3);
        assert.deepEqual(visible.runs[0].sessions, adminRun.sessions.slice(1));
        assert.equal(adminRun.current_price_pence, 667);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM course_sessions WHERE run_guid=$1',
            [run.guid])).rows[0].count, 3);
        await db.query('UPDATE course_runs SET published=false WHERE guid=$1', [run.guid]);
        assert.ok(!(await Courses.findAll({ availableOnly: true })).some(item => item.guid === course.guid));
        await db.query('UPDATE course_runs SET published=true WHERE guid=$1', [run.guid]);
        await db.query("UPDATE course_sessions SET starts_at=starts_at-interval '1 year', ends_at=ends_at-interval '1 year' WHERE run_guid=$1", [run.guid]);
        assert.ok(!(await Courses.findAll({ availableOnly: true })).some(item => item.guid === course.guid));
        assert.equal((await Courses.findAll()).find(item => item.guid === course.guid).runs[0].current_price_pence, 0);
        await Courses.remove(course.guid);
    });

    await t.test('course baskets persist family attendees, use credit atomically and prevent duplicate enrolments and overselling', async () => {
        const Orders = require('../models/CourseOrders');
        const Courses = require('../models/Courses');
        const buyer = await person();
        const rival = await person();
        await granted(buyer);
        const member = await Orders.addFamilyMember(buyer.guid, 'Test child');
        assert.equal((await Orders.familyMembers(buyer.guid))[0].name, 'Test child');
        await assert.rejects(Orders.add(rival.guid, crypto.randomUUID(), member.guid, '/courses'), /saved family member/);
        const { rows: [course] } = await db.query("INSERT INTO courses(name) VALUES ('Basket course') RETURNING guid");
        const { rows: [run] } = await db.query(`
            INSERT INTO course_runs(course_guid,facility_guid,name,full_price_pence,capacity,published)
            VALUES ($1,$2,'Tuesday',3000,2,true) RETURNING guid`, [course.guid, facility.guid]);
        await db.query(`INSERT INTO course_sessions(run_guid,starts_at,ends_at) VALUES
            ($1,now()-interval '2 days',now()-interval '2 days'+interval '1 hour'),
            ($1,now()+interval '2 days',now()+interval '2 days 1 hour'),
            ($1,now()+interval '9 days',now()+interval '9 days 1 hour')`, [run.guid]);
        await Orders.add(buyer.guid, run.guid, member.guid, '/facilities#test-hall');
        await Orders.add(buyer.guid, run.guid, member.guid, '/facilities#test-hall');
        let basket = await Orders.basket(buyer.guid);
        assert.equal(basket.items.length, 1);
        assert.equal(await Orders.itemCount(buyer.guid), 1);
        assert.equal(await Orders.itemCount(rival.guid), 0);
        assert.equal(basket.return_to, '/facilities#test-hall');
        assert.equal(basket.total, 2000);
        assert.equal(basket.credit, 1000);
        await assert.rejects(Orders.pay(buyer.guid, basket.revision, { total: 1, credit: 0 }, 'SIM-TEST'), /changed/);
        assert.equal(await balance(buyer), 1000);
        const order = await Orders.pay(buyer.guid, basket.revision, { total: basket.total, credit: basket.credit }, 'SIM-TEST');
        assert.equal((await Orders.pay(buyer.guid, basket.revision, { total: basket.total, credit: basket.credit }, 'SIM-TEST')).guid, order.guid);
        assert.equal((await Orders.basket(buyer.guid)).items.length, 0);
        assert.equal(await Orders.itemCount(buyer.guid), 0);
        assert.equal(await balance(buyer), 0);
        const confirmed = await Orders.order(buyer.guid, order.guid);
        assert.equal(confirmed.items[0].attendee_name, 'Test child');
        assert.equal(confirmed.items[0].sessions.length, 2);
        assert.equal(confirmed.items[0].credit_applied_pence, 1000);
        assert.equal(await Orders.order(rival.guid, order.guid), null);
        assert.equal((await db.query('SELECT sum(amount_pence)::int AS pence FROM credit_spending WHERE booking_guid = $1',
            [confirmed.items[0].guid])).rows[0].pence, 1000);
        assert.equal((await Courses.findRuns()).find(r => r.guid === run.guid).spaces_remaining, 1);
        await assert.rejects(Orders.add(buyer.guid, run.guid, member.guid, '/courses'), /already enrolled/);

        // Two customers can basket the last place, but only one can purchase it.
        await Orders.add(buyer.guid, run.guid, 'self', '/courses');
        await Orders.add(rival.guid, run.guid, 'self', '/courses');
        const first = await Orders.basket(buyer.guid);
        const second = await Orders.basket(rival.guid);
        const outcomes = await Promise.allSettled([
            Orders.pay(buyer.guid, first.revision, { total: first.total, credit: first.credit }, 'SIM-FIRST'),
            Orders.pay(rival.guid, second.revision, { total: second.total, credit: second.credit }, 'SIM-SECOND')
        ]);
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'BASKET_CONFLICT');
        assert.equal((await Courses.findRuns()).find(r => r.guid === run.guid).spaces_remaining, 0);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM course_enrolments WHERE run_guid=$1', [run.guid])).rows[0].count, 2);

        const another = await Orders.addFamilyMember(rival.guid, 'Another child');
        await Orders.removeFamilyMember(buyer.guid, another.guid).then(() => assert.fail('Foreign member removed'),
            error => assert.match(error.message, /no longer available/));
        await Orders.removeFamilyMember(rival.guid, another.guid);
        assert.equal((await Orders.familyMembers(rival.guid)).length, 0);
        await Orders.removeFamilyMember(buyer.guid, member.guid);
        assert.equal((await Orders.order(buyer.guid, order.guid)).items[0].attendee_name, 'Test child');
        await assert.rejects(Courses.removeRun(run.guid, course.guid), { constraint: 'course_enrolments_run_guid_fkey' });
        await assert.rejects(Courses.saveRun(run.guid, course.guid, {
            facility_guid: facility.guid, name: 'Tuesday', full_price_pence: 3000, capacity: 1,
            sessions: [{ starts_local: '2090-01-05 18:00', ends_local: '2090-01-05 19:00' }]
        }), { code: 'COURSE_CAPACITY' });

        const covered = await person();
        await granted(covered);
        const { rows: [creditRun] } = await db.query(`
            INSERT INTO course_runs(course_guid,facility_guid,name,full_price_pence,capacity,published)
            VALUES ($1,$2,'Credit run',500,3,true) RETURNING guid`, [course.guid, facility.guid]);
        await db.query(`INSERT INTO course_sessions(run_guid,starts_at,ends_at)
            VALUES ($1,now()+interval '3 days',now()+interval '3 days 1 hour')`, [creditRun.guid]);
        await Orders.add(covered.guid, creditRun.guid, 'self', '/courses');
        basket = await Orders.basket(covered.guid);
        assert.equal(basket.due, 0);
        await db.query('UPDATE course_runs SET full_price_pence=600 WHERE guid=$1', [creditRun.guid]);
        await assert.rejects(Orders.pay(covered.guid, basket.revision, { total: basket.total, credit: basket.credit }, 'CREDIT'), /changed/);
        assert.equal(await balance(covered), 1000);
        basket = await Orders.basket(covered.guid);
        await Orders.pay(covered.guid, basket.revision, { total: basket.total, credit: basket.credit }, 'CREDIT');
        assert.equal(await balance(covered), 400);
        const archived = await Orders.addFamilyMember(covered.guid, 'Archived child');
        await Orders.add(covered.guid, creditRun.guid, archived.guid, '/courses');
        await Orders.removeFamilyMember(covered.guid, archived.guid);
        assert.equal((await Orders.basket(covered.guid)).valid, false);
        assert.match((await Orders.basket(covered.guid)).items[0].error, /no longer available/);
    });

    await t.test('multiple child profiles preserve member IDs, inherit live contacts and isolate ownership', async () => {
        const Children = require('../models/Children');
        const Orders = require('../models/CourseOrders');
        const Profiles = require('../models/Profiles');
        const parent = await person();
        const other = await person();
        const oldMember = await Orders.addFamilyMember(parent.guid, 'Existing child');
        const input = { name: 'Updated child', inherit_address: 'yes', inherit_parental_contact: 'yes',
            inherit_emergency_contact: 'no', emergency_contact_name: 'Guardian', emergency_contact_telephone: '12345',
            medical_concern: 'yes', medical_conditions: ['asthma'], activity_limitation: 'no',
            membership_number: 'CHILD-1', interest_sport_guids: [sport.guid] };
        await Children.save(parent.guid, oldMember.guid, input);
        assert.equal((await Children.find(parent.guid, oldMember.guid)).name, 'Updated child');
        const second = await Children.save(parent.guid, null, { ...input, name: 'Second child', medical_concern: 'no' });
        assert.equal((await Orders.familyMembers(parent.guid)).length, 2);
        await Children.save(parent.guid, oldMember.guid, { ...input, date_of_birth: '2010-01-01' });
        await Children.save(parent.guid, second.guid, { ...input, name: 'Second child', date_of_birth: '2020-01-01' });
        assert.deepEqual((await Orders.familyMembers(parent.guid)).map(child => child.guid), [second.guid, oldMember.guid]);
        assert.equal((await Children.find(parent.guid, second.guid)).date_of_birth, '2020-01-01');
        assert.equal(await Children.find(other.guid, oldMember.guid), null);
        assert.equal(await Children.save(other.guid, oldMember.guid, { ...input, name: 'Tampered' }), null);
        await db.query("UPDATE profiles SET address_line_1='Parent address', telephone='555', emergency_contact_name='Parent emergency' WHERE guid=$1", [parent.guid]);
        const child = await Children.find(parent.guid, oldMember.guid);
        assert.deepEqual(child.medical_conditions, ['asthma']);
        assert.equal(child.membership_number, 'CHILD-1');
        assert.deepEqual(child.interest_sport_guids, [sport.guid]);
        let resolved = Children.resolve(child, await Profiles.findByGuid(parent.guid));
        assert.equal(resolved.address_line_1, 'Parent address');
        assert.equal(resolved.parental_contact_telephone, '555');
        assert.equal(resolved.emergency_contact_name, 'Guardian');
        await db.query("UPDATE profiles SET address_line_1='New address' WHERE guid=$1", [parent.guid]);
        assert.equal(Children.resolve(child, await Profiles.findByGuid(parent.guid)).address_line_1, 'New address');
        await Children.save(parent.guid, second.guid, { ...input, name: 'Second child', inherit_address: 'no', address_line_1: 'Other address' });
        resolved = Children.resolve(await Children.find(parent.guid, second.guid), await Profiles.findByGuid(parent.guid));
        assert.equal(resolved.address_line_1, 'Other address');
        await Orders.removeFamilyMember(parent.guid, oldMember.guid);
        assert.equal(await Children.find(parent.guid, oldMember.guid), null);
        assert.equal(await Children.save(parent.guid, oldMember.guid, input), null);
        await assert.rejects(Children.save(parent.guid, null, { ...input, interest_sport_guids: [crypto.randomUUID()] }),
            Children.ChildInputError);
    });

    await t.test('upcoming course bookings include self and archived children but exclude other owners and completed places', async () => {
        const Orders = require('../models/CourseOrders');
        const parent = await person();
        const other = await person();
        const child = await Orders.addFamilyMember(parent.guid, 'Booked child');
        const { rows: [run] } = await db.query('SELECT guid FROM course_runs LIMIT 1');
        assert.ok(run);
        const future = new Date(Date.now() + 86400000).toISOString();
        const end = new Date(Date.now() + 90000000).toISOString();
        const past = new Date(Date.now() - 86400000).toISOString();
        for (const [owner, member, name, sessions] of [
            [parent.guid, null, 'Parent', [{ starts_at: past, ends_at: past }, { starts_at: future, ends_at: end }]],
            [parent.guid, child.guid, 'Booked child', [{ starts_at: future, ends_at: end }]],
            [other.guid, null, 'Other parent', [{ starts_at: future, ends_at: end }]]
        ]) {
            const { rows: [order] } = await db.query(`INSERT INTO course_orders
                (profile_guid, checkout_token, total_pence, credit_pence, payment_reference)
                VALUES ($1, $2, 0, 0, 'TEST') RETURNING guid`, [owner, crypto.randomUUID()]);
            await db.query(`INSERT INTO course_enrolments
                (order_guid, run_guid, profile_guid, member_guid, attendee_name, course_name, run_name,
                 facility_name, sessions, amount_pence, credit_applied_pence, booking_ref)
                VALUES ($1,$2,$3,$4,$5,'Course','Run','Hall',$6,0,0,$7)`,
            [order.guid, run.guid, owner, member, name, JSON.stringify(sessions), crypto.randomUUID()]);
        }
        await Orders.removeFamilyMember(parent.guid, child.guid);
        let bookings = await Orders.upcomingForProfile(parent.guid);
        assert.deepEqual(bookings.map(booking => booking.attendee_name).sort(), ['Booked child', 'Parent']);
        assert.ok(bookings.every(booking => booking.sessions.length === 1 && booking.sessions[0].starts_at === future));
        await db.query(`UPDATE course_enrolments SET sessions = $2 WHERE profile_guid = $1 AND member_guid IS NULL`,
            [parent.guid, JSON.stringify([{ starts_at: past, ends_at: past }])]);
        bookings = await Orders.upcomingForProfile(parent.guid);
        assert.deepEqual(bookings.map(booking => booking.attendee_name), ['Booked child']);
        assert.deepEqual(await Orders.upcomingForProfile(crypto.randomUUID()), []);
    });

    await t.test('independent profile section saves preserve unrelated data and unanswered legacy health', async () => {
        const Profiles = require('../models/Profiles');
        const Children = require('../models/Children');
        const Orders = require('../models/CourseOrders');
        const parent = await person(250);
        const other = await person();
        const before = await Profiles.findByGuid(parent.guid);
        await Promise.all([
            Profiles.updateDetails(parent.guid, { membership_number: 'PARENT', name: 'Ignored' }, 'membership'),
            Profiles.updateDetails(parent.guid, { address_line_1: 'Parent address' }, 'address')
        ]);
        let adult = await Profiles.findByGuid(parent.guid);
        assert.equal(adult.name, before.name);
        assert.equal(adult.email, before.email);
        assert.equal(adult.medical_concern, null);
        assert.equal(adult.credit_pence, before.credit_pence);
        assert.equal(adult.membership_number, 'PARENT');
        assert.equal(adult.address_line_1, 'Parent address');
        const child = await Orders.addFamilyMember(parent.guid, 'Legacy child');
        await Promise.all([
            Children.save(parent.guid, child.guid, { membership_number: ' CHILD ', name: 'Ignored' }, 'membership'),
            Children.save(parent.guid, child.guid, { name: 'New name', date_of_birth: '2020-01-01' }, 'name')
        ]);
        let saved = await Children.find(parent.guid, child.guid);
        assert.equal(saved.membership_number, 'CHILD');
        assert.equal(saved.name, 'New name');
        assert.equal(saved.date_of_birth, '2020-01-01');
        assert.equal(saved.medical_concern, null);
        assert.equal(saved.activity_limitation, null);
        assert.equal(saved.inherit_address, true);
        await Children.save(parent.guid, child.guid, {
            inherit_address: 'no', address_line_1: 'Child address'
        }, 'address');
        assert.equal((await Children.find(parent.guid, child.guid)).address_line_1, 'Child address');
        await Children.save(parent.guid, child.guid, { inherit_address: 'yes', address_line_1: 'Ignored' }, 'address');
        saved = await Children.find(parent.guid, child.guid);
        assert.equal(saved.address_line_1, null);
        assert.equal(Children.resolve(saved, adult).address_line_1, 'Parent address');
        await Children.save(parent.guid, child.guid, {
            medical_concern: 'yes', medical_conditions: ['other'], medical_other: 'Test concern', activity_limitation: 'no'
        }, 'health');
        await Children.save(parent.guid, child.guid, {
            medical_concern: 'no', medical_conditions: ['other'], medical_other: 'Stale', activity_limitation: 'no'
        }, 'health');
        saved = await Children.find(parent.guid, child.guid);
        assert.deepEqual(saved.medical_conditions, []);
        assert.equal(saved.medical_other, null);
        assert.equal(saved.membership_number, 'CHILD');
        assert.equal(await Children.save(other.guid, child.guid, { membership_number: 'OTHER' }, 'membership'), null);
        await assert.rejects(Children.save(parent.guid, child.guid, { name: '' }, 'name'), Children.ChildInputError);
        await Orders.removeFamilyMember(parent.guid, child.guid);
        assert.equal(await Children.save(parent.guid, child.guid, { membership_number: 'ARCHIVED' }, 'membership'), null);
    });

    await t.test('self-service contact details persist without changing roles or booking credit', async () => {
        const Profiles = require('../models/Profiles');
        const resident = await person(250);
        const before = await Profiles.findByGuid(resident.guid);
        const details = { name: before.name, email: before.email, telephone: '+44 (0)20 1234 5678',
            emergency_contact_name: 'Emergency Person', emergency_contact_telephone: '07700 900123',
            address_line_1: '1 Test Street', address_line_2: 'Flat 2', town_city: 'London', county: 'Greater London', postcode: 'NW1 1AA',
            medical_concern: true, medical_conditions: ['asthma', 'other'], medical_other: 'Test concern',
            activity_limitation: 'limited_a_lot', membership_number: 'ABC 123-X' };
        await Profiles.updateDetails(resident.guid, { ...details, roles: ['Administrator'], credit_pence: 999999 });
        const stored = await Profiles.findByGuid(resident.guid);
        for (const [field, value] of Object.entries(details)) assert.deepEqual(stored[field], value);
        for (const row of [...await Profiles.findAll(), ...await Profiles.search(before.name)]) {
            for (const field of ['medical_concern', 'medical_conditions', 'medical_other', 'activity_limitation']) {
                assert.equal(Object.hasOwn(row, field), false);
            }
        }
        assert.deepEqual(stored.roles, before.roles);
        assert.equal(stored.credit_pence, before.credit_pence);
        await Profiles.updateDetails(resident.guid, { ...details, telephone: null,
            emergency_contact_name: null, emergency_contact_telephone: null,
            address_line_1: null, address_line_2: null, town_city: null, county: null, postcode: null,
            medical_concern: false, activity_limitation: 'no', membership_number: null });
        const cleared = await Profiles.findByGuid(resident.guid);
        assert.equal(cleared.telephone, null);
        assert.equal(cleared.emergency_contact_name, null);
        assert.equal(cleared.emergency_contact_telephone, null);
        for (const field of ['address_line_1', 'address_line_2', 'town_city', 'county', 'postcode']) assert.equal(cleared[field], null);
        assert.equal(cleared.medical_concern, false);
        assert.deepEqual(cleared.medical_conditions, []);
        assert.equal(cleared.medical_other, null);
        assert.equal(cleared.activity_limitation, 'no');
        assert.equal(cleared.membership_number, null);
    });

    await t.test('profile sport interests persist, follow renamed sports and omit deleted sports', async () => {
        const Profiles = require('../models/Profiles');
        const Sports = require('../models/Sports');
        const resident = await person();
        const before = await Profiles.findByGuid(resident.guid);
        const first = await Sports.create('Interest test sport');
        const second = await Sports.create('Second interest test sport');
        try {
            const details = { name: before.name, email: before.email,
                interest_sport_guids: [first.guid, second.guid] };
            await Profiles.updateDetails(resident.guid, details);
            assert.deepEqual(new Set((await Profiles.findByGuid(resident.guid)).interest_sport_guids),
                new Set(details.interest_sport_guids));
            await Sports.update(first.guid, 'Renamed interest test sport');
            assert.ok((await Profiles.findByGuid(resident.guid)).interest_sport_guids.includes(first.guid));
            await Sports.remove(second.guid);
            assert.deepEqual((await Profiles.findByGuid(resident.guid)).interest_sport_guids, [first.guid]);
            await Profiles.updateDetails(resident.guid, { ...details, interest_sport_guids: [] });
            const cleared = await Profiles.findByGuid(resident.guid);
            assert.deepEqual(cleared.interest_sport_guids, []);
            assert.deepEqual(cleared.roles, before.roles);
            assert.equal(cleared.credit_pence, before.credit_pence);
        } finally {
            await Sports.remove(first.guid);
            await Sports.remove(second.guid);
        }
    });

    await t.test('profile deletion removes future bookings, cancels requests and preserves inactive history', profileDeletion);

    await t.test('concurrent deletion and booking creation cannot leave active bookings for a deleted profile', async () => {
        const Profiles = require('../models/Profiles');
        const resident = await person();
        const input = bookingInput(resident);
        const results = await Promise.allSettled([
            Profiles.remove(resident.guid, 'Deletion admin'),
            Bookings.createBooking(input)
        ]);
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[0].value, true);
        if (results[1].status === 'rejected') assert.match(results[1].reason.message, /profile no longer exists/);
        assert.equal(await Profiles.findByGuid(resident.guid), null);
        assert.equal((await db.query('SELECT 1 FROM bookings WHERE profile_guid = $1', [resident.guid])).rowCount, 0);
    });

    await t.test('granting credit is once per booking and refundability is administrator-selected', async () => {
        const profile = await person();
        const { booking, credit } = await granted(profile, false);
        assert.equal(credit.refundable, false);
        assert.equal(credit.booking_ref, booking.booking_ref);
        assert.equal(await Credits.requestRefund(profile.guid, credit.guid), null);
        assert.equal(await Bookings.addCreditToBooking(facility.guid, booking.guid, 'Admin', true), null);
        assert.equal(await balance(profile), 1000);
    });

    await t.test('mixed funding retains original refund eligibility across manual, weather, automatic and cancellation credits', async () => {
        const Settings = require('../models/Settings');
        for (const method of ['manual-refundable', 'manual-non-refundable', 'weather', 'automatic', 'cancel']) {
            const resident = await person(800);
            for (const [amount, refundable] of [[300, true], [500, false]]) {
                await db.query(`
                    INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
                    VALUES ($1, 'Original funding', $2, $2, $3)`, [resident.guid, amount, refundable]);
            }
            const [booking] = await Bookings.createBookings([
                { ...bookingInput(resident), credit_applied_pence: 800 }
            ], { profile_guid: resident.guid, pence: 800 });
            const allocations = await db.query('SELECT amount_pence, refundable FROM credit_spending WHERE booking_guid = $1', [booking.guid]);
            assert.equal(allocations.rows.filter(a => a.refundable).reduce((sum, a) => sum + a.amount_pence, 0), 300);
            const funded = (await Bookings.findBookings(facility.guid)).find(b => b.guid === booking.guid);
            assert.equal(funded.card_paid_pence, 200);
            assert.equal(funded.refundable_credit_pence, 300);
            assert.equal(funded.non_refundable_credit_pence, 500);
            assert.equal(funded.untraced_credit_pence, 0);
            let request;
            if (method === 'weather' || method === 'automatic') {
                await db.query('UPDATE bookings SET starts_at = $2, ends_at = $3 WHERE guid = $1',
                    [booking.guid, new Date(Date.now() - 7200000), new Date(Date.now() - 3600000)]);
                request = await Bookings.requestCredit(resident.guid, booking.guid, 'weather', null);
                const queued = (await Bookings.findCreditRequests()).find(r => r.guid === request.guid);
                assert.equal(queued.non_refundable_credit_pence, 500);
                if (method === 'automatic') {
                    await Settings.set('credit_slot_auto_approval', '1');
                    await Bookings.decideCreditRequest(request.guid, true, 'Admin', false, null, true);
                    const later = await person(1000);
                    await db.query(`
                        INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
                        VALUES ($1, 'School allocation', 1000, 1000, false)`, [later.guid]);
                    const [laterBooking] = await Bookings.createBookings([
                        { ...bookingInput(later), credit_applied_pence: 1000 }
                    ], { profile_guid: later.guid, pence: 1000 });
                    await db.query(`
                        UPDATE bookings SET starts_at = b.starts_at, ends_at = b.ends_at
                        FROM bookings b WHERE bookings.guid = $1 AND b.guid = $2`, [laterBooking.guid, booking.guid]);
                    const automatic = await Bookings.requestCredit(later.guid, laterBooking.guid, 'weather', null);
                    assert.equal(automatic.auto_approved, true);
                    const laterCredits = await Credits.findForProfile(later.guid);
                    assert.equal(laterCredits.length, 1);
                    assert.equal(laterCredits[0].refundable, false);
                    await Settings.set('credit_slot_auto_approval', '0');
                    await db.query(`
                        DELETE FROM credit_auto_approval_slots s USING bookings b
                        WHERE b.guid = $1 AND s.starts_at = b.starts_at AND s.ends_at = b.ends_at`, [booking.guid]);
                } else {
                    const decision = await Bookings.decideCreditRequest(request.guid, true, 'Admin', false);
                    assert.equal(decision.refundable_pence, 500);
                    assert.equal(decision.non_refundable_pence, 500);
                }
            } else if (method === 'cancel') {
                assert.equal(await Bookings.removeBookingWithCredit(facility.guid, booking.guid, resident.guid, 1000, 'Admin', true), true);
            } else {
                assert.equal(await Bookings.addCreditToBooking(facility.guid, booking.guid, 'Admin', method === 'manual-refundable'), 1000);
            }
            const expected = method === 'manual-non-refundable' ? 300 : 500;
            const reissued = (await Credits.findForProfile(resident.guid)).filter(c => c.booking_guid === booking.guid);
            assert.equal(reissued.length, 2);
            assert.equal(reissued.filter(c => c.refundable).reduce((sum, c) => sum + c.remaining_pence, 0), expected);
            assert.equal(reissued.filter(c => !c.refundable).reduce((sum, c) => sum + c.remaining_pence, 0), 1000 - expected);
            assert.equal(await balance(resident), 1000);
            const historical = (await Bookings.search({ reference: booking.booking_ref })).bookings[0];
            assert.equal(historical.credit_applied_pence, 800);
            assert.equal(historical.non_refundable_credit_pence, 500);
            assert.equal(await Credits.requestRefund(resident.guid, reissued.find(c => !c.refundable).guid), null);
            // A second all-credit booking must not increase cash eligibility, even with another weather award.
            const [again] = await Bookings.createBookings([
                { ...bookingInput(resident), credit_applied_pence: 1000 }
            ], { profile_guid: resident.guid, pence: 1000 });
            await Bookings.addCreditToBooking(facility.guid, again.guid, 'Admin', true);
            const returned = await Credits.findForProfile(resident.guid);
            assert.equal(returned.filter(c => c.refundable).reduce((sum, c) => sum + c.remaining_pence, 0), expected);
            assert.equal(await balance(resident), 1000);
            const eligible = returned.find(c => c.refundable);
            const refund = await Credits.requestRefund(resident.guid, eligible.guid);
            assert.equal((await Credits.decideRefund(refund.guid, true, 'Admin')).refunded_pence, expected);
            assert.equal(await balance(resident), 1000 - expected);
        }
    });

    await t.test('discretionary non-refundable approval overrides refundable source credit permanently', async () => {
        for (const [creditPence, sourceRefundable, approveRefundable, expectedRefundable] of [
            [1000, true, false, 0],
            [600, true, false, 0],
            [600, true, true, 1000],
            [600, false, true, 400]
        ]) {
            const resident = await person(creditPence);
            await db.query(`
                INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
                VALUES ($1, 'Original allocation', $2, $2, $3)`, [resident.guid, creditPence, sourceRefundable]);
            const [booking] = await Bookings.createBookings([
                { ...bookingInput(resident), credit_applied_pence: creditPence }
            ], { profile_guid: resident.guid, pence: creditPence });
            await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '2 hours', ends_at = now() - INTERVAL '1 hour' WHERE guid = $1", [booking.guid]);
            const request = await Bookings.requestCredit(resident.guid, booking.guid, 'discretionary', 'Court closed');
            const decision = await Bookings.decideCreditRequest(request.guid, true, 'Admin', approveRefundable);
            assert.equal(decision.refundable_pence, expectedRefundable);
            assert.equal(decision.non_refundable_pence, 1000 - expectedRefundable);
            const credits = await Credits.findForProfile(resident.guid);
            assert.equal(credits.filter(c => c.refundable).reduce((sum, c) => sum + c.remaining_pence, 0), expectedRefundable);
            assert.equal(await balance(resident), 1000);
            for (const credit of credits.filter(c => !c.refundable)) {
                assert.equal(await Credits.requestRefund(resident.guid, credit.guid), null);
            }
            if (!approveRefundable) {
                const [again] = await spend(resident, 1000);
                await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '2 hours', ends_at = now() - INTERVAL '1 hour' WHERE guid = $1", [again.guid]);
                const weather = await Bookings.requestCredit(resident.guid, again.guid, 'weather', null);
                const reissued = await Bookings.decideCreditRequest(weather.guid, true, 'Weather admin', true);
                assert.equal(reissued.refundable_pence, 0);
                assert.equal(reissued.non_refundable_pence, 1000);
                assert.equal(await balance(resident), 1000);
            }
        }
    });

    await t.test('wholly non-refundable and untraced credits cannot become cash-refundable', async () => {
        for (const tracked of [true, false]) {
            const resident = await person(tracked ? 1000 : 0);
            let booking;
            if (tracked) {
                await db.query(`
                    INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
                    VALUES ($1, 'School allocation', 1000, 1000, false)`, [resident.guid]);
                [booking] = await Bookings.createBookings([
                    { ...bookingInput(resident), credit_applied_pence: 1000 }
                ], { profile_guid: resident.guid, pence: 1000 });
            } else {
                booking = await Bookings.createBooking(bookingInput(resident));
                await db.query('UPDATE bookings SET credit_applied_pence = 1000 WHERE guid = $1', [booking.guid]);
            }
            const funding = (await Bookings.search({ reference: booking.booking_ref })).bookings[0];
            assert.equal(funding.untraced_credit_pence, tracked ? 0 : 1000);
            await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '2 hours', ends_at = now() - INTERVAL '1 hour' WHERE guid = $1", [booking.guid]);
            const request = await Bookings.requestCredit(resident.guid, booking.guid, 'weather', null);
            await Bookings.decideCreditRequest(request.guid, true, 'Admin', true);
            const credits = await Credits.findForProfile(resident.guid);
            assert.equal(credits.length, 1);
            assert.equal(credits[0].refundable, false);
            assert.equal(credits[0].remaining_pence, 1000);
            assert.equal(await Credits.requestRefund(resident.guid, credits[0].guid), null);
        }
    });

    await t.test('legacy allocation eligibility is backfilled once and cancelled booking funding survives migration', async () => {
        const resident = await person(600);
        const { rows: [source] } = await db.query(`
            INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
            VALUES ($1, 'Legacy school allocation', 600, 600, false) RETURNING guid`, [resident.guid]);
        const [booking] = await Bookings.createBookings([
            { ...bookingInput(resident), credit_applied_pence: 600 }
        ], { profile_guid: resident.guid, pence: 600 });
        await db.query('UPDATE credit_spending SET refundable = NULL WHERE booking_guid = $1', [booking.guid]);
        await Credits.initialize();
        assert.equal((await db.query('SELECT refundable FROM credit_spending WHERE booking_guid = $1', [booking.guid])).rows[0].refundable, false);
        await db.query('UPDATE credits SET refundable = true WHERE guid = $1', [source.guid]);
        await Credits.initialize();
        assert.equal((await db.query('SELECT refundable FROM credit_spending WHERE booking_guid = $1', [booking.guid])).rows[0].refundable, false);
        await Bookings.removeBookingWithCredit(facility.guid, booking.guid, resident.guid, 1000, 'Admin', true);
        await db.query('UPDATE booking_refunds SET credit_applied_pence = 0 WHERE guid = $1', [booking.guid]);
        await Credits.initialize();
        const historical = (await Bookings.search({ reference: booking.booking_ref })).bookings[0];
        assert.equal(historical.credit_applied_pence, 600);
        assert.equal(historical.card_paid_pence, 400);
        assert.equal(historical.non_refundable_credit_pence, 600);
    });

    await t.test('inconsistent funding rolls back the award rather than granting excess refundable credit', async () => {
        const resident = await person(1000);
        await db.query(`
            INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, refundable)
            VALUES ($1, 'Test allocation', 1000, 1000, false)`, [resident.guid]);
        const [booking] = await Bookings.createBookings([
            { ...bookingInput(resident), credit_applied_pence: 1000 }
        ], { profile_guid: resident.guid, pence: 1000 });
        await db.query('UPDATE bookings SET credit_applied_pence = 900 WHERE guid = $1', [booking.guid]);
        await assert.rejects(Bookings.addCreditToBooking(facility.guid, booking.guid, 'Admin', true), /funding history/);
        assert.equal((await db.query('SELECT credited_at FROM bookings WHERE guid = $1', [booking.guid])).rows[0].credited_at, null);
        assert.equal((await db.query('SELECT 1 FROM credits WHERE booking_guid = $1', [booking.guid])).rowCount, 0);
        assert.equal(await balance(resident), 0);
        await db.query('UPDATE bookings SET credit_applied_pence = 1000 WHERE guid = $1', [booking.guid]);
    });

    await t.test('pending refund shrinks after partial spending and approval deducts only what remains', async () => {
        const profile = await person();
        const other = await person();
        const { credit } = await granted(profile);
        assert.equal(await Credits.requestRefund(other.guid, credit.guid), null);
        const request = await Credits.requestRefund(profile.guid, credit.guid);
        assert.ok(request);
        assert.equal(await Credits.requestRefund(profile.guid, credit.guid), null);
        await spend(profile, 400);
        assert.equal((await requestRow(request.guid)).status, 'pending');
        assert.equal((await Credits.findRefundRequests()).find(row => row.guid === request.guid).remaining_pence, 600);
        const result = await Credits.decideRefund(request.guid, true, 'Admin');
        assert.equal(result.refunded_pence, 600);
        assert.equal(await balance(profile), 0);
        assert.equal((await requestRow(request.guid)).status, 'approved');
        assert.equal(await Credits.decideRefund(request.guid, true, 'Admin'), null);
        await assert.rejects(spend(profile, 100), { code: 'INSUFFICIENT_CREDIT' });
    });

    await t.test('fully spent credits close pending requests without action required', async () => {
        const profile = await person();
        const { credit } = await granted(profile);
        const request = await Credits.requestRefund(profile.guid, credit.guid);
        await spend(profile, 1000);
        assert.equal((await requestRow(request.guid)).status, 'spent');
        assert.equal(await Credits.decideRefund(request.guid, true, 'Admin'), null);
        assert.equal(await balance(profile), 0);
    });

    await t.test('declining leaves credit spendable and retains the decision', async () => {
        const profile = await person();
        const { credit } = await granted(profile);
        const request = await Credits.requestRefund(profile.guid, credit.guid);
        await assert.rejects(Credits.decideRefund(request.guid, false, 'Admin'), /decline comment/);
        assert.equal((await Credits.decideRefund(request.guid, false, 'Admin', 'Not eligible for a bank transfer')).refunded_pence, 0);
        assert.equal((await Credits.findForProfile(profile.guid))[0].decline_comment, 'Not eligible for a bank transfer');
        assert.equal(await balance(profile), 1000);
        await spend(profile, 300);
        assert.equal(await balance(profile), 700);
        assert.equal((await requestRow(request.guid)).status, 'declined');
    });

    await t.test('oldest credits fund bookings first and allocations retain both booking references', async () => {
        const profile = await person();
        const first = await granted(profile, false);
        await db.query("UPDATE credits SET created_at = now() - INTERVAL '1 day' WHERE guid = $1", [first.credit.guid]);
        const second = await granted(profile);
        const [booking] = await spend(profile, 1200);
        const credits = await Credits.findForProfile(profile.guid);
        assert.equal(credits.find(c => c.guid === first.credit.guid), undefined);
        assert.equal(credits.find(c => c.guid === second.credit.guid).remaining_pence, 800);
        const allocations = await db.query('SELECT * FROM credit_spending WHERE booking_guid = $1', [booking.guid]);
        assert.equal(allocations.rowCount, 2);
        assert.equal(allocations.rows.reduce((sum, row) => sum + row.amount_pence, 0), 1200);
        assert.ok(allocations.rows.every(row => row.booking_ref === booking.booking_ref));
        assert.equal(await balance(profile), 800);
    });

    await t.test('cancel-and-credit preserves the original reference after the booking is removed', async () => {
        const profile = await person();
        const input = bookingInput(profile);
        const booking = await Bookings.createBooking(input);
        assert.equal(await Bookings.removeBookingWithCredit(facility.guid, booking.guid, profile.guid, 1000, 'Admin', true), true);
        assert.equal(await Bookings.findBooking(facility.guid, booking.guid), null);
        const [credit] = await Credits.findForProfile(profile.guid);
        assert.equal(credit.booking_ref, booking.booking_ref);
        assert.equal(credit.refundable, true);
        assert.equal(credit.payment_reference, input.payment_reference);
        const results = await Bookings.search({ reference: booking.booking_ref });
        assert.equal(results.bookings[0].payment_reference, input.payment_reference);
        const refund = await Credits.requestRefund(profile.guid, credit.guid);
        assert.equal((await Credits.findRefundRequests()).find(r => r.guid === refund.guid).payment_reference, input.payment_reference);
        await db.query('UPDATE credits SET payment_reference = NULL WHERE guid = $1', [credit.guid]);
        await Credits.initialize();
        assert.equal((await Credits.findForProfile(profile.guid))[0].payment_reference, input.payment_reference);
        assert.equal(await balance(profile), 1000);
        assert.equal(await Bookings.removeBookingWithCredit(facility.guid, booking.guid, profile.guid, 1000, 'Admin', true), false);
        assert.equal(await balance(profile), 1000);
    });

    await t.test('weather approvals are always refundable regardless of submitted choice, without double granting', async () => {
        for (const refundable of [false, true]) {
            const profile = await person();
            const booking = await Bookings.createBooking(bookingInput(profile));
            await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '2 days', ends_at = now() - INTERVAL '1 day' WHERE guid = $1", [booking.guid]);
            const request = await Bookings.requestCredit(profile.guid, booking.guid, 'weather', 'Rain');
            assert.ok(request);
            assert.ok(await Bookings.decideCreditRequest(request.guid, true, 'Admin', refundable));
            assert.equal((await Credits.findForProfile(profile.guid))[0].refundable, true);
            assert.equal(await Bookings.decideCreditRequest(request.guid, true, 'Admin', refundable), null);
            assert.equal(await balance(profile), 1000);
        }
    });

    await t.test('failed or insufficient-credit checkout rolls back bookings, balances and pending requests', async () => {
        const profile = await person();
        const { credit } = await granted(profile);
        const request = await Credits.requestRefund(profile.guid, credit.guid);
        await assert.rejects(spend(profile, 1100), { code: 'INSUFFICIENT_CREDIT' });
        const conflicting = { ...bookingInput(profile), credit_applied_pence: 500 };
        await assert.rejects(Bookings.createBookings([conflicting, conflicting], { profile_guid: profile.guid, pence: 1000 }), { code: '23P01' });
        assert.equal(await balance(profile), 1000);
        assert.equal((await requestRow(request.guid)).status, 'pending');
        const { rows: [count] } = await db.query('SELECT COUNT(*)::int AS count FROM bookings WHERE profile_guid = $1', [profile.guid]);
        assert.equal(count.count, 1);
    });

    await t.test('simultaneous spending and approval cannot use the same money twice', async () => {
        const profile = await person();
        const { credit } = await granted(profile);
        const request = await Credits.requestRefund(profile.guid, credit.guid);
        const [checkout, review] = await Promise.allSettled([
            spend(profile, 1000),
            Credits.decideRefund(request.guid, true, 'Admin')
        ]);
        assert.equal(review.status, 'fulfilled');
        if (checkout.status === 'fulfilled') {
            assert.equal(review.value, null);
            assert.equal((await requestRow(request.guid)).status, 'spent');
        } else {
            assert.equal(checkout.reason.code, 'INSUFFICIENT_CREDIT');
            assert.equal(review.value.refunded_pence, 1000);
        }
        assert.equal(await balance(profile), 0);
    });

    await t.test('simultaneous approvals deduct credit only once', async () => {
        const profile = await person();
        const { credit } = await granted(profile);
        const request = await Credits.requestRefund(profile.guid, credit.guid);
        const results = await Promise.all([
            Credits.decideRefund(request.guid, true, 'First admin'),
            Credits.decideRefund(request.guid, true, 'Second admin')
        ]);
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal((await requestRow(request.guid)).refunded_pence, 1000);
        assert.equal(await balance(profile), 0);
    });

    await t.test('multi-slot checkout allocates each booking and rejects mismatched or foreign-owner credit', async () => {
        const profile = await person();
        const other = await person();
        await granted(profile);
        const inputs = [400, 600].map(pence => ({ ...bookingInput(profile), credit_applied_pence: pence }));
        await assert.rejects(Bookings.createBookings(inputs, { profile_guid: profile.guid, pence: 999 }), /Invalid booking credit allocation/);
        await assert.rejects(Bookings.createBookings(inputs, { profile_guid: other.guid, pence: 1000 }), /Invalid booking credit allocation/);
        const created = await Bookings.createBookings(inputs, { profile_guid: profile.guid, pence: 1000 });
        for (const [index, booking] of created.entries()) {
            const { rows: [allocation] } = await db.query('SELECT amount_pence FROM credit_spending WHERE booking_guid = $1', [booking.guid]);
            assert.equal(allocation.amount_pence, inputs[index].credit_applied_pence);
        }
        assert.equal(await balance(profile), 0);
    });

    await t.test('Refunda fixture supplies actionable test scenarios and preserves progress on rerun', async () => {
        const { seedRefunda } = require('../scripts/seedRefunda');
        const created = await seedRefunda(db);
        assert.equal(created.created, true);
        const profile = { guid: created.guid };
        const credits = await Credits.findForProfile(profile.guid);
        assert.equal(credits.length, 3);
        assert.equal(await balance(profile), 4500);
        assert.equal(credits.find(c => c.booking_ref === 'AH-REFUNDA-01').refundable, true);
        assert.equal(credits.find(c => c.booking_ref === 'AH-REFUNDA-02').refundable, false);
        assert.equal(credits.find(c => c.booking_ref === 'AH-REFUNDA-03').refund_status, 'pending');
        const past = await Bookings.findRecentPastForProfile(profile.guid);
        assert.deepEqual(past.map(b => b.booking_ref).sort(), ['AH-REFUNDA-04', 'AH-REFUNDA-05', 'AH-REFUNDA-06']);
        assert.ok(past.every(b => b.credited_at === null));
        for (const ref of ['AH-REFUNDA-04', 'AH-REFUNDA-05']) {
            const booking = past.find(b => b.booking_ref === ref);
            assert.ok(await Bookings.requestCredit(profile.guid, booking.guid, 'weather', 'Test rain'));
        }
        const pending = await Bookings.findCreditRequests('pending');
        assert.ok(pending.some(r => r.booking_ref === 'AH-REFUNDA-06'));
        assert.equal((await Bookings.findUpcomingForProfile(profile.guid)).length, 1);
        const first = credits.find(c => c.booking_ref === 'AH-REFUNDA-01');
        await Credits.requestRefund(profile.guid, first.guid);
        const rerun = await seedRefunda(db);
        assert.equal(rerun.created, false);
        assert.equal(rerun.guid, profile.guid);
        assert.equal(await balance(profile), 4500);
        assert.equal((await Credits.findForProfile(profile.guid)).length, 3);
        assert.equal((await Credits.findForProfile(profile.guid)).find(c => c.guid === first.guid).refund_status, 'pending');
    });

    await t.test('credit reasons persist, discretionary descriptions are required, and legacy weather migrates', async () => {
        const profile = await person();
        const booking = await Bookings.createBooking(bookingInput(profile));
        await db.query("UPDATE bookings SET starts_at = now() - INTERVAL '2 days', ends_at = now() - INTERVAL '1 day' WHERE guid = $1", [booking.guid]);
        await assert.rejects(Bookings.requestCredit(profile.guid, booking.guid, 'discretionary', ' '), /Invalid credit request/);
        await assert.rejects(Bookings.requestCredit(profile.guid, booking.guid, 'invalid', null), /Invalid credit request/);
        const request = await Bookings.requestCredit(profile.guid, booking.guid, 'discretionary', 'Facility closed');
        const row = (await Bookings.findCreditRequests()).find(row => row.guid === request.guid);
        assert.equal(row.reason, 'discretionary');
        assert.equal(row.note, 'Facility closed');
        await assert.rejects(Bookings.decideCreditRequest(request.guid, false, 'Admin'), /decline comment/);
        assert.equal((await Bookings.decideCreditRequest(request.guid, false, 'Admin', false, 'Booking was available')).reason, 'discretionary');
        assert.equal((await Bookings.findRecentPastForProfile(profile.guid))[0].credit_request_decline_comment, 'Booking was available');
        await db.query('ALTER TABLE booking_credit_requests DROP CONSTRAINT booking_credit_requests_reason_check');
        await db.query("UPDATE booking_credit_requests SET reason = 'inclement-weather' WHERE reason = 'weather'");
        await Bookings.initialize();
        const legacy = await db.query("SELECT COUNT(*)::int AS count FROM booking_credit_requests WHERE reason = 'inclement-weather'");
        assert.equal(legacy.rows[0].count, 0);
        assert.ok((await Bookings.findCreditRequests()).some(row => row.reason === 'weather'));
    });

    await t.test('weather slots approve pending and future exact-time requests across facilities, with a feature switch', async () => {
        const Settings = require('../models/Settings');
        assert.equal((await Settings.getAll()).credit_slot_auto_approval, '0');
        const { rows: [otherFacility] } = await db.query(`
            INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
            VALUES ('Other hall', 'Other road', 'AB1 2CD', 0, 0, '', '') RETURNING guid`);
        const start = new Date(Date.now() - 2 * 86400000).toISOString();
        const end = new Date(Date.now() - 2 * 86400000 + 3600000).toISOString();
        async function past({ starts = start, ends = end, other = false } = {}) {
            const resident = await person();
            const booking = await Bookings.createBooking(bookingInput(resident));
            await db.query('UPDATE bookings SET starts_at = $2, ends_at = $3, facility_guid = $4 WHERE guid = $1',
                [booking.guid, starts, ends, other ? otherFacility.guid : facility.guid]);
            return { resident, booking };
        }
        const source = await past();
        const pending = await past({ other: true });
        const later = await past({ other: true });
        const otherReason = await past();
        const differentEnd = await past({ ends: new Date(new Date(end).getTime() + 60000).toISOString() });
        const sourceRequest = await Bookings.requestCredit(source.resident.guid, source.booking.guid, 'weather', null);
        const pendingRequest = await Bookings.requestCredit(pending.resident.guid, pending.booking.guid, 'weather', null);
        const otherRequest = await Bookings.requestCredit(otherReason.resident.guid, otherReason.booking.guid, 'discretionary', 'Court unusable');
        await assert.rejects(Bookings.decideCreditRequest(sourceRequest.guid, true, 'Admin', true, null, true), /disabled/);
        assert.equal(await balance(source.resident), 0);
        await Settings.set('credit_slot_auto_approval', '1');
        const result = await Bookings.decideCreditRequest(sourceRequest.guid, true, 'Slot admin', true, null, true);
        assert.equal(result.auto_approved_count, 1);
        assert.equal(await balance(source.resident), 1000);
        assert.equal(await balance(pending.resident), 1000);
        assert.equal(await balance(later.resident), 0, 'No credit before a request');
        const pendingRow = (await Bookings.findCreditRequests()).find(row => row.guid === pendingRequest.guid);
        assert.equal(pendingRow.auto_approved, true);
        assert.equal(pendingRow.decided_by_name, 'Slot admin');
        assert.equal((await Credits.findForProfile(pending.resident.guid))[0].refundable, true);
        assert.equal((await Credits.findForProfile(pending.resident.guid))[0].auto_approved, true);
        assert.equal((await Credits.findForProfile(source.resident.guid))[0].auto_approved, false);
        assert.equal((await Bookings.findCreditRequests()).find(row => row.guid === otherRequest.guid).status, 'pending');
        const lateRequest = await Bookings.requestCredit(later.resident.guid, later.booking.guid, 'weather', null);
        assert.equal(lateRequest.auto_approved, true);
        assert.equal(await balance(later.resident), 1000);
        assert.equal((await Credits.findForProfile(later.resident.guid))[0].refundable, true);
        assert.equal((await Credits.findForProfile(later.resident.guid))[0].auto_approved, true);
        assert.equal(await Bookings.requestCredit(later.resident.guid, later.booking.guid, 'weather', null), null);
        assert.equal(await Bookings.requestCredit(source.resident.guid, differentEnd.booking.guid, 'weather', null), null);
        const differentRequest = await Bookings.requestCredit(differentEnd.resident.guid, differentEnd.booking.guid, 'weather', null);
        assert.equal(differentRequest.auto_approved, undefined);
        assert.equal(await balance(differentEnd.resident), 0);
        const slotRows = await Bookings.findAutoApprovalSlots();
        assert.equal(slotRows.length, 1);
        assert.equal(slotRows[0].refundable, true);
        await Settings.set('credit_request_days', '1');
        assert.equal((await Bookings.findAutoApprovalSlots()).length, 0);
        const outside = await past();
        assert.equal(await Bookings.requestCredit(outside.resident.guid, outside.booking.guid, 'weather', null), null);
        await Settings.set('credit_request_days', '30');
        await Settings.set('credit_slot_auto_approval', '0');
        const paused = await past();
        const pausedRequest = await Bookings.requestCredit(paused.resident.guid, paused.booking.guid, 'weather', null);
        assert.equal(await balance(paused.resident), 0);
        await Settings.set('credit_slot_auto_approval', '1');
        const resumed = await past();
        assert.equal((await Bookings.requestCredit(resumed.resident.guid, resumed.booking.guid, 'weather', null)).auto_approved, true);
        assert.equal((await Bookings.findCreditRequests()).find(row => row.guid === pausedRequest.guid).status, 'pending');

        // A failed batch must roll back its source credit, other credits and slot.
        const rollbackStart = new Date(Date.now() - 4 * 86400000).toISOString();
        const rollbackEnd = new Date(Date.now() - 4 * 86400000 + 3600000).toISOString();
        const first = await past({ starts: rollbackStart, ends: rollbackEnd });
        const second = await past({ starts: rollbackStart, ends: rollbackEnd });
        const firstRequest = await Bookings.requestCredit(first.resident.guid, first.booking.guid, 'weather', null);
        await Bookings.requestCredit(second.resident.guid, second.booking.guid, 'weather', null);
        const originalGrant = Credits.grant;
        const grantMock = t.mock.method(Credits, 'grant', async (...args) => {
            if (args[1].guid === second.booking.guid) throw new Error('Test grant failure');
            return originalGrant(...args);
        });
        await assert.rejects(Bookings.decideCreditRequest(firstRequest.guid, true, 'Admin', false, null, true), /Test grant failure/);
        grantMock.mock.restore();
        assert.equal(await balance(first.resident), 0);
        assert.equal((await Bookings.findAutoApprovalSlots()).length, 1);

        const racing = await past({ starts: rollbackStart, ends: rollbackEnd });
        await Promise.all([
            Bookings.decideCreditRequest(firstRequest.guid, true, 'Concurrent admin', false, null, true),
            Bookings.requestCredit(racing.resident.guid, racing.booking.guid, 'weather', null)
        ]);
        assert.equal(await balance(first.resident), 1000);
        assert.equal(await balance(second.resident), 1000);
        assert.equal(await balance(racing.resident), 1000);
        assert.equal((await Credits.findForProfile(racing.resident.guid))[0].refundable, true);
        await assert.rejects(Bookings.decideCreditRequest(otherRequest.guid, true, 'Admin', false, null, true), /only to weather/);
        assert.equal(await balance(otherReason.resident), 0);
        await Settings.set('credit_slot_auto_approval', '0');
    });

    await t.test('credit expiry is fixed at issuance, filters balances and spending, but preserves pending refunds', async () => {
        const Settings = require('../models/Settings');
        const Profiles = require('../models/Profiles');
        const resident = await person();
        const old = await granted(resident);
        const originalExpiry = old.credit.expires_at.toISOString();
        assert.equal(Math.round((old.credit.expires_at - old.credit.created_at) / 86400000), 365);
        await Settings.set('credit_lifetime_days', '7');
        const fresh = await granted(resident);
        assert.equal(Math.round((fresh.credit.expires_at - fresh.credit.created_at) / 86400000), 7);
        assert.equal((await Credits.findForProfile(resident.guid)).find(c => c.guid === old.credit.guid).expires_at.toISOString(), originalExpiry);
        const pending = await Credits.requestRefund(resident.guid, old.credit.guid);
        await db.query("UPDATE credits SET expires_at = now() - INTERVAL '1 second' WHERE guid = $1", [old.credit.guid]);
        assert.deepEqual((await Credits.findForProfile(resident.guid)).map(c => c.guid), [fresh.credit.guid]);
        assert.equal((await Profiles.findByGuid(resident.guid)).credit_pence, 1000);
        assert.equal((await Profiles.findAll()).find(p => p.guid === resident.guid).credit_pence, 1000);
        const bookingCount = await db.query('SELECT COUNT(*)::int AS count FROM bookings WHERE profile_guid = $1', [resident.guid]);
        await assert.rejects(spend(resident, 1500), { code: 'INSUFFICIENT_CREDIT' });
        assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM bookings WHERE profile_guid = $1', [resident.guid])).rows[0].count, bookingCount.rows[0].count);
        await spend(resident, 400);
        assert.equal((await Credits.findForProfile(resident.guid))[0].remaining_pence, 600);
        assert.equal((await db.query('SELECT remaining_pence FROM credits WHERE guid = $1', [old.credit.guid])).rows[0].remaining_pence, 1000);
        assert.equal((await Credits.findExpiredPendingRefunds(resident.guid))[0].guid, pending.guid);
        assert.equal((await Credits.findRefundRequests()).find(r => r.guid === pending.guid).expired, true);
        assert.equal((await Credits.decideRefund(pending.guid, true, 'Expiry admin')).refunded_pence, 1000);
        assert.equal((await Profiles.findByGuid(resident.guid)).credit_pence, 600);
        assert.equal((await Credits.findExpiredPendingRefunds(resident.guid)).length, 0);
        await spend(resident, 600);
        assert.deepEqual(await Credits.findForProfile(resident.guid), []);
        assert.equal((await Profiles.findByGuid(resident.guid)).credit_pence, 0);

        const expired = await granted(resident);
        await db.query('UPDATE credits SET expires_at = now() WHERE guid = $1', [expired.credit.guid]);
        assert.equal(await Credits.requestRefund(resident.guid, expired.credit.guid), null);
        await assert.rejects(spend(resident, 1), { code: 'INSUFFICIENT_CREDIT' });
        assert.deepEqual(await Credits.findForProfile(resident.guid), []);

        // Simulate upgrading an existing ledger; expiry is assigned once from upgrade time.
        await db.query('ALTER TABLE credits DROP COLUMN expires_at');
        await Credits.initialize();
        const { rows: [migrated] } = await db.query(`
            SELECT expires_at, EXTRACT(EPOCH FROM (expires_at - now())) / 86400 AS days
            FROM credits WHERE guid = $1`, [old.credit.guid]);
        assert.ok(Number(migrated.days) > 364.99 && Number(migrated.days) <= 365);
        await Credits.initialize();
        assert.equal((await db.query('SELECT expires_at FROM credits WHERE guid = $1', [old.credit.guid])).rows[0].expires_at.toISOString(), migrated.expires_at.toISOString());
        await Settings.set('credit_lifetime_days', '365');
    });

    await t.test('Other approvals default to non-refundable but allow an administrator override', async () => {
        for (const refundable of [undefined, true]) {
            const resident = await person();
            const booking = await Bookings.createBooking(bookingInput(resident));
            await db.query(`UPDATE bookings SET starts_at = now() - INTERVAL '2 days',
                ends_at = now() - INTERVAL '1 day' WHERE guid = $1`, [booking.guid]);
            const request = await Bookings.requestCredit(resident.guid, booking.guid, 'discretionary', 'Court unavailable');
            const result = await Bookings.decideCreditRequest(request.guid, true, 'Admin', refundable);
            assert.equal(result.refundable, refundable === true);
            assert.equal((await Credits.findForProfile(resident.guid))[0].refundable, refundable === true);
        }
    });

    await t.test('profile role assignments migrate idempotently, persist, rename and protect the last administrator', async () => {
        const Profiles = require('../models/Profiles');
        const Roles = require('../models/Roles');
        const legacy = await person();
        assert.deepEqual((await Profiles.findByGuid(legacy.guid)).roles, ['Resident']);
        await Profiles.initialize();
        await Profiles.initialize();
        assert.deepEqual((await Profiles.findByGuid(legacy.guid)).roles, ['Resident']);
        const created = await Profiles.create({ name: 'Multi role', email: `${crypto.randomUUID()}@example.test`, roles: ['Coach', 'Resident'] });
        assert.deepEqual(created.roles, ['Coach', 'Resident']);
        assert.deepEqual((await Profiles.search('Multi role')).find(p => p.guid === created.guid).roles, ['Coach', 'Resident']);
        const custom = await Roles.create({ name: 'Role test', description: null, permissions: ['bookings.manage'] });
        await Profiles.update(created.guid, { name: created.name, email: created.email, roles: ['Resident', custom.name] });
        assert.equal((await Roles.findByGuid(custom.guid)).member_count, 1);
        await assert.rejects(Roles.remove(custom.guid), error => ['23503', '23001'].includes(error.code));
        await Roles.update(custom.guid, { name: 'Renamed role test', description: null, permissions: [] });
        assert.deepEqual((await Profiles.findByGuid(created.guid)).roles, ['Renamed role test', 'Resident']);
        await assert.rejects(Profiles.update(created.guid, { name: 'Invalid edit', email: created.email, roles: ['Resident', 'Missing role'] }),
            error => error.code === '23503');
        assert.equal((await Profiles.findByGuid(created.guid)).name, created.name);
        assert.deepEqual((await Profiles.findByGuid(created.guid)).roles, ['Renamed role test', 'Resident']);
        const baseline = await Profiles.create({ name: 'Baseline resident', email: `${crypto.randomUUID()}@example.test` });
        assert.equal(baseline.role, 'Resident');
        assert.deepEqual(baseline.roles, ['Resident']);
        const coach = await Profiles.create({ name: 'Additional coach', email: `${crypto.randomUUID()}@example.test`, roles: ['Coach'] });
        assert.deepEqual(coach.roles, ['Coach', 'Resident']);
        assert.equal(coach.role, 'Resident');
        assert.deepEqual((await Profiles.update(coach.guid, { ...coach, roles: [] })).roles, ['Resident']);
        await Profiles.update(created.guid, { ...created, roles: ['Resident'] });
        assert.equal((await Profiles.findByGuid(created.guid)).role, 'Resident');
        assert.equal((await Roles.findByGuid(custom.guid)).member_count, 0);
        assert.equal(await Roles.remove(custom.guid), true);
        await Profiles.initialize();
        assert.deepEqual((await Profiles.findByGuid(created.guid)).roles, ['Resident']);

        const originalAdmins = (await Profiles.findAll()).filter(p => p.roles.includes('Administrator'));
        const admins = [];
        for (let i = 0; i < 2; i++) {
            const admin = await Profiles.create({ name: 'Role admin', email: `${crypto.randomUUID()}@example.test`, roles: ['Resident'] });
            admins.push(await Profiles.update(admin.guid, { ...admin, roles: ['Resident', 'Administrator'] }));
        }
        assert.ok(admins.every(p => p.role === 'Resident'));
        assert.equal(await Profiles.countAdministrators(), originalAdmins.length + 2);
        for (const admin of originalAdmins) await Profiles.update(admin.guid, { ...admin, roles: ['Resident'] });
        const outcomes = await Promise.allSettled(admins.map(admin => Profiles.update(admin.guid, { ...admin, roles: ['Resident'] })));
        assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'LAST_ADMINISTRATOR');
        assert.equal(await Profiles.countAdministrators(), 1);
        const survivor = (await Profiles.findAll()).find(p => p.roles.includes('Administrator'));
        await assert.rejects(Profiles.remove(survivor.guid, 'Admin'), error => error.code === 'LAST_ADMINISTRATOR');
        for (const admin of originalAdmins) await Profiles.update(admin.guid, admin);
        for (const admin of admins) await Profiles.remove(admin.guid, 'Admin');
        assert.equal(await Profiles.countAdministrators(), originalAdmins.length);
    });

    await t.test('roles inherit Resident permissions and login ranking counts only additional privileges', async () => {
        const Roles = require('../models/Roles');
        const resident = (await Roles.findAll()).find(role => role.name === 'Resident');
        const original = [...resident.permissions];
        const created = [];
        try {
            await Roles.update(resident.guid, { name: 'Resident', description: resident.description, permissions: ['bookings.manage'] });
            for (const [name, permissions] of [
                ['Alpha rank test', ['bookings.manage', 'profiles.manage']],
                ['Beta rank test', ['roles.manage']],
                ['Highest rank test', ['profiles.manage', 'roles.manage']]
            ]) created.push(await Roles.create({ name, description: null, permissions }));
            assert.deepEqual(await Roles.permissionsFor('Beta rank test'), ['bookings.manage', 'roles.manage']);
            assert.deepEqual(await Roles.permissionsFor('Resident'), ['bookings.manage']);
            assert.equal(await Roles.highestFor(['Beta rank test', 'Alpha rank test']), 'Alpha rank test');
            assert.equal(await Roles.highestFor(created.map(role => role.name)), 'Highest rank test');
            assert.equal(await Roles.highestFor(['Resident', 'Administrator']), 'Administrator');
            assert.equal(await Roles.highestFor(['Resident']), 'Resident');
        } finally {
            await Roles.update(resident.guid, { name: 'Resident', description: resident.description, permissions: original });
            for (const role of created) await Roles.remove(role.guid);
        }
    });

    await t.test('courses migrate draft runs once, support multiple sites and preserve shared FAQs', async () => {
        const Courses = require('../models/Courses');
        const Facilities = require('../models/Facilities');
        const Roles = require('../models/Roles');
        const leader = (await Roles.findAll()).find(role => role.name === 'Course leader');
        assert.ok(leader.permissions.includes('courses.manage'));
        const { rows: [second] } = await db.query(`
            INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
            VALUES ('Course second hall', 'Test', 'AB1 2CD', 0, 0, '', '') RETURNING guid`);
        const { rows: [secondSport] } = await db.query("INSERT INTO sports (name) VALUES ('Course test sport') RETURNING guid");
        const { rows: [legacy] } = await db.query('INSERT INTO courses (name, facility_guid) VALUES ($1, $2) RETURNING guid',
            ['Legacy course', facility.guid]);
        await Courses.initialize();
        await Courses.initialize();
        const migrated = (await Courses.findAll()).find(course => course.guid === legacy.guid);
        assert.deepEqual(migrated.facility_guids, [facility.guid]);
        assert.deepEqual(migrated.sport_guids, []);
        assert.equal(migrated.runs.length, 1);
        assert.equal(migrated.runs[0].published, false);
        assert.ok(!(await Courses.findAll({ availableOnly: true })).some(item => item.guid === legacy.guid));
        const course = await Courses.create({ name: 'Multi-site course', description: '<script>not markup</script>',
            sport_guids: [sport.guid, secondSport.guid] });
        const details = { name: 'Tuesday group', full_price_pence: 12000, capacity: 20, facility_guid: facility.guid,
            sessions: [{ starts_local: '2090-01-03 18:00', ends_local: '2090-01-03 19:00' }] };
        const firstRun = await Courses.saveRun(null, course.guid, details);
        await Courses.saveRun(null, course.guid, { ...details, name: 'Another term' });
        await Courses.saveRun(null, course.guid, { ...details, facility_guid: second.guid });
        const faq = await Courses.saveFaq(null, { sport_guid: sport.guid, question: 'What to bring?', answer: 'A racket.' });
        assert.ok((await Courses.findFaqs()).some(item => item.guid === faq.guid));
        const directory = await Facilities.findAll();
        assert.ok(directory.find(f => f.guid === facility.guid).courses.some(c => c.guid === course.guid));
        assert.ok(directory.find(f => f.guid === second.guid).courses.some(c => c.guid === course.guid));
        await assert.rejects(Courses.update(course.guid, { name: 'Bad edit', start_date: '2026-10-01', end_date: '2026-12-01', facility_guids: [facility.guid], sport_guids: [crypto.randomUUID()] }),
            error => error.code === '23503');
        assert.equal((await Courses.findAll()).find(c => c.guid === course.guid).name, 'Multi-site course');
        await Courses.update(course.guid, { name: 'Updated course', description: '', sport_guids: [sport.guid] });
        assert.equal((await Courses.findAll()).find(c => c.guid === course.guid).runs.length, 3);
        await Courses.saveRun(firstRun.guid, course.guid, { ...details, full_price_pence: 9000,
            sessions: [{ starts_local: '2090-02-03 17:00', ends_local: '2090-02-03 18:00' }] });
        const edited = (await Courses.findRuns()).find(run => run.guid === firstRun.guid);
        assert.equal(edited.current_price_pence, 9000);
        assert.equal(edited.sessions[0].starts_local, '2090-02-03 17:00');
        await assert.rejects(Courses.saveRun(firstRun.guid, course.guid, { ...details,
            sessions: [{ starts_local: '2027-03-28 01:30', ends_local: '2027-03-28 02:30' }] }),
        error => error.code === 'INVALID_SESSION_TIME');
        assert.equal((await Courses.findRuns()).find(run => run.guid === firstRun.guid).sessions[0].starts_local, '2090-02-03 17:00');
        const dstRun = await Courses.saveRun(null, course.guid, { ...details, name: 'Clock change test',
            sessions: [{ starts_local: '2027-03-22 18:00', ends_local: '2027-03-22 19:00' },
                { starts_local: '2027-03-29 18:00', ends_local: '2027-03-29 19:00' }] });
        const { rows: instants } = await db.query("SELECT to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI') AS utc FROM course_sessions WHERE run_guid=$1 ORDER BY starts_at", [dstRun.guid]);
        assert.deepEqual(instants.map(row => row.utc), ['18:00', '17:00']);
        await Courses.removeRun(dstRun.guid, course.guid);
        await assert.rejects(Courses.saveRun(firstRun.guid, course.guid, { ...details, facility_guid: crypto.randomUUID() }),
            error => error.code === '23503');
        assert.equal((await Courses.findRuns()).find(run => run.guid === firstRun.guid).current_price_pence, 9000);
        await Courses.initialize();
        assert.equal((await Courses.findAll()).find(c => c.guid === course.guid).runs.length, 3);
        await Facilities.remove(second.guid);
        assert.ok((await Courses.findAll()).some(c => c.guid === course.guid));
        assert.deepEqual((await Courses.findAll()).find(c => c.guid === course.guid).facility_guids, [facility.guid]);
        await Courses.remove(course.guid);
        assert.equal((await db.query('SELECT 1 FROM course_sports WHERE course_guid = $1', [course.guid])).rowCount, 0);
        assert.ok((await Courses.findFaqs()).some(item => item.guid === faq.guid));
        await Courses.saveFaq(faq.guid, { sport_guid: sport.guid, question: 'Updated question', answer: 'Updated answer' });
        assert.equal((await Courses.findFaqs()).find(item => item.guid === faq.guid).answer, 'Updated answer');
        await Courses.removeFaq(faq.guid);
        await Courses.remove(legacy.guid);
        await db.query('DELETE FROM sports WHERE guid = $1', [secondSport.guid]);
    });

    await t.test('Camden course import creates drafts, is repeatable and never overwrites edited data', async () => {
        const { importCourses } = require('../scripts/importCamdenCourses');
        const source = 'https://camdenactive.camden.gov.uk/courses/detail/test-import/';
        const data = [{ name: 'Camden import test', source, description: 'Original summary',
            runs: [{ source: source + 'run', full_price_pence: 21000, original_sessions: 15,
                advertised_remaining: 1, advertised_price_pence: 1400,
                sessions: [{ starts_local: '2026-11-03 13:45', ends_local: '2026-11-03 14:30',
                    location: 'Credit test hall' }] }] }];
        await db.query("INSERT INTO sports (name) VALUES ('Gymnastics') ON CONFLICT DO NOTHING");
        const result = await importCourses(db, data);
        assert.deepEqual(result, { courses_added: 1, runs_added: 1, runs_skipped: 0, sessions_added: 1 });
        const { rows: [stored] } = await db.query("SELECT * FROM courses WHERE name='Camden import test'");
        const { rows: [run] } = await db.query('SELECT * FROM course_runs WHERE course_guid=$1', [stored.guid]);
        assert.equal(run.published, false);
        assert.equal(run.capacity, null);
        assert.equal(run.full_price_pence, 21000);
        await db.query("UPDATE courses SET description='Admin edited' WHERE guid=$1", [stored.guid]);
        assert.deepEqual(await importCourses(db, data),
            { courses_added: 0, runs_added: 0, runs_skipped: 1, sessions_added: 0 });
        assert.equal((await db.query('SELECT description FROM courses WHERE guid=$1', [stored.guid])).rows[0].description, 'Admin edited');
        const invalid = [{ ...data[0], source: source + 'invalid', name: 'Should roll back',
            runs: [{ ...data[0].runs[0], source: source + 'missing-location',
                sessions: [{ ...data[0].runs[0].sessions[0], location: 'Missing facility' }] }] }];
        await assert.rejects(importCourses(db, invalid), /facility match/);
        assert.equal((await db.query("SELECT 1 FROM courses WHERE name='Should roll back'")).rowCount, 0);
        await db.query('DELETE FROM courses WHERE guid=$1', [stored.guid]);
        await db.query('DELETE FROM site_settings WHERE key=$1 OR key=$2', ['camden_course_import:' + source, 'camden_course_import:' + source + 'run']);
    });

    await t.test('rolling limit restricts new requests but keeps older pending requests visible and approvable', async () => {
        const Settings = require('../models/Settings');
        await Settings.set('credit_request_days', '7');
        const profile = await person();
        const inside = await Bookings.createBooking(bookingInput(profile));
        const outside = await Bookings.createBooking(bookingInput(profile));
        await db.query(`
            UPDATE bookings SET starts_at = now() - INTERVAL '8 days',
                ends_at = now() - INTERVAL '7 days' + INTERVAL '1 minute' WHERE guid = $1`, [inside.guid]);
        await db.query(`
            UPDATE bookings SET starts_at = now() - INTERVAL '9 days',
                ends_at = now() - INTERVAL '7 days' - INTERVAL '1 minute' WHERE guid = $1`, [outside.guid]);
        assert.deepEqual((await Bookings.findRecentPastForProfile(profile.guid)).map(b => b.guid), [inside.guid]);
        assert.equal(await Bookings.requestCredit(profile.guid, outside.guid, 'weather', null), null);
        const request = await Bookings.requestCredit(profile.guid, inside.guid, 'weather', null);
        assert.ok(request);
        await Settings.set('credit_request_days', '1');
        const visible = await Bookings.findRecentPastForProfile(profile.guid);
        assert.deepEqual(visible.map(b => b.guid), [inside.guid]);
        assert.equal(visible[0].credit_request_status, 'pending');
        assert.equal((await Bookings.findRecentPastForProfile((await person()).guid)).length, 0);
        assert.equal(await Bookings.requestCredit(profile.guid, outside.guid, 'weather', null), null);
        assert.equal(await Bookings.requestCredit(profile.guid, inside.guid, 'weather', null), null);
        assert.ok((await Bookings.findCreditRequests('pending')).some(r => r.guid === request.guid));
        const decision = await Bookings.decideCreditRequest(request.guid, true, 'Admin', true);
        assert.equal(decision.credited, 1000);
        assert.equal(await balance(profile), 1000);
        assert.equal((await Bookings.findRecentPastForProfile(profile.guid)).length, 0);
        await Settings.set('credit_request_days', '8');
        assert.deepEqual((await Bookings.findRecentPastForProfile(profile.guid)).map(b => b.guid), [outside.guid]);
        const declined = await Bookings.requestCredit(profile.guid, outside.guid, 'weather', null);
        assert.ok(declined);
        await Settings.set('credit_request_days', '1');
        assert.equal((await Bookings.findRecentPastForProfile(profile.guid)).length, 1);
        await Bookings.decideCreditRequest(declined.guid, false, 'Admin', false, 'Court was available');
        assert.equal((await Bookings.findRecentPastForProfile(profile.guid)).length, 0);
        await Settings.set('credit_request_days', '30');
    });
});
