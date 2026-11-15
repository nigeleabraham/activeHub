const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const references = require('../bookingReferences');

const databaseUrl = process.env.BASKET_TEST_DATABASE_URL;

test('concurrent reference collisions retry after the first transaction commits (PostgreSQL)',
    { skip: !databaseUrl }, async t => {
        assert.ok(new URL(databaseUrl).pathname.endsWith('_test'));
        const pool = new Pool({ connectionString: databaseUrl });
        t.after(() => pool.end());
        await pool.query('CREATE TABLE booking_reference_collision_test (booking_ref text UNIQUE NOT NULL)');
        const first = await pool.connect();
        const second = await pool.connect();
        let calls = 0;
        const random = t.mock.method(crypto, 'randomInt', () => calls++ < 12 ? 0 : 1);
        const query = `INSERT INTO booking_reference_collision_test (booking_ref) VALUES ($1)
            ON CONFLICT (booking_ref) DO NOTHING RETURNING booking_ref`;
        try {
            await first.query('BEGIN');
            await second.query('BEGIN');
            assert.equal((await references.insert(first, 'AH', query, [])).booking_ref, 'AH-AAAAAA');
            const pending = references.insert(second, 'AH', query, []);
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                const { rows: [activity] } = await pool.query(
                    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [second.processID]);
                if (activity?.wait_event_type === 'Lock') {
                    waiting = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true, 'second insert must wait for the uncommitted reference');
            await first.query('COMMIT');
            assert.equal((await pending).booking_ref, 'AH-BBBBBB');
            await second.query('COMMIT');
            assert.equal(calls, 18);
        } finally {
            random.mock.restore();
            await first.query('ROLLBACK');
            await second.query('ROLLBACK');
            first.release();
            second.release();
            await pool.query('DROP TABLE booking_reference_collision_test');
        }
    });
