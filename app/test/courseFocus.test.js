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

test('course anchors open only the matching class disclosure on load and hash changes', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        courses: [], courseGroups: [], siteTitle: 'ActiveHub', hasLogo: false,
        currentProfile: null, isAdmin: false, canSwitchRole: false
    });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const first = { open: false };
    const second = { open: false };
    const scrolled = [];
    const heading = (runs, name) => ({
        closest: () => ({ querySelector: () => runs }),
        scrollIntoView: () => scrolled.push(name)
    });
    const headings = {
        'course-heading-first': heading(first, 'first'),
        'course-heading-second': heading(second, 'second')
    };
    const location = { hash: '#course-heading-first' };
    let hashchange;
    vm.runInNewContext(script, {
        location, document: { getElementById: id => headings[id] },
        window: { addEventListener: (event, listener) => { assert.equal(event, 'hashchange'); hashchange = listener; } },
        requestAnimationFrame: callback => callback()
    });
    assert.equal(first.open, true);
    assert.equal(second.open, false);
    location.hash = '#course-heading-second';
    hashchange();
    assert.equal(second.open, true);
    assert.deepEqual(scrolled, ['first', 'second']);
    for (const hash of ['', '#unrelated', '#course-heading-missing']) {
        location.hash = hash;
        assert.doesNotThrow(hashchange);
    }
    assert.deepEqual(scrolled, ['first', 'second']);
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

test('customer sport sections omit unused sports and FAQs, and retain unassigned courses', async t => {
    t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Facilities, 'findAll', async () => [facility]);
    t.mock.method(Sports, 'findAll', async () => [sport, { guid: 'unused', name: 'Unused sport' }, { guid: 'second', name: 'Second sport' }]);
    t.mock.method(Courses, 'findAll', async () => [course,
        { ...course, guid: 'multi', name: 'Multi-sport course', sport_guids: [GUID, 'second'] },
        { ...course, guid: 'legacy', name: 'Legacy course', sport_guids: [] }]);
    t.mock.method(Courses, 'findFaqs', async () => [{ ...faq, answer: '<bold>Bring</bold> <ul>trainers</ul>' },
        { ...faq, sport_guid: 'unused', question: 'Unused FAQ' }]);
    const handler = router.stack.find(layer => layer.route?.path === '/courses' && layer.route.methods.get).route.stack[0].handle;
    let values;
    await handler({ profile: { guid: GUID } }, { render(_view, locals) { values = locals; }, sendStatus(code) { assert.fail(`Unexpected status ${code}`); } });
    assert.deepEqual(values.courseGroups.map(group => group.name), ['Tennis', 'Second sport', 'Sport to be confirmed']);
    assert.deepEqual(values.courseGroups.map(group => group.courses.length), [2, 1, 1]);
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        ...values, currentProfile: { name: 'Resident', role: 'Resident' }, isAdmin: false, canSwitchRole: false
    });
    assert.equal((html.match(/<details[^>]*data-sport-faqs/g) || []).length, 1);
    assert.ok(html.indexOf('data-sport-faqs') < html.indexOf('<section class="course-card'),
        'Sport FAQs appear once outside and before the course cards');
    assert.match(html, /<span style="color: #003e90; font-weight: 400;">Bring<\/span> <u>trainers<\/u>/);
    assert.doesNotMatch(html, /Unused sport|Unused FAQ|<details[^>]* open/);
});

    test('customer courses route lists courses without management controls and handles empty directories', async t => {
        t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
        t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
        t.mock.method(Settings, 'getLogo', async () => null);
        t.mock.method(Facilities, 'findAll', async () => [facility]);
        t.mock.method(Sports, 'findAll', async () => [sport]);
        t.mock.method(Courses, 'findFaqs', async () => [faq]);
        const find = t.mock.method(Courses, 'findAll', async options => {
            assert.deepEqual(options, { availableOnly: true });
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
            if (empty) assert.match(html, /No courses are available/);
            else {
                assert.match(html, /Tennis course/);
                assert.doesNotMatch(html, /To be confirmed/);
                assert.match(html, /<h2[^>]*>Tennis course<\/h2>/);
                assert.match(html, /<details class="course-card mb-4" data-sport-faqs>/);
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
            assert.equal(widths.length, 6);
            assert.equal(new Set(widths).size, 1);
        }
    });

test('course-focused directory shows assignments, flags legacy courses and restricts FAQ controls', async () => {
    for (const isAdmin of [false, true]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/courses.ejs'), {
            currentProfile: { name: 'Leader', role: isAdmin ? 'Administrator' : 'Course leader', permissions: ['courses.manage'] },
            isAdmin, canSwitchRole: false, area: 'admin', activePage: 'courses', error: '',
            courses: [course, { ...course, guid: 'legacy', sport_guids: [] }],
            facilities: [facility], sports: [sport], faqs: [faq]
        });
        assert.match(html, /Sport: Tennis/);
        assert.match(html, /Sport \(select at least one\)/);
        assert.match(html, /Facility runs/);
        assert.match(html, />Location<\/label>/);
        assert.match(html, /<select[^>]*name="facility_guid" required>/);
        assert.doesNotMatch(html, /name="facility_guids"/);
        assert.match(html, /Sport assignment needed/);
        assert.equal((html.match(/data-course-guid=/g) || []).length, 2);
        assert.equal(html.includes('action="/admin/courses/faqs"'), isAdmin);
        assert.equal(html.includes('action="/admin/courses/faqs/update"'), isAdmin);
        assert.equal(html.includes('action="/admin/courses/faqs/destroy"'), isAdmin);
        if (isAdmin) {
            assert.match(html, /id="sport-faq-[^"]+" data-sport-faq-card/);
            assert.match(html, /<details data-sport-faq-details>\s*<summary class="h5 mb-0"><h3 class="h5 d-inline">Tennis<\/h3> <span[^>]*data-sport-faq-count>1 FAQ<\/span><\/summary>/);
            assert.match(html, /data-sport-faq-list/);
            assert.match(html, /<h4 class="h6">What should I bring\?<\/h4>/);
            assert.doesNotMatch(html, /<p[^>]*>&lt;b&gt;A racket&lt;\/b&gt;<\/p>/);
            assert.match(html, /<textarea[^>]*name="answer"[^>]*>&lt;b&gt;A racket&lt;\/b&gt;<\/textarea>/);
            assert.match(html, /action="\/admin\/courses\/faqs\/update"[^>]*data-editor-preview="false"/);
            assert.match(html, /data-faq-actions>\s*<button[^>]*>Edit<\/button>\s*<form[^>]*action="\/admin\/courses\/faqs\/destroy">/);
            assert.match(html, />Delete<\/button>/);
            assert.doesNotMatch(html, />Edit FAQ<|>Delete FAQ</);
            assert.match(html, /action="\/admin\/courses\/faqs"[^>]*data-faq-add/);
            assert.match(html, /data-edit-toggle data-hide-when-editing[^>]*aria-controls="add-faq-[^"]+">Add FAQ<\/button>/);
            assert.match(html, /data-faq-feedback[^>]*role="status"[^>]*hidden/);
            assert.match(html, /Question<\/label>\s*<div[^>]*data-faq-feedback-slot[^>]*height: 2.5rem/);
            assert.match(html, /async function refreshFaqs/);
            assert.match(html, /resetNoticeFade\(notice, true\)/);
            assert.match(html, /courseForm \|\| entry.form.matches\('\[data-faq-add\], \[data-faq-edit\]'\)/);
            assert.match(html, /data-editor-preview="false" data-faq-edit/);
            assert.match(html, /guard\(\{ kind: 'faq-disclosure', details: summary.parentElement, open: !summary.parentElement.open \}\)/);
            assert.match(html, /if \(action.kind === 'faq-disclosure'\)/);
        }
    }
});

test('collapsed sport FAQ headings distinguish empty, single and multiple FAQs', async () => {
    for (const count of [0, 1, 2]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/courses.ejs'), {
            currentProfile: { name: 'Admin', role: 'Administrator' }, isAdmin: true, canSwitchRole: false,
            area: 'admin', activePage: 'courses', error: '', courses: [], facilities: [facility], sports: [sport],
            faqs: Array.from({ length: count }, (_, index) => ({ ...faq, guid: `faq-${index}` }))
        });
        const label = count === 0 ? 'No FAQs' : count === 1 ? '1 FAQ' : '2 FAQs';
        assert.ok(html.includes(`data-sport-faq-count>${label}</span></summary>`));
        assert.match(html, count ? /badge-info/ : /badge-light text-muted/);
        assert.doesNotMatch(html, /<details data-sport-faq-details open/);
        assert.match(html, /querySelector\('\[data-sport-faq-count\]'\)\.replaceWith\(count\)/);
    }
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
    assert.doesNotMatch(html, /What should I bring\?|data-course-description|data-course-run|action="\/basket\/add"/);
});
