const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

const navigation = path.join(__dirname, '../views/partials/navigation.ejs');
const locals = {
    currentProfile: { name: 'Administrator', role: 'Administrator' },
    isAdmin: true,
    area: 'admin',
    activePage: 'facilities',
    canSwitchRole: false,
    viewingAs: null,
    switchableRoles: []
};

test('every admin navigation renders the shared editor workflow with valid JavaScript', async () => {
    for (const activePage of ['facilities', 'courses', 'sports', 'opening-hours', 'bookings', 'profiles', 'roles', 'settings', 'credit-requests', 'credit-refunds']) {
        const html = await ejs.renderFile(navigation, { ...locals, activePage });
        assert.match(html, /dialog\.className = 'admin-unsaved-dialog'/);
        assert.match(html, /Save and continue/);
        assert.match(html, /Discard changes/);
        assert.match(html, /Keep editing/);
        assert.match(html, /Changes saved successfully\./);
        assert.match(html, /resetNoticeFade\(notice, operation === 'added'\)/);
        assert.match(html, /notice\.classList\.toggle\('sr-only', operation !== 'added'\)/);
        assert.match(html, /sourceRow\.animate\(/);
        assert.match(html, /backgroundColor: '#f8d7da'/);
        assert.match(html, /previous\.forEach\(timer => window\.clearTimeout\(timer\)\)/);
        assert.match(html, /destination\.searchParams\.set\('admin_saved', '1'\)/);
        assert.match(html, /pageUrl\.searchParams\.delete\('admin_saved'\)/);
        assert.match(html, /focus\(\{ preventScroll: true \}\)/);
        assert.match(html, /\(notice \|\| resume\.toggle\)\.scrollIntoView\(\{ block: 'start' \}\)/);
        assert.match(html, /data-unsaved-keep autofocus/);
        assert.match(html, /\? \[saveChoice, keepChoice, discardChoice\]/);
        assert.match(html, /: \[keepChoice, discardChoice, saveChoice\]/);
        assert.match(html, /dialog\.addEventListener\('cancel', event => \{ event\.preventDefault\(\); dismiss\(\); \}\)/);
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
        assert.equal(scripts.length, 1);
        assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
    }
});

test('citizen pages and signed-out pages do not load admin editing behaviour', async () => {
    for (const overrides of [
        { area: 'resident' },
        { isAdmin: false },
        { currentProfile: null }
    ]) {
        const html = await ejs.renderFile(navigation, { ...locals, ...overrides });
        assert.doesNotMatch(html, /admin-unsaved-dialog|data-admin-editors/);
    }
});

test('course actions share a row and editing opens in a separate panel', async () => {
    const course = { guid: 'course-one', name: 'Tennis coaching', description: '', facility_guid: 'facility-one' };
    const facility = { guid: 'facility-one', name: 'Sports centre', address: '1 High Street', postcode: 'SW1A 1AA', courses: [course] };
    const html = await ejs.renderFile(path.join(__dirname, '../views/courses.ejs'), {
        ...locals, activePage: 'courses', totalCourses: 1, courseGroups: [facility], facilities: [facility]
    });
    assert.match(html, /data-edit-toggle[^>]*aria-controls="edit-course-course-one"[^>]*>Edit<\/button>/);
    assert.match(html, /aria-label="Edit Tennis coaching"/);
    assert.match(html, /<\/button>\s*<form method="POST" action="\/admin\/courses\/destroy">/);
    assert.match(html, /id="edit-course-course-one" data-edit-panel hidden/);
    assert.match(html, /id="add-course-facility-one"[^>]*data-editor-success-inline/);
    assert.match(html, /data-course-facility/);
    assert.match(html, /data-course-list/);
    assert.match(html, /data-course-guid="course-one" data-course-name="Tennis coaching"/);
    assert.match(html, /data-course-feedback role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(html, /data-course-count/);
    assert.match(html, /data-course-add-feedback style="height: 4.5rem; min-width: 0; overflow: auto;"/);
    assert.match(html, /aria-controls="add-course-panel-facility-one">Add course<\/button>\s*<div[^>]*data-course-add-feedback/);
    const addForm = html.match(/<form[^>]*id="add-course-facility-one"[\s\S]*?<\/form>/)[0];
    assert.doesNotMatch(addForm, /data-course-add-feedback/);
    assert.match(html, /action="\/admin\/courses\/update" data-editor-label="Edit Tennis coaching"/);
    assert.doesNotMatch(html, /<summary[^>]*>Edit/);
    const editForm = html.match(/<form[^>]*action="\/admin\/courses\/update"[\s\S]*?<\/form>/)[0];
    assert.doesNotMatch(editForm, /name="facility_guid"/);
});

test('course updates accept details without a facility and ignore attempted reassignment', async t => {
    const Courses = require('../models/Courses');
    const router = require('../routes/front');
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    const update = t.mock.method(Courses, 'update', async () => ({ guid, facility_guid: guid }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/courses/update' && layer.route.methods.post).route.stack[0].handle;
    for (const extra of [{}, { facility_guid: 'another-facility' }]) {
        let location;
        await handler({ body: { guid, name: ' Tennis ', description: ' Coaching ', ...extra } }, {
            redirect(value) { location = value; },
            sendStatus(value) { assert.fail(`Unexpected status ${value}`); }
        });

        assert.equal(location, `/admin/courses?admin_saved=course-updated&admin_saved_target=facility-${guid}#facility-${guid}`);
        assert.deepEqual(update.mock.calls.at(-1).arguments, [guid, { name: 'Tennis', description: 'Coaching' }]);
    }
});

test('course creation and deletion redirect with action-specific confirmation only after success', async t => {
    const Courses = require('../models/Courses');
    const router = require('../routes/front');
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    for (const [route, method, confirmation] of [
        ['/courses', 'create', 'course-created'],
        ['/courses/destroy', 'remove', 'course-deleted']
    ]) {
        const operation = t.mock.method(Courses, method, async () => ({ guid, facility_guid: guid }));
        const handler = admin.stack.findLast(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;
        let location;
        let status;
        const res = { redirect(value) { location = value; }, sendStatus(value) { status = value; } };
        const req = { body: { guid, name: 'Tennis', facility_guid: guid } };
        await handler(req, res);
        const target = `${method === 'create' ? 'add-course-' : 'facility-'}${guid}`;
        assert.equal(location, `/admin/courses?admin_saved=${confirmation}&admin_saved_target=${target}#${target}`);
        operation.mock.mockImplementation(async () => { throw new Error('Database unavailable'); });
        location = undefined;
        await handler(req, res);
        assert.equal(status, 500);
        assert.equal(location, undefined);
    }
});

test('logo upload uses the shared form workflow and retains explicit upload constraints', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/settings.ejs'), {
        ...locals,
        saved: false,
        error: null,
        maxLength: 60,
        siteTitle: 'ActiveHub',
        organisationError: false,
        organisationName: 'Council',
        hasLogo: false,
        windowSaved: false,
        windowError: false,
        lifetimeError: false,
        creditRequestDays: 30,
        creditLifetimeDays: 365,
        autoApprovalEnabled: false
    });
    assert.match(html, /action="\/admin\/settings\/logo" data-admin-logo/);
    assert.match(html, /name="site_logo" type="file"/);
    assert.match(html, /id="logo-upload">Upload logo/);
    assert.doesNotMatch(html, /getElementById\('logo-upload'\)\.addEventListener/);
});

test('facility creation has one heading action, grouped fields and optional advanced coordinates', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/facilities.ejs'), {
        ...locals, facilities: [], sports: [], openingHoursTemplates: []
    });
    assert.match(html, /data-hide-when-editing[^>]*aria-controls="add-facility-section">Add facility/);
    assert.match(html, /id="add-facility-section"[^>]*data-edit-panel hidden/);
    for (const title of ['New facility', 'Facility details', 'Activities', 'Booking arrangements', 'Advanced location settings']) {
        assert.ok(html.includes(title));
    }
    assert.match(html, /type="radio" name="booking_mode" value="in_app" checked required/);
    assert.match(html, /type="radio" name="booking_mode" value="external"\s+required/);
    assert.match(html, /Create facility/);
    assert.equal((html.match(/>Add facility<\/button>/g) || []).length, 1);
});

test('facility add and edit share grouped controls, preserve values and keep delete separate', async () => {
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    const sport = { guid: 'tennis', name: 'Tennis' };
    const template = { guid: 'weekday', name: 'Weekdays' };
    const facility = {
        guid, name: 'Hall & courts', address: '1 High Street', postcode: 'SW1A 1AA',
        description: 'Indoor & outdoor', latitude: 0, longitude: -0.1278,
        booking_mode: 'external', external_booking_url: 'https://example.test/book',
        opening_hours_template_guid: template.guid, max_resident_bookings: 4,
        google_maps_url: 'https://maps.google.com', sports: [sport], courses: []
    };
    const html = await ejs.renderFile(path.join(__dirname, '../views/facilities.ejs'), {
        ...locals, facilities: [facility, { ...facility, guid: 'second', booking_mode: 'in_app' }],
        sports: [sport, { guid: 'netball', name: 'Netball' }], openingHoursTemplates: [template]
    });
    const forms = [...html.matchAll(/<form\b[^>]*data-facility-form[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
    assert.equal(forms.length, 3);
    for (const form of forms) {
        assert.doesNotMatch(form, /max-width/);
        assert.match(form, /form-group col-md-8/);
        assert.match(form, /form-group col-md-4/);
        assert.match(form, /col-12 col-md-4 col-lg-3/);
        assert.equal((form.match(/form-group col-md-6/g) || []).length, 2);
        for (const heading of ['Facility details', 'Activities', 'Booking arrangements', 'Advanced location settings']) {
            assert.ok(form.includes(heading));
        }
        assert.match(form, /type="radio" name="booking_mode" value="in_app"/);
        assert.match(form, /type="radio" name="booking_mode" value="external"/);
        assert.match(form, /data-cancel-edit/);
        assert.match(form, /data-editor-preview="false"/);
        assert.doesNotMatch(form, /\/destroy/);
    }
    assert.match(forms[0], /action="\/admin\/facilities"/);
    assert.match(forms[0], /value="in_app" checked required/);
    assert.match(forms[0], /Create facility/);
    assert.doesNotMatch(forms[0], /name="guid"/);
    for (const form of forms.slice(1)) {
        assert.match(form, /action="\/admin\/facilities\/update"/);
        assert.match(form, /Save changes/);
        assert.match(form, /name="name"[^>]*value="Hall &amp; courts"/);
        assert.match(form, /name="coordinates"[^>]*value="0, -0.1278"/);
        assert.match(form, /name="description"[^>]*>Indoor &amp; outdoor<\/textarea>/);
        assert.match(form, /name="sport_guids"[^>]*value="tennis" checked/);
        assert.doesNotMatch(form, /name="sport_guids"[^>]*value="netball" checked/);
        assert.match(form, /value="weekday" selected/);
        assert.match(form, /name="max_resident_bookings"[^>]*value="4"/);
    }
    assert.match(forms[1], /value="external" checked required/);
    assert.match(forms[1], /name="external_booking_url"[^>]*value="https:\/\/example.test\/book"[^>]*required/);
    assert.match(forms[2], /value="in_app" checked required/);
    assert.equal((html.match(/action="\/admin\/facilities\/destroy"/g) || []).length, 2);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, target] of html.matchAll(/<label[^>]*for="([^"]+)"/g)) {
        assert.ok(ids.includes(target), `Missing label target ${target}`);
    }
});
