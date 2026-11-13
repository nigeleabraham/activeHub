const { Pool } = require('pg');
const { isValidDateRange } = require('../validation');
const { actionLabel } = require('../auditEvents');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const PAGE_SIZE = 50;
const RANGE_FILTER = `created_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/London'
    AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/London'`;
const MAX_RANGE_DAYS = 62;
const SORT_COLUMNS = Object.freeze({
    time: 'created_at',
    profile: 'lower(profile_name)',
    event: 'array_position($6::text[], action)',
    item: "lower(COALESCE(NULLIF(entity_label, ''), entity_type))",
    details: 'details::text'
});

function isValidSort(sort, direction) {
    return typeof sort === 'string' && Object.hasOwn(SORT_COLUMNS, sort) && ['asc', 'desc'].includes(direction);
}

function currentMonth(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', year: 'numeric', month: '2-digit'
    }).formatToParts(now);
    return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function isValidMonth(month) {
    return typeof month === 'string' && /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(month);
}

function isValidRange(from, to) {
    return isValidDateRange(from, to, MAX_RANGE_DAYS);
}

function requireRange(from, to) {
    if (!isValidRange(from, to)) throw new RangeError('Select valid From and To dates spanning no more than 62 days.');
}

async function initialize() {
    // Profile name and role are copied onto each row so the trail survives profile edits and deletion.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            created_at timestamptz NOT NULL DEFAULT now(),
            profile_guid uuid REFERENCES profiles(guid) ON DELETE SET NULL,
            profile_name text NOT NULL,
            profile_role text NOT NULL,
            action text NOT NULL,
            entity_type text NOT NULL,
            entity_guid text,
            entity_label text,
            details jsonb NOT NULL DEFAULT '{}'::jsonb
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS audit_log_profile_idx ON audit_log (profile_guid)');
    await pool.query('CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action)');
}

async function record(profile, { action, entityType, entityGuid = null, entityLabel = null, details = {} }, client = pool) {
    await client.query(
        `INSERT INTO audit_log
            (profile_guid, profile_name, profile_role, action, entity_type, entity_guid, entity_label, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [profile.guid, profile.name, profile.role, action, entityType, entityGuid, entityLabel, JSON.stringify(details)]
    );
}

async function search({ profileGuid = null, action = null, page = 1, from, to, sort = 'time', direction = 'desc' } = {}) {
    requireRange(from, to);
    if (!isValidSort(sort, direction)) throw new RangeError('Select a valid audit sort order.');
    const filters = [from, to, profileGuid, action];
    const offset = (page - 1) * PAGE_SIZE;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset)) {
        throw new RangeError('Select a valid audit page.');
    }
    const where = `${RANGE_FILTER} AND ($3::uuid IS NULL OR profile_guid = $3) AND ($4::text IS NULL OR action = $4)`;
    const eventOrder = sort === 'event'
        ? (await findActions()).sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)) || a.localeCompare(b))
        : null;
    const order = `${SORT_COLUMNS[sort]} ${direction.toUpperCase()} NULLS LAST, guid ASC`;
    const [rows, total] = await Promise.all([
        pool.query(
            `SELECT guid, created_at, profile_guid, profile_name, profile_role,
                    action, entity_type, entity_guid, entity_label, details
             FROM audit_log WHERE ${where}
             ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET $5`,
            sort === 'event' ? [...filters, offset, eventOrder] : [...filters, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS count FROM audit_log WHERE ${where}`, filters)
    ]);
    return { entries: rows.rows, total: total.rows[0].count, pageSize: PAGE_SIZE };
}

async function findActions() {
    const { rows } = await pool.query(
        `WITH RECURSIVE actions AS (
            (SELECT action FROM audit_log ORDER BY action LIMIT 1)
            UNION ALL
            SELECT next_action.action FROM actions
            CROSS JOIN LATERAL (
                SELECT action FROM audit_log WHERE action > actions.action ORDER BY action LIMIT 1
            ) AS next_action
        )
        SELECT action FROM actions ORDER BY action`
    );
    return rows.map(row => row.action);
}

// Audit entries are kept for two months; older ones are deleted.
const RETENTION = '2 months';

async function purgeExpired() {
    const { rowCount } = await pool.query(`DELETE FROM audit_log WHERE created_at < now() - INTERVAL '${RETENTION}'`);
    return rowCount;
}

function purgeOnStartup() {
    return purgeExpired()
        .then(count => { if (count) console.log(`Deleted ${count} audit entries older than ${RETENTION}`); })
        .catch(error => console.error('Audit purge failed:', error));
}

module.exports = { PAGE_SIZE, MAX_RANGE_DAYS, RETENTION, currentMonth, isValidMonth, isValidRange, isValidSort, initialize, record, search, findActions, purgeExpired, purgeOnStartup };
