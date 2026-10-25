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
            description text,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS description text');
}

async function findAll() {
    const { rows } = await pool.query(`
        SELECT courses.guid, courses.facility_guid, courses.name, courses.description,
               facilities.name AS facility_name, courses.created_at
        FROM courses
        JOIN facilities ON facilities.guid = courses.facility_guid
        ORDER BY LOWER(facilities.name), LOWER(courses.name)
    `);
    return rows;
}

async function create({ name, facility_guid, description }) {
    const { rows } = await pool.query(
        `INSERT INTO courses (name, facility_guid, description)
         VALUES ($1, $2, $3)
         RETURNING guid, name, facility_guid, description, created_at`,
        [name, facility_guid, description]
    );
    return rows[0];
}

async function update(guid, { name, description }) {
    const { rows } = await pool.query(
        `UPDATE courses
         SET name = $2, description = $3
         WHERE guid = $1
         RETURNING guid, name, facility_guid, description, created_at`,
        [guid, name, description]
    );
    return rows[0] || null;
}

async function remove(guid) {
    const { rows } = await pool.query('DELETE FROM courses WHERE guid = $1 RETURNING facility_guid', [guid]);
    return rows[0] || null;
}

module.exports = { initialize, findAll, create, update, remove };
