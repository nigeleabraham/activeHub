const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const references = require('../bookingReferences');

test('booking references have six readable characters with distinct prefixes', () => {
    for (let i = 0; i < 100; i++) {
        assert.match(references.generate('AHC'), /^AHC-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
        assert.match(references.generate('AH'), /^AH-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
});

test('reference conflicts are retried and other errors are propagated', async t => {
    let calls = 0;
    const random = t.mock.method(crypto, 'randomInt', () => Math.floor(calls++ / 6));
    const queries = [];
    const client = {
        async query(query, values) {
            queries.push({ query, values });
            return queries.length === 1 ? { rowCount: 0, rows: [] }
                : { rowCount: 1, rows: [{ booking_ref: values.at(-1) }] };
        }
    };
    const inserted = await references.insert(client, 'AHC', 'INSERT', ['other']);
    assert.equal(inserted.booking_ref, 'AHC-BBBBBB');
    assert.deepEqual(queries.map(item => item.values), [['other', 'AHC-AAAAAA'], ['other', 'AHC-BBBBBB']]);
    random.mock.restore();

    const failure = new Error('database unavailable');
    await assert.rejects(references.insert({ query: async () => { throw failure; } }, 'AH', 'INSERT', []), failure);
    let attempts = 0;
    await assert.rejects(references.insert({ query: async () => {
        attempts++;
        return { rowCount: 0, rows: [] };
    } }, 'AH', 'INSERT', []), /unique booking reference after 10 attempts/);
    assert.equal(attempts, 10);
});
