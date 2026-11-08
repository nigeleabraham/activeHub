const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Profiles = require('../models/Profiles');
const router = require('../routes/front');

test('profile search matches every name word prefix in either order with bounded results', async t => {
    const profiles = [{ guid: 'resident', name: 'Rita Resident' }];
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: profiles }));
    for (const [input, prefix, terms] of [
        ['Rita', 'rita%', "'rita':*"],
        ['Resident', 'resident%', "'resident':*"],
        ['Resident Rita', 'resident rita%', "'resident':* & 'rita':*"],
        ['  ri \t res  ', 'ri res%', "'ri':* & 'res':*"],
        ['rita.resident@example.com', 'rita.resident@example.com%', "'rita.resident@example.com':*"],
        ['A_%\\', 'a\\_\\%\\\\%', "'a_%\\\\':*"],
        ["O'Ne", "o'ne%", "'o\\'ne':*"],
        ['A&B | !:*', 'a&b | !:*%', "'a&b':* & '|':* & '!:*':*"]
    ]) {
        assert.deepEqual(await Profiles.search(input), profiles);
        const [sql, values] = query.mock.calls.at(-1).arguments;
        assert.deepEqual(values, [prefix, 20, terms]);
        assert.match(sql, /deleted_at IS NULL/);
        assert.match(sql, /LOWER\(email\) LIKE \$1/);
        assert.match(sql, /array_to_tsvector\(array_remove\(regexp_split_to_array\(LOWER\(name\), '\\s\+'\), ''\)\) @@ \$3::tsquery/);
        assert.doesNotMatch(sql, /NOT EXISTS|regexp_split_to_table/);
        assert.match(sql, /ORDER BY CASE WHEN LOWER\(name\) LIKE \$1 THEN 0 ELSE 1 END/);
        assert.match(sql, /LIMIT \$2/);
        assert.ok(sql.indexOf('LIMIT $2') < sql.indexOf('FROM profile_roles'));
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

test('indexed profile search preserves literal name matching in PostgreSQL', {
    skip: !process.env.SEARCH_TEST_DATABASE_URL
}, async t => {
    const db = new Pool({ connectionString: process.env.SEARCH_TEST_DATABASE_URL });
    const client = await db.connect();
    t.after(async () => {
        await client.query('ROLLBACK');
        client.release();
        await db.end();
    });
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE profiles (LIKE public.profiles INCLUDING ALL) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE profile_roles (LIKE public.profile_roles INCLUDING ALL) ON COMMIT DROP');
    const schema = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [{}] }));
    await Profiles.initialize();
    const indexSql = schema.mock.calls.map(call => call.arguments[0])
        .find(sql => sql.includes('profiles_name_words_idx'));
    assert.ok(indexSql);
    await client.query(indexSql);
    schema.mock.mockImplementation((sql, values) => client.query(sql, values));
    const names = ['Rita Resident', 'Resident Rita', "Anne O'Neil", 'Jean-Luc Smith', 'A_%\\ Literal',
        'A&B | !:*', 'José Álvarez', 'Rita\tResident', ' Rita  Resident ', '', 'Deleted Resident',
        ...Array.from({ length: 25 }, (_, index) => `Rita Extra${index}`)];
    for (const [index, name] of names.entries()) {
        await client.query(`INSERT INTO profiles (name, email, role, deleted_at)
            VALUES ($1, $2, 'Resident', $3)`,
        [name, `person${index}@example.test`, name === 'Deleted Resident' ? new Date() : null]);
    }
    await client.query('SET LOCAL enable_seqscan = off');
    for (const input of ['Ri', 'Resident', 'Resident Rita', 'ri res', '  ri \t res  ',
        "O'Ne", 'Jean-', 'A_%\\', 'A&B | !:*', 'José Á', 'person3@', 'Deleted', 'missing']) {
        const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
        const escapeLike = value => value.replace(/[\\%_]/g, '\\$&');
        const { rows: expected } = await client.query(`
            SELECT guid FROM profiles
            WHERE deleted_at IS NULL AND (LOWER(name) LIKE $1 OR LOWER(email) LIKE $1 OR
                NOT EXISTS (
                    SELECT 1 FROM unnest($2::text[]) AS terms(pattern)
                    WHERE NOT EXISTS (
                        SELECT 1 FROM regexp_split_to_table(LOWER(name), '\\s+') AS words(word)
                        WHERE words.word LIKE terms.pattern
                    )
                ))
            ORDER BY CASE WHEN LOWER(name) LIKE $1 THEN 0 ELSE 1 END, LOWER(name), guid LIMIT 20`,
        [`${escapeLike(normalized)}%`, normalized.split(' ').map(term => `${escapeLike(term)}%`)]);
        const actual = await Profiles.search(input);
        assert.deepEqual(actual.map(profile => profile.guid), expected.map(profile => profile.guid), input);
        assert.ok(actual.every(profile => profile.roles.includes('Resident')));
    }
    const [sql, values] = schema.mock.calls.at(-1).arguments;
    const { rows: plan } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
    assert.match(JSON.stringify(plan), /profiles_name_words_idx/);
    await client.query("UPDATE profiles SET name = 'New Family' WHERE name = 'Jean-Luc Smith'");
    assert.equal((await Profiles.search('Jean-')).length, 0);
    const [renamed] = await Profiles.search('Family Ne');
    assert.equal(renamed.name, 'New Family');
    await client.query("INSERT INTO profile_roles (profile_guid, role) VALUES ($1, 'Coach')", [renamed.guid]);
    assert.deepEqual((await Profiles.search('Family Ne'))[0].roles, ['Coach', 'Resident']);
    await client.query('UPDATE profiles SET deleted_at = now() WHERE guid = $1', [renamed.guid]);
    assert.equal((await Profiles.search('Family Ne')).length, 0);
});
