const { Pool } = require('pg');
const { PERMISSION_KEYS } = require('./../permissions');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const ADMINISTRATOR = 'Administrator';

const SEED_ROLES = [
    { name: ADMINISTRATOR, description: 'Full access to every administration area. Always has every permission.', is_system: true },
    { name: 'Coach', description: 'Coaches use the coach experience and have no administration access by default.', is_system: false },
    { name: 'Resident', description: 'Residents use the resident experience and have no administration access by default.', is_system: false },
    { name: 'Course leader', description: 'Manage courses and their sport and facility assignments.', is_system: false }
];

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS roles (
            guid uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL UNIQUE,
            description text,
            is_system boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS roles_name_lower_key ON roles (LOWER(name))');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS role_permissions (
            role_guid uuid NOT NULL REFERENCES roles (guid) ON DELETE CASCADE,
            permission text NOT NULL,
            PRIMARY KEY (role_guid, permission)
        )
    `);
    for (const role of SEED_ROLES) {
        const created = await pool.query(
            'INSERT INTO roles (name, description, is_system) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING guid',
            [role.name, role.description, role.is_system]
        );
        if (role.name === 'Course leader' && created.rows.length) {
            await pool.query('INSERT INTO role_permissions (role_guid, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [created.rows[0].guid, 'courses.manage']);
        }
    }
}

async function findAll() {
    const { rows } = await pool.query(`
        SELECT r.guid, r.name, r.description, r.is_system,
               COALESCE((SELECT array_agg(rp.permission ORDER BY rp.permission) FROM role_permissions rp WHERE rp.role_guid = r.guid), '{}') AS permissions,
               (SELECT COUNT(*)::int FROM profiles p WHERE r.name = 'Resident' OR p.role = r.name OR EXISTS (
                   SELECT 1 FROM profile_roles pr WHERE pr.profile_guid = p.guid AND pr.role = r.name)) AS member_count
        FROM roles r
        ORDER BY r.is_system DESC, LOWER(r.name)
    `);
    return rows.map(row => ({
        ...row,
        permissions: row.is_system && row.name === ADMINISTRATOR ? [...PERMISSION_KEYS] : row.permissions
    }));
}

async function findByGuid(guid) {
    return (await findAll()).find(role => role.guid === guid) || null;
}

async function names() {
    const { rows } = await pool.query('SELECT name FROM roles ORDER BY is_system DESC, LOWER(name)');
    return rows.map(row => row.name);
}

// Administrator always has every permission so the tool can never be locked out.
async function permissionsFor(roleName) {
    if (roleName === ADMINISTRATOR) return [...PERMISSION_KEYS];
    const { rows } = await pool.query(
        `SELECT DISTINCT rp.permission FROM role_permissions rp JOIN roles r ON r.guid = rp.role_guid
         WHERE r.name = $1 OR r.name = 'Resident' ORDER BY rp.permission`,
        [roleName]
    );
    return rows.map(row => row.permission);
}

async function highestFor(roleNames) {
    if (roleNames.includes(ADMINISTRATOR)) return ADMINISTRATOR;
    if (!roleNames.length) throw new Error('Profile has no assigned roles');
    const { rows } = await pool.query(`
        SELECT r.name FROM roles r LEFT JOIN role_permissions rp ON rp.role_guid = r.guid
        WHERE r.name = ANY($1::text[])
        GROUP BY r.guid, r.name
        ORDER BY COUNT(rp.permission) FILTER (WHERE rp.permission NOT IN (
            SELECT base.permission FROM role_permissions base JOIN roles resident ON resident.guid = base.role_guid
            WHERE resident.name = 'Resident')) DESC, LOWER(r.name), r.name
        LIMIT 1`, [roleNames]);
    if (!rows.length) throw new Error('Profile has no existing assigned roles');
    return rows[0].name;
}

async function setPermissions(client, roleGuid, permissions) {
    await client.query('DELETE FROM role_permissions WHERE role_guid = $1', [roleGuid]);
    for (const permission of permissions) {
        await client.query('INSERT INTO role_permissions (role_guid, permission) VALUES ($1, $2)', [roleGuid, permission]);
    }
}

async function create({ name, description, permissions }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING guid, name, description',
            [name, description]
        );
        await setPermissions(client, rows[0].guid, permissions);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Renaming cascades to default roles and additional profile assignments.
async function update(guid, { name, description, permissions }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            'UPDATE roles SET name = $2, description = $3 WHERE guid = $1 RETURNING guid, name, description',
            [guid, name, description]
        );
        if (!rows.length) {
            await client.query('ROLLBACK');
            return null;
        }
        await setPermissions(client, guid, permissions);
        await client.query('COMMIT');
        return rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function remove(guid) {
    const result = await pool.query('DELETE FROM roles WHERE guid = $1 AND is_system = false', [guid]);
    return result.rowCount > 0;
}

module.exports = {
    ADMINISTRATOR,
    initialize,
    findAll,
    findByGuid,
    names,
    permissionsFor,
    highestFor,
    create,
    update,
    remove
};
