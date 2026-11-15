const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const vm = require('node:vm');
const Courses = require('../models/Courses');
const CourseOrders = require('../models/CourseOrders');
const Settings = require('../models/Settings');
const Facilities = require('../models/Facilities');
const Sports = require('../models/Sports');
const router = require('../routes/front');

const courseGuid = '123e4567-e89b-42d3-a456-426614174000';
const sportGuid = '123e4567-e89b-42d3-a456-426614174001';
const groupId = `sport-group-${sportGuid}`;
const headingId = `course-heading-${courseGuid}`;
const run = {
    guid: '123e4567-e89b-42d3-a456-426614174002', course_guid: courseGuid,
    name: 'Evening class', facility_name: 'Hall', booking_status: 'in_progress',
    capacity: 2, spaces_remaining: 1, total_sessions: 1, remaining_sessions: 1,
    full_price_pence: 500, current_price_pence: 500,
    sessions: [{ starts_local: '2090-01-01 18:00', ends_local: '2090-01-01 19:00' }]
};

test('initial course page retains counts but omits class cards and offers a no-script link', async () => {
    const course = { guid: courseGuid, name: 'Tennis', runs: [run] };
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        courses: [course], courseGroups: [{ guid: sportGuid, name: 'Sport', courses: [course], faqs: [] }],
        siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident' },
        isAdmin: false, canSwitchRole: false, lazyRuns: true
    });
    assert.match(html, /<strong>In progress<\/strong>: 1 with spaces, 0 fully booked; <strong>Upcoming<\/strong>: 0 with spaces, 0 fully booked/);
    assert.match(html, /data-classes-url="\/courses\//);
    assert.match(html, /<noscript>[\s\S]*Load classes for Tennis/);
    assert.doesNotMatch(html, /Evening class|name="run_guid"|Session dates and times/);
});

test('class endpoint scopes its query, renders booking details and rejects invalid identifiers', async t => {
    const find = t.mock.method(Courses, 'findRuns', async () => [run]);
    t.mock.method(CourseOrders, 'familyMembers', async () => [{ guid: sportGuid, name: 'Child' }]);
    const handler = router.stack.find(layer => layer.route?.path === '/courses/:courseGuid/classes').route.stack[0].handle;
    const req = { params: { courseGuid }, query: { group: groupId, heading: headingId }, profile: { guid: courseGuid } };
    let locals;
    const res = {
        set(name, value) { assert.equal(name, 'Cache-Control'); assert.equal(value, 'no-store'); },
        render(view, data) { assert.equal(view, 'partials/course-run-groups'); locals = data; },
        sendStatus: assert.fail
    };
    await handler(req, res);
    assert.deepEqual(find.mock.calls[0].arguments[0], { availableOnly: true, includeFullyBooked: true, courseGuid });
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/course-run-groups.ejs'), {
        ...locals, currentProfile: { name: 'Resident' }, basketItemCount: 0
    });
    assert.match(html, /Evening class/);
    assert.match(html, /name="run_guid"/);
    assert.match(html, />Child<\/option>/);
    assert.match(html, /Session dates and times/);
    req.query.heading = 'invalid';
    await handler(req, { sendStatus(code) { assert.equal(code, 400); } });
    assert.equal(find.mock.callCount(), 1);
});

test('no-script link loads the selected course and opens its sport and class sections', async t => {
    const course = { guid: courseGuid, name: 'Tennis', sport_guids: [sportGuid], runs: [run] };
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Facilities, 'findAll', async () => []);
    t.mock.method(Sports, 'findAll', async () => [
        { guid: sportGuid, name: 'Sport' }, { guid: '123e4567-e89b-42d3-a456-426614174003', name: 'Other' }
    ]);
    t.mock.method(Courses, 'findAll', async () => [course, {
        guid: '123e4567-e89b-42d3-a456-426614174004', name: 'Other course',
        sport_guids: ['123e4567-e89b-42d3-a456-426614174003'], runs: []
    }]);
    t.mock.method(Courses, 'findFaqs', async () => []);
    const find = t.mock.method(Courses, 'findRuns', async () => [run]);
    t.mock.method(CourseOrders, 'familyMembers', async () => []);
    const handler = router.stack.find(layer => layer.route?.path === '/courses').route.stack[0].handle;
    let locals;
    await handler({ profile: { guid: courseGuid }, query: { course: courseGuid, group: groupId, heading: headingId } },
        { render(_view, data) { locals = data; }, sendStatus: assert.fail });
    assert.equal(find.mock.calls[0].arguments[0].courseGuid, courseGuid);
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        ...locals, currentProfile: { name: 'Resident' }, isAdmin: false, canSwitchRole: false
    });
    assert.match(html, /data-course-sport-disclosure[^>]* open>/);
    assert.match(html, /data-course-runs[^>]* open>/);
    assert.match(html, /Evening class/);
    assert.match(html, /name="run_guid"/);
});

test('lazy loader requests once, retries failures and does not reload successful sections', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/course-lazy-load.ejs'));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    let toggled;
    let attempts = 0;
    const container = { textContent: '', innerHTML: '', setAttribute() {}, removeAttribute() {} };
    const details = {
        open: false, dataset: { classesUrl: '/classes' },
        querySelector: () => container,
        addEventListener(_type, listener) { toggled = listener; }
    };
    const window = {};
    vm.runInNewContext(script, {
        window, document: { querySelectorAll: () => [details] }, console: { error() {} },
        fetch: async () => {
            attempts++;
            if (attempts === 1) throw new Error('offline');
            return { ok: true, redirected: false, headers: { get: () => 'text/html' }, text: async () => '<p>Class</p>' };
        }
    });
    details.open = true;
    toggled();
    await window.loadCourseRuns(details);
    assert.equal(attempts, 1);
    assert.match(container.textContent, /Unable to load classes/);
    await window.loadCourseRuns(details);
    assert.equal(container.innerHTML, '<p>Class</p>');
    assert.equal(details.dataset.classesUrl, undefined);
    await window.loadCourseRuns(details);
    assert.equal(attempts, 2);
});
