const crypto = require('crypto');
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
        ALTER TABLE bookings
        ADD COLUMN IF NOT EXISTS profile_guid uuid REFERENCES profiles(guid) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS booked_by_guid uuid REFERENCES profiles(guid) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'not_required',
        ADD COLUMN IF NOT EXISTS payment_reference text,
        ADD COLUMN IF NOT EXISTS amount_pence integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS credit_applied_pence integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS amount_paid_pence integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS booking_ref text,
        ADD COLUMN IF NOT EXISTS credited_pence integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS credited_at timestamptz,
        ADD COLUMN IF NOT EXISTS credited_by_name text
    `);
    // Every booking slot has its own reference, e.g. AH-3F9A2C71B4.
    await pool.query(`
        UPDATE bookings SET booking_ref = 'AH-' || UPPER(SUBSTR(MD5(guid::text || random()::text), 1, 10))
        WHERE booking_ref IS NULL
    `);
    // Snapshot of each refunded booking: the booking row itself is deleted so its slot can be rebooked.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_refunds (
            guid uuid PRIMARY KEY,
            booking_ref text NOT NULL,
            facility_guid uuid,
            facility_name text NOT NULL,
            address text,
            postcode text,
            option_name text,
            sport_name text,
            starts_at timestamptz NOT NULL,
            ends_at timestamptz NOT NULL,
            profile_guid uuid,
            profile_name text,
            profile_email text,
            booked_by_name text,
            amount_pence integer NOT NULL DEFAULT 0,
            amount_paid_pence integer NOT NULL DEFAULT 0,
            refunded_pence integer NOT NULL,
            refunded_by_name text,
            refunded_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query("ALTER TABLE booking_refunds ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'credit'");
    // Residents can ask for credit on a past booking, for inclement weather only. One request per booking.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS booking_credit_requests (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            booking_guid uuid NOT NULL UNIQUE REFERENCES bookings(guid) ON DELETE CASCADE,
            profile_guid uuid REFERENCES profiles(guid) ON DELETE SET NULL,
            reason text NOT NULL DEFAULT 'inclement-weather',
            note text,
            status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
            requested_at timestamptz NOT NULL DEFAULT now(),
            decided_at timestamptz,
            decided_by_name text
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS booking_refunds_ref_idx ON booking_refunds (booking_ref)');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS bookings_booking_ref_key ON bookings (booking_ref)');
    // Bookings paid before this column existed: what was paid is the recorded price.
    await pool.query(`
        UPDATE bookings SET amount_paid_pence = amount_pence
        WHERE amount_paid_pence = 0 AND amount_pence > 0 AND payment_status IN ('paid', 'credit')
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS bookings_profile_idx ON bookings (profile_guid)');

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
        `SELECT guid, name, latitude, longitude, opening_hours_template_guid, max_resident_bookings
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
                bookings.profile_guid, profiles.name AS profile_name,
                bookings.booked_by_guid, booked_by.name AS booked_by_name,
                bookings.payment_status, bookings.amount_pence, bookings.credit_applied_pence, bookings.amount_paid_pence, bookings.booking_ref, bookings.credited_at,
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
         LEFT JOIN profiles ON profiles.guid = bookings.profile_guid
         LEFT JOIN profiles AS booked_by ON booked_by.guid = bookings.booked_by_guid
         LEFT JOIN booking_reservations AS reservations ON reservations.booking_guid = bookings.guid
         LEFT JOIN booking_resources AS resources ON resources.guid = reservations.resource_guid
                 WHERE bookings.facility_guid = $1
                     AND ($2::timestamptz IS NULL OR bookings.ends_at > $2)
                     AND ($3::timestamptz IS NULL OR bookings.starts_at < $3)
         GROUP BY bookings.guid, options.name, sports.name, profiles.name, booked_by.name
         ORDER BY bookings.starts_at`,
                [facilityGuid, startsAt, endsAt]
    );
    return rows;
}

function findBookingsForProfile(profileGuid, condition, order) {
    return pool.query(
        `SELECT bookings.guid, bookings.facility_guid, bookings.booking_ref, bookings.starts_at, bookings.ends_at,
                bookings.payment_status, bookings.payment_reference, bookings.amount_pence, bookings.credit_applied_pence, bookings.amount_paid_pence,
                bookings.credited_at, bookings.credited_pence,
                (SELECT status FROM booking_credit_requests requests WHERE requests.booking_guid = bookings.guid) AS credit_request_status,
                facilities.name AS facility_name, facilities.address, facilities.postcode,
                facilities.google_maps_url,
                options.name AS option_name, sports.name AS sport_name
         FROM bookings
         JOIN facilities ON facilities.guid = bookings.facility_guid
         JOIN bookable_options AS options ON options.guid = bookings.option_guid
         JOIN sports ON sports.guid = options.sport_guid
         WHERE bookings.profile_guid = $1 AND ${condition}
         ORDER BY ${order}, facilities.name`,
        [profileGuid]
    ).then(result => result.rows);
}

function findUpcomingForProfile(profileGuid) {
    return findBookingsForProfile(profileGuid, 'bookings.ends_at > now()', 'bookings.starts_at');
}

// Bookings that finished within the last month, most recent first.
function findRecentPastForProfile(profileGuid) {
    return findBookingsForProfile(
        profileGuid,
        "bookings.ends_at <= now() AND bookings.ends_at > now() - INTERVAL '1 month'",
        'bookings.starts_at DESC'
    );
}

async function countUpcomingForProfile(profileGuid, facilityGuid) {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM bookings
         WHERE profile_guid = $1 AND facility_guid = $2 AND ends_at > now()`,
        [profileGuid, facilityGuid]
    );
    return rows[0].count;
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

async function newBookingRef(client) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const ref = `AH-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        const { rowCount } = await client.query('SELECT 1 FROM bookings WHERE booking_ref = $1', [ref]);
        if (!rowCount) return ref;
    }
    throw new Error('Could not generate a unique booking reference.');
}

async function insertBooking(client, { facility_guid, option_guid, starts_at, ends_at, profile_guid = null, booked_by_guid = null, payment_status = 'not_required', payment_reference = null, amount_pence = 0, credit_applied_pence = 0, amount_paid_pence = 0 }) {
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
        `INSERT INTO bookings (facility_guid, option_guid, starts_at, ends_at, profile_guid, booked_by_guid, payment_status, payment_reference, amount_pence, credit_applied_pence, amount_paid_pence, booking_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING guid, option_guid, starts_at, ends_at, profile_guid, booking_ref`,
        [facility_guid, option_guid, starts_at, ends_at, profile_guid, booked_by_guid, payment_status, payment_reference, amount_pence, credit_applied_pence, amount_paid_pence, await newBookingRef(client)]
    );
    await client.query(
        `INSERT INTO booking_reservations (booking_guid, resource_guid, starts_at, ends_at)
         SELECT $1, selected.resource_guid, $2, $3
         FROM UNNEST($4::uuid[]) AS selected(resource_guid)`,
        [booking.rows[0].guid, starts_at, ends_at, resources.rows.map(row => row.resource_guid)]
    );
    return booking.rows[0];
}

// All bookings are created in one transaction: if any slot fails, none are saved.
// creditUse = { profile_guid, pence } deducts profile credit in the same transaction as the bookings.
async function createBookings(bookings, creditUse = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (creditUse && creditUse.pence > 0) {
            const deducted = await client.query(
                'UPDATE profiles SET credit_pence = credit_pence - $2 WHERE guid = $1 AND credit_pence >= $2',
                [creditUse.profile_guid, creditUse.pence]
            );
            if (!deducted.rowCount) {
                const error = new Error('Insufficient credit');
                error.code = 'INSUFFICIENT_CREDIT';
                throw error;
            }
        }
        const created = [];
        for (const booking of bookings) {
            created.push(await insertBooking(client, booking));
        }
        await client.query('COMMIT');
        return created;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function createBooking(booking) {
    const [created] = await createBookings([booking]);
    return created;
}

async function findBooking(facilityGuid, bookingGuid) {
    const { rows } = await pool.query(
        `SELECT bookings.guid, bookings.facility_guid, bookings.option_guid, bookings.starts_at, bookings.ends_at,
                bookings.profile_guid, profiles.name AS profile_name,
                bookings.amount_pence, bookings.amount_paid_pence, bookings.credit_applied_pence, bookings.credited_at,
                bookings.payment_status, bookings.booking_ref,
                options.name AS option_name, facilities.name AS facility_name
         FROM bookings
         JOIN bookable_options AS options ON options.guid = bookings.option_guid
         JOIN facilities ON facilities.guid = bookings.facility_guid
         LEFT JOIN profiles ON profiles.guid = bookings.profile_guid
         WHERE bookings.facility_guid = $1 AND bookings.guid = $2`,
        [facilityGuid, bookingGuid]
    );
    return rows[0] || null;
}

const SEARCH_LIMIT = 100;

// Finds bookings for the refunds page. All filters are optional and combine with AND.
async function search({ reference, profile, location, from, to } = {}) {
    const like = value => `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await pool.query(
        `SELECT bookings.guid, bookings.facility_guid, bookings.booking_ref, bookings.starts_at, bookings.ends_at,
                bookings.profile_guid, profiles.name AS profile_name, profiles.email AS profile_email,
                bookings.booked_by_guid, booked_by.name AS booked_by_name,
                bookings.payment_status, bookings.amount_pence, bookings.amount_paid_pence, bookings.credit_applied_pence,
                bookings.credited_pence, bookings.credited_at, bookings.credited_by_name,
                facilities.name AS facility_name, facilities.address, facilities.postcode,
                options.name AS option_name, sports.name AS sport_name
         FROM bookings
         JOIN facilities ON facilities.guid = bookings.facility_guid
         JOIN bookable_options AS options ON options.guid = bookings.option_guid
         JOIN sports ON sports.guid = options.sport_guid
         LEFT JOIN profiles ON profiles.guid = bookings.profile_guid
         LEFT JOIN profiles AS booked_by ON booked_by.guid = bookings.booked_by_guid
         WHERE ($1::text IS NULL OR bookings.booking_ref ILIKE $1)
           AND ($2::text IS NULL OR profiles.name ILIKE $2 OR profiles.email ILIKE $2)
           AND ($3::text IS NULL OR facilities.name ILIKE $3 OR facilities.address ILIKE $3 OR facilities.postcode ILIKE $3)
           AND ($4::date IS NULL OR bookings.ends_at > ($4::date)::timestamp AT TIME ZONE 'Europe/London')
           AND ($5::date IS NULL OR bookings.starts_at < ($5::date + 1)::timestamp AT TIME ZONE 'Europe/London')
         ORDER BY bookings.starts_at DESC
         LIMIT ${SEARCH_LIMIT + 1}`,
        [reference ? like(reference) : null, profile ? like(profile) : null, location ? like(location) : null, from || null, to || null]
    );
    const refunded = await pool.query(
        `SELECT guid, booking_ref, facility_guid, starts_at, ends_at, profile_guid, profile_name, profile_email,
                booked_by_name, amount_pence, amount_paid_pence, facility_name, address, postcode, option_name, sport_name,
                refunded_pence, refunded_by_name, refunded_at, method
         FROM booking_refunds
         WHERE ($1::text IS NULL OR booking_ref ILIKE $1)
           AND ($2::text IS NULL OR profile_name ILIKE $2 OR profile_email ILIKE $2)
           AND ($3::text IS NULL OR facility_name ILIKE $3 OR address ILIKE $3 OR postcode ILIKE $3)
           AND ($4::date IS NULL OR ends_at > ($4::date)::timestamp AT TIME ZONE 'Europe/London')
           AND ($5::date IS NULL OR starts_at < ($5::date + 1)::timestamp AT TIME ZONE 'Europe/London')
         ORDER BY starts_at DESC
         LIMIT ${SEARCH_LIMIT + 1}`,
        [reference ? like(reference) : null, profile ? like(profile) : null, location ? like(location) : null, from || null, to || null]
    );
    const all = [...rows, ...refunded.rows].sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
    return { bookings: all.slice(0, SEARCH_LIMIT), truncated: all.length > SEARCH_LIMIT };
}

async function snapshotRefund(client, facilityGuid, bookingGuid, pence, byName, method) {
    await client.query(
        `INSERT INTO booking_refunds (guid, booking_ref, facility_guid, facility_name, address, postcode, option_name, sport_name,
                starts_at, ends_at, profile_guid, profile_name, profile_email, booked_by_name,
                amount_pence, amount_paid_pence, refunded_pence, refunded_by_name, method)
         SELECT bookings.guid, bookings.booking_ref, bookings.facility_guid, facilities.name, facilities.address, facilities.postcode,
                options.name, sports.name, bookings.starts_at, bookings.ends_at, bookings.profile_guid, profiles.name, profiles.email,
                booked_by.name, bookings.amount_pence, bookings.amount_paid_pence, $3, $4, $5
         FROM bookings
         JOIN facilities ON facilities.guid = bookings.facility_guid
         JOIN bookable_options AS options ON options.guid = bookings.option_guid
         JOIN sports ON sports.guid = options.sport_guid
         LEFT JOIN profiles ON profiles.guid = bookings.profile_guid
         LEFT JOIN profiles AS booked_by ON booked_by.guid = bookings.booked_by_guid
         WHERE bookings.facility_guid = $1 AND bookings.guid = $2`,
        [facilityGuid, bookingGuid, pence, byName, method]
    );
}

async function inTransaction(work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query(result ? 'COMMIT' : 'ROLLBACK');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Cancels a booking and adds creditPence to the booked-for profile in one transaction.
// A booking that has already been credited is never credited again.
function removeBookingWithCredit(facilityGuid, bookingGuid, profileGuid, creditPence, refundedByName = null) {
    return inTransaction(async client => {
        if (creditPence > 0) await snapshotRefund(client, facilityGuid, bookingGuid, creditPence, refundedByName, 'credit');
        const result = await client.query(
            'DELETE FROM bookings WHERE facility_guid = $1 AND guid = $2 AND credited_at IS NULL',
            [facilityGuid, bookingGuid]
        );
        if (!result.rowCount) return false;
        await client.query('UPDATE profiles SET credit_pence = credit_pence + $2 WHERE guid = $1', [profileGuid, creditPence]);
        return true;
    });
}

// Adds what was paid to the profile's credit and keeps the booking. This can only happen once per booking.
function addCreditToBooking(facilityGuid, bookingGuid, byName = null) {
    return inTransaction(async client => {
        const marked = await client.query(
            `UPDATE bookings SET credited_pence = amount_paid_pence, credited_at = now(), credited_by_name = $3
             WHERE facility_guid = $1 AND guid = $2 AND credited_at IS NULL
               AND amount_paid_pence > 0 AND profile_guid IS NOT NULL
             RETURNING profile_guid, amount_paid_pence`,
            [facilityGuid, bookingGuid, byName]
        );
        if (!marked.rowCount) return null;
        const { profile_guid, amount_paid_pence } = marked.rows[0];
        await client.query('UPDATE profiles SET credit_pence = credit_pence + $2 WHERE guid = $1', [profile_guid, amount_paid_pence]);
        return amount_paid_pence;
    });
}

// Cancels a booking that is being refunded outside ActiveHub (e.g. back to the card). No credit is added.
function cancelWithExternalRefund(facilityGuid, bookingGuid, pence, byName = null) {
    return inTransaction(async client => {
        await snapshotRefund(client, facilityGuid, bookingGuid, pence, byName, 'external');
        const result = await client.query(
            'DELETE FROM bookings WHERE facility_guid = $1 AND guid = $2 AND credited_at IS NULL',
            [facilityGuid, bookingGuid]
        );
        return result.rowCount > 0;
    });
}

async function removeBooking(facilityGuid, bookingGuid) {
    const result = await pool.query(
        'DELETE FROM bookings WHERE facility_guid = $1 AND guid = $2',
        [facilityGuid, bookingGuid]
    );
    return result.rowCount > 0;
}

// Past, paid, not-yet-credited booking that belongs to the profile and has no request yet.
async function requestWeatherCredit(profileGuid, bookingGuid, note) {
    const { rows } = await pool.query(
        `INSERT INTO booking_credit_requests (booking_guid, profile_guid, note)
         SELECT bookings.guid, bookings.profile_guid, $3
         FROM bookings
         WHERE bookings.guid = $2 AND bookings.profile_guid = $1
           AND bookings.ends_at <= now() AND bookings.ends_at > now() - INTERVAL '1 month'
           AND bookings.amount_paid_pence > 0 AND bookings.credited_at IS NULL
         ON CONFLICT (booking_guid) DO NOTHING
         RETURNING guid`,
        [profileGuid, bookingGuid, note]
    );
    return rows[0] || null;
}

async function findCreditRequests(status) {
    const { rows } = await pool.query(
        `SELECT requests.guid, requests.status, requests.note, requests.requested_at, requests.decided_at, requests.decided_by_name,
                bookings.guid AS booking_guid, bookings.facility_guid, bookings.booking_ref, bookings.starts_at, bookings.ends_at,
                bookings.amount_paid_pence, bookings.credited_at,
                profiles.name AS profile_name, profiles.email AS profile_email,
                facilities.name AS facility_name, options.name AS option_name, sports.name AS sport_name
         FROM booking_credit_requests requests
         JOIN bookings ON bookings.guid = requests.booking_guid
         JOIN facilities ON facilities.guid = bookings.facility_guid
         JOIN bookable_options AS options ON options.guid = bookings.option_guid
         JOIN sports ON sports.guid = options.sport_guid
         LEFT JOIN profiles ON profiles.guid = requests.profile_guid
         WHERE ($1::text IS NULL OR requests.status = $1)
         ORDER BY (requests.status = 'pending') DESC, requests.requested_at DESC
         LIMIT 100`,
        [status || null]
    );
    return rows;
}

// Approving gives the profile what was paid (once per booking); declining just closes the request.
function decideCreditRequest(requestGuid, approve, byName) {
    return inTransaction(async client => {
        const found = await client.query(
            `SELECT requests.booking_guid, bookings.facility_guid, bookings.booking_ref
             FROM booking_credit_requests requests JOIN bookings ON bookings.guid = requests.booking_guid
             WHERE requests.guid = $1 AND requests.status = 'pending' FOR UPDATE OF requests`,
            [requestGuid]
        );
        if (!found.rowCount) return null;
        const { booking_guid, facility_guid, booking_ref } = found.rows[0];
        let credited = 0;
        if (approve) {
            const marked = await client.query(
                `UPDATE bookings SET credited_pence = amount_paid_pence, credited_at = now(), credited_by_name = $2
                 WHERE guid = $1 AND credited_at IS NULL AND amount_paid_pence > 0 AND profile_guid IS NOT NULL
                 RETURNING profile_guid, amount_paid_pence`,
                [booking_guid, byName]
            );
            if (!marked.rowCount) return null;
            credited = marked.rows[0].amount_paid_pence;
            await client.query('UPDATE profiles SET credit_pence = credit_pence + $2 WHERE guid = $1', [marked.rows[0].profile_guid, credited]);
        }
        await client.query(
            'UPDATE booking_credit_requests SET status = $2, decided_at = now(), decided_by_name = $3 WHERE guid = $1',
            [requestGuid, approve ? 'approved' : 'declined', byName]
        );
        return { booking_guid, facility_guid, booking_ref, credited };
    });
}

module.exports = {
    requestWeatherCredit,
    findCreditRequests,
    decideCreditRequest,
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
    createBookings,
    findUpcomingForProfile,
    findRecentPastForProfile,
    countUpcomingForProfile,
    findBooking,
    removeBooking,
    removeBookingWithCredit,
    addCreditToBooking,
    cancelWithExternalRefund,
    search
};
