// Snapshots the current database into seed/data.json so seedDatabase.js can recreate it.
// Bookings and the audit log are history rather than reference data, so they are left out.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { TABLES, ROLE_PERMISSIONS_QUERY, SEEDED_KEY } = require('./seedTables');

const OUTPUT = path.join(__dirname, '..', 'seed', 'data.json');

// bytea is stored as a "\x..." hex string so the snapshot stays plain JSON.
const toJson = value => (Buffer.isBuffer(value) ? `\\x${value.toString('hex')}` : value);

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const data = {};
    try {
        for (const table of TABLES) {
            const { rows } = await pool.query(`SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`);
            data[table.name] = rows.map(row => Object.fromEntries(
                Object.entries(row)
                    .filter(([column]) => !(table.skip || []).includes(column))
                    .map(([column, value]) => [column, toJson(value)])
            )).filter(row => !(table.name === 'site_settings' && row.key === SEEDED_KEY));
        }
        data.role_permissions = (await pool.query(ROLE_PERMISSIONS_QUERY)).rows;
    } finally {
        await pool.end();
    }
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(data, null, 2)}\n`);
    for (const [name, rows] of Object.entries(data)) console.log(`${name}: ${rows.length}`);
    console.log(`Wrote ${OUTPUT}`);
}

main().catch(error => {
    console.error('Seed export failed:', error);
    process.exit(1);
});
