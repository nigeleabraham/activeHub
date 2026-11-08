const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const ejs = require('ejs');
const path = require('node:path');
const Courses = require('../models/Courses');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');
const { adminPermissions } = require('../permissions');

const sport = '123e4567-e89b-42d3-a456-426614174000';
const first = '123e4567-e89b-42d3-a456-426614174001';

test('FAQ text merges existing rows under a sport lock, retains the first ID and supports clearing', async t => {
    const queries = [];
    let existing = [{ guid: first }, { guid: sport }];
    let found = true;
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, values) {
            queries.push({ sql, values });
            if (sql.includes('SELECT guid FROM sports')) return { rows: found ? [{ guid: sport }] : [] };
            if (sql.includes('SELECT guid FROM sport_course_faqs')) return { rows: existing };
            return { rows: [] };
        },
        release() { queries.push({ sql: 'release' }); }
    }));
    await Courses.saveFaqText(sport, ' <bold>Question</bold>\nAnswer ');
    assert.match(queries[1].sql, /FOR UPDATE/);
    assert.match(queries[2].sql, /ORDER BY sort_order NULLS LAST, created_at, guid FOR UPDATE/);
    assert.deepEqual(queries.find(query => query.sql.startsWith('UPDATE')).values, [first, '<bold>Question</bold>\nAnswer']);
    assert.deepEqual(queries.find(query => query.sql.startsWith('DELETE')).values, [sport, first]);
    assert.deepEqual(queries.slice(-2).map(query => query.sql), ['COMMIT', 'release']);
    queries.length = 0;
    await Courses.saveFaqText(sport, '');
    assert.deepEqual(queries.find(query => query.sql.startsWith('DELETE')).values, [sport]);
    existing = [];
    queries.length = 0;
    await Courses.saveFaqText(sport, 'New block');
    assert.deepEqual(queries.find(query => query.sql.startsWith('INSERT')).values, [sport, 'New block']);
    found = false;
    assert.equal(await Courses.saveFaqText(sport, 'Missing'), null);
    assert.deepEqual(queries.slice(-2).map(query => query.sql), ['ROLLBACK', 'release']);
});

test('FAQ text failures roll back without deleting other records', async t => {
    const queries = [];
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql) {
            queries.push(sql);
            if (sql.includes('FROM sports')) return { rows: [{ guid: sport }] };
            if (sql.includes('FROM sport_course_faqs')) return { rows: [{ guid: first }] };
            if (sql.startsWith('UPDATE')) throw new Error('Write failed');
            return { rows: [] };
        },
        release() { queries.push('release'); }
    }));
    await assert.rejects(Courses.saveFaqText(sport, 'Text'), /Write failed/);
    assert.equal(queries.some(sql => sql.startsWith('DELETE')), false);
    assert.deepEqual(queries.slice(-2), ['ROLLBACK', 'release']);
    await assert.rejects(Courses.saveFaqText(sport, 'x'.repeat(1020001)), RangeError);
});

test('FAQ text route validates, audits, returns to the sport and reports failures', async t => {
    assert.deepEqual(adminPermissions('/courses/faqs/save'), []);
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/courses/faqs/save').route.stack[0].handle;
    const save = t.mock.method(Courses, 'saveFaqText', async () => ({ sport_guid: sport }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    let location;
    let status;
    const res = { redirect(value) { location = value; }, sendStatus(value) { status = value; } };
    const req = { profile: { guid: first }, body: { sport_guid: sport, faq_text: '<bold>Question</bold>\nAnswer' } };
    await handler(req, res);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(audit.mock.callCount(), 1);
    assert.match(location, /admin_saved=sport-updated/);
    for (const body of [{ sport_guid: 'invalid', faq_text: 'Text' }, { sport_guid: sport }, { sport_guid: sport, faq_text: 'x'.repeat(1020001) }]) {
        await handler({ ...req, body }, res);
        assert.equal(location, '/admin/sports?error=invalid-faq');
    }
    assert.equal(save.mock.callCount(), 1);
    save.mock.mockImplementation(async () => null);
    await handler(req, res);
    assert.equal(status, 404);
    save.mock.mockImplementation(async () => { throw new Error('Database failed'); });
    await handler(req, res);
    assert.equal(status, 500);
});

test('customer FAQ block formats questions and answers safely without separate cards', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/sport-faq-content.ejs'), {
        faqs: [{ question: 'First question?', answer: '<bold>Bold</bold> <ul>Underline</ul>' },
            { question: 'Second question?', answer: '<bullet>Item</bullet><email>a@example.com</email><script>unsafe</script>' }]
    });
    assert.match(html, /<strong>First question\?<\/strong>/);
    assert.match(html, /<strong>Bold<\/strong> <u>Underline<\/u>/);
    assert.match(html, /<li>Item<\/li>/);
    assert.match(html, /href="mailto:a%40example.com"/);
    assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.ok(html.indexOf('First question') < html.indexOf('Second question'));
    assert.doesNotMatch(html, /<dl|<dt|data-faq-card/);
    const merged = await ejs.renderFile(path.join(__dirname, '../views/partials/sport-faq-content.ejs'), {
        faqs: [{ question: '', answer: '<bold>Merged question</bold>\nAnswer' }]
    });
    assert.match(merged, /<strong>Merged question<\/strong>/);
    assert.doesNotMatch(merged, /<strong><\/strong>/);
});
