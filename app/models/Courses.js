const { Pool } = require('pg');
const { parseRunInput, priceForRemainingSessions, compareCourses, compareRuns } = require('../courseRuns');
const { descriptionConfig, resolveDescription } = require('../courseDescriptions');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initialize() {
    await require('./Sports').initialize();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS courses (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            name text NOT NULL,
            description text,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS description text');
    await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS description_sport_guid uuid REFERENCES sports(guid) ON DELETE RESTRICT;
        ALTER TABLE courses ADD COLUMN IF NOT EXISTS description_overrides jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE courses ADD COLUMN IF NOT EXISTS description_sections jsonb NOT NULL DEFAULT '[]'`);
    await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS end_date date');
    await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS start_date date;
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'courses'::regclass AND conname = 'courses_date_order') THEN
                ALTER TABLE courses ADD CONSTRAINT courses_date_order CHECK (start_date <= end_date);
            END IF;
        END $$`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS course_facilities (
            course_guid uuid NOT NULL REFERENCES courses(guid) ON DELETE CASCADE,
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            PRIMARY KEY (course_guid, facility_guid)
        );
        CREATE INDEX IF NOT EXISTS course_facilities_facility_idx ON course_facilities (facility_guid, course_guid);
        CREATE TABLE IF NOT EXISTS course_sports (
            course_guid uuid NOT NULL REFERENCES courses(guid) ON DELETE CASCADE,
            sport_guid uuid NOT NULL REFERENCES sports(guid) ON DELETE RESTRICT,
            PRIMARY KEY (course_guid, sport_guid)
        );
        CREATE INDEX IF NOT EXISTS course_sports_sport_idx ON course_sports (sport_guid, course_guid);
        INSERT INTO course_facilities (course_guid, facility_guid)
            SELECT guid, facility_guid FROM courses WHERE facility_guid IS NOT NULL ON CONFLICT DO NOTHING;
        ALTER TABLE courses ALTER COLUMN facility_guid DROP NOT NULL;
        UPDATE courses SET facility_guid = NULL WHERE facility_guid IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS course_facilities_one_per_course_idx ON course_facilities (course_guid);
        CREATE TABLE IF NOT EXISTS sport_course_faqs (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            sport_guid uuid NOT NULL REFERENCES sports(guid) ON DELETE CASCADE,
            question text NOT NULL,
            answer text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS sport_course_faqs_sport_idx ON sport_course_faqs (sport_guid, created_at, guid);
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS course_runs (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            course_guid uuid NOT NULL REFERENCES courses(guid) ON DELETE CASCADE,
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            name text NOT NULL,
            full_price_pence integer CHECK (full_price_pence >= 0),
            capacity integer CHECK (capacity > 0),
            published boolean NOT NULL DEFAULT false,
            CHECK (NOT published OR (full_price_pence IS NOT NULL AND capacity IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS course_runs_course_idx ON course_runs(course_guid);
        CREATE INDEX IF NOT EXISTS course_runs_facility_idx ON course_runs(facility_guid);
        CREATE TABLE IF NOT EXISTS course_sessions (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            run_guid uuid NOT NULL REFERENCES course_runs(guid) ON DELETE CASCADE,
            starts_at timestamptz NOT NULL,
            ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
            UNIQUE (run_guid, starts_at)
        );
        ALTER TABLE courses ADD COLUMN IF NOT EXISTS runs_migrated boolean NOT NULL DEFAULT false;
        BEGIN;
        LOCK TABLE courses IN SHARE ROW EXCLUSIVE MODE;
        INSERT INTO course_runs (course_guid, facility_guid, name)
            SELECT c.guid, cf.facility_guid, 'Existing run - complete details'
            FROM courses c JOIN course_facilities cf ON cf.course_guid = c.guid WHERE NOT c.runs_migrated;
        UPDATE courses SET runs_migrated = true WHERE NOT runs_migrated;
        COMMIT;
    `);
}

async function findAll({ availableOnly = false } = {}) {
    const { rows } = await pool.query(`
        SELECT courses.guid, courses.name, courses.description, courses.created_at,
               courses.description_sport_guid, courses.description_overrides, courses.description_sections,
               COALESCE(description_sport.course_description_sections,'[]'::jsonb) AS default_sections,
               to_char(courses.end_date, 'YYYY-MM-DD') AS end_date,
               to_char(courses.start_date, 'YYYY-MM-DD') AS start_date,
               ARRAY(SELECT DISTINCT facility_guid FROM course_runs WHERE course_guid = courses.guid AND (NOT $1::boolean OR published)) AS facility_guids,
               ARRAY(SELECT sport_guid FROM course_sports WHERE course_guid = courses.guid ORDER BY sport_guid) AS sport_guids
        FROM courses
        LEFT JOIN sports description_sport ON description_sport.guid=courses.description_sport_guid
        WHERE NOT $1::boolean OR EXISTS (
            SELECT 1 FROM course_runs r JOIN course_sessions s ON s.run_guid = r.guid
            WHERE r.course_guid = courses.guid AND r.published AND s.starts_at > statement_timestamp())
        ORDER BY LOWER(courses.name), courses.guid
    `, [availableOnly]);
    const runs = await findRuns({ availableOnly });
    return rows.sort(compareCourses).map(course => ({ ...course,
        resolved_sections: resolveDescription(course, course.default_sections),
        runs: runs.filter(run => run.course_guid === course.guid) }));
}

async function create(details) {
    return save(null, details);
}

async function update(guid, details) {
    return save(guid, details);
}

async function save(guid, { name, description, sport_guids, description_sport_guid = null,
    description_overrides = {}, description_sections = [] }) {
    if (!Array.isArray(sport_guids) || !sport_guids.length) throw new Error('Assign at least one sport');
    const config = descriptionConfig(description_sport_guid, description_overrides, description_sections, sport_guids);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (config.description_sport_guid) {
            const { rows: sources } = await client.query('SELECT course_description_sections FROM sports WHERE guid=$1 FOR SHARE',
                [config.description_sport_guid]);
            if (sources.length !== 1 || Object.keys(config.description_overrides).some(id =>
                !sources[0].course_description_sections.some(section => section.id === id))) {
                throw new Error('Description overrides must match current sport sections');
            }
        } else if (Object.keys(config.description_overrides).length) {
            throw new Error('Description overrides require a sport source');
        }
        const { rows } = guid ? await client.query(
            `UPDATE courses SET name=$2,description=$3,description_sport_guid=$4,description_overrides=$5,
                description_sections=$6 WHERE guid=$1 RETURNING *`,
            [guid, name, description, config.description_sport_guid, JSON.stringify(config.description_overrides), JSON.stringify(config.description_sections)]
        ) : await client.query(`INSERT INTO courses (name,description,description_sport_guid,description_overrides,description_sections,runs_migrated)
            VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
            [name, description, config.description_sport_guid, JSON.stringify(config.description_overrides), JSON.stringify(config.description_sections)]);
        if (!rows.length) {
            await client.query('COMMIT');
            return null;
        }
        const course = rows[0];
        await client.query('DELETE FROM course_sports WHERE course_guid = $1', [course.guid]);
        await client.query('INSERT INTO course_sports SELECT $1, unnest($2::uuid[])', [course.guid, [...new Set(sport_guids)]]);
        await client.query('COMMIT');
        return { ...course, sport_guids };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function findRuns({ availableOnly = false } = {}) {
    const { rows } = await pool.query(`
            SELECT r.*, f.name AS facility_name,
                r.capacity - (SELECT count(*)::int FROM course_enrolments WHERE run_guid = r.guid) AS spaces_remaining,
                (SELECT count(*)::int FROM course_sessions WHERE run_guid = r.guid) AS total_sessions,
                (SELECT count(*)::int FROM course_sessions WHERE run_guid = r.guid AND starts_at > statement_timestamp()) AS remaining_sessions,
                COALESCE((SELECT json_agg(json_build_object(
                    'starts_local', to_char(starts_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD HH24:MI'),
                    'ends_local', to_char(ends_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD HH24:MI'))
                    ORDER BY starts_at) FROM course_sessions WHERE run_guid = r.guid
                    AND (NOT $1::boolean OR starts_at > statement_timestamp())), '[]') AS sessions
            FROM course_runs r JOIN facilities f ON f.guid = r.facility_guid
            WHERE NOT $1::boolean OR (r.published AND EXISTS (
                SELECT 1 FROM course_sessions WHERE run_guid = r.guid AND starts_at > statement_timestamp()))
            ORDER BY LOWER(f.name), LOWER(r.name), r.guid`, [availableOnly]);
    return rows.sort(compareRuns).map(run => ({ ...run, current_price_pence: run.full_price_pence !== null && run.total_sessions
        ? priceForRemainingSessions(run.full_price_pence, run.total_sessions, run.remaining_sessions) : null }));
}

async function saveRun(guid, courseGuid, { facility_guid, name, full_price_pence, capacity, sessions }) {
    const valid = Number.isInteger(full_price_pence) && full_price_pence >= 0 && full_price_pence <= 99999999 &&
        Number.isInteger(capacity) && Array.isArray(sessions) && sessions.every(session =>
            session && typeof session.starts_local === 'string' && typeof session.ends_local === 'string' &&
            session.starts_local.slice(0, 10) === session.ends_local.slice(0, 10)) &&
        parseRunInput({ name, price: (full_price_pence / 100).toFixed(2), capacity: String(capacity),
            schedule_mode: 'individual', sessions: sessions.map(session => `${session.starts_local} ${session.ends_local.slice(11)}`).join('\n') });
    if (!valid) throw new Error('Invalid course run details or sessions');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = guid ? await client.query(`UPDATE course_runs SET facility_guid=$3, name=$4,
                full_price_pence=$5, capacity=$6, published=true WHERE guid=$1 AND course_guid=$2 RETURNING guid`,
            [guid, courseGuid, facility_guid, name, full_price_pence, capacity]) :
                await client.query(`INSERT INTO course_runs (course_guid, facility_guid, name, full_price_pence, capacity, published)
                    VALUES ($1,$2,$3,$4,$5,true) RETURNING guid`, [courseGuid, facility_guid, name, full_price_pence, capacity]);
        if (!rows.length) {
            await client.query('ROLLBACK');
            return null;
        }
        const run = rows[0];
        const enrolled = await client.query('SELECT count(*)::int AS count FROM course_enrolments WHERE run_guid = $1', [run.guid]);
        if (capacity < enrolled.rows[0].count) {
            const error = new Error('Capacity cannot be less than the number of enrolled attendees.');
            error.code = 'COURSE_CAPACITY';
            throw error;
        }
        await client.query('DELETE FROM course_sessions WHERE run_guid=$1', [run.guid]);
        for (const session of sessions) {
            const result = await client.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
                    SELECT $1, $2::text::timestamp AT TIME ZONE 'Europe/London', $3::text::timestamp AT TIME ZONE 'Europe/London'
                    WHERE to_char(($2::text::timestamp AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London', 'YYYY-MM-DD HH24:MI')=$2::text
                    AND to_char(($3::text::timestamp AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London', 'YYYY-MM-DD HH24:MI')=$3::text`,
            [run.guid, session.starts_local, session.ends_local]);
            if (!result.rowCount) {
                const error = new Error('A session time does not exist because the UK clocks change. Choose a different time.');
                error.code = 'INVALID_SESSION_TIME';
                throw error;
            }
        }
        await client.query('COMMIT');
        return run;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function removeRun(guid, courseGuid) {
    return (await pool.query('DELETE FROM course_runs WHERE guid=$1 AND course_guid=$2 RETURNING guid', [guid, courseGuid])).rows[0] || null;
}

async function remove(guid) {
    const { rows } = await pool.query('DELETE FROM courses WHERE guid = $1 RETURNING guid', [guid]);
    return rows[0] || null;
}

async function findFaqs() {
    return (await pool.query('SELECT * FROM sport_course_faqs ORDER BY created_at, guid')).rows;
}

async function saveFaq(guid, { sport_guid, question, answer }) {
    const { rows } = guid ? await pool.query(
        'UPDATE sport_course_faqs SET sport_guid = $2, question = $3, answer = $4 WHERE guid = $1 RETURNING *',
        [guid, sport_guid, question, answer]
    ) : await pool.query('INSERT INTO sport_course_faqs (sport_guid, question, answer) VALUES ($1, $2, $3) RETURNING *',
        [sport_guid, question, answer]);
    return rows[0] || null;
}

async function removeFaq(guid) {
    return (await pool.query('DELETE FROM sport_course_faqs WHERE guid = $1', [guid])).rowCount > 0;
}

module.exports = { initialize, findAll, create, update, remove, findRuns, saveRun, removeRun, findFaqs, saveFaq, removeFaq };
