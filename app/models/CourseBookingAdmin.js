const { Pool } = require('pg');
const Children = require('./Children');
const Credits = require('./Credits');
const AuditLog = require('./AuditLog');
const { isValidCourseDates } = require('../validation');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseFilters(query) {
    const filters = {};
    for (const key of ['sport', 'course', 'run', 'facility', 'q', 'status', 'from', 'to', 'session', 'page', 'view']) {
        if (query[key] !== undefined && typeof query[key] !== 'string') throw new RangeError('Select valid course booking filters.');
        filters[key] = query[key]?.trim() || '';
    }
    for (const key of ['sport', 'course', 'run', 'facility']) {
        if (filters[key] && !GUID.test(filters[key])) throw new RangeError('Select a valid sport, course, class or facility.');
    }
    if (filters.q.length > 120 || !['', 'upcoming', 'completed'].includes(filters.status) ||
        !['', 'search', 'register'].includes(filters.view)) throw new RangeError('Select valid course booking filters.');
    for (const key of ['from', 'to', 'session']) {
        if (filters[key] && !isValidCourseDates(filters[key], filters[key])) throw new RangeError('Enter valid calendar dates.');
    }
    if (filters.from && filters.to && filters.from > filters.to) throw new RangeError('The purchase To date must not be before From.');
    if (filters.page && (!/^[1-9]\d{0,5}$/.test(filters.page))) throw new RangeError('Select a valid results page.');
    filters.page = Number(filters.page || 1);
    filters.view ||= 'search';
    if (filters.view === 'register' && !filters.run) throw new RangeError('Choose a class to view its register.');
    return filters;
}

async function catalogue() {
    const { rows } = await pool.query(`
        SELECT c.guid, c.name,
            COALESCE((SELECT json_agg(json_build_object('guid', s.guid, 'name', s.name) ORDER BY lower(s.name))
                FROM course_sports cs JOIN sports s ON s.guid = cs.sport_guid WHERE cs.course_guid = c.guid), '[]') AS sports,
            COALESCE((SELECT json_agg(json_build_object('guid', r.guid, 'name', r.name,
                'facility_guid', f.guid, 'facility_name', f.name) ORDER BY lower(r.name), r.guid)
                FROM course_runs r JOIN facilities f ON f.guid = r.facility_guid WHERE r.course_guid = c.guid), '[]') AS runs
        FROM courses c WHERE EXISTS (SELECT 1 FROM course_runs WHERE course_guid = c.guid)
        ORDER BY lower(c.name), c.guid`);
    return rows;
}

const base = `
    FROM course_enrolments e
    JOIN course_orders o ON o.guid = e.order_guid
    JOIN profiles p ON p.guid = e.profile_guid
    JOIN course_runs r ON r.guid = e.run_guid
    CROSS JOIN LATERAL (
        SELECT max((session->>'ends_at')::timestamptz) AS last_end
        FROM jsonb_array_elements(e.sessions) session
    ) schedule`;

function conditions(filters) {
    const values = [];
    const clauses = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replaceAll('?', `$${values.length}`)); };
    if (filters.sport) add('EXISTS (SELECT 1 FROM course_sports cs WHERE cs.course_guid = r.course_guid AND cs.sport_guid = ?)', filters.sport);
    if (filters.course) add('r.course_guid = ?', filters.course);
    if (filters.run) add('e.run_guid = ?', filters.run);
    if (filters.facility) add('r.facility_guid = ?', filters.facility);
    if (filters.q) add(`(e.attendee_name ILIKE ? ESCAPE '\\' OR p.name ILIKE ? ESCAPE '\\' OR e.booking_ref ILIKE ? ESCAPE '\\')`,
        `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`);
    if (filters.from) add("(o.created_at AT TIME ZONE 'Europe/London')::date >= ?::date", filters.from);
    if (filters.to) add("(o.created_at AT TIME ZONE 'Europe/London')::date <= ?::date", filters.to);
    if (filters.status === 'upcoming') clauses.push('e.cancelled_at IS NULL AND schedule.last_end > statement_timestamp()');
    if (filters.status === 'completed') clauses.push('e.cancelled_at IS NULL AND (schedule.last_end IS NULL OR schedule.last_end <= statement_timestamp())');
    if (filters.session) add(`EXISTS (SELECT 1 FROM jsonb_array_elements(e.sessions) session
        WHERE ((session->>'starts_at')::timestamptz AT TIME ZONE 'Europe/London')::date = ?::date)`, filters.session);
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

async function search(filters) {
    const { where, values } = conditions(filters);
    const { rows: [count] } = await pool.query(`SELECT count(*)::int AS total ${base} ${where}`, values);
    const { rows } = await pool.query(`SELECT e.guid, e.booking_ref, e.attendee_name, e.member_guid, e.cancelled_at,
        e.course_name, e.run_name, e.facility_name, p.name AS account_name, o.created_at,
        CASE WHEN e.cancelled_at IS NOT NULL THEN 'Removed' WHEN schedule.last_end > statement_timestamp() THEN 'Upcoming' ELSE 'Completed' END AS status
        ${base} ${where} ORDER BY o.created_at DESC, e.guid LIMIT 50 OFFSET $${values.length + 1}`,
    [...values, (filters.page - 1) * 50]);
    return { entries: rows, total: count.total, pageSize: 50 };
}

async function register(runGuid, session = '') {
    const { rows: [run] } = await pool.query(`SELECT r.*, c.name AS course_name, f.name AS facility_name,
        (SELECT count(*)::int FROM course_enrolments WHERE run_guid = r.guid AND cancelled_at IS NULL) AS booked,
        COALESCE((SELECT json_agg(json_build_object('starts_at', starts_at, 'ends_at', ends_at) ORDER BY starts_at)
            FROM course_sessions WHERE run_guid = r.guid), '[]') AS sessions,
        COALESCE((SELECT json_agg(day ORDER BY day) FROM (
            SELECT DISTINCT (starts_at AT TIME ZONE 'Europe/London')::date::text AS day FROM course_sessions WHERE run_guid = r.guid
            UNION
            SELECT DISTINCT ((session->>'starts_at')::timestamptz AT TIME ZONE 'Europe/London')::date::text
            FROM course_enrolments e CROSS JOIN LATERAL jsonb_array_elements(e.sessions) session WHERE e.run_guid = r.guid
        ) dates), '[]') AS dates
        FROM course_runs r JOIN courses c ON c.guid = r.course_guid JOIN facilities f ON f.guid = r.facility_guid
        WHERE r.guid = $1`, [runGuid]);
    if (!run) return null;
    if (session && !run.dates.includes(session)) throw new RangeError('Choose a session date from this class.');
    const { where, values } = conditions({ run: runGuid, session });
    const { rows } = await pool.query(`SELECT e.guid, e.booking_ref, e.attendee_name, e.member_guid,
        p.name AS account_name, e.sessions, o.created_at,
        child.medical_concern, child.medical_conditions, child.medical_other, child.activity_limitation,
        p.email AS parent_email, p.telephone AS parent_telephone,
        json_build_object('inherit_parental_contact', child.inherit_parental_contact,
            'parental_contact_name', child.parental_contact_name,
            'parental_contact_email', child.parental_contact_email,
            'parental_contact_telephone', child.parental_contact_telephone) AS child_contact,
        CASE WHEN schedule.last_end > statement_timestamp() THEN 'Upcoming' ELSE 'Completed' END AS status
        ${base}
        LEFT JOIN profile_family_members child ON child.guid = e.member_guid AND child.profile_guid = e.profile_guid
        ${where} AND e.cancelled_at IS NULL ORDER BY lower(e.attendee_name), e.guid`, values);
    const entries = rows.map(({ child_contact, parent_email, parent_telephone, ...entry }) => ({
        ...entry,
        parental_contact: entry.member_guid ? Children.resolve(child_contact, {
            name: entry.account_name, email: parent_email, telephone: parent_telephone
        }) : null
    }));
    return { ...run, entries, spaces: run.capacity - run.booked };
}

async function details(guid) {
    if (!GUID.test(guid)) return null;
    const { rows: [booking] } = await pool.query(`SELECT e.*, p.name AS account_name, p.email AS account_email,
        o.created_at, o.payment_reference,
        CASE WHEN e.cancelled_at IS NOT NULL THEN 'Removed' WHEN schedule.last_end > statement_timestamp() THEN 'Upcoming' ELSE 'Completed' END AS status
        ${base} WHERE e.guid = $1`, [guid]);
    if (!booking) return null;
    return { booking };
}

function removalAmount(value, maximum) {
    if (typeof value !== 'string' || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) {
        throw new RangeError('Enter a valid credit amount in pounds.');
    }
    const [pounds, pennies = ''] = value.split('.');
    const pence = Number(pounds) * 100 + Number(pennies.padEnd(2, '0'));
    if (pence <= 0 || pence > maximum) throw new RangeError('Credit must be greater than zero and cannot exceed the price paid for this place.');
    return pence;
}

function remainingValue(booking, now = Date.now()) {
    const remaining = booking.sessions.filter(session => new Date(session.starts_at).getTime() > now).length;
    return booking.sessions.length ? Math.round(booking.amount_pence * remaining / booking.sessions.length) : 0;
}

async function removeAttendee(guid, mode, amount, actor) {
    if (!GUID.test(guid) || !['none', 'refundable', 'non-refundable'].includes(mode)) {
        throw new RangeError('Choose a valid attendee removal action.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Use the same profile -> class lock order as checkout.
        const { rows: [identity] } = await client.query('SELECT profile_guid, run_guid FROM course_enrolments WHERE guid = $1', [guid]);
        if (!identity) throw new RangeError('This booking no longer exists.');
        await client.query('SELECT guid FROM profiles WHERE guid = $1 FOR UPDATE', [identity.profile_guid]);
        await client.query('SELECT guid FROM course_runs WHERE guid = $1 FOR UPDATE', [identity.run_guid]);
        const { rows: [booking] } = await client.query(`SELECT e.*, o.payment_reference
            FROM course_enrolments e JOIN course_orders o ON o.guid = e.order_guid WHERE e.guid = $1 FOR UPDATE OF e`, [guid]);
        if (booking.cancelled_at) throw new RangeError('This attendee has already been removed. No further credit was issued.');
        if (mode !== 'none' && remainingValue(booking) <= 0) {
            throw new RangeError('No credit is available for the remaining purchased sessions. Choose removal without credit.');
        }
        const pence = mode === 'none' ? 0 : removalAmount(amount, booking.amount_pence);
        const funding = pence ? await Credits.grant(client, { ...booking, amount_paid_pence: booking.amount_pence },
            pence, actor.name, mode === 'refundable', { allowPartial: true, forceNonRefundable: mode === 'non-refundable' })
            : { refundable_pence: 0, non_refundable_pence: 0 };
        await client.query(`UPDATE course_enrolments SET cancelled_at = statement_timestamp(),
            cancelled_by_name = $2, cancellation_mode = $3, cancellation_credit_pence = $4 WHERE guid = $1`,
        [guid, actor.name, mode, pence]);
        await AuditLog.record(actor, { action: 'course-booking.cancel', entityType: 'course-booking',
            entityGuid: guid, entityLabel: booking.booking_ref, details: {
                attendee_name: booking.attendee_name, run_guid: booking.run_guid, mode, credit_pence: pence, ...funding
            } }, client);
        await client.query('COMMIT');
        return booking;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { parseFilters, catalogue, search, register, details, removalAmount, remainingValue, removeAttendee };
