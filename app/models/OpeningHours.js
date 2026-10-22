const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});
const TIME_ZONE = 'Europe/London';
const londonDateFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});
const londonDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
});

function partsAsObject(formatter, date) {
    return Object.fromEntries(formatter.formatToParts(date)
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value]));
}

function formatDatabaseTime(value) {
    return value == null ? null : String(value).slice(0, 5);
}

function dateKey(parts) {
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function localMinutes(parts) {
    return Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60;
}

function timeMinutes(value) {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
}

function isIntervalWithinSchedule(schedule, startsAt, endsAt) {
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (!schedule || schedule.is_closed || !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) || end <= start) {
        return false;
    }

    const startParts = partsAsObject(londonDateTimeFormatter, start);
    const endParts = partsAsObject(londonDateTimeFormatter, end);
    if (dateKey(startParts) !== schedule.date || dateKey(endParts) !== schedule.date) {
        return false;
    }

    return localMinutes(startParts) >= timeMinutes(schedule.opens_at) &&
        localMinutes(endParts) <= timeMinutes(schedule.closes_at);
}

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS opening_hours_templates (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS opening_hours_templates_name_lower_key
        ON opening_hours_templates (LOWER(name))
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS opening_hours_rules (
            template_guid uuid NOT NULL REFERENCES opening_hours_templates(guid) ON DELETE CASCADE,
            day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
            opens_at time NOT NULL,
            closes_at time NOT NULL,
            PRIMARY KEY (template_guid, day_of_week),
            CHECK (closes_at > opens_at)
        )
    `);
    await pool.query('DROP TABLE IF EXISTS opening_hours_seasonal_rules');
    await pool.query('ALTER TABLE opening_hours_rules DROP CONSTRAINT IF EXISTS opening_hours_rules_check');
    await pool.query('ALTER TABLE opening_hours_rules DROP CONSTRAINT IF EXISTS opening_hours_rules_close_mode_check');
    await pool.query('ALTER TABLE opening_hours_rules DROP CONSTRAINT IF EXISTS opening_hours_rules_fixed_check');
    await pool.query(`
        UPDATE opening_hours_rules
        SET closes_at = CASE
            WHEN opens_at < TIME '16:30' THEN TIME '16:30'
            WHEN opens_at < TIME '23:00' THEN opens_at + INTERVAL '1 hour'
            ELSE TIME '23:59'
        END
        WHERE closes_at IS NULL
    `);
    await pool.query('ALTER TABLE opening_hours_rules DROP COLUMN IF EXISTS close_mode');
    await pool.query('ALTER TABLE opening_hours_rules ALTER COLUMN closes_at SET NOT NULL');
    await pool.query(`
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'opening_hours_rules_valid_hours'
                    AND conrelid = 'public.opening_hours_rules'::regclass
            ) THEN
                ALTER TABLE opening_hours_rules
                ADD CONSTRAINT opening_hours_rules_valid_hours CHECK (closes_at > opens_at);
            END IF;
        END $$
    `);
    await pool.query('ALTER TABLE facilities ADD COLUMN IF NOT EXISTS opening_hours_template_guid uuid');
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'facilities_opening_hours_template_fkey'
                    AND conrelid = 'public.facilities'::regclass
            ) THEN
                ALTER TABLE facilities
                    ADD CONSTRAINT facilities_opening_hours_template_fkey
                    FOREIGN KEY (opening_hours_template_guid)
                    REFERENCES opening_hours_templates(guid)
                    ON DELETE SET NULL;
            END IF;
        END
        $$
    `);

    await pool.query(
        `UPDATE opening_hours_templates
         SET name = $2
         WHERE LOWER(name) = LOWER($1)
             AND NOT EXISTS (
                 SELECT 1 FROM opening_hours_templates WHERE LOWER(name) = LOWER($2)
             )`,
        ['Daily 08:00 to dusk', 'Camden park hours']
    );
    const seeded = await pool.query(
        `INSERT INTO opening_hours_templates (name)
         VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING guid`,
        ['Camden park hours']
    );
    const template = seeded.rows[0] || (await pool.query(
        'SELECT guid FROM opening_hours_templates WHERE LOWER(name) = LOWER($1)',
        ['Camden park hours']
    )).rows[0];
    if (template) {
        await pool.query(
            `INSERT INTO opening_hours_rules (template_guid, day_of_week, opens_at, closes_at)
             SELECT $1, day_of_week, '08:00', '16:30'
             FROM generate_series(0, 6) AS days(day_of_week)
             ON CONFLICT (template_guid, day_of_week) DO NOTHING`,
            [template.guid]
        );
        await pool.query(
            `UPDATE facilities
             SET opening_hours_template_guid = $1
             WHERE booking_mode = 'in_app' AND opening_hours_template_guid IS NULL`,
            [template.guid]
        );
    }
}

async function findAll() {
    const { rows } = await pool.query(`
        SELECT templates.guid, templates.name, templates.created_at,
               COALESCE(
                   json_agg(
                       json_build_object(
                           'day_of_week', rules.day_of_week,
                           'opens_at', rules.opens_at,
                           'closes_at', rules.closes_at
                       ) ORDER BY rules.day_of_week
                   ) FILTER (WHERE rules.day_of_week IS NOT NULL),
                   '[]'::json
               ) AS rules
        FROM opening_hours_templates AS templates
        LEFT JOIN opening_hours_rules AS rules ON rules.template_guid = templates.guid
        GROUP BY templates.guid
        ORDER BY LOWER(templates.name)
    `);
    return rows;
}

async function create({ name, rules }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'INSERT INTO opening_hours_templates (name) VALUES ($1) RETURNING guid, name',
            [name]
        );
        await saveRules(client, rows[0].guid, rules);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function update(guid, { name, rules }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'UPDATE opening_hours_templates SET name = $2 WHERE guid = $1 RETURNING guid, name',
            [guid, name]
        );
        if (!rows[0]) {
            await client.query('ROLLBACK');
            return null;
        }
        await saveRules(client, guid, rules);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function saveRules(client, templateGuid, rules) {
    await client.query('DELETE FROM opening_hours_rules WHERE template_guid = $1', [templateGuid]);
    if (!rules.length) return;
    await client.query(
        `INSERT INTO opening_hours_rules (template_guid, day_of_week, opens_at, closes_at)
         SELECT $1, rule.day_of_week, rule.opens_at, rule.closes_at
         FROM JSONB_TO_RECORDSET($2::jsonb) AS rule(
             day_of_week smallint,
             opens_at time,
             closes_at time
         )`,
        [templateGuid, JSON.stringify(rules)]
    );
}

async function remove(guid) {
    await pool.query('DELETE FROM opening_hours_templates WHERE guid = $1', [guid]);
}

async function getSchedules(templateGuid, startDate, dayCount = 1) {
    if (!templateGuid) return null;
    const startParts = partsAsObject(londonDateFormatter, new Date(startDate));
    const firstDay = new Date(Date.UTC(Number(startParts.year), Number(startParts.month) - 1, Number(startParts.day)));
    const { rows } = await pool.query(
        `SELECT day_of_week, opens_at, closes_at
         FROM opening_hours_rules
         WHERE template_guid = $1`,
        [templateGuid]
    );
    const rulesByWeekday = new Map(rows.map(rule => [rule.day_of_week, rule]));

    return Array.from({ length: dayCount }, (_, index) => {
        const day = new Date(firstDay);
        day.setUTCDate(day.getUTCDate() + index);
        const dateParts = {
            year: day.getUTCFullYear(),
            month: day.getUTCMonth() + 1,
            day: day.getUTCDate()
        };
        const weekday = day.getUTCDay();
        const date = `${dateParts.year}-${String(dateParts.month).padStart(2, '0')}-${String(dateParts.day).padStart(2, '0')}`;
        const rule = rulesByWeekday.get(weekday);
        if (!rule) {
            return { date, day_of_week: weekday, is_closed: true };
        }

        const opensAt = formatDatabaseTime(rule.opens_at);
        const closesAt = formatDatabaseTime(rule.closes_at);
        return {
            date,
            day_of_week: weekday,
            is_closed: !closesAt,
            opens_at: opensAt,
            closes_at: closesAt
        };
    });
}

async function getToday(templateGuid, date = new Date()) {
    const [schedule] = await getSchedules(templateGuid, date, 1) || [];
    return schedule || null;
}

async function isBookingWithinHours(templateGuid, startsAt, endsAt) {
    if (!templateGuid) return true;
    const [schedule] = await getSchedules(templateGuid, startsAt, 1) || [];
    return isIntervalWithinSchedule(schedule, startsAt, endsAt);
}

module.exports = {
    initialize,
    findAll,
    create,
    update,
    remove,
    getSchedules,
    getToday,
    isIntervalWithinSchedule,
    isBookingWithinHours
};
