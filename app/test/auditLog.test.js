const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const AuditLog = require('../models/AuditLog');
const Profiles = require('../models/Profiles');
const auditEvents = require('../auditEvents');
const router = require('../routes/front');

const admin = router.stack.find(layer => layer.handle.stack).handle;
const auditHandler = admin.stack.find(layer => layer.route?.path === '/audit').route.stack[0].handle;
const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('audit month defaults follow London time at month boundaries', () => {
    assert.equal(AuditLog.currentMonth(new Date('2026-10-31T23:30:00Z')), '2026-10');
    assert.equal(AuditLog.currentMonth(new Date('2026-06-30T23:30:00Z')), '2026-07');
    assert.equal(AuditLog.currentMonth(new Date('2026-01-01T00:00:00Z')), '2026-01');
});

test('audit entry and count queries use the same inclusive London date range', async t => {
    const entries = [{ guid: GUID }];
    const query = t.mock.method(Pool.prototype, 'query', async sql => {
        if (sql.includes('COUNT(*)')) return { rows: [{ count: 51 }] };
        return { rows: entries };
    });
    assert.deepEqual(await AuditLog.search({ from: '2026-10-01', to: '2026-10-31', profileGuid: GUID, action: 'profile.update', page: 2 }), {
        entries, total: 51, pageSize: 50
    });
    assert.equal(query.mock.callCount(), 2);
    for (const call of query.mock.calls) {
        const [sql, params] = call.arguments;
        assert.match(sql, /created_at >= \(\$1::date\)::timestamp AT TIME ZONE 'Europe\/London'/);
        assert.match(sql, /created_at < \(\$2::date \+ 1\)::timestamp AT TIME ZONE 'Europe\/London'/);
        assert.equal(params[0], '2026-10-01');
    }
    assert.match(query.mock.calls[0].arguments[0], /LIMIT 50 OFFSET \$5/);
    assert.deepEqual(query.mock.calls[0].arguments[1], ['2026-10-01', '2026-10-31', GUID, 'profile.update', 50]);
    assert.deepEqual(query.mock.calls[1].arguments[1], ['2026-10-01', '2026-10-31', GUID, 'profile.update']);
});

test('audit action catalogue uses indexed next-value lookups independently of dates', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [{ action: 'legacy.event' }, { action: 'profile.update' }] }));
    assert.deepEqual(await AuditLog.findActions(), ['legacy.event', 'profile.update']);
    const [sql] = query.mock.calls[0].arguments;
    assert.match(sql, /WITH RECURSIVE actions/);
    assert.match(sql, /WHERE action > actions\.action ORDER BY action LIMIT 1/);
    assert.equal(query.mock.calls[0].arguments.length, 1);
});

test('audit sorts are validated and applied before pagination', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async sql => {
        if (sql.includes('WITH RECURSIVE')) return { rows: [{ action: 'auth.login' }, { action: 'booking.create' }] };
        if (sql.includes('COUNT(*)')) return { rows: [{ count: 100 }] };
        return { rows: [] };
    });
    for (const [sort, column] of [
        ['time', 'created_at'], ['profile', 'lower(profile_name)'], ['event', 'array_position($6::text[], action)'],
        ['item', "lower(COALESCE(NULLIF(entity_label, ''), entity_type))"], ['details', 'details::text']
    ]) {
        for (const direction of ['asc', 'desc']) {
            await AuditLog.search({ from: '2026-01-01', to: '2026-03-03', sort, direction, page: 2 });
            const call = query.mock.calls.findLast(c => c.arguments[0].includes('LIMIT 50 OFFSET $5'));
            assert.ok(call.arguments[0].includes(`ORDER BY ${column} ${direction.toUpperCase()} NULLS LAST, guid ASC LIMIT 50 OFFSET $5`));
            assert.equal(call.arguments[1][4], 50);
            if (sort === 'event') assert.deepEqual(call.arguments[1][5], ['booking.create', 'auth.login']);
        }
    }
    for (const [sort, direction] of [['time; DROP TABLE audit_log', 'asc'], ['constructor', 'asc'], ['time', 'DESC'], [[], 'asc']]) {
        await assert.rejects(AuditLog.search({ from: '2026-01-01', to: '2026-03-03', sort, direction }), RangeError);
    }
});

test('audit event labels cover current and historic codes', () => {
    assert.ok(auditEvents.currentActions.includes('sport-section.destroy'));
    assert.equal(auditEvents.actionLabel('sport-section.destroy'), 'Sport section deleted');
    assert.equal(auditEvents.actionLabel('booking.create'), 'Booking created');
    assert.equal(auditEvents.actionLabel('legacy.unknown_event'), 'Legacy unknown event');
    assert.equal(auditEvents.actionLabel('legacy.create.extra'), 'Legacy create extra');
});

test('audit model rejects missing, invalid and overlong dates and unsafe pages without querying', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async () => { assert.fail('Unexpected query'); });
    for (const [from, to] of [[undefined, undefined], ['', ''], [null, null], [[], {}],
        ['0000-01-01', '2026-01-01'], ['2026-02-30', '2026-03-01'],
        ['2026-11-02', '2026-11-01'], ['2026-01-01', '2026-03-04'],
        ['2026-10', '2026-10-31'], ["2026-10-01';--", '2026-10-31']]) {
        assert.equal(AuditLog.isValidRange(from, to), false);
        await assert.rejects(AuditLog.search({ from, to }), RangeError);
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
    const actions = t.mock.method(AuditLog, 'findActions', async () => ['legacy.event']);
    t.mock.method(Profiles, 'findAll', async () => []);
    for (const query of [{}, { from: '', to: '' }, { profile: GUID, action: 'profile.update' },
        { from: '2026-10-01', to: '2026-10-31', profile: GUID, action: 'profile.update', page: '2',
            sort: 'profile', direction: 'asc' }]) {
        let data;
        await auditHandler({ query }, {
            render(view, values) { assert.equal(view, 'audit'); data = values; },
            sendStatus(status) { assert.fail(`Unexpected HTTP ${status}`); }
        });
        assert.equal(data.filters.from, query.from || '');
        assert.equal(data.filters.to, query.to || '');
        assert.equal(data.maxRangeDays, AuditLog.MAX_RANGE_DAYS);
        assert.ok(data.actions.includes('legacy.event'));
        assert.ok(data.actions.includes('booking.create'));
        assert.equal(data.page, query.page ? 2 : 1);
        if (!query.from) {
            assert.equal(search.mock.callCount(), 0);
            assert.deepEqual(actions.mock.calls.at(-1).arguments, []);
            assert.deepEqual(data.entries, []);
            assert.equal(data.total, 0);
            continue;
        }
        assert.deepEqual(search.mock.calls.at(-1).arguments, [{
            from: query.from, to: query.to, page: data.page, profileGuid: query.profile || null, action: query.action || null,
            sort: query.sort || 'time', direction: query.direction || 'desc'
        }]);
        assert.deepEqual(actions.mock.calls.at(-1).arguments, []);
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
        ...[{ sort: 'created_at' }, { sort: ['time'] }, { sort: 'constructor' }, { direction: 'DESC' }, { direction: ['asc'] }]
            .map(order => ({ from: '2026-10-01', to: '2026-10-31', ...order })),
        ...['', '0', '-1', '2abc', '1.5', 'Infinity', '9007199254740991', ['2'], {}].map(page => ({ from: '2026-10-01', to: '2026-10-31', page }))
    ];
    for (const query of invalidQueries) {
        let message;
        await auditHandler({ query }, {
            status(status) { assert.equal(status, 400); return this; },
            send(value) { message = value; }
        });
        assert.match(message, /Select (?:valid From and To dates|a valid audit page|a valid audit sort order)/);
    }
});

test('audit filter changes reset sorting while unchanged filters retain it', async t => {
    for (const [model, method] of [[AuditLog, 'search'], [AuditLog, 'findActions'], [Profiles, 'findAll']]) {
        t.mock.method(model, method, async () => { assert.fail('Unexpected database work before redirect'); });
    }
    const base = { filter_submit: '1', from: '2026-10-01', to: '2026-10-31', profile: GUID,
        action: 'profile.update', previous_from: '2026-10-01', previous_to: '2026-10-31',
        previous_profile: GUID, previous_action: 'profile.update', sort: 'profile', direction: 'asc' };
    for (const [changes, expected] of [
        [{}, 'profile'], [{ from: '2026-10-02' }, 'time'], [{ to: '2026-10-30' }, 'time'],
        [{ profile: '' }, 'time'], [{ action: '' }, 'time']
    ]) {
        let destination;
        await auditHandler({ query: { ...base, ...changes } }, { redirect(url) { destination = url; } });
        const url = new URL(destination, 'http://localhost');
        assert.equal(url.searchParams.get('sort'), expected);
        assert.equal(url.searchParams.get('direction'), expected === 'time' ? 'desc' : 'asc');
        assert.equal(url.searchParams.get('filter_submit'), null);
        assert.equal(url.searchParams.get('page'), null);
        assert.equal(url.hash, '#audit-list-heading');
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
        entries: [{ created_at: new Date('2026-10-10T12:00:00Z'), profile_name: 'Staff', profile_role: 'Administrator',
            action: 'profile.update', details: { old_value: '<script>', roles: ['Resident'] } }],
        total: 101, pageSize: 50, page: 2, sort: 'time', direction: 'desc', maxRangeDays: AuditLog.MAX_RANGE_DAYS, actions: ['profile.update'], profiles: [], auditEvents,
        filters: { from: '2026-10-01', to: '2026-10-31', profile: GUID, action: 'profile.update' },
        currentProfile: null, isAdmin: false, canSwitchRole: false, activePage: 'audit',
        moment: require('moment')
    };
    const html = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), values);
    assert.match(html, /name="from" type="date" value="2026-10-01" required/);
    assert.match(html, /name="to" type="date" value="2026-10-31" required/);
    assert.match(html, /Europe\/London/);
    assert.match(html, /Profile updated/);
    assert.match(html, /<code class="small">profile\.update<\/code>/);
    assert.match(html, /<dt>old value<\/dt>\s*<dd>&lt;script&gt;<\/dd>/);
    assert.match(html, /<dt>roles<\/dt>\s*<dd>\[&#34;Resident&#34;\]<\/dd>/);
    assert.match(html, /Showing 1 Oct 2026 to 31 Oct 2026/);
    assert.match(html, /101 matching this period/);
    assert.match(html, /action="\/admin\/audit#audit-list-heading"/);
    assert.match(html, /id="audit-list-heading"[^>]*tabindex="-1" aria-describedby="audit-results-summary">Audit results/);
    assert.match(html, /id="audit-results-summary"[^>]*>101 matching entries\./);
    assert.match(html, /href="#audit-filter-heading">Change filters/);
    assert.match(html, /Page 2 of 3/);
    for (const page of [1, 3]) {
        assert.ok(html.includes(`/admin/audit?from=2026-10-01&amp;to=2026-10-31&amp;profile=${GUID}&amp;action=profile.update&amp;sort=time&amp;direction=desc&amp;page=${page}#audit-list-heading`));
    }
    assert.match(html, /aria-sort="descending"/);
    assert.match(html, /sort=profile&amp;direction=asc#audit-list-heading/);
    assert.match(html, /sort=time&amp;direction=asc#audit-list-heading/);
    assert.match(html, /name="sort" value="time"/);
    assert.match(html, /id="audit-sort" name="sort"/);
    const empty = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), { ...values, entries: [], total: 0 });
    assert.match(empty, /No activity found for this period and these filters/);
    assert.match(empty, /0 matching entries\./);
    assert.match(empty, /href="\/admin\/audit">Clear/);
    assert.match(empty, /href="\/admin\/audit">Clear<\/a>\s*<button[^>]*type="submit">Apply<\/button>/);
    const initial = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), {
        ...values, entries: [], total: 0, filters: { from: '', to: '', profile: null, action: null }
    });
    assert.match(initial, /name="from" type="date" value="" required/);
    assert.match(initial, /<div class="form-group col-md" id="audit-to-group">/);
    assert.match(initial, /name="to" type="date" value="" required/);
    assert.match(initial, /Maximum search range: <strong>62 calendar days<\/strong>, including both dates/);
    assert.match(initial, /required aria-describedby="audit-range-help audit-to-help"/);
    assert.doesNotMatch(initial, /id="audit-to"[^>]*disabled/);
    assert.match(initial, /Choose a date range and optional filters, then select Apply/);
    assert.match(initial, /value="profile.update">Profile updated \(profile.update\)/);
    assert.doesNotMatch(initial, /<table|matching this period|No activity found|Audit pages/);
});

test('audit date controls default to the inclusive maximum and preserve a searched range', async () => {
    const ejs = require('ejs');
    const path = require('node:path');
    const vm = require('node:vm');
    const html = await ejs.renderFile(path.join(__dirname, '../views/audit.ejs'), {
        entries: [], total: 0, pageSize: 50, page: 1, sort: 'time', direction: 'desc', maxRangeDays: AuditLog.MAX_RANGE_DAYS,
        actions: [], profiles: [], auditEvents, filters: { from: '', to: '', profile: null, action: null },
        currentProfile: null, isAdmin: false, canSwitchRole: false, activePage: 'audit', moment: require('moment')
    });
    const script = html.slice(html.indexOf("        const auditFrom ="), html.indexOf("        document.querySelectorAll('[data-local-booking-time]')"));
    function setup(fromValue, toValue) {
        let change;
        const from = {
            value: fromValue,
            get valueAsDate() { return this.value ? new Date(`${this.value}T00:00:00.000Z`) : null; },
            addEventListener(event, handler) { assert.equal(event, 'change'); change = handler; }
        };
        const to = { value: toValue, disabled: false, removeAttribute(name) { this[name] = ''; } };
        const help = { textContent: '' };
        vm.runInNewContext(script, { document: { getElementById(id) {
            return { 'audit-from': from, 'audit-to': to, 'audit-to-help': help }[id];
        } }, Date });
        return { from, to, help, change: () => change() };
    }
    const empty = setup('', '');
    assert.equal(empty.to.disabled, true);
    assert.match(empty.help.textContent, /Select From first/);
    for (const [from, max] of [
        ['2026-01-01', '2026-03-03'], ['2024-02-29', '2024-04-30'],
        ['2026-10-25', '2026-12-25'], ['9999-12-01', '9999-12-31']
    ]) {
        empty.from.value = from;
        empty.change();
        assert.equal(empty.to.disabled, false);
        assert.equal(empty.to.min, from);
        assert.equal(empty.to.max, max);
        assert.equal(empty.to.value, max);
        assert.equal(AuditLog.isValidRange(from, max), true);
    }
    empty.from.value = '';
    empty.change();
    assert.equal(empty.to.disabled, true);
    assert.equal(empty.to.value, '');
    assert.match(empty.help.textContent, /Select From first/);
    const searched = setup('2026-01-01', '2026-01-15');
    assert.equal(searched.to.value, '2026-01-15');
    assert.equal(searched.to.max, '2026-03-03');
    assert.match(searched.help.textContent, /Latest To date: 3 March 2026, based on the maximum search range of 62 calendar days\./);
    searched.from.value = '2026-02-01';
    searched.change();
    assert.equal(searched.to.value, '2026-04-03');
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
        assert.deepEqual(await AuditLog.findActions(), ['after', 'before', 'inside', 'last']);
        assert.equal((await AuditLog.search({ from, to, profileGuid: GUID, action: 'last' })).total, 1);
        assert.equal((await AuditLog.search({ from, to, action: 'after' })).total, 0);
    }
    await client.query('TRUNCATE audit_log');
    await client.query(`INSERT INTO audit_log (created_at, profile_name, action, entity_type, entity_label, details)
        SELECT '2026-01-01T12:00:00Z'::timestamptz + n * INTERVAL '1 minute',
            'Profile ' || lpad((120 - n)::text, 3, '0'),
            CASE WHEN n % 2 = 0 THEN 'auth.login' ELSE 'booking.create' END,
            'resource', 'Item ' || lpad((120 - n)::text, 3, '0'),
            jsonb_build_object('value', lpad((120 - n)::text, 3, '0'))
        FROM generate_series(1, 120) AS n`);
    const key = {
        time: row => row.created_at.toISOString(),
        profile: row => row.profile_name,
        event: row => auditEvents.actionLabel(row.action),
        item: row => row.entity_label,
        details: row => row.details.value
    };
    for (const sort of Object.keys(key)) {
        for (const direction of ['asc', 'desc']) {
            const pages = await Promise.all([1, 2, 3].map(page => AuditLog.search({
                from: '2026-01-01', to: '2026-01-01', sort, direction, page
            })));
            const rows = pages.flatMap(result => result.entries);
            assert.deepEqual(pages.map(result => result.entries.length), [50, 50, 20]);
            assert.equal(new Set(rows.map(row => row.guid)).size, 120);
            const values = rows.map(key[sort]);
            const expected = [...values].sort();
            if (direction === 'desc') expected.reverse();
            assert.deepEqual(values, expected, `${sort} ${direction}`);
        }
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
