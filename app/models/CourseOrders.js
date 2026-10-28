const crypto = require('crypto');
const { Pool } = require('pg');
const Credits = require('./Credits');
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
        CREATE UNIQUE INDEX IF NOT EXISTS course_enrolment_attendee_idx
            ON course_enrolments(run_guid, profile_guid, COALESCE(member_guid, profile_guid));
        CREATE INDEX IF NOT EXISTS course_enrolment_order_idx ON course_enrolments(order_guid);
    `);
    await require('./Children').initialize();
}

function returnPath(value) {
    return typeof value === 'string' && /^\/(?:courses|facilities)(?:#[a-zA-Z0-9_-]+)?$/.test(value) ? value : '/courses';
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
            r.capacity - (SELECT count(*)::int FROM course_enrolments WHERE run_guid = r.guid) AS spaces_remaining,
            COALESCE((SELECT json_agg(json_build_object('starts_at', starts_at, 'ends_at', ends_at) ORDER BY starts_at)
                FROM course_sessions WHERE run_guid = r.guid AND starts_at > statement_timestamp()), '[]') AS sessions
        FROM course_runs r JOIN courses c ON c.guid = r.course_guid
        JOIN facilities f ON f.guid = r.facility_guid WHERE r.guid = ANY($1::uuid[])`, [ids]);
    return rows;
}

async function quote(client, profileGuid, basket) {
    const { rows } = await client.query(`
        SELECT i.*, COALESCE(m.name, p.name) AS attendee_name,
            (i.member_guid IS NULL OR (m.profile_guid = i.profile_guid AND m.deleted_at IS NULL)) AS valid_attendee
        FROM course_basket_items i JOIN profiles p ON p.guid = i.profile_guid
        LEFT JOIN profile_family_members m ON m.guid = i.member_guid
        WHERE i.profile_guid = $1 ORDER BY i.guid`, [profileGuid]);
    const runs = await inventory(client, [...new Set(rows.map(item => item.run_guid))]);
    const { rows: existing } = await client.query('SELECT run_guid, member_guid FROM course_enrolments WHERE profile_guid = $1', [profileGuid]);
    const items = rows.map(item => {
        const run = runs.find(run => run.guid === item.run_guid);
        const count = rows.filter(other => other.run_guid === item.run_guid).length;
        let error = '';
        if (!item.valid_attendee) error = 'This family member is no longer available. Remove this place.';
        else if (!run?.published || !run.remaining_sessions || run.full_price_pence === null) error = 'This run is no longer available. Remove this place.';
        else if (run.spaces_remaining < count) error = 'There are not enough spaces remaining. Remove a place or choose another run.';
        else if (existing.some(enrolment => enrolment.run_guid === item.run_guid && enrolment.member_guid === item.member_guid)) {
            error = 'This attendee is already enrolled. Remove this place.';
        }
        return { ...item, course_name: run?.course_name, run_name: run?.name, facility_name: run?.facility_name,
            sessions: run?.sessions || [], remaining_sessions: run?.remaining_sessions || 0,
            amount_pence: run?.total_sessions && run.full_price_pence !== null
                ? priceForRemainingSessions(run.full_price_pence, run.total_sessions, run.remaining_sessions) : 0, error };
    });
    const total = items.reduce((sum, item) => sum + item.amount_pence, 0);
    const { rows: [balance] } = await client.query(`
        SELECT COALESCE(sum(remaining_pence), 0)::int AS pence FROM credits
        WHERE profile_guid = $1 AND expires_at > statement_timestamp()`, [profileGuid]);
    const credit = Math.min(total, balance.pence);
    return { ...basket, items, total, credit, due: total - credit, valid: items.length > 0 && items.every(item => !item.error) };
}

function basket(profileGuid) {
    return transaction(async client => quote(client, profileGuid, await lockBasket(client, profileGuid)));
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
        const { rows: [count] } = await client.query('SELECT count(*)::int AS count FROM course_basket_items WHERE profile_guid = $1', [profileGuid]);
        if (count.count >= 50) throw new BasketError('Your basket can contain up to 50 places.');
        await client.query(`
            INSERT INTO course_basket_items(profile_guid, run_guid, member_guid)
            SELECT $1, guid, $3 FROM course_runs WHERE guid = $2 ON CONFLICT DO NOTHING`,
        [profileGuid, runGuid, memberGuid === 'self' ? null : memberGuid]);
        const { rows: [saved] } = await client.query(`
            UPDATE course_baskets SET return_to = $2, revision = gen_random_uuid() WHERE profile_guid = $1 RETURNING *`,
        [profileGuid, returnPath(from)]);
        const checked = await quote(client, profileGuid, saved);
        if (!checked.items.some(item => item.run_guid === runGuid)) throw new BasketError('This run is no longer available.');
        const invalid = checked.items.find(item => item.run_guid === runGuid && item.error);
        if (invalid) throw new BasketError(invalid.error);
    });
}

function remove(profileGuid, itemGuid) {
    if (!isGuid(itemGuid)) throw new BasketError('Choose a basket item.');
    return transaction(async client => {
        await lockBasket(client, profileGuid);
        await client.query('DELETE FROM course_basket_items WHERE profile_guid = $1 AND guid = $2', [profileGuid, itemGuid]);
        await client.query('UPDATE course_baskets SET revision = gen_random_uuid() WHERE profile_guid = $1', [profileGuid]);
    });
}

function pay(profileGuid, token, expected, paymentReference) {
    if (!isGuid(token)) throw new BasketError('Reload your basket before paying.');
    return transaction(async client => {
        const saved = await lockBasket(client, profileGuid);
        const { rows: [previous] } = await client.query('SELECT guid FROM course_orders WHERE profile_guid = $1 AND checkout_token = $2', [profileGuid, token]);
        if (previous) return previous;
        const current = await quote(client, profileGuid, saved);
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
        await client.query('UPDATE course_baskets SET revision = gen_random_uuid() WHERE profile_guid = $1', [profileGuid]);
        return order;
    });
}

async function order(profileGuid, guid) {
    if (!isGuid(guid)) return null;
    const { rows: [result] } = await pool.query('SELECT * FROM course_orders WHERE profile_guid = $1 AND guid = $2', [profileGuid, guid]);
    if (!result) return null;
    const { rows: items } = await pool.query('SELECT * FROM course_enrolments WHERE order_guid = $1 ORDER BY booking_ref', [guid]);
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
        WHERE e.profile_guid = $1 AND upcoming.next_session IS NOT NULL
        ORDER BY upcoming.next_session, lower(e.attendee_name), e.guid`, [profileGuid]);
    return rows;
}

async function itemCount(profileGuid) {
    const { rows: [result] } = await pool.query(
        'SELECT count(*)::int AS count FROM course_basket_items WHERE profile_guid = $1', [profileGuid]);
    return result.count;
}

module.exports = { initialize, BasketError, returnPath, familyMembers, addFamilyMember, removeFamilyMember, basket, add, remove, pay, order, orders, upcomingForProfile, itemCount };
