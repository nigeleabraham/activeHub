const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const AuditLog = require('../models/AuditLog');
const Profiles = require('../models/Profiles');
const router = require('../routes/front');

const admin = router.stack.find(layer => layer.handle.stack).handle;
const auditHandler = admin.stack.find(layer => layer.route?.path === '/audit').route.stack[0].handle;
const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('audit month defaults follow London time at month boundaries', () => {
    assert.equal(AuditLog.currentMonth(new Date('2026-10-31T23:30:00Z')), '2026-10');
    assert.equal(AuditLog.currentMonth(new Date('2026-06-30T23:30:00Z')), '2026-07');
    assert.equal(AuditLog.currentMonth(new Date('2026-01-01T00:00:00Z')), '2026-01');
});

test('audit entry, count and action queries use the same inclusive London date range', async t => {
    const entries = [{ guid: GUID }];
    const query = t.mock.method(Pool.prototype, 'query', async sql => {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: 51 }] };
        if (sql.includes('DISTINCT action')) return { rows: [{ action: 'profile.update' }] };
        return { rows: entries };
    });
    assert.deepEqual(await AuditLog.search({ from: '2026-10-01', to: '2026-10-31', profileGuid: GUID, action: 'profile.update', page: 2 }), {
        entries, total: 51, pageSize: 50
    });
    assert.deepEqual(await AuditLog.findActions('2026-10-01', '2026-10-31'), ['profile.update']);
    assert.equal(query.mock.callCount(), 3);
    for (const call of query.mock.calls) {
        const [sql, params] = call.arguments;
        assert.match(sql, /created_at >= \(\$1::date\)::timestamp AT TIME ZONE 'Europe\/London'/);
        assert.match(sql, /created_at < \(\$2::date \+ 1\)::timestamp AT TIME ZONE 'Europe\/London'/);
        assert.equal(params[0], '2026-10-01');
    }
    assert.match(query.mock.calls[0].arguments[0], /LIMIT 50 OFFSET \$5/);
    assert.deepEqual(query.mock.calls[0].arguments[1], ['2026-10-01', '2026-10-31', GUID, 'profile.update', 50]);
    assert.deepEqual(query.mock.calls[1].arguments[1], ['2026-10-01', '2026-10-31', GUID, 'profile.update']);
    assert.deepEqual(query.mock.calls[2].arguments[1], ['2026-10-01', '2026-10-31']);
});

test('audit model rejects missing, invalid and overlong dates and unsafe pages without querying', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async () => { assert.fail('Unexpected query'); });
    for (const [from, to] of [[undefined, undefined], ['', ''], [null, null], [[], {}],
        ['0000-01-01', '2026-01-01'], ['2026-02-30', '2026-03-01'],
        ['2026-11-02', '2026-11-01'], ['2026-01-01', '2026-03-04'],
        ['2026-10', '2026-10-31'], ["2026-10-01';--", '2026-10-31']]) {
        assert.equal(AuditLog.isValidRange(from, to), false);
        await assert.rejects(AuditLog.search({ from, to }), RangeError);
        await assert.rejects(AuditLog.findActions(from, to), RangeError);
    }
    assert.equal(AuditLog.isValidRange('2026-01-01', '2026-03-03'), true);
    assert.equal(AuditLog.isValidRange('2026-11-01', '2026-11-01'), true);
    assert.equal(AuditLog.isValidRange('2024-02-29', '2024-03-01'), true);
    assert.equal(AuditLog.isValidRange('2026-02-29', '2026-03-01'), false);
    for (const page of [0, -1, 1.5, Infinity, NaN, '2', Number.MAX_SAFE_INTEGER]) {
        await assert.rejects(AuditLog.search({ from: '2026-10-01', to: '2026-10-31', page }), RangeError);
    }
    assert.equal(query.mock.callCount(), 0);
});

test('audit route waits for explicit dates and preserves selected range, filters and page', async t => {
    t.mock.method(AuditLog, 'currentMonth', () => '2026-11');
    const search = t.mock.method(AuditLog, 'search', async () => ({ entries: [], total: 0, pageSize: 50 }));
    const actions = t.mock.method(AuditLog, 'findActions', async () => []);
    t.mock.method(Profiles, 'findAll', async () => []);
    for (const query of [{}, { from: '', to: '' }, { profile: GUID, action: 'profile.update' },
        { from: '2026-10-01', to: '2026-10-31', profile: GUID, action: 'profile.update', page: '2' }]) {
        let data;
        await auditHandler({ query }, {
            render(view, values) { assert.equal(view, 'audit'); data = values; },
            sendStatus(status) { assert.fail(`Unexpected HTTP ${status}`); }
        });
        assert.equal(data.filters.from, query.from || '');
        assert.equal(data.filters.to, query.to || '');
        assert.equal(data.page, query.page ? 2 : 1);
        if (!query.from) {
            assert.equal(search.mock.callCount(), 0);
            assert.equal(actions.mock.callCount(), 0);
            assert.deepEqual(data.entries, []);
            assert.equal(data.total, 0);
            continue;
        }
        assert.deepEqual(search.mock.calls.at(-1).arguments, [{
            from: query.from, to: query.to, page: data.page, profileGuid: query.profile || null, action: query.action || null
        }]);
        assert.deepEqual(actions.mock.calls.at(-1).arguments, [query.from, query.to]);
    }
});

test('audit route returns explicit validation errors before any database work', async t => {
    for (const [model, method] of [[AuditLog, 'search'], [AuditLog, 'findActions'], [Profiles, 'findAll']]) {
        t.mock.method(model, method, async () => { assert.fail('Unexpected database work'); });
    }
    const invalidQueries = [
        ...['0000-01-01', '2026-13-01', '2026-02-30', ['2026-10-01'], {}].map(from => ({ from, to: '2026-10-31' })),
        { from: '2026-10-01' }, { to: '2026-10-31' },
        { from: '2026-01-01', to: '2026-03-04' },
        ...['', '0', '-1', '2abc', '1.5', 'Infinity', '9007199254740991', ['2'], {}].map(page => ({ from: '2026-10-01', to: '2026-10-31', page }))
    ];
    for (const query of invalidQueries) {
        let message;
        await auditHandler({ query }, {
            status(status) { assert.equal(status, 400); return this; },
            send(value) { message = value; }
        });
        assert.match(message, /Select (?:valid From and To dates|a valid audit page)/);
    }
});

test('audit database failures are logged and returned as HTTP 500', async t => {
    const error = new Error('Database unavailable');
    t.mock.method(AuditLog, 'search', async () => { throw error; });
    t.mock.method(AuditLog, 'findActions', async () => []);
    t.mock.method(Profiles, 'findAll', async () => []);
    const log = t.mock.method(console, 'error', () => {});
    let status;
    await auditHandler({ query: { from: '2026-10-01', to: '2026-10-31' } }, { sendStatus(value) { status = value; } });
    assert.equal(status, 500);
    assert.deepEqual(log.mock.calls[0].arguments, ['Unable to load audit:', error]);
});

test('audit view requires both dates and preserves all filters in pagination links', async () => {
    const ejs = require('ejs');
    const path = require('node:path');
    const values = {
        entries: [{ created_at: new Date('2026-10-10T12:00:00Z'), profile_name: 'Staff', profile_role: 'Administrator', action: 'profile.update' }],
        total: 101, pageSize: 50, page: 2, actions: ['profile.update'], profiles: [],
        filters: { from: '2026-10-01', to: '2026-10-31', profile: GUID, action: 'profile.update' },
        currentProfile: null, isAdmin: false, canSwitchRole: false, activePage: 'audit',
        moment: require('moment')
    };
    const html = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), values);
    assert.match(html, /name="from" type="date" value="2026-10-01" required/);
    assert.match(html, /name="to" type="date" value="2026-10-31" required/);
    assert.match(html, /Europe\/London/);
    assert.match(html, /101 matching this period/);
    assert.match(html, /Page 2 of 3/);
    for (const page of [1, 3]) {
        assert.ok(html.includes(`/admin/audit?from=2026-10-01&amp;to=2026-10-31&amp;profile=${GUID}&amp;action=profile.update&amp;page=${page}`));
    }
    const empty = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), { ...values, entries: [], total: 0 });
    assert.match(empty, /No activity found for this period and these filters/);
    assert.match(empty, /href="\/admin\/audit">Clear/);
    const initial = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), {
        ...values, entries: [], total: 0, filters: { from: '', to: '', profile: null, action: null }
    });
    assert.match(initial, /name="from" type="date" value="" required/);
    assert.match(initial, /Select From and To dates and apply the filter/);
    assert.doesNotMatch(initial, /<table|matching this period|No activity found|Audit pages/);
});

test('audit month boundaries and 50-row pages (PostgreSQL)', {
    skip: !process.env.CREDIT_TEST_DATABASE_URL
}, async t => {
    const databaseUrl = process.env.CREDIT_TEST_DATABASE_URL;
    assert.ok(new URL(databaseUrl).pathname.endsWith('_test'), 'Use a dedicated database whose name ends in _test');
    const db = new Pool({ connectionString: databaseUrl });
    const client = await db.connect();
    t.after(async () => {
        await client.query('ROLLBACK');
        client.release();
        await db.end();
    });
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE audit_log (
        guid uuid DEFAULT gen_random_uuid(), created_at timestamptz, profile_guid uuid,
        profile_name text, profile_role text, action text, entity_type text,
        entity_guid text, entity_label text, details jsonb
    ) ON COMMIT DROP`);
    t.mock.method(Pool.prototype, 'query', (sql, params) => client.query(sql, params));
    for (const [month, start, end] of [
        ['2026-03', '2026-03-01T00:00:00Z', '2026-03-31T23:00:00Z'],
        ['2026-10', '2026-09-30T23:00:00Z', '2026-11-01T00:00:00Z'],
        ['2024-02', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z']
    ]) {
        await client.query('TRUNCATE audit_log');
        await client.query(`INSERT INTO audit_log (created_at, profile_guid, action)
            SELECT $1::timestamptz + n * INTERVAL '1 hour', $2, 'inside'
            FROM generate_series(0, 54) AS n`, [start, GUID]);
        await client.query(`INSERT INTO audit_log (created_at, profile_guid, action) VALUES
            ($1::timestamptz - INTERVAL '1 microsecond', $3, 'before'),
            ($2::timestamptz - INTERVAL '1 microsecond', $3, 'last'),
            ($2::timestamptz, $3, 'after')`, [start, end, GUID]);
        const from = month + '-01';
        const to = month + (month === '2024-02' ? '-29' : '-31');
        const first = await AuditLog.search({ from, to });
        const second = await AuditLog.search({ from, to, page: 2 });
        assert.equal(first.entries.length, 50);
        assert.equal(second.entries.length, 6);
        assert.equal(first.total, 56);
        assert.equal(second.total, 56);
        assert.equal(new Set([...first.entries, ...second.entries].map(row => row.guid)).size, 56);
        assert.deepEqual(await AuditLog.findActions(from, to), ['inside', 'last']);
        assert.equal((await AuditLog.search({ from, to, profileGuid: GUID, action: 'last' })).total, 1);
        assert.equal((await AuditLog.search({ from, to, action: 'after' })).total, 0);
    }
});

test('audit startup purge runs once without scheduling an interval', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rowCount: 2 }));
    const log = t.mock.method(console, 'log', () => {});
    t.mock.method(global, 'setInterval', () => assert.fail('Must not schedule audit cleanup'));
    await AuditLog.purgeOnStartup();
    assert.equal(query.mock.callCount(), 1);
    assert.equal(log.mock.callCount(), 1);
    assert.match(query.mock.calls[0].arguments[0], /DELETE FROM audit_log WHERE created_at < now\(\) - INTERVAL '2 months'/);
});

test('audit purge logs database failures without rejecting', async t => {
    const error = new Error('Database unavailable');
    t.mock.method(Pool.prototype, 'query', async () => { throw error; });
    const log = t.mock.method(console, 'error', () => {});
    t.mock.method(global, 'setInterval', () => assert.fail('Must not schedule audit cleanup'));
    await assert.doesNotReject(AuditLog.purgeOnStartup());
    assert.deepEqual(log.mock.calls[0].arguments, ['Audit purge failed:', error]);
    assert.equal(log.mock.callCount(), 1);
});
