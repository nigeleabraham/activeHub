const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const vm = require('node:vm');
const Courses = require('../models/Courses');
const Facilities = require('../models/Facilities');
const Sports = require('../models/Sports');
const Settings = require('../models/Settings');
const OpeningHours = require('../models/OpeningHours');
const router = require('../routes/front');

const GUID = '123e4567-e89b-42d3-a456-426614174000';
const sport = { guid: GUID, name: 'Tennis' };
const facility = { guid: GUID, name: 'Hall', courses: [], sports: [sport] };
const course = { guid: GUID, name: 'Tennis course', facility_guids: [GUID], sport_guids: [GUID], description: 'All levels' };
const faq = { guid: GUID, sport_guid: GUID, question: 'What should I bring?', answer: '<b>A racket</b>' };

test('course anchors open the matching sport and class on load and hash changes, including courses without runs', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        courses: [], courseGroups: [], siteTitle: 'ActiveHub', hasLogo: false,
        currentProfile: null, isAdmin: false, canSwitchRole: false
    });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const first = { open: false };
    const second = { open: false };
    const firstSport = { open: false };
    const secondSport = { open: false };
    const thirdSport = { open: false };
    const scrolled = [];
    const heading = (runs, sport, name) => ({
        closest: selector => selector === '[data-course-sport-disclosure]' ? sport : { querySelector: () => runs },
        scrollIntoView: () => scrolled.push(name)
    });
    const headings = {
        'course-heading-first': heading(first, firstSport, 'first'),
        'course-heading-second': heading(second, secondSport, 'second'),
        'course-heading-third': heading(null, thirdSport, 'third'),
        'course-heading-single': heading(first, null, 'single')
    };
    const location = { hash: '#course-heading-first' };
    let hashchange;
    vm.runInNewContext(script, {
        location, document: { getElementById: id => headings[id] },
        window: { addEventListener: (event, listener) => { assert.equal(event, 'hashchange'); hashchange = listener; } },
        requestAnimationFrame: callback => callback()
    });
    assert.equal(first.open, true);
    assert.equal(firstSport.open, true);
    assert.equal(second.open, false);
    assert.equal(secondSport.open, false);
    location.hash = '#course-heading-second';
    hashchange();
    assert.equal(second.open, true);
    assert.equal(secondSport.open, true);
    assert.deepEqual(scrolled, ['first', 'second']);
    location.hash = '#course-heading-third';
    hashchange();
    assert.equal(thirdSport.open, true);
    location.hash = '#course-heading-single';
    assert.doesNotThrow(hashchange);
    for (const hash of ['', '#unrelated', '#course-heading-missing']) {
        location.hash = hash;
        assert.doesNotThrow(hashchange);
    }
    assert.deepEqual(scrolled, ['first', 'second', 'third', 'single']);
});

test('one visible sport remains expanded without a sport toggle, including unassigned courses', async () => {
    const render = groups => ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        courses: [course], courseGroups: groups, siteTitle: 'ActiveHub', hasLogo: false,
        currentProfile: null, isAdmin: false, canSwitchRole: false
    });
    for (const [guid, name] of [[GUID, 'Tennis'], ['unassigned', 'Sport to be confirmed']]) {
        const html = await render([{ guid, name, courses: [course], faqs: [faq] },
            { guid: 'empty', name: 'Empty', courses: [], faqs: [] }]);
        assert.match(html, /<div class="sport-panel">[\s\S]*<div class="sport-panel-heading">/);
        assert.match(html, new RegExp(`<h2[^>]*>${name}</h2>`));
        assert.match(html, /data-sport-faqs/);
        assert.match(html, /data-sport-faqs[\s\S]*?<\/details>\s*<section class="course-card/);
        assert.match(html, /<\/section>\s*<\/div>\s*<\/div>\s*<\/section>/);
        assert.match(html, /Tennis course/);
        assert.doesNotMatch(html, /<details[^>]*data-course-sport-disclosure/);
        assert.doesNotMatch(html, /Empty/);
    }
});

test('FAQ answer formatting supports coloured text, underline and bullets without allowing arbitrary HTML', async () => {
    for (const [answer, expected] of [
        ['Bring <bold>a racket</bold> and <ul>trainers</ul>.',
            'Bring <span style="color: #003e90; font-weight: 400;">a racket</span> and <u>trainers</u>.'],
        ['<bold>Coloured <ul>and underlined</ul></bold>',
            '<span style="color: #003e90; font-weight: 400;">Coloured <u>and underlined</u></span>'],
        ['<bullet>First</bullet><bullet><ul>Second</ul></bullet>',
            '<ul style="margin: 0; padding-left: 1.5rem;"><li>First</li></ul><ul style="margin: 0; padding-left: 1.5rem;"><li><u>Second</u></li></ul>'],
        ['<script>alert("x")</script> <bold><img src=x onerror=alert(1)></bold>',
            '&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt; <span style="color: #003e90; font-weight: 400;">&lt;img src=x onerror=alert(1)&gt;</span>'],
        ['<bold onclick="alert(1)">text</bold>', '&lt;bold onclick=&#34;alert(1)&#34;&gt;text&lt;/bold&gt;'],
        ['Unfinished <bold>text', 'Unfinished &lt;bold&gt;text'],
        ['</bold>text', '&lt;/bold&gt;text'],
        ['**bold** __underline__', '**bold** __underline__'],
        ['First line\n<ul>Second line</ul>', 'First line\n<u>Second line</u>'],
        ['Plain & simple', 'Plain &amp; simple'],
        ['', '']
    ]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/partials/faq-answer.ejs'), { answer });
        assert.equal(html.trim(), expected);
    }
});

test('course sport choices use two equal-width columns', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/course-form.ejs'), {
        prefix: 'test-course', course, facilities: [facility],
        sports: [sport, { guid: 'second-sport', name: 'Badminton' }]
    });
    assert.equal((html.match(/class="col-6 mb-1"/g) || []).length, 2);
    assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
});

test('course form uses one formatted description with whole-description inheritance', async () => {
    const section = { id: 'age', heading: 'Age', text: '<bold>5 to 8</bold>' };
    const render = locals => ejs.renderFile(path.join(__dirname, '../views/partials/course-form.ejs'), {
        prefix: 'test-course', facilities: [facility], sports: [{ ...sport, course_description_sections: [section],
            course_description_text: '<bold>Age</bold>\n<bold>5 to 8</bold>' }], ...locals
    });
    const standard = await render({ course: { ...course, description_sport_guid: GUID } });
    assert.ok(standard.indexOf('1. Course details') < standard.indexOf('Sport (select at least one)'));
    assert.ok(standard.indexOf('Sport (select at least one)') < standard.indexOf('2. Description'));
    assert.match(standard, /id="test-course-mode-standard" name="description_mode" value="standard" data-description-mode aria-describedby="test-course-standard-availability" checked/);
    assert.match(standard, /Use a sport's standard description/);
    assert.match(standard, /Customise this course's description/);
    assert.match(standard, /<template data-description-defaults=/);
    assert.equal((standard.match(/<textarea/g) || []).length, 1);
    assert.doesNotMatch(standard, /data-description-override=|data-section-add|Additional sections/);
    assert.match(standard, /data-description-reset>Reset to sport description/);
    assert.match(standard, /Formatting help/);
    assert.match(standard, /Preview as customers see it/);
    assert.doesNotMatch(standard, /Choose description defaults/);

    const own = await render({ course });
    assert.match(own, /value="own" data-description-mode checked/);
    assert.doesNotMatch(own, /data-override-mode/);
    const legacyCustom = await render({ course: { ...course, description_sport_guid: GUID,
        description_overrides: { age: { heading: 'Age', text: 'Custom' } }, description_text: '<bold>Age</bold>\nCustom' } });
    assert.match(legacyCustom, /value="own" data-description-mode checked/);
    assert.match(legacyCustom, /&lt;bold&gt;Age&lt;\/bold&gt;\nCustom<\/textarea>/);
    const added = await render({ course: null });
    assert.match(added, /value="standard" data-description-mode[^>]* disabled/);
    assert.match(added, /value="own" data-description-mode checked/);
    const missing = await render({ course: { ...course, description_sport_guid: GUID },
        sports: [{ ...sport, course_description_text: ' \n ' }] });
    assert.match(missing, /value="standard" data-description-mode[^>]* disabled/);
    assert.match(missing, /class="form-check-label text-muted"[^>]*data-description-standard-label/);
    assert.match(missing, /Unavailable: select a sport with a standard description/);
    assert.match(missing, /value="own" data-description-mode checked/);
    const editorSource = await require('node:fs/promises').readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    assert.match(editorSource, /\[data-description-mode\]\[value="standard"\]:disabled \+ \[data-description-standard-label\] \{ text-decoration: line-through; \}/);
});

test('main course saves shared details without dates or a facility', async t => {
    const create = t.mock.method(Courses, 'create', async () => ({ guid: GUID }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/courses' && layer.route.methods.post).route.stack[0].handle;
    await handler({ body: { name: ' Course ', sport_guids: GUID } }, { redirect() {} });
    assert.deepEqual(create.mock.calls[0].arguments[0], { name: 'Course', description: null, sport_guids: [GUID] });
});

test('course section input accepts assigned sources and rejects mismatched or malformed overrides', async t => {
    const create = t.mock.method(Courses, 'create', async () => ({ guid: GUID }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/courses' && layer.route.methods.post).route.stack[0].handle;
    let status;
    const res = { redirect() {}, sendStatus(value) { status = value; } };
    const body = { name: 'Course', sport_guids: GUID, description_sport_guid: GUID,
        description_overrides: '{}', description_sections: '[]' };
    await handler({ body }, res);
    assert.equal(create.mock.calls[0].arguments[0].description_sport_guid, GUID);
    for (const change of [
        { description_sport_guid: '123e4567-e89b-42d3-a456-426614174001' },
        { description_overrides: '{broken' }, { description_sections: '{}' }
    ]) {
        await handler({ body: { ...body, ...change } }, res);
        assert.equal(status, 400);
    }
    assert.equal(create.mock.calls.length, 1);
});

test('customer sport panels contain their own courses and FAQs, omit unused sports and retain unassigned courses', async t => {
    t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Facilities, 'findAll', async () => [facility]);
    t.mock.method(Sports, 'findAll', async () => [sport, { guid: 'unused', name: 'Unused sport' }, { guid: 'second', name: 'Second sport' }]);
    t.mock.method(Courses, 'findAll', async () => [course,
        { ...course, guid: 'multi', name: 'Multi-sport course', sport_guids: [GUID, 'second'], runs: [
            { guid: 'shared-run', name: 'Shared class', facility_name: 'Hall', capacity: 10, current_price_pence: 1000,
                full_price_pence: 1000, total_sessions: 1, remaining_sessions: 1, sessions: [] }
        ] },
        { ...course, guid: 'legacy', name: 'Legacy course', sport_guids: [] }]);
    t.mock.method(Courses, 'findFaqs', async () => [{ ...faq, answer: '<bold>Bring</bold> <ul>trainers</ul>' },
        { ...faq, sport_guid: 'unused', question: 'Unused FAQ' }]);
    const handler = router.stack.find(layer => layer.route?.path === '/courses' && layer.route.methods.get).route.stack[0].handle;
    let values;
    await handler({ profile: { guid: GUID } }, { render(_view, locals) { values = locals; }, sendStatus(code) { assert.fail(`Unexpected status ${code}`); } });
    assert.deepEqual(values.courseGroups.map(group => group.name), ['Tennis', 'Second sport', 'Sport to be confirmed']);
    assert.deepEqual(values.courseGroups.map(group => group.courses.length), [2, 1, 1]);
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        ...values, lazyRuns: false, currentProfile: { name: 'Resident', role: 'Resident' }, isAdmin: false, canSwitchRole: false
    });
    assert.equal((html.match(/<details[^>]*data-sport-faqs/g) || []).length, 1);
    const panels = html.split('<section class="mb-4" data-course-sport-group=').slice(1);
    assert.equal(panels.length, 3);
    assert.match(panels[0], /Tennis FAQs[\s\S]*Tennis course[\s\S]*Multi-sport course/);
    assert.match(panels[0], /2 courses/);
    assert.match(panels[1], /Second sport[\s\S]*1 course[\s\S]*Multi-sport course/);
    assert.doesNotMatch(panels[1], /data-sport-faqs|Tennis course|Legacy course/);
    assert.match(panels[2], /Sport to be confirmed[\s\S]*Legacy course/);
    assert.doesNotMatch(panels[2], /data-sport-faqs|Multi-sport course/);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'Multi-sport courses must not duplicate heading or attendee IDs');
    assert.equal((html.match(/id="course-heading-multi"/g) || []).length, 1);
    assert.match(panels[1], /value="\/courses#course-heading-multi-sport-group-second"/);
    for (const match of html.matchAll(/<label[^>]*for="(attendee-[^"]+)"/g)) {
        assert.ok(ids.includes(match[1]), 'Each attendee label points to its own control');
    }
    assert.match(html, /<strong>Bring<\/strong> <u>trainers<\/u>/);
    assert.doesNotMatch(html, /Unused sport|Unused FAQ|<details[^>]* open/);
});

test('customer course page displays available, full and overbooked runs with accurate counts', async t => {
    t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Facilities, 'findAll', async () => [facility]);
    t.mock.method(Sports, 'findAll', async () => [sport]);
    t.mock.method(Courses, 'findFaqs', async () => [faq]);
    const makeRun = (guid, spaces, status = 'in_progress') => ({
        guid, name: guid, facility_name: 'Hall', capacity: 3, spaces_remaining: spaces,
        booking_status: status, start_date: status === 'upcoming' ? '2090-01-01' : null,
        current_price_pence: 500, full_price_pence: 500, total_sessions: 1, remaining_sessions: 1, sessions: []
    });
    const available = makeRun('Available class', 1);
    const full = makeRun('Full class', 0);
    const overbooked = makeRun('Overbooked class', -1, 'upcoming');
    const input = [
        { ...course, has_scheduled_classes: true, has_upcoming_classes: true, runs: [full, available, overbooked] },
        { ...course, guid: 'fully-booked-course', name: 'Fully booked course', has_scheduled_classes: true,
            has_upcoming_classes: true, runs: [overbooked] },
        { ...course, guid: 'current-full', name: 'Current fully booked course', has_scheduled_classes: true,
            has_current_classes: true, runs: [full] },
        { ...course, guid: 'both-full', name: 'Both fully booked course', has_scheduled_classes: true,
            has_current_classes: true, has_upcoming_classes: true, runs: [full, overbooked] },
        { ...course, guid: 'unscheduled', name: 'Unscheduled course', runs: [] },
        { ...course, guid: 'unknown', name: 'Unknown start course', has_scheduled_classes: true,
            has_unknown_start_classes: true, runs: [makeRun('Unknown full', 0, 'unknown')] },
        { ...course, guid: 'upcoming', name: 'Upcoming course', has_scheduled_classes: true,
            has_upcoming_classes: true, runs: [makeRun('Upcoming class', 1, 'upcoming')] },
        { ...course, guid: 'current-full-upcoming-available', name: 'Current full future available',
            has_scheduled_classes: true, has_current_classes: true, has_upcoming_classes: true,
            runs: [full, makeRun('Available future', 1, 'upcoming')] },
        { ...course, guid: 'current-available', name: 'Current available course', has_scheduled_classes: true,
            has_current_classes: true, runs: [available, full] }
    ];
    t.mock.method(Courses, 'findAll', async () => input);
    const handler = router.stack.find(layer => layer.route?.path === '/courses' && layer.route.methods.get).route.stack[0].handle;
    async function render() {
        let locals;
        await handler({ profile: { guid: GUID } }, { render(_view, values) { locals = values; }, sendStatus: assert.fail });
        return { locals, html: await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
            ...locals, lazyRuns: false, currentProfile: { name: 'Resident' }, isAdmin: false, canSwitchRole: false
        }) };
    }
    const { locals, html } = await render();
    assert.deepEqual(locals.courses.map(item => item.runs.map(run => run.guid)),
        [['Full class', 'Available class', 'Overbooked class'], ['Overbooked class'], ['Full class'],
            ['Full class', 'Overbooked class'], [], ['Unknown full'], ['Upcoming class'],
            ['Full class', 'Available future'], ['Available class', 'Full class']]);
    assert.equal(input[0].runs.length, 3, 'Filtering must not alter shared course data');
    assert.match(html, /Choose a class \(3\)/);
    assert.match(html, /Classes in progress \(1\)/);
    assert.match(html, /Available class/);
    const cards = html.split('<section class="course-card');
    const card = name => cards.find(item => item.includes(name));
    const upcomingFullMessage = /All upcoming classes are fully booked\. Check back here for future dates\./;
    assert.match(card('Tennis course'), /Choose a class \(3\)[\s\S]*?<strong>In progress<\/strong>: 1 with spaces, 1 fully booked; <strong>Upcoming<\/strong>: 0 with spaces, 1 fully booked[\s\S]*?<\/summary>/);
    assert.match(card('Current full future available'), /<strong>In progress<\/strong>: 0 with spaces, 1 fully booked; <strong>Upcoming<\/strong>: 1 with spaces, 0 fully booked/);
    assert.match(card('Both fully booked course'), /<strong>In progress<\/strong>: 0 with spaces, 1 fully booked; <strong>Upcoming<\/strong>: 0 with spaces, 1 fully booked/);
    assert.match(card('Tennis course'), upcomingFullMessage);
    assert.match(card('Fully booked course'), /No classes are currently available to book/);
    assert.match(card('Fully booked course'), upcomingFullMessage);
    assert.match(card('Current fully booked course'),
        /All classes that are in progress are fully booked\./);
    assert.match(card('Both fully booked course'),
        /All classes that are in progress are fully booked\./);
    assert.match(card('Both fully booked course'), upcomingFullMessage);
    assert.match(card('Current full future available'), /All classes that are in progress are fully booked\./);
    assert.doesNotMatch(card('Current full future available'), /No classes are currently available to book|All upcoming classes are fully booked/);
    assert.doesNotMatch(card('Current available course'), /All classes that are in progress are fully booked/);
    assert.doesNotMatch(card('Fully booked course'), /All classes that are in progress are fully booked/);
    assert.doesNotMatch(card('Fully booked course'), /Upcoming classes have not yet been made available/);
    assert.match(card('Unscheduled course'), /No classes are currently available to book/);
    assert.match(card('Unscheduled course'), /Upcoming classes have not yet been made available for booking\./);
    for (const message of [
        'All classes that are in progress are fully booked.',
        'No classes are currently available to book.',
        'All upcoming classes are fully booked. Check back here for future dates.',
        'Upcoming classes have not yet been made available for booking.'
    ]) {
        assert.ok(html.includes(`class="text-danger mb-${message.startsWith('All upcoming') || message.startsWith('Upcoming') ? '0' : '2'}">${message}</p>`),
            `${message} should use the accessible error colour`);
    }
    assert.doesNotMatch(card('Unscheduled course'), /fully booked/);
    assert.match(card('Unknown start course'), /No classes are currently available to book/);
    assert.match(card('Unknown start course'), /Unknown start date: 0 with spaces, 1 fully booked/);
    assert.doesNotMatch(card('Unknown start course'), /classes that are in progress are fully booked/);
    assert.doesNotMatch(card('Unknown start course'), /upcoming classes/i);
    assert.doesNotMatch(card('Upcoming course'), /All upcoming classes are fully booked|Upcoming classes have not yet been made available/i);
    assert.match(card('Both fully booked course'), /Full class[\s\S]*Fully booked[\s\S]*Overbooked class[\s\S]*Fully booked/);
    assert.doesNotMatch(card('Both fully booked course'), /action="\/basket\/add"|View details and book/);
    full.spaces_remaining = 1;
    const reopened = await render();
    assert.match(reopened.html, /<strong>In progress<\/strong>: 2 with spaces, 0 fully booked/);
    assert.match(reopened.html, /Full class/);
});

    test('customer courses route lists courses without management controls and handles empty directories', async t => {
        t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
        t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
        t.mock.method(Settings, 'getLogo', async () => null);
        t.mock.method(Facilities, 'findAll', async () => [facility]);
        t.mock.method(Sports, 'findAll', async () => [sport]);
        t.mock.method(Courses, 'findFaqs', async () => [faq]);
        const find = t.mock.method(Courses, 'findAll', async options => {
            assert.deepEqual(options, { availableOnly: true, includeUnscheduled: true, includeFullyBooked: true, includeSessions: false });
            return [{ ...course, description: '<script>unsafe</script>' }];
        });
        const handler = router.stack.find(layer => layer.route?.path === '/courses' && layer.route.methods.get).route.stack[0].handle;
        for (const empty of [false, true]) {
            if (empty) find.mock.mockImplementation(async () => []);
            let values;
            await handler({ profile: { guid: GUID } }, { render(view, locals) { assert.equal(view, 'resident-courses'); values = locals; },
                sendStatus(code) { assert.fail(`Unexpected status ${code}`); } });
            const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
                ...values, currentProfile: { name: 'Resident', role: 'Resident' }, isAdmin: false, canSwitchRole: false
            });
            assert.doesNotMatch(html, /href="\/admin\/courses"|<button[^>]*data-edit-toggle/);
            if (empty) {
                assert.match(html, /No courses are available/);
                assert.doesNotMatch(html, /data-course-sport-group=|data-sport-faqs>/);
            }
            else {
                assert.match(html, /Tennis course/);
                assert.doesNotMatch(html, /To be confirmed/);
                assert.match(html, /<h2[^>]*>Tennis<\/h2>/);
                assert.match(html, /<h3[^>]*>Tennis course<\/h3>/);
                assert.match(html, /<details class="sport-faqs mb-4" data-sport-faqs[^>]*>/);
                assert.match(html, /&lt;b&gt;A racket&lt;\/b&gt;/);
                assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
            }
        }
    });

    test('home links to customer courses and administration has the same card width for every role', async () => {
        for (const isAdmin of [false, true]) {
            const html = await ejs.renderFile(path.join(__dirname, '../views/home.ejs'), {
                siteTitle: 'ActiveHub', hasLogo: false, activePage: 'home', isAdmin,
                currentProfile: { name: 'Manager', role: isAdmin ? 'Administrator' : 'Course leader', permissions: ['courses.manage'] },
                canSwitchRole: false, canAccessAdmin: () => true
            });
            assert.match(html, /href="\/courses"/);
            const widths = [...html.matchAll(/<div class="([^"]*mb-4)">\s*<a class="brand-tile/g)].map(match => match[1]);
            assert.equal(widths.length, 7);
            assert.equal(new Set(widths).size, 1);
        }
    });

test('course-focused directory shows assignments and legacy warnings without FAQ management', async () => {
    for (const isAdmin of [false, true]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/courses.ejs'), {
            currentProfile: { name: 'Leader', role: isAdmin ? 'Administrator' : 'Course leader', permissions: ['courses.manage'] },
            isAdmin, canSwitchRole: false, area: 'admin', activePage: 'courses', error: '',
            courses: [course, { ...course, guid: 'legacy', sport_guids: [] }],
            facilities: [facility], sports: [sport], faqs: [faq]
        });
        assert.doesNotMatch(html, /Sport: Tennis/);
        assert.match(html, /Sport \(select at least one\)/);
        assert.match(html, /<title>Courses and course runs \| ActiveHub<\/title>/);
        assert.match(html, /<h1 class="h2 mb-1">Courses and course runs<\/h1>/);
        assert.match(html, /Course runs/);
        assert.match(html, />Location<\/label>/);
        assert.match(html, /<select[^>]*name="facility_guid" required>/);
        assert.doesNotMatch(html, /name="facility_guids"/);
        assert.equal((html.match(/<span class="badge badge-warning[^"]*">Sport assignment needed<\/span>/g) || []).length, 1);
        assert.equal((html.match(/data-course-guid=/g) || []).length, 2);
        assert.doesNotMatch(html, /<form[^>]*action="\/admin\/courses\/faqs|<section[^>]*data-sport-faq-card|The FAQ could not be saved/);
    }
});

test('sport FAQs merge zero, single and multiple entries into one text box in order', async () => {
    for (const count of [0, 1, 2]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            currentProfile: { name: 'Admin', role: 'Administrator' }, isAdmin: true, canSwitchRole: false,
            area: 'admin', activePage: 'sports', error: '', sports: [sport],
            faqs: Array.from({ length: count }, (_, index) => ({ ...faq, guid: `faq-${index}`, question: `Question ${index}`, answer: `Answer ${index}` }))
        });
        const form = html.match(/<form[^>]*action="\/admin\/courses\/faqs\/save"[\s\S]*?<\/form>/)[0];
        assert.equal((form.match(/<textarea/g) || []).length, 1);
        const text = form.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1];
        assert.equal(text, Array.from({ length: count }, (_, index) =>
            `&lt;bold&gt;Question ${index}&lt;/bold&gt;\nAnswer ${index}`).join('\n\n'));
        assert.doesNotMatch(html, /<details[^>]*data-sport-faq-details[^>]* open/);
        assert.doesNotMatch(form, /data-faq-card|data-card-order-list/);
    }
});

test('sports directory provides one formatted FAQ editor per sport for administrators only', async () => {
    for (const isAdmin of [false, true]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            currentProfile: { name: 'Manager', role: isAdmin ? 'Administrator' : 'Manager' },
            isAdmin, canSwitchRole: false, area: 'admin', activePage: 'sports', error: '',
            sports: [sport, { guid: 'other-sport', name: 'Swimming' }], faqs: [faq]
        });
        assert.equal(/<form[^>]*action="\/admin\/courses\/faqs\/save"/.test(html), isAdmin);
        assert.doesNotMatch(html, /<form[^>]*action="\/admin\/courses\/faqs(?:\/update|\/destroy)?"/);
        if (!isAdmin) continue;
        const tennis = html.match(/<article id="sport-[^"]+"[\s\S]*?<\/article>/)[0];
        const swimming = html.match(/<article id="sport-other-sport"[\s\S]*?<\/article>/)[0];
        assert.match(tennis, /<h4[^>]*>FAQs<\/h4>/);
        assert.match(tennis, /<textarea[^>]*name="faq_text"[^>]*>&lt;bold&gt;What should I bring\?&lt;\/bold&gt;\n&lt;b&gt;A racket&lt;\/b&gt;<\/textarea>/);
        assert.match(tennis, /data-cancel-edit>Cancel<\/button>\s*<button[^>]*>Save FAQs<\/button>/);
        assert.match(tennis, /Preview as customers see it/);
        assert.doesNotMatch(tennis, /data-faq-card=|>Add FAQ<\/h5>|data-card-order-list="\/admin\/courses\/faqs/);
        assert.match(swimming, /name="faq_text"[^>]*><\/textarea>/);
        assert.doesNotMatch(swimming, /What should I bring/);
    }
});

test('sport defaults use one description box without section cards or section counts', async () => {
    for (const count of [0, 1, 2]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            currentProfile: { name: 'Admin', role: 'Administrator' }, isAdmin: true, canSwitchRole: false,
            area: 'admin', activePage: 'sports', error: '',
            sports: [{ ...sport, course_description_sections: Array.from({ length: count }, (_, index) => ({
                id: `section-${index}`, heading: 'Heading', text: 'Text'
            })), course_description_text: count ? '<bold>Heading</bold>\nText' : '' }],
            faqs: Array.from({ length: count }, (_, index) => ({ ...faq, guid: `faq-${index}` }))
        });
        const form = html.match(/<form[^>]*action="\/admin\/sports\/course-defaults"[\s\S]*?<\/form>/)[0];
        assert.equal((form.match(/<textarea/g) || []).length, 1);
        assert.match(form, /name="course_description"/);
        assert.doesNotMatch(form, /data-section-add|data-section-card/);
        assert.doesNotMatch(html, /data-sport-section-count>/);
    }
});

test('admin FAQ data loads only on sports, and sports load failures are explicit', async t => {
    t.mock.method(Sports, 'findAll', async () => [sport]);
    t.mock.method(Courses, 'findAll', async () => [course]);
    t.mock.method(Facilities, 'findAll', async () => [facility]);
    const findFaqs = t.mock.method(Courses, 'findFaqs', async () => [faq]);
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    for (const view of ['courses', 'sports']) {
        const handler = admin.stack.find(layer => layer.route?.path === '/' + view && layer.route.methods.get).route.stack[0].handle;
        let rendered;
        await handler({ query: {} }, {
            render(name, values) { rendered = { name, values }; },
            sendStatus(status) { assert.fail(`Unexpected status ${status}`); }
        });
        assert.equal(rendered.name, view);
        if (view === 'courses') {
            assert.equal(findFaqs.mock.callCount(), 0);
            assert.equal(rendered.values.faqs, undefined);
        } else assert.deepEqual(rendered.values.faqs, [faq]);
    }
    findFaqs.mock.mockImplementation(async () => { throw new Error('FAQ database unavailable'); });
    const log = t.mock.method(console, 'error', () => {});
    let status;
    const handler = admin.stack.find(layer => layer.route?.path === '/sports' && layer.route.methods.get).route.stack[0].handle;
    await handler({ query: {} }, { sendStatus(value) { status = value; } });
    assert.equal(status, 500);
    assert.equal(log.mock.callCount(), 1);
});

test('course writes reject missing or malformed sports before calling the model', async t => {
    const create = t.mock.method(Courses, 'create', async () => assert.fail('Invalid create reached model'));
    const update = t.mock.method(Courses, 'update', async () => assert.fail('Invalid update reached model'));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    for (const route of ['/courses', '/courses/update']) {
        const handler = admin.stack.findLast(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;
        for (const fields of [{ sport_guids: undefined }, { sport_guids: '' }, { sport_guids: 'invalid' },
            { sport_guids: {} }, { sport_guids: [GUID, 'invalid'] }]) {
            let status;
            await handler({ body: { guid: GUID, name: 'Course', sport_guids: GUID, start_date: '2026-10-01', end_date: '2026-12-01', ...fields } },
                { sendStatus(value) { status = value; } });
            assert.equal(status, 400);
        }
    }
    assert.equal(create.mock.callCount(), 0);
    assert.equal(update.mock.callCount(), 0);
});

test('facility course listings link to the matching course without descriptions, FAQs or run controls', async t => {
    t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Facilities, 'findAll', async () => [facility]);
    t.mock.method(Sports, 'findAll', async () => [sport]);
    t.mock.method(Courses, 'findAll', async options => {
        assert.deepEqual(options, { availableOnly: true });
        return [course, { ...course, guid: 'other', name: 'Second course' }];
    });
    t.mock.method(Courses, 'findFaqs', async () => [faq]);
    t.mock.method(OpeningHours, 'getSchedules', async () => null);
    const handler = router.stack.find(layer => layer.route?.path === '/facilities' && layer.route.methods.get).route.stack[0].handle;
    let values;
    await handler({ profile: { guid: GUID } }, { render(_view, locals) { values = locals; }, sendStatus(code) { assert.fail(`Unexpected status ${code}`); } });
    assert.equal(values.facilities[0].courses.length, 2);
    assert.deepEqual(values.facilities[0].courses, [
        { guid: course.guid, name: course.name }, { guid: 'other', name: 'Second course' }
    ]);
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-facilities.ejs'), {
        ...values, currentProfile: { name: 'Resident', role: 'Resident' }, isAdmin: false, canSwitchRole: false
    });
    assert.ok(html.includes(`href="/courses#course-heading-${course.guid}"`));
    assert.match(html, /href="\/courses#course-heading-other">Second course<\/a>/);
    assert.doesNotMatch(html, /id="open-today"|Open today<\/label>/);
    const filterFields = [...html.matchAll(/<div class="form-group ([^"]+)">\s*<label for="(?:search|sport)"/g)];
    assert.deepEqual(filterFields.map(match => match[1]), ['col-md-6', 'col-md-6']);
    assert.doesNotMatch(html, /What should I bring\?|data-course-description|data-course-run|action="\/basket\/add"/);
});
