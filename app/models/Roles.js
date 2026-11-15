const { Pool } = require('pg');
const { PERMISSION_KEYS } = require('./../permissions');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const ADMINISTRATOR = 'Administrator';
const FACILITY_MANAGER = 'Facility manager';
const FACILITY_MANAGER_PERMISSIONS = ['facilities.manage', 'bookings.manage', 'courses.manage', 'course_bookings.view'];

const SEED_ROLES = [
    { name: ADMINISTRATOR, description: 'Full access to every administration area. Always has every permission.', is_system: true },
    { name: FACILITY_MANAGER, description: 'Manage assigned facilities, court bookings and course classes.', is_system: true },
    { name: 'Coach', description: 'Coaches use the coach experience and have no administration access by default.', is_system: false },
    { name: 'Resident', description: 'Residents use the resident experience and have no administration access by default.', is_system: false },
    { name: 'Course leader', description: 'Manage courses and their sport and facility assignments.', is_system: false }
];
const OPTIONAL_SEED_ROLE_NAMES = SEED_ROLES.filter(role => !role.is_system && role.name !== 'Resident').map(role => role.name);

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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS suppressed_seed_roles (
            name text PRIMARY KEY
        )
    `);
    for (const role of SEED_ROLES) {
        const created = await pool.query(
            `INSERT INTO roles (name, description, is_system)
             SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM suppressed_seed_roles WHERE name = $1)
             ON CONFLICT DO NOTHING RETURNING guid`,
            [role.name, role.description, role.is_system]
        );
        if (role.name === 'Course leader' && created.rows.length) {
            await pool.query('INSERT INTO role_permissions (role_guid, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [created.rows[0].guid, 'courses.manage']);
        }
    }
    await pool.query(`UPDATE roles SET name = $1, is_system = true, description = $2 WHERE LOWER(name) = LOWER($1)`,
        [FACILITY_MANAGER, 'Manage assigned facilities, court bookings and course classes.']);
}

async function findAll() {
    const { rows } = await pool.query(`
        SELECT r.guid, r.name, r.description, r.is_system,
               COALESCE((SELECT array_agg(rp.permission ORDER BY rp.permission) FROM role_permissions rp WHERE rp.role_guid = r.guid), '{}') AS permissions,
               (SELECT COUNT(*)::int FROM profiles p WHERE p.deleted_at IS NULL AND (r.name = 'Resident' OR p.role = r.name OR EXISTS (
                   SELECT 1 FROM profile_roles pr WHERE pr.profile_guid = p.guid AND pr.role = r.name))) AS member_count
        FROM roles r
        ORDER BY r.is_system DESC, LOWER(r.name)
    `);
    return rows.map(row => ({
        ...row,
        permissions: row.name === ADMINISTRATOR ? [...PERMISSION_KEYS] :
            row.name === FACILITY_MANAGER ? [...FACILITY_MANAGER_PERMISSIONS] : row.permissions
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
    if (roleName === FACILITY_MANAGER) return [...FACILITY_MANAGER_PERMISSIONS];
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
        ORDER BY CASE WHEN r.name = 'Facility manager' THEN 4 ELSE COUNT(rp.permission) FILTER (WHERE rp.permission NOT IN (
            SELECT base.permission FROM role_permissions base JOIN roles resident ON resident.guid = base.role_guid
            WHERE resident.name = 'Resident')) END DESC, LOWER(r.name), r.name
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
        const existing = (await client.query('SELECT name FROM roles WHERE guid = $1 FOR UPDATE', [guid])).rows[0];
        if (existing && existing.name !== name && OPTIONAL_SEED_ROLE_NAMES.includes(existing.name)) {
            await client.query('INSERT INTO suppressed_seed_roles (name) VALUES ($1) ON CONFLICT DO NOTHING', [existing.name]);
        }
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
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const role = (await client.query(
            "SELECT name FROM roles WHERE guid = $1 AND is_system = false AND name <> 'Resident' FOR UPDATE", [guid]
        )).rows[0];
        if (!role) {
            await client.query('COMMIT');
            return false;
        }
        const active = await client.query(`
            SELECT 1 FROM profiles p WHERE p.deleted_at IS NULL AND (p.role = $1 OR EXISTS (
                SELECT 1 FROM profile_roles pr WHERE pr.profile_guid = p.guid AND pr.role = $1)) LIMIT 1`, [role.name]);
        if (active.rowCount) {
            const error = new Error('Role is assigned to active profiles');
            error.code = 'ROLE_IN_USE';
            throw error;
        }
        await client.query(`
            INSERT INTO deleted_profile_roles (profile_guid, role, was_default)
            SELECT p.guid, $1, p.role = $1 FROM profiles p
            WHERE p.deleted_at IS NOT NULL AND (p.role = $1 OR EXISTS (
                SELECT 1 FROM profile_roles pr WHERE pr.profile_guid = p.guid AND pr.role = $1))
            ON CONFLICT (profile_guid, role) DO UPDATE
                SET was_default = deleted_profile_roles.was_default OR EXCLUDED.was_default`, [role.name]);
        await client.query("UPDATE profiles SET role = 'Resident' WHERE deleted_at IS NOT NULL AND role = $1", [role.name]);
        await client.query(`
            DELETE FROM profile_roles pr USING profiles p
            WHERE pr.profile_guid = p.guid AND p.deleted_at IS NOT NULL AND pr.role = $1`, [role.name]);
        if (OPTIONAL_SEED_ROLE_NAMES.includes(role.name)) {
            await client.query('INSERT INTO suppressed_seed_roles (name) VALUES ($1) ON CONFLICT DO NOTHING', [role.name]);
        }
        await client.query('DELETE FROM roles WHERE guid = $1', [guid]);
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
    ADMINISTRATOR,
    FACILITY_MANAGER,
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
