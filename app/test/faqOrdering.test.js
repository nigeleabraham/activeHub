const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Courses = require('../models/Courses');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');
const guid = '123e4567-e89b-42d3-a456-426614174000';
const second = '123e4567-e89b-42d3-a456-426614174001';

test('FAQ ordering persists only the selected sport order under a lock and preserves IDs', async t => {
    let rows = [{ guid }, { guid: second }];
    const calls = [];
    let releases = 0;
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, params) {
            calls.push([sql, params]);
            if (sql.includes('FROM sports')) return { rows: [{ guid }] };
            if (sql.includes('FROM sport_course_faqs')) return { rows: structuredClone(rows) };
            return { rows: [] };
        },
        release() { releases++; }
    }));
    assert.deepEqual(await Courses.moveFaq(guid, second, 'up'), { guid: second });
    const writes = calls.filter(([sql]) => sql.startsWith('UPDATE'));
    assert.deepEqual(writes.map(([, params]) => params), [[second, 0], [guid, 1]]);
    assert.match(calls[1][0], /FOR UPDATE/);
    assert.match(calls[2][0], /WHERE sport_guid=\$1 ORDER BY sort_order NULLS LAST, created_at, guid FOR UPDATE/);
    assert.equal(calls.at(-1)[0], 'COMMIT');
    rows = [];
    assert.equal(await Courses.moveFaq(guid, second, 'down'), null);
    assert.equal(calls.at(-1)[0], 'ROLLBACK');
    assert.equal(releases, 2);
    await assert.rejects(Courses.moveFaq(guid, second, 'invalid'), RangeError);
});

test('FAQ ordering rolls back database errors and releases the client', async t => {
    let released = false;
    const calls = [];
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql) {
            calls.push(sql);
            if (sql.includes('FROM sports')) return { rows: [{ guid }] };
            if (sql.includes('FROM sport_course_faqs')) return { rows: [{ guid }, { guid: second }] };
            if (sql.startsWith('UPDATE')) throw new Error('Database failed');
            return { rows: [] };
        },
        release() { released = true; }
    }));
    await assert.rejects(Courses.moveFaq(guid, guid, 'down'), /Database failed/);
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.equal(released, true);
});

test('FAQ reads retain legacy chronology until reordered and append new unordered FAQs last', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [] }));
    await Courses.findFaqs();
    assert.match(query.mock.calls[0].arguments[0], /ORDER BY sort_order NULLS LAST, created_at, guid/);
});

test('FAQ reorder rejects invalid directions and missing records and reports database errors', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/courses/faqs/move').route.stack[0].handle;
    const move = t.mock.method(Courses, 'moveFaq', async () => ({ guid }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(console, 'error', () => {});
    let status;
    let location;
    const res = { sendStatus(value) { status = value; }, redirect(value) { location = value; } };
    const body = { guid, sport_guid: guid, direction: 'down' };
    await handler({ body, profile: { guid } }, res);
    assert.equal(location, `/admin/sports?admin_saved=1#sport-faq-${guid}`);
    assert.equal(audit.mock.callCount(), 1);
    for (const invalid of [{ direction: 'invalid' }, { guid: 'bad' }, { sport_guid: '' }]) {
        await handler({ body: { ...body, ...invalid } }, res);
        assert.equal(status, 400);
    }
    assert.equal(move.mock.callCount(), 1);
    move.mock.mockImplementation(async () => null);
    await handler({ body }, res);
    assert.equal(status, 404);
    move.mock.mockImplementation(async () => { throw new Error('Database failed'); });
    await handler({ body }, res);
    assert.equal(status, 500);
    assert.equal(audit.mock.callCount(), 1);
});
