const { Pool } = require('pg');
const { createGoogleMapsUrl } = require('../facilityUtils');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initialize() {
    await pool.query(`
        DO $$
        BEGIN
            IF to_regclass('public.todos') IS NOT NULL
                AND to_regclass('public.facilities') IS NULL THEN
                ALTER TABLE todos RENAME TO facilities;
            END IF;
        END
        $$
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                    AND table_name = 'facilities'
                    AND column_name = 'task'
            ) AND NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                    AND table_name = 'facilities'
                    AND column_name = 'name'
            ) THEN
                ALTER TABLE facilities RENAME COLUMN task TO name;
            END IF;
        END
        $$
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS facilities (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            address text NOT NULL,
            postcode text NOT NULL,
            latitude numeric(20, 17) NOT NULL,
            longitude numeric(20, 17) NOT NULL,
            google_maps_url text NOT NULL,
            description text NOT NULL,
            booking_mode text NOT NULL DEFAULT 'in_app',
            external_booking_url text,
            opening_hours_template_guid uuid,
            source_url text UNIQUE,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        ALTER TABLE facilities
            ADD COLUMN IF NOT EXISTS guid uuid DEFAULT gen_random_uuid(),
            ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS postcode text NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS latitude numeric(20, 17),
            ADD COLUMN IF NOT EXISTS longitude numeric(20, 17),
            ADD COLUMN IF NOT EXISTS google_maps_url text NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS booking_mode text NOT NULL DEFAULT 'in_app',
            ADD COLUMN IF NOT EXISTS external_booking_url text,
            ADD COLUMN IF NOT EXISTS opening_hours_template_guid uuid,
            ADD COLUMN IF NOT EXISTS max_resident_bookings integer NOT NULL DEFAULT 8,
            ADD COLUMN IF NOT EXISTS source_url text,
            ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()
    `);

    await pool.query(`
        ALTER TABLE facilities
            ALTER COLUMN latitude TYPE numeric(20, 17),
            ALTER COLUMN longitude TYPE numeric(20, 17)
    `);

    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'facilities_booking_mode_check'
                    AND conrelid = 'public.facilities'::regclass
            ) THEN
                ALTER TABLE facilities
                    ADD CONSTRAINT facilities_booking_mode_check
                    CHECK (booking_mode IN ('in_app', 'external'));
            END IF;
        END
        $$
    `);

    await pool.query(`
        UPDATE facilities
        SET guid = gen_random_uuid()
        WHERE guid IS NULL
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS facilities_guid_key ON facilities (guid)
    `);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS facilities_source_url_key ON facilities (source_url)
    `);

    await pool.query(`
        UPDATE facilities
        SET google_maps_url = 'https://www.google.com/maps/search/?api=1&query='
            || latitude || '%2C' || longitude || '&zoom=4'
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `);
}

async function findAll() {
    const { rows } = await pool.query(
        `SELECT facilities.guid, facilities.name, facilities.address, facilities.postcode,
                facilities.latitude, facilities.longitude, facilities.google_maps_url,
                facilities.description, facilities.booking_mode, facilities.external_booking_url,
                facilities.opening_hours_template_guid, facilities.max_resident_bookings,
                opening_hours_templates.name AS opening_hours_template_name,
                facilities.created_at,
                COALESCE(course_data.courses, '[]'::json) AS courses,
                COALESCE(sport_data.sports, '[]'::json) AS sports
         FROM facilities
         LEFT JOIN opening_hours_templates
             ON opening_hours_templates.guid = facilities.opening_hours_template_guid
         LEFT JOIN LATERAL (
             SELECT json_agg(
                 json_build_object('guid', courses.guid, 'name', courses.name)
                 ORDER BY LOWER(courses.name)
             ) AS courses
             FROM courses
             WHERE EXISTS (SELECT 1 FROM course_runs cf
                           WHERE cf.course_guid = courses.guid AND cf.facility_guid = facilities.guid)
         ) AS course_data ON TRUE
         LEFT JOIN LATERAL (
             SELECT json_agg(
                 json_build_object('guid', sports.guid, 'name', sports.name)
                 ORDER BY LOWER(sports.name)
             ) AS sports
             FROM facility_sports
             JOIN sports ON sports.guid = facility_sports.sport_guid
             WHERE facility_sports.facility_guid = facilities.guid
         ) AS sport_data ON TRUE
         ORDER BY LOWER(facilities.name)`
    );
    return rows;
}

async function create({ name, address, postcode, latitude, longitude, description, booking_mode, external_booking_url, opening_hours_template_guid, max_resident_bookings = 8, sport_guids }) {
    const googleMapsUrl = createGoogleMapsUrl(latitude, longitude);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description, booking_mode, external_booking_url, opening_hours_template_guid, max_resident_bookings)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING guid, name, address, postcode, latitude, longitude, google_maps_url, description, booking_mode, external_booking_url, created_at`,
            [name, address, postcode, latitude, longitude, googleMapsUrl, description, booking_mode, external_booking_url, opening_hours_template_guid, max_resident_bookings]
        );
        await replaceSports(client, rows[0].guid, sport_guids);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function update(guid, { name, address, postcode, latitude, longitude, description, booking_mode, external_booking_url, opening_hours_template_guid, max_resident_bookings = 8, sport_guids }) {
    const googleMapsUrl = createGoogleMapsUrl(latitude, longitude);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `UPDATE facilities
             SET name = $2, address = $3, postcode = $4, latitude = $5,
                 longitude = $6, google_maps_url = $7, description = $8,
                 booking_mode = $9, external_booking_url = $10,
                 opening_hours_template_guid = $11, max_resident_bookings = $12
             WHERE guid = $1
             RETURNING guid, name, address, postcode, latitude, longitude, google_maps_url, description, booking_mode, external_booking_url, created_at`,
            [guid, name, address, postcode, latitude, longitude, googleMapsUrl, description, booking_mode, external_booking_url, opening_hours_template_guid, max_resident_bookings]
        );
        if (!rows[0]) {
            await client.query('ROLLBACK');
            return null;
        }
        await replaceSports(client, guid, sport_guids);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function replaceSports(client, facilityGuid, sportGuids = []) {
    await client.query(
        `DELETE FROM facility_sports
         WHERE facility_guid = $1 AND NOT (sport_guid = ANY($2::uuid[]))`,
        [facilityGuid, sportGuids]
    );
    if (sportGuids.length) {
        await client.query(
            `INSERT INTO facility_sports (facility_guid, sport_guid)
             SELECT $1, selected.sport_guid
             FROM UNNEST($2::uuid[]) AS selected(sport_guid)
             ON CONFLICT DO NOTHING`,
            [facilityGuid, sportGuids]
        );
    }
}

async function upsertImported(facility) {
    const googleMapsUrl = createGoogleMapsUrl(facility.latitude, facility.longitude);
    const { rows } = await pool.query(
        `INSERT INTO facilities (
            name, address, postcode, latitude, longitude, google_maps_url,
            description, booking_mode, external_booking_url, source_url
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_url) DO UPDATE SET
            name = EXCLUDED.name,
            address = EXCLUDED.address,
            postcode = EXCLUDED.postcode,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            google_maps_url = EXCLUDED.google_maps_url,
            description = EXCLUDED.description
         RETURNING guid`,
        [
            facility.name,
            facility.address,
            facility.postcode,
            facility.latitude,
            facility.longitude,
            googleMapsUrl,
            facility.description,
            facility.booking_mode,
            facility.external_booking_url,
            facility.source_url
        ]
    );
    return rows[0];
}

async function close() {
    await pool.end();
}

async function remove(guid) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM bookings WHERE facility_guid = $1', [guid]);
        await client.query(
            `DELETE FROM bookable_option_resources
             WHERE option_guid IN (
                 SELECT guid FROM bookable_options WHERE facility_guid = $1
             )`,
            [guid]
        );
        await client.query('DELETE FROM bookable_options WHERE facility_guid = $1', [guid]);
        await client.query('DELETE FROM booking_resources WHERE facility_guid = $1', [guid]);
        await client.query('DELETE FROM facilities WHERE guid = $1', [guid]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { initialize, findAll, create, update, upsertImported, close, remove };