const { Pool } = require('pg');
const { isValidDateRange } = require('../validation');
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
        await client.query(`ALTER TABLE credits ADD COLUMN IF NOT EXISTS card_paid_pence integer
            CHECK (card_paid_pence >= 0 AND card_paid_pence <= amount_pence)`);
        await client.query('ALTER TABLE credits ADD COLUMN IF NOT EXISTS voided_at timestamptz, ADD COLUMN IF NOT EXISTS voided_pence integer NOT NULL DEFAULT 0');
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
            ALTER TABLE credit_refund_requests DROP CONSTRAINT IF EXISTS credit_refund_requests_status_check,
            ADD CONSTRAINT credit_refund_requests_status_check CHECK (status IN ('pending', 'approved', 'declined', 'spent', 'cancelled'))
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS credit_spending (
                credit_guid uuid NOT NULL REFERENCES credits(guid) ON DELETE CASCADE,
                booking_guid uuid NOT NULL,
                booking_ref text NOT NULL,
                amount_pence integer NOT NULL CHECK (amount_pence > 0),
                PRIMARY KEY (credit_guid, booking_guid)
            )
        `);
        await client.query('ALTER TABLE credit_spending ADD COLUMN IF NOT EXISTS refundable boolean');
        await client.query('CREATE INDEX IF NOT EXISTS credit_spending_booking_idx ON credit_spending (booking_guid)');
        await client.query(`
            UPDATE credit_spending s SET refundable = c.refundable
            FROM credits c WHERE c.guid = s.credit_guid AND s.refundable IS NULL`);
        await client.query(`
            UPDATE booking_refunds b SET credit_applied_pence = s.pence
            FROM (SELECT booking_guid, SUM(amount_pence)::int AS pence FROM credit_spending GROUP BY booking_guid) s
            WHERE b.guid = s.booking_guid AND b.credit_applied_pence = 0`);
        await client.query('CREATE INDEX IF NOT EXISTS credits_profile_idx ON credits (profile_guid, created_at, guid)');
        await client.query('CREATE INDEX IF NOT EXISTS credits_booking_idx ON credits (booking_guid)');
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

async function withFunding(client, bookings, key = 'guid') {
    if (!bookings.length) return [];
    const { rows } = await client.query(`
        SELECT booking_guid,
               SUM(amount_pence)::int AS tracked_pence,
               COALESCE(SUM(amount_pence) FILTER (WHERE refundable IS TRUE), 0)::int AS refundable_pence
        FROM credit_spending WHERE booking_guid = ANY($1::uuid[]) GROUP BY booking_guid`,
    [bookings.map(booking => booking[key])]);
    const funding = new Map(rows.map(row => [row.booking_guid, row]));
    return bookings.map(booking => {
        const credit = booking.credit_applied_pence || 0;
        const paid = booking.amount_paid_pence;
        const tracked = funding.get(booking[key]);
        if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(credit) ||
            credit < 0 || paid < credit || (tracked?.tracked_pence || 0) > credit) {
            throw new Error('Booking payment does not match its credit funding history');
        }
        const refundable = tracked?.refundable_pence || 0;
        return {
            ...booking,
            card_paid_pence: paid - credit,
            refundable_credit_pence: refundable,
            non_refundable_credit_pence: credit - refundable,
            untraced_credit_pence: credit - (tracked?.tracked_pence || 0)
        };
    });
}

function fundingForBookings(bookings, key = 'guid') {
    return withFunding(pool, bookings, key);
}

// Called inside the booking transaction so its credit and the profile total cannot diverge.
async function grant(client, booking, pence, byName, refundable, { forceNonRefundable = false } = {}) {
    if (!Number.isSafeInteger(pence) || pence <= 0 || typeof refundable !== 'boolean') {
        throw new Error('Invalid credit grant');
    }
    const profile = await client.query('SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [booking.profile_guid]);
    if (!profile.rowCount) throw new Error('Credit recipient no longer exists');
    const { rows } = await client.query("SELECT value FROM site_settings WHERE key = 'credit_lifetime_days'");
    const days = Settings.parseCreditLifetimeDays(rows[0]?.value ?? Settings.DEFAULTS.credit_lifetime_days);
    if (days === null) throw new Error('Invalid configured credit lifetime');
    const [funding] = await withFunding(client, [booking]);
    if (pence !== booking.amount_paid_pence) throw new Error('Credit must match the booking payment');
    if (funding.untraced_credit_pence) {
        console.warn('Untraced booking credit retained as non-refundable:', booking.guid, funding.untraced_credit_pence);
    }
    const refundablePence = forceNonRefundable ? 0
        : funding.refundable_credit_pence + (refundable ? funding.card_paid_pence : 0);
    for (const [amount, eligible] of [[refundablePence, true], [pence - refundablePence, false]]) {
        if (!amount) continue;
        await client.query(`
        INSERT INTO credits (profile_guid, booking_guid, booking_ref, facility_name,
                             amount_pence, remaining_pence, created_by_name, refundable, created_at, expires_at, payment_reference, card_paid_pence)
        VALUES ($1, $2, $3, $4, $5, $5, $6, $7, statement_timestamp(),
                statement_timestamp() + $8 * INTERVAL '24 hours',
                (SELECT payment_reference FROM bookings WHERE guid = $2
                 UNION ALL SELECT payment_reference FROM booking_refunds WHERE guid = $2 LIMIT 1), $9)`,
        [booking.profile_guid, booking.guid, booking.booking_ref, booking.facility_name, amount, byName, eligible, days,
            eligible === (forceNonRefundable ? false : refundable) ? funding.card_paid_pence : 0]);
    }
    await client.query('UPDATE profiles SET credit_pence = credit_pence + $2 WHERE guid = $1', [booking.profile_guid, pence]);
    return { refundable_pence: refundablePence, non_refundable_pence: pence - refundablePence };
}

async function spend(client, profileGuid, bookings) {
    const pence = bookings.reduce((sum, booking) => sum + booking.credit_applied_pence, 0);
    if (!Number.isSafeInteger(pence) || pence < 0) throw new Error('Invalid credit spend');
    const deducted = await client.query(`
        UPDATE profiles SET credit_pence = credit_pence - $2 WHERE guid = $1 AND deleted_at IS NULL AND credit_pence >= $2
        RETURNING guid`, [profileGuid, pence]);
    if (!deducted.rowCount) {
        const error = new Error('Insufficient credit');
        error.code = 'INSUFFICIENT_CREDIT';
        throw error;
    }
    const { rows } = await client.query(`
        SELECT guid, remaining_pence, refundable FROM credits WHERE profile_guid = $1 AND remaining_pence > 0
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
                INSERT INTO credit_spending (credit_guid, booking_guid, booking_ref, amount_pence, refundable)
                VALUES ($1, $2, $3, $4, $5)`, [credit.guid, booking.guid, booking.booking_ref, applied, credit.refundable]);
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
        await Settings.assertRefundsEnabled(client);
        const profile = await client.query('SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [profileGuid]);
        if (!profile.rowCount) return null;
        const { rows } = await client.query(`
            INSERT INTO credit_refund_requests (credit_guid, requested_pence)
            SELECT guid, remaining_pence FROM credits
            WHERE guid = $2 AND profile_guid = $1 AND refundable AND remaining_pence > 0 AND expires_at > statement_timestamp()
            ON CONFLICT (credit_guid) DO NOTHING RETURNING guid, requested_pence`, [profileGuid, creditGuid]);
        return rows[0] || null;
    });
}

async function findRefundRequests({ pendingOnly = false } = {}) {
    const { rows } = await pool.query(`
        SELECT r.*, c.booking_ref, c.payment_reference, c.facility_name, c.remaining_pence, c.expires_at,
               c.expires_at <= statement_timestamp() AS expired,
               p.name AS profile_name, p.email AS profile_email
        FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
        JOIN profiles p ON p.guid = c.profile_guid
        ${pendingOnly ? "WHERE r.status = 'pending'" : ''}
        ORDER BY (r.status = 'pending') DESC, r.requested_at DESC, r.guid DESC`);
    return rows;
}

const REFUND_HISTORY_PAGE_SIZE = 50;

async function searchRefundHistory({ from, to, page = 1, profileGuid = null }) {
    if (!isValidDateRange(from, to)) throw new RangeError('Select valid From and To dates spanning no more than 62 days.');
    const offset = (page - 1) * REFUND_HISTORY_PAGE_SIZE;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset)) {
        throw new RangeError('Select a valid refund history page.');
    }
    const where = `r.status <> 'pending'
        AND r.decided_at >= $1::date::timestamp AT TIME ZONE 'Europe/London'
        AND r.decided_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/London'
        AND ($3::uuid IS NULL OR c.profile_guid = $3)`;
    const [result, total] = await Promise.all([
        pool.query(`SELECT r.*, c.booking_ref, c.payment_reference, c.facility_name, c.remaining_pence, c.expires_at,
                c.expires_at <= statement_timestamp() AS expired,
                p.name AS profile_name, p.email AS profile_email
            FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
            JOIN profiles p ON p.guid = c.profile_guid
            WHERE ${where}
            ORDER BY r.decided_at DESC, r.guid DESC LIMIT $4 OFFSET $5`,
        [from, to, profileGuid, REFUND_HISTORY_PAGE_SIZE, offset]),
        pool.query(`SELECT COUNT(*)::int AS count FROM credit_refund_requests r
            JOIN credits c ON c.guid = r.credit_guid WHERE ${where}`, [from, to, profileGuid])
    ]);
    return { entries: result.rows, total: total.rows[0].count, pageSize: REFUND_HISTORY_PAGE_SIZE };
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

function decideRefund(requestGuid, approve, byName) {
    if (approve !== true) return Promise.reject(new Error('Refund requests cannot be declined'));
    return transaction(async client => {
        await Settings.assertRefundsEnabled(client);
        // Every balance mutation locks the profile first, serializing checkout and review.
        const owner = await client.query(`
            SELECT c.profile_guid FROM credits c JOIN credit_refund_requests r ON r.credit_guid = c.guid
            WHERE r.guid = $1`, [requestGuid]);
        if (!owner.rowCount) return null;
        const profileGuid = owner.rows[0].profile_guid;
        const profile = await client.query('SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [profileGuid]);
        if (!profile.rowCount) return null;
        const found = await client.query(`
            SELECT r.credit_guid, c.remaining_pence, c.booking_ref
            FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
            WHERE r.guid = $1 AND r.status = 'pending' AND c.refundable AND c.remaining_pence > 0
            FOR UPDATE OF c, r`, [requestGuid]);
        if (!found.rowCount) return null;
        const credit = found.rows[0];
        const refunded = credit.remaining_pence;
        const deducted = await client.query(`
                UPDATE profiles SET credit_pence = credit_pence - $2 WHERE guid = $1 AND credit_pence >= $2
                RETURNING guid`, [profileGuid, refunded]);
        if (!deducted.rowCount) throw new Error('Credit ledger does not match profile balance');
        await client.query('UPDATE credits SET remaining_pence = 0 WHERE guid = $1', [credit.credit_guid]);
        await client.query(`
            UPDATE credit_refund_requests SET status = $2, refunded_pence = $3, decided_at = now(), decided_by_name = $4, decline_comment = $5
            WHERE guid = $1`, [requestGuid, 'approved', refunded, byName, null]);
        return { ...credit, refunded_pence: refunded, profile_guid: profileGuid };
    });
}

function correctionError(message) {
    const error = new Error(message);
    error.code = 'CREDIT_CORRECTION_CONFLICT';
    return error;
}

function reopenRefund(requestGuid) {
    return transaction(async client => {
        const owner = await client.query(`SELECT c.profile_guid FROM credits c
            JOIN credit_refund_requests r ON r.credit_guid = c.guid WHERE r.guid = $1`, [requestGuid]);
        if (!owner.rowCount) throw correctionError('Refund request not found.');
        const profile = await client.query('SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [owner.rows[0].profile_guid]);
        if (!profile.rowCount) throw correctionError('The profile is no longer available.');
        const found = await client.query(`SELECT r.*, c.remaining_pence, c.refundable, c.booking_ref
            FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
            WHERE r.guid = $1 FOR UPDATE OF c, r`, [requestGuid]);
        const request = found.rows[0];
        if (request.status !== 'declined' || request.refunded_pence !== 0 ||
            !request.refundable || request.remaining_pence <= 0) {
            throw correctionError('Only declined requests with remaining refundable credit can be reopened.');
        }
        await client.query(`UPDATE credit_refund_requests SET status = 'pending', decided_at = NULL,
            decided_by_name = NULL, decline_comment = NULL WHERE guid = $1`, [requestGuid]);
        return request;
    });
}

function changeRequestRefundability(requestGuid, refundable) {
    if (typeof refundable !== 'boolean') return Promise.reject(new Error('Invalid refund eligibility'));
    return transaction(async client => {
        const found = await client.query(`SELECT r.booking_guid, r.profile_guid, b.booking_ref,
                b.amount_paid_pence, b.credit_applied_pence
            FROM booking_credit_requests r JOIN bookings b ON b.guid = r.booking_guid
            WHERE r.guid = $1 AND r.status = 'approved'`, [requestGuid]);
        if (!found.rowCount) throw correctionError('Only approved credit requests can have their refund eligibility changed.');
        const booking = { ...found.rows[0], guid: found.rows[0].booking_guid };
        const profile = await client.query('SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [booking.profile_guid]);
        if (!profile.rowCount) throw correctionError('The profile is no longer available.');
        const result = await client.query(`SELECT *, expires_at > statement_timestamp() AS unexpired
            FROM credits WHERE booking_guid = $1 AND profile_guid = $2 ORDER BY guid FOR UPDATE`,
        [booking.guid, booking.profile_guid]);
        const credits = result.rows;
        const pending = await client.query(`SELECT r.guid FROM credit_refund_requests r JOIN credits c ON c.guid = r.credit_guid
            WHERE c.booking_guid = $1 AND c.profile_guid = $2 AND r.status = 'pending'`, [booking.guid, booking.profile_guid]);
        if (pending.rowCount) throw correctionError('Complete the pending bank refund request before changing refund eligibility.');
        // Legacy grants grouped card and reused credit by eligibility. Recover provenance only for an unambiguous original grant.
        if (credits.some(credit => credit.card_paid_pence === null)) {
            if (credits.length > 2 || credits.reduce((sum, credit) => sum + credit.amount_pence, 0) !== booking.amount_paid_pence) {
                throw correctionError('The original card-paid credit cannot be identified safely for this older award.');
            }
            const [funding] = await withFunding(client, [booking]);
            let card = funding.card_paid_pence;
            for (const credit of credits) {
                const reused = credit.refundable ? funding.refundable_credit_pence : funding.non_refundable_credit_pence;
                const portion = credits.length === 1 ? card : Math.max(0, credit.amount_pence - reused);
                credit.card_paid_pence = Math.min(card, portion);
                card -= credit.card_paid_pence;
                await client.query('UPDATE credits SET card_paid_pence = $2 WHERE guid = $1', [credit.guid, credit.card_paid_pence]);
            }
            if (card !== 0) throw correctionError('The original card-paid credit cannot be identified safely for this older award.');
        }
        let changedPence = 0;
        for (const credit of credits) {
            // Treat consumed amounts as card-funded first, never upgrading an uncertain reused portion.
            const cardRemaining = Math.max(0, credit.card_paid_pence - (credit.amount_pence - credit.remaining_pence));
            if (!credit.unexpired || credit.voided_at || !cardRemaining || credit.refundable === refundable) continue;
            if (cardRemaining === credit.amount_pence) {
                await client.query('UPDATE credits SET refundable = $2 WHERE guid = $1', [credit.guid, refundable]);
            } else {
                const refund = await client.query('SELECT guid FROM credit_refund_requests WHERE credit_guid = $1', [credit.guid]);
                if (refund.rowCount) throw correctionError('This mixed credit has a previous bank refund request and cannot be split safely.');
                await client.query(`INSERT INTO credits (profile_guid, booking_guid, booking_ref, facility_name,
                    amount_pence, remaining_pence, refundable, created_at, created_by_name, expires_at, payment_reference, card_paid_pence)
                    SELECT profile_guid, booking_guid, booking_ref, facility_name, $2, $2, $3,
                        created_at, created_by_name, expires_at, payment_reference, $2 FROM credits WHERE guid = $1`,
                [credit.guid, cardRemaining, refundable]);
                await client.query(`UPDATE credits SET amount_pence = amount_pence - $2,
                    remaining_pence = remaining_pence - $2, card_paid_pence = card_paid_pence - $2 WHERE guid = $1`,
                [credit.guid, cardRemaining]);
            }
            changedPence += cardRemaining;
        }
        if (!changedPence) throw correctionError('No unexpired, unspent card-paid credit needs this change. Reused credit keeps its original eligibility.');
        return { booking_ref: booking.booking_ref, changed_pence: changedPence, refundable };
    });
}

module.exports = { initialize, grant, spend, fundingForBookings, findForProfile, requestRefund, findRefundRequests, searchRefundHistory, REFUND_HISTORY_PAGE_SIZE, decideRefund, findExpiredPendingRefunds, reopenRefund, changeRequestRefundability };
