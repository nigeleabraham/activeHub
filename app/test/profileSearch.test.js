const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Profiles = require('../models/Profiles');
const router = require('../routes/front');

test('profile search matches every name word prefix in either order with bounded results', async t => {
    const profiles = [{ guid: 'resident', name: 'Rita Resident' }];
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: profiles }));
    for (const [input, prefix, terms] of [
        ['Rita', 'rita%', ['rita%']],
        ['Resident', 'resident%', ['resident%']],
        ['Resident Rita', 'resident rita%', ['resident%', 'rita%']],
        ['  ri \t res  ', 'ri res%', ['ri%', 'res%']],
        ['rita.resident@example.com', 'rita.resident@example.com%', ['rita.resident@example.com%']],
        ['A_%\\', 'a\\_\\%\\\\%', ['a\\_\\%\\\\%']]
    ]) {
        assert.deepEqual(await Profiles.search(input), profiles);
        const [sql, values] = query.mock.calls.at(-1).arguments;
        assert.deepEqual(values, [prefix, 20, terms]);
        assert.match(sql, /deleted_at IS NULL/);
        assert.match(sql, /LOWER\(email\) LIKE \$1/);
        assert.match(sql, /unnest\(\$3::text\[\]\)/);
        assert.match(sql, /regexp_split_to_table\(LOWER\(name\), '\\s\+'\)/);
        assert.match(sql, /WHERE words\.word LIKE terms\.pattern/);
        assert.match(sql, /ORDER BY CASE WHEN LOWER\(name\) LIKE \$1 THEN 0 ELSE 1 END/);
        assert.match(sql, /LIMIT \$2/);
    }
    await Profiles.search('Rita', 5);
    assert.equal(query.mock.calls.at(-1).arguments[1][1], 5);
});

test('profile search route preserves query bounds, returns matches and surfaces database failures', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/profiles/search').route.stack[0].handle;
    const profiles = [{ guid: 'resident', name: 'Rita Resident' }];
    const search = t.mock.method(Profiles, 'search', async () => profiles);
    for (const q of ['', 'r', 'x'.repeat(101), ['Rita', 'Resident'], undefined]) {
        let result;
        await handler({ query: { q } }, { json(value) { result = value; } });
        assert.deepEqual(result, { profiles: [] });
    }
    assert.equal(search.mock.callCount(), 0);
    let result;
    await handler({ query: { q: ' Resident Rita ' } }, { json(value) { result = value; } });
    assert.deepEqual(result, { profiles });
    assert.deepEqual(search.mock.calls[0].arguments, ['Resident Rita']);
    search.mock.mockImplementation(async () => { throw new Error('Database unavailable'); });
    let status;
    await handler({ query: { q: 'Resident' } }, { sendStatus(value) { status = value; } });
    assert.equal(status, 500);
});
