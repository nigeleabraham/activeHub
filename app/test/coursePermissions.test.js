const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const router = require('../routes/front');
const Courses = require('../models/Courses');
const Facilities = require('../models/Facilities');
const Settings = require('../models/Settings');
const AuditLog = require('../models/AuditLog');
const auth = require('../middleware/auth');
const Sports = require('../models/Sports');

const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('course permission grants all course actions without opening unrelated admin routes', async t => {
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Facilities, 'findAll', async () => [{ guid: GUID, name: 'Hall' }]);
    t.mock.method(Courses, 'findAll', async () => []);
    t.mock.method(Courses, 'findFaqs', async () => []);
    t.mock.method(Sports, 'findAll', async () => [{ guid: GUID, name: 'Tennis' }]);
    const create = t.mock.method(Courses, 'create', async () => ({ guid: GUID }));
    const update = t.mock.method(Courses, 'update', async () => ({ guid: GUID, facility_guid: GUID }));
    const remove = t.mock.method(Courses, 'remove', async () => ({ facility_guid: GUID }));
    const saveFaq = t.mock.method(Courses, 'saveFaq', async () => ({ guid: GUID }));
    const removeFaq = t.mock.method(Courses, 'removeFaq', async () => true);
    const saveRun = t.mock.method(Courses, 'saveRun', async () => ({ guid: GUID }));
    t.mock.method(Courses, 'removeRun', async () => ({ guid: GUID }));
    t.mock.method(AuditLog, 'record', async () => {});
    const app = express();
    app.set('views', path.join(__dirname, '../views'));
    app.set('view engine', 'ejs');
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        const role = req.get('test-role');
        req.profile = role ? { guid: GUID, name: 'Test', role,
            permissions: req.get('test-permission') === 'yes' ? ['courses.manage'] : [] } : null;
        Object.assign(res.locals, { currentProfile: req.profile, isAdmin: role === 'Administrator', canSwitchRole: false,
            canAccessAdmin: path => auth.canAccessAdmin(req.profile, path) });
        next();
    });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (url, role, permission, body) => fetch(base + url, {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { ...(role ? { 'test-role': role } : {}), 'test-permission': permission ? 'yes' : 'no',
            'content-type': 'application/x-www-form-urlencoded' },
        ...(body ? { body: new URLSearchParams(body) } : {})
    });
    const body = { guid: GUID, facility_guid: GUID, sport_guids: GUID, name: 'Tennis', description: '', start_date: '2026-10-01', end_date: '2026-12-01' };
    for (const role of ['Coach', 'Resident', 'Custom role', 'Administrator']) {
        const page = await call('/admin/courses', role, role !== 'Administrator');
        assert.equal(page.status, 200);
        const html = await page.text();
        assert.match(html, /data-admin-editors|admin-editor/);
        assert.match(html, /href="\/admin\/courses"/);
        if (role !== 'Administrator') {
            assert.doesNotMatch(html, /href="\/admin\/(?:profiles|roles|settings|facilities)"/);
            const home = await (await call('/', role, true)).text();
            assert.match(home, />Administration</);
            assert.doesNotMatch(home, /href="\/admin\/courses"/);
        }
        for (const action of ['/courses', '/courses/update', '/courses/destroy', '/facilities/courses/destroy']) {
            const response = await call('/admin' + action, role, role !== 'Administrator', body);
            assert.equal(response.status, 302);
            if (role !== 'Administrator') assert.match(response.headers.get('location'), /^\/admin\/courses/);
        }
    }
    assert.equal(create.mock.callCount(), 4);
    assert.equal(update.mock.callCount(), 4);
    assert.equal(remove.mock.callCount(), 8);
    const runBody = { guid: GUID, course_guid: GUID, facility_guid: GUID, name: 'Tuesday',
        price: '100.00', capacity: '12', schedule_mode: 'weekly', start_date: '2027-01-01',
        end_date: '2027-02-01', weekday: '2', start_time: '18:00', end_time: '19:00' };
    for (const route of ['/courses/runs', '/courses/runs/update', '/courses/runs/destroy']) {
        assert.equal((await call('/admin' + route, 'Coach', true, runBody)).status, 302);
        assert.equal((await call('/admin' + route, 'Resident', false, runBody)).status, 403);
        assert.equal((await call('/admin' + route, null, false, runBody)).status, 401);
    }
    assert.equal(saveRun.mock.callCount(), 2);
    const invalid = await call('/admin/courses/runs', 'Coach', true, { ...runBody, capacity: '0' });
    assert.equal(invalid.status, 422);
    assert.match((await invalid.json()).error, /capacity/);
    assert.equal(saveRun.mock.callCount(), 2);
    for (const route of ['/courses/faqs', '/courses/faqs/update', '/courses/faqs/destroy']) {
        const faqBody = { guid: GUID, sport_guid: GUID, question: 'Question?', answer: 'Answer.' };
        assert.equal((await call('/admin' + route, 'Coach', true, faqBody)).status, 403);
        assert.equal((await call('/admin' + route, 'Administrator', false, faqBody)).status, 302);
    }
    assert.equal(saveFaq.mock.callCount(), 2);
    assert.equal(removeFaq.mock.callCount(), 1);
    for (const role of ['Coach', 'Resident']) {
        assert.equal((await call('/admin/courses', role, false)).status, 403);
        for (const action of ['/courses', '/courses/update', '/courses/destroy', '/facilities/courses/destroy']) {
            assert.equal((await call('/admin' + action, role, false, body)).status, 403);
        }
    }
    const dashboard = await call('/admin', 'Coach', true);
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /href="\/admin\/courses"/);
    assert.doesNotMatch(dashboardHtml, /href="\/admin\/(?:profiles|roles|settings|facilities|bookings|refunds)"/);
    for (const url of ['/admin/profiles', '/admin/roles', '/admin/settings', '/admin/facilities', '/admin/bookings', '/admin/refunds']) {
        assert.equal((await call(url, 'Coach', true)).status, 403);
    }
    assert.equal((await call('/admin/profiles/destroy', 'Coach', true, body)).status, 403);
    const signedOut = await call('/admin/courses', null, false);
    assert.equal(signedOut.status, 302);
    assert.equal(signedOut.headers.get('location'), '/login');
    assert.equal((await call('/admin/courses', null, false, body)).status, 401);
    assert.equal(create.mock.callCount(), 4);
    assert.equal(update.mock.callCount(), 4);
    assert.equal(remove.mock.callCount(), 8);
});
