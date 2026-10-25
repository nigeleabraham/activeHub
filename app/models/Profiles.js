const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

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

    const { rows } = await pool.query('SELECT 1 FROM profiles LIMIT 1');
    if (!rows.length) {
        for (const profile of SEED_PROFILES) {
            await pool.query(
                'INSERT INTO profiles (name, email, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                [profile.name, profile.email, profile.role]
            );
        }
    }
}

async function findAll() {
    const { rows } = await pool.query(
        `SELECT guid, name, email, role,
                (SELECT COALESCE(SUM(remaining_pence), 0)::int FROM credits
                 WHERE profile_guid = profiles.guid AND expires_at > statement_timestamp()) AS credit_pence,
                created_at FROM profiles
         ORDER BY CASE role WHEN 'Administrator' THEN 0 WHEN 'Coach' THEN 1 WHEN 'Resident' THEN 2 ELSE 3 END, role, LOWER(name)`
    );
    return rows;
}

async function findByGuid(guid) {
    const { rows } = await pool.query(
        `SELECT guid, name, email, role,
                (SELECT COALESCE(SUM(remaining_pence), 0)::int FROM credits
                 WHERE profile_guid = profiles.guid AND expires_at > statement_timestamp()) AS credit_pence,
                created_at FROM profiles WHERE guid = $1`,
        [guid]
    );
    return rows[0] || null;
}

async function search(query, limit = 20) {
    const prefix = `${query.toLowerCase()}%`;
    const { rows } = await pool.query(
        `SELECT guid, name, email, role FROM profiles
         WHERE LOWER(name) LIKE $1 OR LOWER(email) LIKE $1
         ORDER BY CASE WHEN LOWER(name) LIKE $1 THEN 0 ELSE 1 END, LOWER(name)
         LIMIT $2`,
        [prefix, limit]
    );
    return rows;
}

async function create({ name, email, role }) {
    const { rows } = await pool.query(
        'INSERT INTO profiles (name, email, role) VALUES ($1, $2, $3) RETURNING guid, name, email, role',
        [name, email, role]
    );
    return rows[0];
}

async function countAdministrators() {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM profiles WHERE role = 'Administrator'");
    return rows[0].count;
}

async function update(guid, { name, email, role }) {
    const { rows } = await pool.query(
        'UPDATE profiles SET name = $2, email = $3, role = $4 WHERE guid = $1 RETURNING guid, name, email, role',
        [guid, name, email, role]
    );
    return rows[0] || null;
}

// Lets a person change their own name and email only; role and credit are never touched.
async function updateDetails(guid, { name, email }) {
    const { rows } = await pool.query(
        'UPDATE profiles SET name = $2, email = $3 WHERE guid = $1 RETURNING guid, name, email',
        [guid, name, email]
    );
    return rows[0] || null;
}

async function remove(guid) {
    const result = await pool.query('DELETE FROM profiles WHERE guid = $1', [guid]);
    return result.rowCount > 0;
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
