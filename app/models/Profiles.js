const { Pool } = require('pg');
const ProfileSections = require('./ProfileSections');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

// Keep the existing role as the default for login and legacy imports.
const assignedRoles = `ARRAY(SELECT role FROM (
    SELECT 'Resident' AS role UNION SELECT profiles.role UNION SELECT role FROM profile_roles WHERE profile_guid = profiles.guid
) assigned ORDER BY role) AS roles`;

const SEED_PROFILES = [
    { name: 'Rita Resident', email: 'rita.resident@example.com', role: 'Resident' },
    { name: 'Adam Administrator', email: 'adam.admin@example.com', role: 'Administrator' },
    { name: 'Colin Coach', email: 'colin.coach@example.com', role: 'Coach' }
];

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS profiles (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            email text NOT NULL,
            role text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    // Roles are now data (see Roles.js): replace the hard-coded role list with a foreign key.
    await pool.query('ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check');
    await pool.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_fkey') THEN
                ALTER TABLE profiles ADD CONSTRAINT profiles_role_fkey
                    FOREIGN KEY (role) REFERENCES roles (name) ON UPDATE CASCADE ON DELETE RESTRICT;
            END IF;
        END $$
    `);
    // Booking credit, held in pence. Never negative.
    await pool.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS credit_pence integer NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz');
    await pool.query(`ALTER TABLE profiles
        ADD COLUMN IF NOT EXISTS telephone text,
        ADD COLUMN IF NOT EXISTS emergency_contact_name text,
        ADD COLUMN IF NOT EXISTS emergency_contact_telephone text`);
    await pool.query(`ALTER TABLE profiles
        ADD COLUMN IF NOT EXISTS address_line_1 text,
        ADD COLUMN IF NOT EXISTS address_line_2 text,
        ADD COLUMN IF NOT EXISTS town_city text,
        ADD COLUMN IF NOT EXISTS county text,
        ADD COLUMN IF NOT EXISTS postcode text`);
    await pool.query(`ALTER TABLE profiles
        ADD COLUMN IF NOT EXISTS interest_sport_guids uuid[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS membership_number text`);
    await pool.query(`ALTER TABLE profiles
        ADD COLUMN IF NOT EXISTS medical_concern boolean,
        ADD COLUMN IF NOT EXISTS medical_conditions text[] NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS medical_other text,
        ADD COLUMN IF NOT EXISTS activity_limitation text
            CHECK (activity_limitation IN ('limited_a_lot', 'limited_a_little', 'no'))`);
    await pool.query(`
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_credit_nonnegative') THEN
                ALTER TABLE profiles ADD CONSTRAINT profiles_credit_nonnegative CHECK (credit_pence >= 0);
            END IF;
        END $$
    `);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_lower_key ON profiles (LOWER(email))');
    await pool.query('CREATE INDEX IF NOT EXISTS profiles_name_prefix_idx ON profiles (LOWER(name) text_pattern_ops)');
    await pool.query('CREATE INDEX IF NOT EXISTS profiles_email_prefix_idx ON profiles (LOWER(email) text_pattern_ops)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS profile_roles (
            profile_guid uuid NOT NULL REFERENCES profiles(guid) ON DELETE CASCADE,
            role text NOT NULL REFERENCES roles(name) ON UPDATE CASCADE ON DELETE RESTRICT,
            PRIMARY KEY (profile_guid, role)
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS profile_roles_role_idx ON profile_roles (role, profile_guid)');

    const { rows } = await pool.query('SELECT 1 FROM profiles LIMIT 1');
    if (!rows.length) {
        for (const profile of SEED_PROFILES) {
            await pool.query(
                'INSERT INTO profiles (name, email, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [profile.name, profile.email, profile.role]
            );
        }
    }
    await pool.query('INSERT INTO profile_roles (profile_guid, role) SELECT guid, role FROM profiles ON CONFLICT DO NOTHING');
    await pool.query("INSERT INTO profile_roles (profile_guid, role) SELECT guid, 'Resident' FROM profiles ON CONFLICT DO NOTHING");
}

async function findAll() {
    const { rows } = await pool.query(
        `SELECT guid, name, email, role, ${assignedRoles},
                (SELECT COALESCE(SUM(remaining_pence), 0)::int FROM credits
                 WHERE profile_guid = profiles.guid AND expires_at > statement_timestamp()) AS credit_pence,
                created_at FROM profiles WHERE deleted_at IS NULL
         ORDER BY CASE role WHEN 'Administrator' THEN 0 WHEN 'Coach' THEN 1 WHEN 'Resident' THEN 2 ELSE 3 END, role, LOWER(name)`
    );
    return rows;
}

async function findByGuid(guid) {
    const { rows } = await pool.query(
        `SELECT guid, name, email, telephone, emergency_contact_name, emergency_contact_telephone,
                address_line_1, address_line_2, town_city, county, postcode,
                medical_concern, medical_conditions, medical_other, activity_limitation, membership_number, role, ${assignedRoles},
                ARRAY(SELECT guid FROM sports WHERE guid = ANY(profiles.interest_sport_guids) ORDER BY LOWER(name)) AS interest_sport_guids,
                (SELECT COALESCE(SUM(remaining_pence), 0)::int FROM credits
                 WHERE profile_guid = profiles.guid AND expires_at > statement_timestamp()) AS credit_pence,
                created_at FROM profiles WHERE guid = $1 AND deleted_at IS NULL`,
        [guid]
    );
    return rows[0] || null;
}

async function search(query, limit = 20) {
    const prefix = `${query.toLowerCase()}%`;
    const { rows } = await pool.query(
        `SELECT guid, name, email, role, ${assignedRoles} FROM profiles
         WHERE deleted_at IS NULL AND (LOWER(name) LIKE $1 OR LOWER(email) LIKE $1)
         ORDER BY CASE WHEN LOWER(name) LIKE $1 THEN 0 ELSE 1 END, LOWER(name)
         LIMIT $2`,
        [prefix, limit]
    );
    return rows;
}

async function create(details) {
    return save(null, details);
}

async function countAdministrators() {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM profiles
        WHERE deleted_at IS NULL AND (role = 'Administrator' OR EXISTS (
            SELECT 1 FROM profile_roles WHERE profile_guid = profiles.guid AND role = 'Administrator'))`);
    return rows[0].count;
}

async function update(guid, details) {
    return save(guid, details);
}

async function protectLastAdministrator(client, guid) {
    const { rows } = await client.query(`SELECT guid FROM profiles
        WHERE deleted_at IS NULL AND (role = 'Administrator' OR EXISTS (
            SELECT 1 FROM profile_roles WHERE profile_guid = profiles.guid AND role = 'Administrator'))`);
    if (rows.length === 1 && rows[0].guid === guid) {
        const error = new Error('There must always be at least one Administrator');
        error.code = 'LAST_ADMINISTRATOR';
        throw error;
    }
}

async function save(guid, { name, email, roles = [] }) {
    if (!Array.isArray(roles) || roles.some(role => typeof role !== 'string' || !role)) {
        throw new Error('Invalid profile roles');
    }
    const selected = [...new Set(['Resident', ...roles])].sort((first, second) => first.localeCompare(second));
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(18427, 1)');
        let existing;
        if (guid) {
            existing = (await client.query('SELECT role FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [guid])).rows[0];
            if (!existing) {
                await client.query('COMMIT');
                return null;
            }
            if (!selected.includes('Administrator')) await protectLastAdministrator(client, guid);
        }
        const defaultRole = selected.includes(existing?.role) ? existing.role : 'Resident';
        const { rows } = guid ? await client.query(
            'UPDATE profiles SET name = $2, email = $3, role = $4 WHERE guid = $1 RETURNING guid, name, email, role',
            [guid, name, email, defaultRole]
        ) : await client.query(
            'INSERT INTO profiles (name, email, role) VALUES ($1, $2, $3) RETURNING guid, name, email, role',
            [name, email, defaultRole]
        );
        await client.query('DELETE FROM profile_roles WHERE profile_guid = $1', [rows[0].guid]);
        await client.query('INSERT INTO profile_roles (profile_guid, role) SELECT $1, unnest($2::text[])', [rows[0].guid, selected]);
        await client.query('COMMIT');
        return { ...rows[0], roles: selected };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Self-service updates never change roles or credit.
async function updateDetails(guid, { name, email, telephone = null, emergency_contact_name = null, emergency_contact_telephone = null,
    address_line_1 = null, address_line_2 = null, town_city = null, county = null, postcode = null,
    medical_concern = null, medical_conditions = [], medical_other = null, activity_limitation = null,
    interest_sport_guids = [], membership_number = null }, section = null) {
    if (section !== null) {
        const fields = ProfileSections.fields(section);
        if (!fields) throw new Error('Unknown profile section.');
        const values = { name, email, telephone, emergency_contact_name, emergency_contact_telephone,
            address_line_1, address_line_2, town_city, county, postcode, medical_concern,
            medical_conditions: medical_concern === true ? medical_conditions : [],
            medical_other: medical_concern === true && medical_conditions.includes('other') ? medical_other : null,
            activity_limitation, interest_sport_guids, membership_number };
        const { rows } = await pool.query(
            `UPDATE profiles SET ${fields.map((field, index) => `${field} = $${index + 2}`).join(', ')}
             WHERE guid = $1 AND deleted_at IS NULL RETURNING guid, name, email`,
            [guid, ...fields.map(field => values[field])]);
        return rows[0] || null;
    }
    const { rows } = await pool.query(
        `UPDATE profiles SET name = $2, email = $3, telephone = $4,
            emergency_contact_name = $5, emergency_contact_telephone = $6,
            address_line_1 = $7, address_line_2 = $8, town_city = $9, county = $10, postcode = $11,
            medical_concern = $12, medical_conditions = $13, medical_other = $14, activity_limitation = $15,
            interest_sport_guids = $16, membership_number = $17
         WHERE guid = $1 AND deleted_at IS NULL RETURNING guid, name, email, telephone, emergency_contact_name, emergency_contact_telephone,
            address_line_1, address_line_2, town_city, county, postcode,
            medical_concern, medical_conditions, medical_other, activity_limitation, interest_sport_guids, membership_number`,
        [guid, name, email, telephone, emergency_contact_name, emergency_contact_telephone,
            address_line_1, address_line_2, town_city, county, postcode,
            medical_concern, medical_concern === true ? medical_conditions : [],
            medical_concern === true && medical_conditions.includes('other') ? medical_other : null, activity_limitation,
            interest_sport_guids, membership_number]
    );
    return rows[0] || null;
}

async function remove(guid, byName = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(18427, 1)');
        const found = await client.query('SELECT guid FROM profiles WHERE guid = $1 AND deleted_at IS NULL FOR UPDATE', [guid]);
        if (!found.rowCount) {
            await client.query('COMMIT');
            return false;
        }
        await protectLastAdministrator(client, guid);
        await client.query(`
            UPDATE booking_credit_requests SET status = 'cancelled', decided_at = now(),
                decided_by_name = $2, decline_comment = 'Profile deleted'
            WHERE profile_guid = $1 AND status = 'pending'`, [guid, byName]);
        await client.query(`
            UPDATE credit_refund_requests r SET status = 'cancelled', decided_at = now(),
                decided_by_name = $2, decline_comment = 'Profile deleted'
            FROM credits c WHERE r.credit_guid = c.guid AND c.profile_guid = $1 AND r.status = 'pending'`, [guid, byName]);
        await client.query('UPDATE credits SET voided_pence = remaining_pence, remaining_pence = 0, voided_at = now() WHERE profile_guid = $1 AND remaining_pence > 0', [guid]);
        await client.query('DELETE FROM bookings WHERE profile_guid = $1 AND starts_at > now()', [guid]);
        await client.query('UPDATE profiles SET credit_pence = 0, deleted_at = now() WHERE guid = $1', [guid]);
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    initialize,
    findAll,
    findByGuid,
    search,
    create,
    countAdministrators,
    update,
    updateDetails,
    remove
};
