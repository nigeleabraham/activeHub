const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initialize() {
    await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_resources (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS booking_resources_facility_name_key
        ON booking_resources (facility_guid, LOWER(name))
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bookable_options (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            sport_guid uuid NOT NULL,
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (facility_guid, sport_guid)
                REFERENCES facility_sports(facility_guid, sport_guid)
                ON DELETE RESTRICT
        )
    `);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS bookable_options_facility_name_key
        ON bookable_options (facility_guid, LOWER(name))
    `);
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'bookable_options_facility_sport_fkey'
                    AND conrelid = 'public.bookable_options'::regclass
            ) THEN
                ALTER TABLE bookable_options
                    ADD CONSTRAINT bookable_options_facility_sport_fkey
                    FOREIGN KEY (facility_guid, sport_guid)
                    REFERENCES facility_sports(facility_guid, sport_guid)
                    ON DELETE RESTRICT;
            END IF;
        END
        $$
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bookable_option_resources (
            option_guid uuid NOT NULL REFERENCES bookable_options(guid) ON DELETE CASCADE,
            resource_guid uuid NOT NULL REFERENCES booking_resources(guid) ON DELETE RESTRICT,
            PRIMARY KEY (option_guid, resource_guid)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS bookings (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            option_guid uuid NOT NULL REFERENCES bookable_options(guid) ON DELETE RESTRICT,
            starts_at timestamptz NOT NULL,
            ends_at timestamptz NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            CHECK (ends_at > starts_at)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_reservations (
            booking_guid uuid NOT NULL REFERENCES bookings(guid) ON DELETE CASCADE,
            resource_guid uuid NOT NULL REFERENCES booking_resources(guid) ON DELETE RESTRICT,
            starts_at timestamptz NOT NULL,
            ends_at timestamptz NOT NULL,
            time_range tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
            CHECK (ends_at > starts_at),
            EXCLUDE USING gist (resource_guid WITH =, time_range WITH &&)
        )
    `);
}

async function findInAppFacilities() {
    const { rows } = await pool.query(
        `SELECT guid, name, latitude, longitude, opening_hours_template_guid
         FROM facilities
         WHERE booking_mode = 'in_app'
         ORDER BY LOWER(name)`
    );
    return rows;
}

async function findFacilitySports(facilityGuid) {
    const { rows } = await pool.query(
        `SELECT sports.guid, sports.name
         FROM facility_sports
         JOIN sports ON sports.guid = facility_sports.sport_guid
         WHERE facility_sports.facility_guid = $1
         ORDER BY LOWER(sports.name)`,
        [facilityGuid]
    );
    return rows;
}

async function findResources(facilityGuid) {
    const { rows } = await pool.query(
        `SELECT resources.guid, resources.name,
                COUNT(option_resources.option_guid)::int AS claim_count
         FROM booking_resources AS resources
         LEFT JOIN bookable_option_resources AS option_resources
             ON option_resources.resource_guid = resources.guid
         WHERE resources.facility_guid = $1
         GROUP BY resources.guid
         ORDER BY LOWER(resources.name)`,
        [facilityGuid]
    );
    return rows;
}

async function findOptions(facilityGuid) {
    const { rows } = await pool.query(
        `SELECT options.guid, options.facility_guid, options.sport_guid,
                options.name, sports.name AS sport_name,
                COALESCE(resource_data.resources, '[]'::json) AS resources
         FROM bookable_options AS options
         JOIN sports ON sports.guid = options.sport_guid
         LEFT JOIN LATERAL (
             SELECT json_agg(
                 json_build_object('guid', resources.guid, 'name', resources.name)
                 ORDER BY LOWER(resources.name)
             ) AS resources
             FROM bookable_option_resources AS claims
             JOIN booking_resources AS resources ON resources.guid = claims.resource_guid
             WHERE claims.option_guid = options.guid
         ) AS resource_data ON TRUE
         WHERE options.facility_guid = $1
         ORDER BY LOWER(sports.name), LOWER(options.name)`,
        [facilityGuid]
    );
    return rows;
}

async function findBookings(facilityGuid, startsAt = null, endsAt = null) {
    const { rows } = await pool.query(
        `SELECT bookings.guid, bookings.option_guid, bookings.starts_at, bookings.ends_at,
                options.name AS option_name, sports.name AS sport_name,
                COALESCE(
                    json_agg(resources.name ORDER BY LOWER(resources.name))
                        FILTER (WHERE resources.guid IS NOT NULL),
                    '[]'::json
                ) AS resource_names,
                COALESCE(
                    json_agg(resources.guid ORDER BY resources.guid)
                        FILTER (WHERE resources.guid IS NOT NULL),
                    '[]'::json
                ) AS resource_guids
         FROM bookings
         JOIN bookable_options AS options ON options.guid = bookings.option_guid
         JOIN sports ON sports.guid = options.sport_guid
         LEFT JOIN booking_reservations AS reservations ON reservations.booking_guid = bookings.guid
         LEFT JOIN booking_resources AS resources ON resources.guid = reservations.resource_guid
                 WHERE bookings.facility_guid = $1
                     AND ($2::timestamptz IS NULL OR bookings.ends_at > $2)
                     AND ($3::timestamptz IS NULL OR bookings.starts_at < $3)
         GROUP BY bookings.guid, options.name, sports.name
         ORDER BY bookings.starts_at`,
                [facilityGuid, startsAt, endsAt]
    );
    return rows;
}

async function createResource(facilityGuid, name) {
    const { rows } = await pool.query(
        `INSERT INTO booking_resources (facility_guid, name)
         SELECT guid, $2 FROM facilities
         WHERE guid = $1 AND booking_mode = 'in_app'
         RETURNING guid, facility_guid, name`,
        [facilityGuid, name]
    );
    return rows[0] || null;
}

async function updateResource(facilityGuid, resourceGuid, name) {
    const { rows } = await pool.query(
        `UPDATE booking_resources SET name = $3
         WHERE facility_guid = $1 AND guid = $2
         RETURNING guid, facility_guid, name`,
        [facilityGuid, resourceGuid, name]
    );
    return rows[0] || null;
}

async function removeResource(facilityGuid, resourceGuid) {
    const result = await pool.query(
        'DELETE FROM booking_resources WHERE facility_guid = $1 AND guid = $2',
        [facilityGuid, resourceGuid]
    );
    return result.rowCount > 0;
}

async function replaceOptionResources(client, optionGuid, facilityGuid, resourceGuids) {
    const uniqueGuids = [...new Set(resourceGuids)];
    if (!uniqueGuids.length) {
        throw new Error('A bookable option must claim at least one resource.');
    }

    const resources = await client.query(
        'SELECT guid FROM booking_resources WHERE facility_guid = $1 AND guid = ANY($2::uuid[])',
        [facilityGuid, uniqueGuids]
    );
    if (resources.rowCount !== uniqueGuids.length) {
        throw new Error('One or more resources do not belong to this facility.');
    }

    await client.query('DELETE FROM bookable_option_resources WHERE option_guid = $1', [optionGuid]);
    await client.query(
        `INSERT INTO bookable_option_resources (option_guid, resource_guid)
         SELECT $1, selected.resource_guid
         FROM UNNEST($2::uuid[]) AS selected(resource_guid)`,
        [optionGuid, uniqueGuids]
    );
}

async function createOption({ facility_guid, sport_guid, name, resource_guids }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO bookable_options (facility_guid, sport_guid, name)
             VALUES ($1, $2, $3)
             RETURNING guid, facility_guid, sport_guid, name`,
            [facility_guid, sport_guid, name]
        );
        await replaceOptionResources(client, rows[0].guid, facility_guid, resource_guids);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function updateOption({ facility_guid, guid, sport_guid, name, resource_guids }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const current = await client.query(
            'SELECT guid FROM bookable_options WHERE guid = $1 AND facility_guid = $2 FOR UPDATE',
            [guid, facility_guid]
        );
        if (!current.rowCount) {
            await client.query('ROLLBACK');
            return null;
        }

        const activeBookings = await client.query(
            'SELECT 1 FROM bookings WHERE option_guid = $1 AND ends_at > now() LIMIT 1',
            [guid]
        );
        if (activeBookings.rowCount) {
            throw new Error('Cannot change a court option while it has current or future bookings.');
        }

        await client.query(
            'UPDATE bookable_options SET sport_guid = $2, name = $3 WHERE guid = $1',
            [guid, sport_guid, name]
        );
        await replaceOptionResources(client, guid, facility_guid, resource_guids);
        await client.query('COMMIT');
        return { guid, facility_guid, sport_guid, name };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function removeOption(facilityGuid, optionGuid) {
    const result = await pool.query(
        'DELETE FROM bookable_options WHERE facility_guid = $1 AND guid = $2',
        [facilityGuid, optionGuid]
    );
    return result.rowCount > 0;
}

async function createBooking({ facility_guid, option_guid, starts_at, ends_at }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const option = await client.query(
            `SELECT guid FROM bookable_options
             WHERE guid = $1 AND facility_guid = $2
             FOR UPDATE`,
            [option_guid, facility_guid]
        );
        if (!option.rowCount) {
            throw new Error('The selected court option does not belong to this facility.');
        }

        const resources = await client.query(
            'SELECT resource_guid FROM bookable_option_resources WHERE option_guid = $1 ORDER BY resource_guid',
            [option_guid]
        );
        if (!resources.rowCount) {
            throw new Error('The selected court option has no resource claims.');
        }

        const booking = await client.query(
            `INSERT INTO bookings (facility_guid, option_guid, starts_at, ends_at)
             VALUES ($1, $2, $3, $4)
             RETURNING guid, starts_at, ends_at`,
            [facility_guid, option_guid, starts_at, ends_at]
        );
        await client.query(
            `INSERT INTO booking_reservations (booking_guid, resource_guid, starts_at, ends_at)
             SELECT $1, selected.resource_guid, $2, $3
             FROM UNNEST($4::uuid[]) AS selected(resource_guid)`,
            [booking.rows[0].guid, starts_at, ends_at, resources.rows.map(row => row.resource_guid)]
        );
        await client.query('COMMIT');
        return booking.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function removeBooking(facilityGuid, bookingGuid) {
    const result = await pool.query(
        'DELETE FROM bookings WHERE facility_guid = $1 AND guid = $2',
        [facilityGuid, bookingGuid]
    );
    return result.rowCount > 0;
}

module.exports = {
    initialize,
    findInAppFacilities,
    findFacilitySports,
    findResources,
    findOptions,
    findBookings,
    createResource,
    updateResource,
    removeResource,
    createOption,
    updateOption,
    removeOption,
    createBooking,
    removeBooking
};
