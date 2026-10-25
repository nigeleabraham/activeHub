const { Pool } = require('pg');
const Credits = require('../models/Credits');

const EMAIL = 'refunda@example.test';
const MARKER = 'refunda_test_account_v1';

async function seedRefunda(pool) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('activehub-refunda-fixture'))");
        const existing = await client.query('SELECT value FROM site_settings WHERE key = $1', [MARKER]);
        if (existing.rowCount) {
            await client.query('COMMIT');
            return { created: false, guid: existing.rows[0].value };
        }
        const duplicate = await client.query('SELECT 1 FROM profiles WHERE LOWER(email) = LOWER($1)', [EMAIL]);
        if (duplicate.rowCount) throw new Error('Refunda email already exists without the fixture marker; refusing to overwrite it.');
        const { rows: [profile] } = await client.query(`
            INSERT INTO profiles (name, email, role) VALUES ('Refunda', $1, 'Resident') RETURNING guid`, [EMAIL]);
        const { rows: [facility] } = await client.query(`
            INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
            VALUES ('Refunda Test Centre', 'Dummy test location', 'TEST', 51.5, -0.1,
                    'https://www.google.com/maps/search/?api=1&query=51.5,-0.1',
                    'Dummy facility for testing credits and bank refunds. No real bookings or payments.')
            RETURNING guid, name`);
        const { rows: [sport] } = await client.query('SELECT guid FROM sports ORDER BY name LIMIT 1');
        if (!sport) throw new Error('Seed reference sports before creating Refunda.');
        await client.query('INSERT INTO facility_sports (facility_guid, sport_guid) VALUES ($1, $2)', [facility.guid, sport.guid]);
        const { rows: [resource] } = await client.query(`
            INSERT INTO booking_resources (facility_guid, name) VALUES ($1, 'Refund test court') RETURNING guid`, [facility.guid]);
        const { rows: [option] } = await client.query(`
            INSERT INTO bookable_options (facility_guid, sport_guid, name) VALUES ($1, $2, 'Refund test booking') RETURNING guid`,
        [facility.guid, sport.guid]);
        await client.query('INSERT INTO bookable_option_resources (option_guid, resource_guid) VALUES ($1, $2)', [option.guid, resource.guid]);
        const scenarios = [
            { ref: 'AH-REFUNDA-01', days: -8, pence: 2000, credit: true, refundable: true },
            { ref: 'AH-REFUNDA-02', days: -7, pence: 1000, credit: true, refundable: false },
            { ref: 'AH-REFUNDA-03', days: -6, pence: 1500, credit: true, refundable: true, pendingRefund: true },
            { ref: 'AH-REFUNDA-04', days: -5, pence: 1000 },
            { ref: 'AH-REFUNDA-05', days: -4, pence: 1000 },
            { ref: 'AH-REFUNDA-06', days: -3, pence: 1000, pendingWeather: true },
            { ref: 'AH-REFUNDA-07', days: 3, pence: 1000 }
        ];
        for (const scenario of scenarios) {
            const start = new Date();
            start.setUTCDate(start.getUTCDate() + scenario.days);
            start.setUTCHours(12, 0, 0, 0);
            const end = new Date(start.getTime() + 3600000);
            const { rows: [booking] } = await client.query(`
                INSERT INTO bookings (facility_guid, option_guid, profile_guid, booked_by_guid, starts_at, ends_at,
                                      payment_status, payment_reference, amount_pence, amount_paid_pence, booking_ref)
                VALUES ($1, $2, $3, $3, $4, $5, 'paid', 'DUMMY-NOT-A-REAL-PAYMENT', $6, $6, $7)
                RETURNING guid, profile_guid, booking_ref`,
            [facility.guid, option.guid, profile.guid, start, end, scenario.pence, scenario.ref]);
            await client.query(`
                INSERT INTO booking_reservations (booking_guid, resource_guid, starts_at, ends_at)
                VALUES ($1, $2, $3, $4)`, [booking.guid, resource.guid, start, end]);
            if (scenario.credit) {
                await client.query(`
                    UPDATE bookings SET credited_pence = amount_paid_pence, credited_at = now(), credited_by_name = 'Dummy data setup'
                    WHERE guid = $1`, [booking.guid]);
                await Credits.grant(client, { ...booking, facility_name: facility.name }, scenario.pence, 'Dummy data setup', scenario.refundable);
            }
            if (scenario.pendingRefund) {
                await client.query(`
                    INSERT INTO credit_refund_requests (credit_guid, requested_pence)
                    SELECT guid, remaining_pence FROM credits WHERE booking_guid = $1`, [booking.guid]);
            }
            if (scenario.pendingWeather) {
                await client.query(`
                    INSERT INTO booking_credit_requests (booking_guid, profile_guid, note)
                    VALUES ($1, $2, 'Dummy weather credit request for testing administrator review.')`, [booking.guid, profile.guid]);
            }
        }
        await client.query('INSERT INTO site_settings (key, value) VALUES ($1, $2)', [MARKER, profile.guid]);
        await client.query('COMMIT');
        return { created: true, guid: profile.guid };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function main() {
    for (const name of ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings']) {
        await require(`../models/${name}`).initialize();
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const result = await seedRefunda(pool);
        console.log(result.created
            ? 'Created Refunda (refunda@example.test): £45 credit, a pending bank refund, paid past bookings and a pending weather credit request.'
            : 'Refunda already exists; her test progress was left unchanged.');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().then(() => process.exit(0)).catch(error => {
        console.error('Unable to create Refunda:', error);
        process.exit(1);
    });
}

module.exports = { seedRefunda };
