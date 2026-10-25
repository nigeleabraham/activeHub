// Populates the database from seed/data.json (create it with `npm run seed:export`).
// Runs once per database (recorded in site_settings) and never overwrites admin edits afterwards;
// pass --force to run again and add any rows that are missing.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { TABLES, SEEDED_KEY } = require('./seedTables');

const DATA_FILE = path.join(__dirname, '..', 'seed', 'data.json');
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const MODELS = ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings'];

function toDbValue(value) {
    return typeof value === 'string' && value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : value;
}

function insertQuery(table, columns, upsert) {
    for (const column of [table, ...columns]) {
        if (!IDENTIFIER.test(column)) throw new Error(`Unexpected identifier in seed data: ${column}`);
    }
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    const conflict = upsert
        ? `ON CONFLICT (${upsert.conflict.join(', ')}) DO UPDATE SET ${upsert.update.map(column => `${column} = EXCLUDED.${column}`).join(', ')}`
        : 'ON CONFLICT DO NOTHING';
    return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ${conflict}`;
}

async function seedKeyedTable(client, table, rows, guidMaps) {
    const guidMap = new Map();
    guidMaps[table.name] = guidMap;
    let inserted = 0;
    for (const row of rows) {
        const existing = await client.query(
            `SELECT guid FROM ${table.name} WHERE LOWER(${table.keyBy}) = LOWER($1)`,
            [row[table.keyBy]]
        );
        let guid = existing.rows[0]?.guid;
        if (!guid) {
            const columns = Object.keys(row);
            const { rows: created } = await client.query(
                `${insertQuery(table.name, columns)} RETURNING guid`,
                columns.map(column => toDbValue(row[column]))
            );
            guid = created[0]?.guid;
            inserted += 1;
        }
        if (row.guid) guidMap.set(row.guid, guid);
    }
    return inserted;
}

async function seedPlainTable(client, table, rows, guidMaps, firstRun) {
    let inserted = 0;
    for (const row of rows) {
        const values = { ...row };
        for (const [column, source] of Object.entries(table.remap || {})) {
            if (values[column]) values[column] = guidMaps[source].get(values[column]) || values[column];
        }
        const columns = Object.keys(values);
        const result = await client.query(insertQuery(table.name, columns, firstRun ? table.upsert : null), columns.map(column => toDbValue(values[column])));
        inserted += result.rowCount;
    }
    return inserted;
}

async function main() {
    if (!fs.existsSync(DATA_FILE)) {
        throw new Error(`${DATA_FILE} not found. Run "npm run seed:export" against a populated database first.`);
    }
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const force = process.argv.includes('--force');

    // Creating the tables is the models' job; run them in the same order as server.js.
    for (const name of MODELS) await require(`../models/${name}`).initialize();

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    const guidMaps = {};
    try {
        const seededBefore = (await client.query('SELECT value FROM site_settings WHERE key = $1', [SEEDED_KEY])).rows[0];
        if (seededBefore && !force) {
            console.log(`Already seeded on ${seededBefore.value}; nothing to do (use --force to fill in missing rows).`);
            return;
        }
        const firstRun = !seededBefore;
        await client.query('BEGIN');
        for (const table of TABLES) {
            const rows = data[table.name] || [];
            const inserted = table.keyBy
                ? await seedKeyedTable(client, table, rows, guidMaps)
                : await seedPlainTable(client, table, rows, guidMaps, firstRun);
            console.log(`${table.name}: ${inserted} added, ${rows.length - inserted} already present`);
            if (table.name === 'roles') {
                let added = 0;
                for (const { role, permission } of data.role_permissions || []) {
                    const result = await client.query(
                        `INSERT INTO role_permissions (role_guid, permission)
                         SELECT guid, $2 FROM roles WHERE LOWER(name) = LOWER($1)
                         ON CONFLICT DO NOTHING`,
                        [role, permission]
                    );
                    added += result.rowCount;
                }
                console.log(`role_permissions: ${added} added`);
            }
        }
        await client.query(
            `INSERT INTO site_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [SEEDED_KEY, new Date().toISOString()]
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Seeding failed:', error);
        process.exit(1);
    });
