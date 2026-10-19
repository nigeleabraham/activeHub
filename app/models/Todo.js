const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS todos (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            task text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
}

async function findAll() {
    const { rows } = await pool.query(
        'SELECT id, task, created_at FROM todos ORDER BY id DESC'
    );
    return rows;
}

async function create(task) {
    const { rows } = await pool.query(
        'INSERT INTO todos (task) VALUES ($1) RETURNING id, task, created_at',
        [task]
    );
    return rows[0];
}

async function remove(id) {
    await pool.query('DELETE FROM todos WHERE id = $1', [id]);
}

module.exports = { initialize, findAll, create, remove };