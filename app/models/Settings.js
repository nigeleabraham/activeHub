const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

const DEFAULTS = { site_title: 'ActiveHub', organisation_name: "Peck'em", credit_request_days: '30', credit_slot_auto_approval: '0', credit_lifetime_days: '365' };
const SITE_TITLE_MAX_LENGTH = 60;

function parseCreditRequestDays(value) {
    if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return null;
    const days = Number(value);
    return days >= 1 && days <= 365 ? days : null;
}

function parseCreditLifetimeDays(value) {
    if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
    const days = Number(value);
    return days >= 1 && days <= 36500 ? days : null;
}

async function getCreditRequestDays() {
    const settings = await getAll();
    const days = parseCreditRequestDays(settings.credit_request_days);
    if (days === null) throw new Error('Invalid configured credit request day limit');
    return days;
}

async function initialize() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS site_settings (
            key text PRIMARY KEY,
            value text NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS site_logo (
            id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            content_type text NOT NULL,
            data bytea NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
        )
    `);
}

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const LOGO_MAX_BYTES = 512 * 1024;

async function getLogo() {
    const { rows } = await pool.query('SELECT content_type, data, updated_at FROM site_logo WHERE id = 1');
    return rows[0] || null;
}

async function setLogo(contentType, data) {
    await pool.query(
        `INSERT INTO site_logo (id, content_type, data) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
        [contentType, data]
    );
}

async function removeLogo() {
    await pool.query('DELETE FROM site_logo WHERE id = 1');
}

async function getAll() {
    const { rows } = await pool.query('SELECT key, value FROM site_settings');
    return { ...DEFAULTS, ...Object.fromEntries(rows.map(row => [row.key, row.value])) };
}

async function set(key, value) {
    await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, value]
    );
}

module.exports = { initialize, getAll, set, getLogo, setLogo, removeLogo, LOGO_TYPES, LOGO_MAX_BYTES, DEFAULTS, SITE_TITLE_MAX_LENGTH, parseCreditRequestDays, getCreditRequestDays, parseCreditLifetimeDays };
