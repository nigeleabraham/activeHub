const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sports (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS sports_name_lower_key ON sports (LOWER(name))
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS facility_sports (
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            sport_guid uuid NOT NULL REFERENCES sports(guid) ON DELETE CASCADE,
            PRIMARY KEY (facility_guid, sport_guid)
        )
    `);
    await pool.query(`
        INSERT INTO sports (name)
        VALUES ('Tennis'), ('Netball')
        ON CONFLICT DO NOTHING
    `);
}

async function findAll() {
    const { rows } = await pool.query(
        'SELECT guid, name, created_at FROM sports ORDER BY LOWER(name)'
    );
    return rows;
}

async function create(name) {
    const { rows } = await pool.query(
        'INSERT INTO sports (name) VALUES ($1) RETURNING guid, name, created_at',
        [name]
    );
    return rows[0];
}

async function update(guid, name) {
    const { rows } = await pool.query(
        'UPDATE sports SET name = $2 WHERE guid = $1 RETURNING guid, name, created_at',
        [guid, name]
    );
    return rows[0] || null;
}

async function remove(guid) {
    await pool.query('DELETE FROM sports WHERE guid = $1', [guid]);
}

module.exports = { initialize, findAll, create, update, remove };
