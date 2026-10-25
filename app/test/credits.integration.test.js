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
    for (const name of ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings']) {
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

    await t.test('granting credit is once per booking and refundability is administrator-selected', async () => {
        const profile = await person();
        const { booking, credit } = await granted(profile, false);
        assert.equal(credit.refundable, false);
        assert.equal(credit.booking_ref, booking.booking_ref);
        assert.equal(await Credits.requestRefund(profile.guid, credit.guid), null);
        assert.equal(await Bookings.addCreditToBooking(facility.guid, booking.guid, 'Admin', true), null);
        assert.equal(await balance(profile), 1000);
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

    await t.test('configured rolling day limit controls both profile visibility and new requests', async () => {
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
        assert.equal((await Bookings.findRecentPastForProfile(profile.guid)).length, 0);
        assert.ok((await Bookings.findCreditRequests('pending')).some(r => r.guid === request.guid));
        await Settings.set('credit_request_days', '8');
        assert.equal((await Bookings.findRecentPastForProfile(profile.guid)).length, 2);
        assert.ok(await Bookings.requestCredit(profile.guid, outside.guid, 'weather', null));
        await Settings.set('credit_request_days', '30');
    });
});
