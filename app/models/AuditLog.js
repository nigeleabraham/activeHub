const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const PAGE_SIZE = 50;

async function initialize() {
    // Profile name and role are copied onto each row so the trail survives profile edits and deletion.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            created_at timestamptz NOT NULL DEFAULT now(),
            profile_guid uuid REFERENCES profiles(guid) ON DELETE SET NULL,
            profile_name text NOT NULL,
            profile_role text NOT NULL,
            action text NOT NULL,
            entity_type text NOT NULL,
            entity_guid text,
            entity_label text,
            details jsonb NOT NULL DEFAULT '{}'::jsonb
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS audit_log_profile_idx ON audit_log (profile_guid)');
    await pool.query('CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action)');
}

async function record(profile, { action, entityType, entityGuid = null, entityLabel = null, details = {} }) {
    await pool.query(
        `INSERT INTO audit_log
            (profile_guid, profile_name, profile_role, action, entity_type, entity_guid, entity_label, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [profile.guid, profile.name, profile.role, action, entityType, entityGuid, entityLabel, JSON.stringify(details)]
    );
}

async function search({ profileGuid = null, action = null, page = 1 } = {}) {
    const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
    const filters = [profileGuid, action];
    const where = `($1::uuid IS NULL OR profile_guid = $1) AND ($2::text IS NULL OR action = $2)`;
    const [rows, total] = await Promise.all([
        pool.query(
            `SELECT guid, created_at, profile_guid, profile_name, profile_role,
                    action, entity_type, entity_guid, entity_label, details
             FROM audit_log WHERE ${where}
             ORDER BY created_at DESC, guid LIMIT ${PAGE_SIZE} OFFSET $3`,
            [...filters, offset]
        ),
        pool.query(`SELECT COUNT(*)::int AS count FROM audit_log WHERE ${where}`, filters)
    ]);
    return { entries: rows.rows, total: total.rows[0].count, pageSize: PAGE_SIZE };
}

async function findActions() {
    const { rows } = await pool.query('SELECT DISTINCT action FROM audit_log ORDER BY action');
    return rows.map(row => row.action);
}

module.exports = { PAGE_SIZE, initialize, record, search, findActions };
