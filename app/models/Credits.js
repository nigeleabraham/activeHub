const { Pool } = require('pg');
const { parseDeclineComment } = require('../validation');
const Settings = require('./Settings');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
    await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('activehub-credit-ledger'))");
        await client.query(`
            CREATE TABLE IF NOT EXISTS credits (
                guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                profile_guid uuid NOT NULL REFERENCES profiles(guid) ON DELETE CASCADE,
                booking_guid uuid,
                booking_ref text,
                facility_name text NOT NULL,
                amount_pence integer NOT NULL CHECK (amount_pence > 0),
                remaining_pence integer NOT NULL CHECK (remaining_pence >= 0 AND remaining_pence <= amount_pence),
                refundable boolean NOT NULL DEFAULT false,
                created_at timestamptz NOT NULL DEFAULT now(),
                created_by_name text
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS credit_refund_requests (
                guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                credit_guid uuid NOT NULL UNIQUE REFERENCES credits(guid) ON DELETE CASCADE,
                status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'spent')),
                requested_pence integer NOT NULL CHECK (requested_pence > 0),
                refunded_pence integer NOT NULL DEFAULT 0 CHECK (refunded_pence >= 0 AND refunded_pence <= requested_pence),
                requested_at timestamptz NOT NULL DEFAULT now(),
                decided_at timestamptz,
                decided_by_name text
            )
        `);
        // Backfill once from deployment time, not the original issue date.
        await client.query(`ALTER TABLE credits ADD COLUMN IF NOT EXISTS expires_at timestamptz
            NOT NULL DEFAULT (now() + INTERVAL '365 days')`);
        await client.query('ALTER TABLE credits ADD COLUMN IF NOT EXISTS payment_reference text');
        await client.query(`
            UPDATE credits c SET payment_reference = source.payment_reference
            FROM (
                SELECT guid, payment_reference FROM bookings WHERE payment_reference IS NOT NULL
                UNION ALL
                SELECT guid, payment_reference FROM booking_refunds WHERE payment_reference IS NOT NULL
            ) source
            WHERE c.booking_guid = source.guid AND c.payment_reference IS NULL`);
        await client.query('ALTER TABLE credit_refund_requests ADD COLUMN IF NOT EXISTS decline_comment text');
        await client.query(`
            CREATE TABLE IF NOT EXISTS credit_spending (
                credit_guid uuid NOT NULL REFERENCES credits(guid) ON DELETE CASCADE,
                booking_guid uuid NOT NULL,
                booking_ref text NOT NULL,
                amount_pence integer NOT NULL CHECK (amount_pence > 0),
                PRIMARY KEY (credit_guid, booking_guid)
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS credits_profile_idx ON credits (profile_guid, created_at, guid)');
        await client.query('CREATE TABLE IF NOT EXISTS credit_migrations (name text PRIMARY KEY)');
        const migrated = await client.query("SELECT 1 FROM credit_migrations WHERE name = 'opening-balances'");
        if (migrated.rowCount) return;

        const profiles = await client.query('SELECT guid, credit_pence FROM profiles ORDER BY guid FOR UPDATE');
        for (const profile of profiles.rows) {
            const sources = await client.query(`
                SELECT guid, booking_ref, facility_name, amount_pence, created_at, by_name FROM (
                    SELECT b.guid, b.booking_ref, f.name AS facility_name, b.credited_pence AS amount_pence,
                           b.credited_at AS created_at, b.credited_by_name AS by_name
                    FROM bookings b JOIN facilities f ON f.guid = b.facility_guid
                    WHERE b.profile_guid = $1 AND b.credited_pence > 0 AND b.credited_at IS NOT NULL
                    UNION ALL
                    SELECT guid, booking_ref, facility_name, refunded_pence, refunded_at, refunded_by_name
                    FROM booking_refunds WHERE profile_guid = $1 AND method = 'credit' AND refunded_pence > 0
                ) sources ORDER BY created_at DESC, guid DESC`, [profile.guid]);
            let remaining = profile.credit_pence;
            for (const source of sources.rows) {
                const available = Math.min(remaining, source.amount_pence);
                await client.query(`
                    INSERT INTO credits (profile_guid, booking_guid, booking_ref, facility_name, amount_pence,
                                         remaining_pence, created_at, created_by_name, payment_reference)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                        (SELECT payment_reference FROM bookings WHERE guid = $2
                         UNION ALL SELECT payment_reference FROM booking_refunds WHERE guid = $2 LIMIT 1))`,
                [profile.guid, source.guid, source.booking_ref, source.facility_name, source.amount_pence,
                    available, source.created_at, source.by_name]);
                remaining -= available;
            }
            if (remaining > 0) {
                await client.query(`
                    INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence)
                    VALUES ($1, 'Opening balance (booking unavailable)', $2, $2)`, [profile.guid, remaining]);
            }
        }
        await client.query("INSERT INTO credit_migrations (name) VALUES ('opening-balances')");
    });
}

// Called inside the booking transaction so its credit and the profile total cannot diverge.
async function grant(client, booking, pence, byName, refundable) {
    if (!Number.isSafeInteger(pence) || pence <= 0 || typeof refundable !== 'boolean') {
        throw new Error('Invalid credit grant');
    }
    const profile = await client.query('SELECT guid FROM profiles WHERE guid = $1 FOR UPDATE', [booking.profile_guid]);
    if (!profile.rowCount) throw new Error('Credit recipient no longer exists');
    const { rows } = await client.query("SELECT value FROM site_settings WHERE key = 'credit_lifetime_days'");
    const days = Settings.parseCreditLifetimeDays(rows[0]?.value ?? Settings.DEFAULTS.credit_lifetime_days);
    if (days === null) throw new Error('Invalid configured credit lifetime');
    await client.query(`
        INSERT INTO credits (profile_guid, booking_guid, booking_ref, facility_name,
                             amount_pence, remaining_pence, created_by_name, refundable, created_at, expires_at, payment_reference)
        VALUES ($1, $2, $3, $4, $5, $5, $6, $7, statement_timestamp(),
                statement_timestamp() + $8 * INTERVAL '24 hours',
                (SELECT payment_reference FROM bookings WHERE guid = $2
                 UNION ALL SELECT payment_reference FROM booking_refunds WHERE guid = $2 LIMIT 1))`,
    [booking.profile_guid, booking.guid, booking.booking_ref, booking.facility_name, pence, byName, refundable, days]);
    await client.query('UPDATE profiles SET credit_pence = credit_pence + $2 WHERE guid = $1', [booking.profile_guid, pence]);
}

async function spend(client, profileGuid, bookings) {
    const pence = bookings.reduce((sum, booking) => sum + booking.credit_applied_pence, 0);
    if (!Number.isSafeInteger(pence) || pence < 0) throw new Error('Invalid credit spend');
    const deducted = await client.query(`
        UPDATE profiles SET credit_pence = credit_pence - $2 WHERE guid = $1 AND credit_pence >= $2
        RETURNING guid`, [profileGuid, pence]);
    if (!deducted.rowCount) {
        const error = new Error('Insufficient credit');
        error.code = 'INSUFFICIENT_CREDIT';
        throw error;
    }
    const { rows } = await client.query(`
        SELECT guid, remaining_pence FROM credits WHERE profile_guid = $1 AND remaining_pence > 0
        AND expires_at > statement_timestamp()
        ORDER BY created_at, guid FOR UPDATE`, [profileGuid]);
    if (rows.reduce((sum, credit) => sum + credit.remaining_pence, 0) < pence) {
        const error = new Error('Insufficient unexpired credit');
        error.code = 'INSUFFICIENT_CREDIT';
        throw error;
    }
    let index = 0;
    for (const booking of bookings) {
        let needed = booking.credit_applied_pence;
        while (needed > 0) {
            const credit = rows[index];
            const applied = Math.min(needed, credit.remaining_pence);
            await client.query(`
                INSERT INTO credit_spending (credit_guid, booking_guid, booking_ref, amount_pence)
                VALUES ($1, $2, $3, $4)`, [credit.guid, booking.guid, booking.booking_ref, applied]);
            credit.remaining_pence -= applied;
            needed -= applied;
            await client.query('UPDATE credits SET remaining_pence = $2 WHERE guid = $1', [credit.guid, credit.remaining_pence]);
            if (credit.remaining_pence === 0) {
                await client.query(`
                    UPDATE credit_refund_requests SET status = 'spent', decided_at = now()
                    WHERE credit_guid = $1 AND status = 'pending'`, [credit.guid]);
                index++;
            }
        }
    }
}

async function findForProfile(profileGuid) {
    const { rows } = await pool.query(`
        SELECT c.*, CEIL(EXTRACT(EPOCH FROM (c.expires_at - statement_timestamp())) / 86400)::int AS days_remaining,
               r.status AS refund_status, r.refunded_pence, r.requested_pence, r.decline_comment,
               EXISTS (SELECT 1 FROM booking_credit_requests requests
                       WHERE requests.booking_guid = c.booking_guid AND requests.profile_guid = c.profile_guid
                         AND requests.status = 'approved' AND requests.auto_approved) AS auto_approved
        FROM credits c LEFT JOIN credit_refund_requests r ON r.credit_guid = c.guid
        WHERE c.profile_guid = $1 AND c.remaining_pence > 0 AND c.expires_at > statement_timestamp()
        ORDER BY c.created_at DESC, c.guid DESC`, [profileGuid]);
    return rows;
}

function requestRefund(profileGuid, creditGuid) {
    return transaction(async client => {
        await client.query('SELECT guid FROM profiles WHERE guid = $1 FOR UPDATE', [profileGuid]);
        const { rows } = await client.query(`
            INSERT INTO credit_refund_requests (credit_guid, requested_pence)
            SELECT guid, remaining_pence FROM credits
            WHERE guid = $2 AND profile_guid = $1 AND refundable AND remaining_pence > 0 AND expires_at > statement_timestamp()
            ON CONFLICT (credit_guid) DO NOTHING RETURNING guid, requested_pence`, [profileGuid, creditGuid]);
        return rows[0] || null;
    });
}

async function findRefundRequests() {
    const { rows } = await pool.query(`
        SELECT r.*, c.booking_ref, c.payment_reference, c.facility_name, c.remaining_pence, c.expires_at,
               c.expires_at <= statement_timestamp() AS expired,
               p.name AS profile_name, p.email AS profile_email
        FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
        JOIN profiles p ON p.guid = c.profile_guid
        ORDER BY (r.status = 'pending') DESC, r.requested_at DESC, r.guid DESC`);
    return rows;
}

async function findExpiredPendingRefunds(profileGuid) {
    const { rows } = await pool.query(`
        SELECT r.guid, c.booking_ref, c.payment_reference, c.remaining_pence
        FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
        WHERE c.profile_guid = $1 AND r.status = 'pending' AND c.remaining_pence > 0
          AND c.expires_at <= statement_timestamp()
        ORDER BY r.requested_at DESC`, [profileGuid]);
    return rows;
}

function decideRefund(requestGuid, approve, byName, comment = null) {
    const declineComment = approve ? null : parseDeclineComment(comment);
    if (!approve && !declineComment) return Promise.reject(new Error('A decline comment of 1 to 500 characters is required'));
    return transaction(async client => {
        // Every balance mutation locks the profile first, serializing checkout and review.
        const owner = await client.query(`
            SELECT c.profile_guid FROM credits c JOIN credit_refund_requests r ON r.credit_guid = c.guid
            WHERE r.guid = $1`, [requestGuid]);
        if (!owner.rowCount) return null;
        const profileGuid = owner.rows[0].profile_guid;
        await client.query('SELECT guid FROM profiles WHERE guid = $1 FOR UPDATE', [profileGuid]);
        const found = await client.query(`
            SELECT r.credit_guid, c.remaining_pence, c.booking_ref
            FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
            WHERE r.guid = $1 AND r.status = 'pending' AND c.refundable AND c.remaining_pence > 0
            FOR UPDATE OF c, r`, [requestGuid]);
        if (!found.rowCount) return null;
        const credit = found.rows[0];
        const refunded = approve ? credit.remaining_pence : 0;
        if (approve) {
            const deducted = await client.query(`
                UPDATE profiles SET credit_pence = credit_pence - $2 WHERE guid = $1 AND credit_pence >= $2
                RETURNING guid`, [profileGuid, refunded]);
            if (!deducted.rowCount) throw new Error('Credit ledger does not match profile balance');
            await client.query('UPDATE credits SET remaining_pence = 0 WHERE guid = $1', [credit.credit_guid]);
        }
        await client.query(`
            UPDATE credit_refund_requests SET status = $2, refunded_pence = $3, decided_at = now(), decided_by_name = $4, decline_comment = $5
            WHERE guid = $1`, [requestGuid, approve ? 'approved' : 'declined', refunded, byName, declineComment]);
        return { ...credit, refunded_pence: refunded, profile_guid: profileGuid };
    });
}

module.exports = { initialize, grant, spend, findForProfile, requestRefund, findRefundRequests, decideRefund, findExpiredPendingRefunds };
