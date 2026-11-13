const crypto = require('crypto');
const { Pool } = require('pg');
const Credits = require('./Credits');
const Bookings = require('./Bookings');
const OpeningHours = require('./OpeningHours');
const AuditLog = require('./AuditLog');
const Settings = require('./Settings');
const { priceForRemainingSessions } = require('../courseRuns');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGuid = value => typeof value === 'string' && GUID.test(value);

class BasketError extends Error {
    constructor(message) {
        super(message);
        this.code = 'BASKET_CONFLICT';
    }
}

async function transaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS profile_family_members (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            profile_guid uuid NOT NULL REFERENCES profiles(guid) ON DELETE CASCADE,
            name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
            deleted_at timestamptz
        );
        CREATE TABLE IF NOT EXISTS course_baskets (
            profile_guid uuid PRIMARY KEY REFERENCES profiles(guid) ON DELETE CASCADE,
            revision uuid NOT NULL DEFAULT gen_random_uuid(),
            return_to text NOT NULL DEFAULT '/courses'
        );
        CREATE TABLE IF NOT EXISTS course_basket_items (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            profile_guid uuid NOT NULL REFERENCES course_baskets(profile_guid) ON DELETE CASCADE,
            run_guid uuid NOT NULL REFERENCES course_runs(guid) ON DELETE CASCADE,
            member_guid uuid REFERENCES profile_family_members(guid) ON DELETE RESTRICT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS course_basket_attendee_idx
            ON course_basket_items(profile_guid, run_guid, COALESCE(member_guid, profile_guid));
        CREATE TABLE IF NOT EXISTS court_basket_items (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            profile_guid uuid NOT NULL REFERENCES course_baskets(profile_guid) ON DELETE CASCADE,
            option_guid uuid NOT NULL REFERENCES bookable_options(guid) ON DELETE CASCADE,
            starts_at timestamptz NOT NULL,
            ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
            UNIQUE (profile_guid, option_guid, starts_at, ends_at)
        );
        CREATE TABLE IF NOT EXISTS course_orders (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            profile_guid uuid NOT NULL REFERENCES profiles(guid) ON DELETE RESTRICT,
            checkout_token uuid NOT NULL UNIQUE,
            total_pence bigint NOT NULL CHECK (total_pence >= 0),
            credit_pence integer NOT NULL CHECK (credit_pence >= 0 AND credit_pence <= total_pence),
            payment_reference text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS course_enrolments (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            order_guid uuid NOT NULL REFERENCES course_orders(guid) ON DELETE RESTRICT,
            run_guid uuid NOT NULL REFERENCES course_runs(guid) ON DELETE RESTRICT,
            profile_guid uuid NOT NULL REFERENCES profiles(guid) ON DELETE RESTRICT,
            member_guid uuid REFERENCES profile_family_members(guid) ON DELETE RESTRICT,
            attendee_name text NOT NULL,
            course_name text NOT NULL,
            run_name text NOT NULL,
            facility_name text NOT NULL,
            sessions jsonb NOT NULL,
            amount_pence integer NOT NULL,
            credit_applied_pence integer NOT NULL,
            booking_ref text NOT NULL UNIQUE
        );
        ALTER TABLE course_enrolments
            ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
            ADD COLUMN IF NOT EXISTS cancelled_by_name text,
            ADD COLUMN IF NOT EXISTS cancellation_mode text,
            ADD COLUMN IF NOT EXISTS cancellation_credit_pence integer NOT NULL DEFAULT 0;
        DROP INDEX IF EXISTS course_enrolment_attendee_idx;
        CREATE INDEX IF NOT EXISTS course_enrolment_profile_run_idx ON course_enrolments(profile_guid, run_guid);
        CREATE INDEX IF NOT EXISTS course_enrolment_order_idx ON course_enrolments(order_guid);
        CREATE TABLE IF NOT EXISTS order_court_bookings (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            order_guid uuid NOT NULL REFERENCES course_orders(guid) ON DELETE RESTRICT,
            booking_guid uuid UNIQUE REFERENCES bookings(guid) ON DELETE SET NULL,
            snapshot jsonb NOT NULL
        );
    `);
    await require('./Children').initialize();
}

function returnPath(value) {
    return typeof value === 'string' && /^\/(?:courses|facilities|court-bookings)(?:#[a-zA-Z0-9_-]+)?$/.test(value) ? value : '/courses';
}

async function familyMembers(profileGuid) {
    const { rows } = await pool.query(`
        SELECT guid, name FROM profile_family_members
        WHERE profile_guid = $1 AND deleted_at IS NULL
        ORDER BY date_of_birth DESC NULLS LAST, lower(name), guid`, [profileGuid]);
    return rows;
}

async function addFamilyMember(profileGuid, name) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
        throw new BasketError('Enter a family member name of up to 120 characters.');
    }
    const { rows } = await pool.query(`
        INSERT INTO profile_family_members(profile_guid, name)
        SELECT guid, $2 FROM profiles WHERE guid = $1 AND deleted_at IS NULL RETURNING guid`,
    [profileGuid, name.trim()]);
    if (!rows.length) throw new BasketError('This profile is no longer available.');
    return rows[0];
}

async function removeFamilyMember(profileGuid, guid) {
    if (!isGuid(guid)) throw new BasketError('Choose a saved family member.');
    const result = await pool.query(`
        UPDATE profile_family_members SET deleted_at = now()
        WHERE guid = $2 AND profile_guid = $1 AND deleted_at IS NULL`, [profileGuid, guid]);
    if (!result.rowCount) throw new BasketError('This family member is no longer available.');
}

async function lockBasket(client, profileGuid) {
    const profile = await client.query('SELECT name FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [profileGuid]);
    if (!profile.rowCount) throw new BasketError('This profile is no longer available.');
    await client.query('INSERT INTO course_baskets(profile_guid) VALUES ($1) ON CONFLICT DO NOTHING', [profileGuid]);
    const { rows: [basket] } = await client.query('SELECT * FROM course_baskets WHERE profile_guid = $1 FOR UPDATE', [profileGuid]);
    return basket;
}

async function inventory(client, ids) {
    if (!ids.length) return [];
    // Lock in a stable order so simultaneous multi-run purchases cannot oversell.
    await client.query('SELECT guid FROM course_runs WHERE guid = ANY($1::uuid[]) ORDER BY guid FOR UPDATE', [ids]);
    const { rows } = await client.query(`
        SELECT r.*, c.name AS course_name, f.name AS facility_name,
            (SELECT count(*)::int FROM course_sessions WHERE run_guid = r.guid) AS total_sessions,
            (SELECT count(*)::int FROM course_sessions WHERE run_guid = r.guid AND starts_at > statement_timestamp()) AS remaining_sessions,
            r.capacity - (SELECT count(*)::int FROM course_enrolments WHERE run_guid = r.guid AND cancelled_at IS NULL) AS spaces_remaining,
            COALESCE((SELECT json_agg(json_build_object('starts_at', starts_at, 'ends_at', ends_at) ORDER BY starts_at)
                FROM course_sessions WHERE run_guid = r.guid AND starts_at > statement_timestamp()), '[]') AS sessions
        FROM course_runs r JOIN courses c ON c.guid = r.course_guid
        JOIN facilities f ON f.guid = r.facility_guid WHERE r.guid = ANY($1::uuid[])`, [ids]);
    return rows;
}

async function courtItems(client, profileGuid, role) {
    await client.query(`SELECT o.guid FROM bookable_options o
        JOIN court_basket_items i ON i.option_guid = o.guid
        WHERE i.profile_guid = $1 ORDER BY o.guid FOR UPDATE OF o`, [profileGuid]);
    const { rows } = await client.query(`
        SELECT i.*, o.facility_guid, o.name AS option_name, o.price_pence AS amount_pence,
            f.name AS facility_name, to_jsonb(f) AS facility, p.name AS attendee_name,
            fs.allowed_months,
            ARRAY(SELECT resource_guid FROM bookable_option_resources WHERE option_guid = o.guid) AS resource_guids,
            EXISTS (SELECT 1 FROM booking_reservations r
                JOIN bookable_option_resources resources ON resources.resource_guid = r.resource_guid
                WHERE resources.option_guid = o.guid AND r.starts_at < i.ends_at AND r.ends_at > i.starts_at) AS occupied,
            (SELECT count(*)::int FROM bookings b WHERE b.profile_guid = $1
                AND b.facility_guid = f.guid AND b.ends_at > statement_timestamp()) AS upcoming
        FROM court_basket_items i JOIN bookable_options o ON o.guid = i.option_guid
        JOIN facilities f ON f.guid = o.facility_guid JOIN profiles p ON p.guid = i.profile_guid
        LEFT JOIN facility_sports fs ON fs.facility_guid = f.guid AND fs.sport_guid = o.sport_guid
        WHERE i.profile_guid = $1 ORDER BY i.starts_at, i.guid`, [profileGuid]);
    const latest = new Date();
    latest.setMonth(latest.getMonth() + 1);
    const month = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', month: 'numeric' });
    for (const item of rows) {
        item.kind = 'court';
        const start = new Date(item.starts_at);
        const end = new Date(item.ends_at);
        const count = rows.filter(other => other.facility_guid === item.facility_guid).length;
        const overlaps = rows.some(other => other.guid !== item.guid &&
            new Date(other.starts_at) < end && new Date(other.ends_at) > start &&
            other.resource_guids.some(guid => item.resource_guids.includes(guid)));
        item.error = '';
        if (item.facility.booking_mode !== 'in_app' || !item.resource_guids.length) {
            item.error = 'This court is no longer available. Remove this slot.';
        } else if (start <= new Date() || start > latest) {
            item.error = 'Court slots must be in the future and within one month. Remove this slot.';
        } else if (!item.allowed_months?.includes(Number(month.format(start))) ||
            !item.allowed_months.includes(Number(month.format(new Date(end.getTime() - 1))))) {
            item.error = 'This sport is not available in the selected month. Remove this slot.';
        } else if (role === 'Resident' && item.upcoming + count > item.facility.max_resident_bookings) {
            item.error = 'These slots exceed your upcoming booking limit. Remove a slot.';
        } else if (item.occupied || overlaps) {
            item.error = 'This slot conflicts with another booking or basket slot. Remove it and choose another time.';
        } else if (!await OpeningHours.isBookingWithinHours(item.facility.opening_hours_template_guid, start, end, item.facility)) {
            item.error = 'This slot is outside opening hours. Remove it and choose another time.';
        }
    }
    return rows;
}

async function quote(client, profileGuid, basket, role = 'Resident') {
    const { rows } = await client.query(`
        SELECT i.*, COALESCE(m.name, p.name) AS attendee_name,
            (i.member_guid IS NULL OR (m.profile_guid = i.profile_guid AND m.deleted_at IS NULL)) AS valid_attendee
        FROM course_basket_items i JOIN profiles p ON p.guid = i.profile_guid
        LEFT JOIN profile_family_members m ON m.guid = i.member_guid
        WHERE i.profile_guid = $1 ORDER BY i.guid`, [profileGuid]);
    const rules = rows.length ? await Settings.getCourseBookingRules(client) : null;
    const runs = await inventory(client, [...new Set(rows.map(item => item.run_guid))]);
    const { rows: existing } = await client.query(`
        SELECT e.run_guid, e.member_guid, r.course_guid, r.name AS run_name
        FROM course_enrolments e JOIN course_runs r ON r.guid = e.run_guid
        WHERE e.profile_guid = $1 AND e.cancelled_at IS NULL`, [profileGuid]);
    const items = rows.map(item => {
        const run = runs.find(run => run.guid === item.run_guid);
        const count = rows.filter(other => other.run_guid === item.run_guid).length;
        let error = '';
        if (!item.valid_attendee) error = 'This family member is no longer available. Remove this place.';
        else if (!run?.published || !run.remaining_sessions || run.full_price_pence === null) error = 'This run is no longer available. Remove this place.';
        else if (run.spaces_remaining < count) error = 'There are not enough spaces remaining. Remove a place or choose another run.';
        else if (rules.preventDuplicateClass && existing.some(enrolment =>
            enrolment.run_guid === item.run_guid && enrolment.member_guid === item.member_guid)) {
            error = `${item.attendee_name} is already enrolled on this class: ${run.name} (${run.course_name}). The repeat class booking rule is enabled. Choose another attendee or class.`;
        } else if (rules.preventMultipleClasses && (existing.some(enrolment =>
            enrolment.course_guid === run.course_guid && enrolment.run_guid !== item.run_guid && enrolment.member_guid === item.member_guid) ||
            rows.some(other => other.run_guid !== item.run_guid && other.member_guid === item.member_guid &&
                runs.find(otherRun => otherRun.guid === other.run_guid)?.course_guid === run.course_guid))) {
            const booked = existing.find(enrolment => enrolment.course_guid === run.course_guid &&
                enrolment.run_guid !== item.run_guid && enrolment.member_guid === item.member_guid);
            const basketPlace = rows.find(other => other.run_guid !== item.run_guid && other.member_guid === item.member_guid &&
                runs.find(otherRun => otherRun.guid === other.run_guid)?.course_guid === run.course_guid);
            const otherClass = booked?.run_name || runs.find(otherRun => otherRun.guid === basketPlace?.run_guid)?.name;
            error = `${item.attendee_name} already has ${booked ? 'a booking' : 'a basket place'} in a different class for ${run.course_name}: ${otherClass}. You selected ${run.name}. The one class per course rule is enabled. Choose another attendee or course.`;
        }
        return { ...item, course_name: run?.course_name, run_name: run?.name, facility_name: run?.facility_name,
            sessions: run?.sessions || [], remaining_sessions: run?.remaining_sessions || 0,
            amount_pence: run?.total_sessions && run.full_price_pence !== null
                ? priceForRemainingSessions(run.full_price_pence, run.total_sessions, run.remaining_sessions) : 0, error };
    });
    items.push(...await courtItems(client, profileGuid, role));
    const total = items.reduce((sum, item) => sum + item.amount_pence, 0);
    const { rows: [balance] } = await client.query(`
        SELECT COALESCE(sum(remaining_pence), 0)::int AS pence FROM credits
        WHERE profile_guid = $1 AND expires_at > statement_timestamp()`, [profileGuid]);
    const credit = Math.min(total, balance.pence);
    return { ...basket, items, total, credit, due: total - credit, valid: items.length > 0 && items.every(item => !item.error) };
}

function basket(profileGuid, role) {
    return transaction(async client => quote(client, profileGuid, await lockBasket(client, profileGuid), role));
}

function addCourts(profileGuid, slots, role = 'Resident') {
    if (!Array.isArray(slots) || !slots.length || slots.length > 50 || slots.some(slot =>
        !isGuid(slot?.option_guid) || !Number.isFinite(Date.parse(slot.starts_at)) ||
        !Number.isFinite(Date.parse(slot.ends_at)) || Date.parse(slot.ends_at) <= Date.parse(slot.starts_at))) {
        throw new BasketError('Choose valid court slots.');
    }
    return transaction(async client => {
        await lockBasket(client, profileGuid);
        for (const slot of slots) {
            const option = await client.query('SELECT guid FROM bookable_options WHERE guid = $1', [slot.option_guid]);
            if (!option.rowCount) throw new BasketError('This court is no longer available.');
            await client.query(`INSERT INTO court_basket_items (profile_guid, option_guid, starts_at, ends_at)
                VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [profileGuid, slot.option_guid, slot.starts_at, slot.ends_at]);
        }
        const { rows: [saved] } = await client.query(`UPDATE course_baskets
            SET return_to = '/court-bookings', revision = gen_random_uuid() WHERE profile_guid = $1 RETURNING *`, [profileGuid]);
        const current = await quote(client, profileGuid, saved, role);
        if (current.items.length > 50) throw new BasketError('Your basket can contain up to 50 items.');
        const invalid = current.items.find(item => item.kind === 'court' && item.error);
        if (invalid) throw new BasketError(invalid.error);
    });
}

function add(profileGuid, runGuid, memberGuid, from) {
    if (!isGuid(runGuid) || (memberGuid !== 'self' && !isGuid(memberGuid))) {
        throw new BasketError('Choose a course run and attendee.');
    }
    return transaction(async client => {
        await lockBasket(client, profileGuid);
        const members = await client.query(`
            SELECT guid FROM profile_family_members WHERE guid = $2 AND profile_guid = $1 AND deleted_at IS NULL FOR SHARE`,
        [profileGuid, memberGuid === 'self' ? null : memberGuid]);
        if (memberGuid !== 'self' && !members.rowCount) throw new BasketError('Choose yourself or a saved family member.');
        const { rows: [count] } = await client.query(`SELECT (
            (SELECT count(*) FROM course_basket_items WHERE profile_guid = $1) +
            (SELECT count(*) FROM court_basket_items WHERE profile_guid = $1))::int AS count`, [profileGuid]);
        if (count.count >= 50) throw new BasketError('Your basket can contain up to 50 items.');
        const inserted = await client.query(`
            INSERT INTO course_basket_items(profile_guid, run_guid, member_guid)
            SELECT $1, guid, $3 FROM course_runs WHERE guid = $2 ON CONFLICT DO NOTHING RETURNING guid`,
        [profileGuid, runGuid, memberGuid === 'self' ? null : memberGuid]);
        const { rows: [saved] } = await client.query(`
            UPDATE course_baskets SET return_to = $2, revision = gen_random_uuid() WHERE profile_guid = $1 RETURNING *`,
        [profileGuid, returnPath(from)]);
        const checked = await quote(client, profileGuid, saved);
        if (!checked.items.some(item => item.run_guid === runGuid)) throw new BasketError('This run is no longer available.');
        const invalid = checked.items.find(item => item.run_guid === runGuid &&
            item.member_guid === (memberGuid === 'self' ? null : memberGuid) && item.error);
        if (invalid) throw new BasketError(invalid.error);
        if (!inserted.rowCount && (await Settings.getCourseBookingRules(client)).preventDuplicateClass) {
            const item = checked.items.find(item => item.run_guid === runGuid &&
                item.member_guid === (memberGuid === 'self' ? null : memberGuid));
            throw new BasketError(`${item.attendee_name} already has a place in your basket for ${item.course_name}, class ${item.run_name}. The repeat class booking rule is enabled. Review your basket or choose another attendee.`);
        }
    });
}

function remove(profileGuid, itemGuid) {
    if (!isGuid(itemGuid)) throw new BasketError('Choose a basket item.');
    return transaction(async client => {
        await lockBasket(client, profileGuid);
        await client.query('DELETE FROM course_basket_items WHERE profile_guid = $1 AND guid = $2', [profileGuid, itemGuid]);
        await client.query('DELETE FROM court_basket_items WHERE profile_guid = $1 AND guid = $2', [profileGuid, itemGuid]);
        await client.query('UPDATE course_baskets SET revision = gen_random_uuid() WHERE profile_guid = $1', [profileGuid]);
    });
}

function pay(profileGuid, token, expected, paymentReference, role = 'Resident') {
    if (!isGuid(token)) throw new BasketError('Reload your basket before paying.');
    return transaction(async client => {
        const saved = await lockBasket(client, profileGuid);
        const { rows: [previous] } = await client.query('SELECT guid FROM course_orders WHERE profile_guid = $1 AND checkout_token = $2', [profileGuid, token]);
        if (previous) return previous;
        const current = await quote(client, profileGuid, saved, role);
        if (saved.revision !== token || !current.valid || current.total !== expected.total || current.credit !== expected.credit) {
            throw new BasketError('Your basket, prices, availability or credit changed. Review the basket before paying again.');
        }
        // Lock family records through commit; an archived attendee cannot be enrolled concurrently.
        const memberIds = current.items.map(item => item.member_guid).filter(Boolean);
        const members = await client.query(`
            SELECT guid FROM profile_family_members WHERE guid = ANY($1::uuid[]) AND profile_guid = $2 AND deleted_at IS NULL FOR SHARE`,
        [memberIds, profileGuid]);
        if (members.rowCount !== new Set(memberIds).size) throw new BasketError('An attendee is no longer available. Review your basket.');
        const { rows: [order] } = await client.query(`
            INSERT INTO course_orders(profile_guid, checkout_token, total_pence, credit_pence, payment_reference)
            VALUES ($1, $2, $3, $4, $5) RETURNING guid`, [profileGuid, token, current.total, current.credit, paymentReference]);
        let creditLeft = current.credit;
        const enrolments = [];
        for (const item of current.items) {
            const applied = Math.min(creditLeft, item.amount_pence);
            creditLeft -= applied;
            if (item.kind === 'court') {
                const booking = await Bookings.insertBooking(client, {
                    ...item, profile_guid: profileGuid, booked_by_guid: profileGuid,
                    payment_status: current.due > 0 ? 'paid' : 'credit', payment_reference: paymentReference,
                    credit_applied_pence: applied, amount_paid_pence: item.amount_pence
                });
                await client.query('INSERT INTO order_court_bookings (order_guid, booking_guid, snapshot) VALUES ($1, $2, $3)',
                    [order.guid, booking.guid, JSON.stringify({
                        ...booking, kind: 'court', option_name: item.option_name, facility_name: item.facility_name,
                        amount_pence: item.amount_pence, credit_applied_pence: applied
                    })]);
                await AuditLog.record({ guid: profileGuid, name: item.attendee_name, role }, {
                    action: 'booking.create', entityType: 'booking', entityGuid: booking.guid,
                    entityLabel: item.facility_name, details: {
                        starts_at: item.starts_at, ends_at: item.ends_at, option_guid: item.option_guid,
                        reference: booking.booking_ref, payment_reference: paymentReference,
                        credit_applied_pence: applied
                    }
                }, client);
                enrolments.push({ ...booking, credit_applied_pence: applied });
                continue;
            }
            const { rows: [enrolment] } = await client.query(`
                INSERT INTO course_enrolments(order_guid, run_guid, profile_guid, member_guid, attendee_name,
                    course_name, run_name, facility_name, sessions, amount_pence, credit_applied_pence, booking_ref)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [order.guid, item.run_guid, profileGuid, item.member_guid, item.attendee_name, item.course_name,
                item.run_name, item.facility_name, JSON.stringify(item.sessions), item.amount_pence, applied,
                `AHC-${crypto.randomUUID().toUpperCase()}`]);
            enrolments.push(enrolment);
        }
        if (current.credit) await Credits.spend(client, profileGuid, enrolments);
        await client.query('DELETE FROM course_basket_items WHERE profile_guid = $1', [profileGuid]);
        await client.query('DELETE FROM court_basket_items WHERE profile_guid = $1', [profileGuid]);
        await client.query('UPDATE course_baskets SET revision = gen_random_uuid() WHERE profile_guid = $1', [profileGuid]);
        return order;
    });
}

async function order(profileGuid, guid) {
    if (!isGuid(guid)) return null;
    const { rows: [result] } = await pool.query('SELECT * FROM course_orders WHERE profile_guid = $1 AND guid = $2', [profileGuid, guid]);
    if (!result) return null;
    const { rows: items } = await pool.query('SELECT * FROM course_enrolments WHERE order_guid = $1 ORDER BY booking_ref', [guid]);
    const { rows: courts } = await pool.query(`SELECT snapshot FROM order_court_bookings
        WHERE order_guid = $1 ORDER BY snapshot->>'starts_at'`, [guid]);
    items.push(...courts.map(item => item.snapshot));
    return { ...result, items };
}

async function orders(profileGuid) {
    const { rows } = await pool.query(`
        SELECT guid, total_pence, created_at FROM course_orders WHERE profile_guid = $1
        ORDER BY created_at DESC LIMIT 50`, [profileGuid]);
    return rows;
}

async function upcomingForProfile(profileGuid) {
    const { rows } = await pool.query(`
        SELECT e.guid, e.order_guid, e.member_guid, e.attendee_name, e.course_name,
            e.run_name, e.facility_name, e.booking_ref, e.amount_pence,
            upcoming.sessions
        FROM course_enrolments e
        JOIN course_orders o ON o.guid = e.order_guid AND o.profile_guid = e.profile_guid
        CROSS JOIN LATERAL (
            SELECT jsonb_agg(session ORDER BY (session->>'starts_at')::timestamptz) AS sessions,
                min((session->>'starts_at')::timestamptz) AS next_session
            FROM jsonb_array_elements(e.sessions) AS session
            WHERE (session->>'starts_at')::timestamptz > statement_timestamp()
        ) upcoming
        WHERE e.profile_guid = $1 AND e.cancelled_at IS NULL AND upcoming.next_session IS NOT NULL
        ORDER BY upcoming.next_session, lower(e.attendee_name), e.guid`, [profileGuid]);
    return rows;
}

async function itemCount(profileGuid) {
    const { rows: [result] } = await pool.query(
        `SELECT ((SELECT count(*) FROM course_basket_items WHERE profile_guid = $1) +
            (SELECT count(*) FROM court_basket_items WHERE profile_guid = $1))::int AS count`, [profileGuid]);
    return result.count;
}

module.exports = { initialize, BasketError, returnPath, familyMembers, addFamilyMember, removeFamilyMember, basket, add, addCourts, remove, pay, order, orders, upcomingForProfile, itemCount };
