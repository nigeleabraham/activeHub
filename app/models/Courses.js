const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS courses (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_guid uuid NOT NULL REFERENCES facilities(guid) ON DELETE CASCADE,
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
}

async function findAll() {
    const { rows } = await pool.query(`
        SELECT courses.guid, courses.facility_guid, courses.name,
               facilities.name AS facility_name, courses.created_at
        FROM courses
        JOIN facilities ON facilities.guid = courses.facility_guid
        ORDER BY LOWER(facilities.name), LOWER(courses.name)
    `);
    return rows;
}

async function create({ name, facility_guid }) {
    const { rows } = await pool.query(
        `INSERT INTO courses (name, facility_guid)
         VALUES ($1, $2)
         RETURNING guid, name, facility_guid, created_at`,
        [name, facility_guid]
    );
    return rows[0];
}

async function update(guid, { name, facility_guid }) {
    const { rows } = await pool.query(
        `UPDATE courses
         SET name = $2, facility_guid = $3
         WHERE guid = $1
         RETURNING guid, name, facility_guid, created_at`,
        [guid, name, facility_guid]
    );
    return rows[0] || null;
}

async function remove(guid) {
    await pool.query('DELETE FROM courses WHERE guid = $1', [guid]);
}

module.exports = { initialize, findAll, create, update, remove };
