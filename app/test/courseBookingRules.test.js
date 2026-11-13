const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const ejs = require('ejs');
const path = require('node:path');
const Settings = require('../models/Settings');
const CourseOrders = require('../models/CourseOrders');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');
const { adminPermissions } = require('../permissions');
const { actionLabel } = require('../auditEvents');

const owner = '123e4567-e89b-42d3-a456-426614174000';
const keys = ['course_prevent_duplicate_class', 'course_prevent_multiple_classes'];

test('course booking rules default enabled, validate values and initialize without overwriting saved choices', async t => {
    assert.deepEqual(Settings.courseBookingRules({}), { preventDuplicateClass: true, preventMultipleClasses: true });
    assert.deepEqual(Settings.courseBookingRules(Object.fromEntries(keys.map(key => [key, '0']))),
        { preventDuplicateClass: false, preventMultipleClasses: false });
    for (const key of keys) {
        for (const value of ['yes', '', 1, ['1']]) {
            assert.throws(() => Settings.courseBookingRules({ [key]: value }), /Invalid configured/);
        }
    }
    const query = t.mock.method(Pool.prototype, 'query', async () => ({ rows: [] }));
    await Settings.initialize();
    assert.ok(query.mock.calls.some(call => call.arguments[0].includes("('course_prevent_duplicate_class', '1')") &&
        call.arguments[0].includes("('course_prevent_multiple_classes', '1')") &&
        call.arguments[0].includes('ON CONFLICT (key) DO NOTHING')));
    await CourseOrders.initialize();
    assert.ok(query.mock.calls.some(call => call.arguments[0].includes('DROP INDEX IF EXISTS course_enrolment_attendee_idx')));
});

test('booking transactions lock persisted rules and reject missing or corrupt settings', async () => {
    let rows = keys.map(key => ({ key, value: '1' }));
    const client = { async query(sql, values) {
        assert.match(sql, /ORDER BY key FOR SHARE/);
        assert.deepEqual(values, [keys]);
        return { rows };
    } };
    assert.equal((await Settings.getCourseBookingRules(client)).preventMultipleClasses, true);
    rows[0].value = 'bad';
    await assert.rejects(Settings.getCourseBookingRules(client), /Invalid configured/);
    rows = [];
    await assert.rejects(Settings.getCourseBookingRules(client), /not been initialized/);
});

test('administrators save and audit each rule independently; invalid values and failures are explicit', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const save = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(console, 'error', () => {});
    for (const [index, suffix] of ['duplicate-class', 'multiple-classes'].entries()) {
        const endpoint = `/settings/course-booking-rules/${suffix}`;
        assert.deepEqual(adminPermissions(endpoint), []);
        const handler = admin.stack.find(layer => layer.route?.path === endpoint).route.stack[0].handle;
        const res = { status(code) { this.code = code; return this; }, send() {},
            sendStatus(code) { this.code = code; }, redirect(url) { this.url = url; } };
        const before = save.mock.callCount();
        for (const enabled of [undefined, 'yes', ['1'], '']) {
            await handler({ body: { enabled } }, res);
            assert.equal(res.code, 400);
        }
        assert.equal(save.mock.callCount(), before);
        for (const enabled of ['0', '1']) {
            await handler({ profile: { guid: owner }, body: { enabled } }, res);
            assert.deepEqual(save.mock.calls.at(-1).arguments, [keys[index], enabled]);
            assert.equal(audit.mock.calls.at(-1).arguments[1].action, `settings.${keys[index]}`);
            assert.deepEqual(audit.mock.calls.at(-1).arguments[1].details, { enabled: enabled === '1' });
            assert.equal(res.url, '/admin/settings?saved=1');
        }
        assert.notEqual(actionLabel(`settings.${keys[index]}`), `settings.${keys[index]}`);
        save.mock.mockImplementation(async () => { throw new Error('Write failed'); });
        res.url = null;
        await handler({ body: { enabled: '1' } }, res);
        assert.equal(res.code, 500);
        assert.equal(res.url, null);
        save.mock.mockImplementation(async () => {});
    }
});

test('settings page displays separately saved booking rules and their full-history scope', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/settings' && layer.route.methods.get).route.stack[0].handle;
    t.mock.method(Settings, 'getAll', async () => ({ ...Settings.DEFAULTS, course_prevent_multiple_classes: '0' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Settings, 'getCreditRequestDays', async () => 30);
    t.mock.method(Settings, 'getBookingSearchDays', async () => 30);
    let locals;
    await handler({ query: {} }, { render(_view, values) { locals = values; }, sendStatus: assert.fail });
    assert.deepEqual(locals.courseBookingRules, { preventDuplicateClass: true, preventMultipleClasses: false });
    const html = await ejs.renderFile(path.join(__dirname, '../views/settings.ejs'), {
        ...locals, currentProfile: null, isAdmin: false, canSwitchRole: false
    });
    assert.match(html, /All past and future course bookings count/);
    assert.match(html, /id="course-rule-duplicate-class"[\s\S]*?<option value="1" selected/);
    assert.match(html, /id="course-rule-multiple-classes"[\s\S]*?<option value="0" selected/);
    assert.equal((html.match(/action="\/admin\/settings\/course-booking-rules\//g) || []).length, 2);
});
