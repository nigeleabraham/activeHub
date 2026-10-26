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
    await pool.query("ALTER TABLE sports ADD COLUMN IF NOT EXISTS course_description_sections jsonb NOT NULL DEFAULT '[]'");
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
        'SELECT guid, name, course_description_sections, created_at FROM sports ORDER BY LOWER(name)'
    );
    return rows;
}

async function create(name, descriptionSections = []) {
    const validated = require('../courseDescriptions').sections(descriptionSections);
    const { rows } = await pool.query(
        'INSERT INTO sports (name,course_description_sections) VALUES ($1,$2) RETURNING *',
        [name, JSON.stringify(validated)]
    );
    return rows[0];
}

async function update(guid, name, descriptionSections) {
    const validated = descriptionSections === undefined ? null : require('../courseDescriptions').sections(descriptionSections);
    const { rows } = await pool.query(
        'UPDATE sports SET name = $2, course_description_sections=COALESCE($3::jsonb,course_description_sections) WHERE guid = $1 RETURNING *',
        [guid, name, validated === null ? null : JSON.stringify(validated)]
    );
    return rows[0] || null;
}

async function remove(guid) {
    await pool.query('DELETE FROM sports WHERE guid = $1', [guid]);
}

async function updateCourseDefaults(guid, descriptionSections) {
    const validated = require('../courseDescriptions').sections(descriptionSections);
    const { rows } = await pool.query('UPDATE sports SET course_description_sections=$2 WHERE guid=$1 RETURNING guid',
        [guid, JSON.stringify(validated)]);
    return rows[0] || null;
}

module.exports = { initialize, findAll, create, update, remove, updateCourseDefaults };
