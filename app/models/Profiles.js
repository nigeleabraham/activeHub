const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const ROLES = ['Resident', 'Administrator', 'Coach'];

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
            role text NOT NULL CHECK (role IN ('Resident', 'Administrator', 'Coach')),
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_lower_key ON profiles (LOWER(email))');

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
        `SELECT guid, name, email, role, created_at FROM profiles
         ORDER BY CASE role WHEN 'Administrator' THEN 0 WHEN 'Coach' THEN 1 ELSE 2 END, LOWER(name)`
    );
    return rows;
}

async function findByGuid(guid) {
    const { rows } = await pool.query(
        'SELECT guid, name, email, role, created_at FROM profiles WHERE guid = $1',
        [guid]
    );
    return rows[0] || null;
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

async function remove(guid) {
    const result = await pool.query('DELETE FROM profiles WHERE guid = $1', [guid]);
    return result.rowCount > 0;
}

module.exports = {
    ROLES,
    initialize,
    findAll,
    findByGuid,
    create,
    countAdministrators,
    update,
    remove
};
