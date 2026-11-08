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

test('course form steps through details then a standard or own description with customisable sections', async () => {
    const section = { id: 'age', heading: 'Age', text: '<bold>5 to 8</bold>' };
    const render = locals => ejs.renderFile(path.join(__dirname, '../views/partials/course-form.ejs'), {
        prefix: 'test-course', facilities: [facility], sports: [{ ...sport, course_description_sections: [section] }], ...locals
    });
    const standard = await render({ course: { ...course, description_sport_guid: GUID,
        description_overrides: { age: { heading: 'Age', text: 'Custom' } } } });
    assert.ok(standard.indexOf('1. Course details') < standard.indexOf('Sport (select at least one)'));
    assert.ok(standard.indexOf('Sport (select at least one)') < standard.indexOf('2. Description'));
    assert.match(standard, /id="test-course-mode-standard" name="description_mode" value="standard" data-description-mode checked/);
    assert.match(standard, /Use a sport's standard description/);
    assert.match(standard, /Write my own description/);
    assert.match(standard, /data-standard-heading="Age" data-standard-text="&lt;bold&gt;5 to 8&lt;\/bold&gt;"/);
    assert.match(standard, /data-override-mode checked/);
    assert.match(standard, />Custom<\/textarea>/);
    assert.match(standard, /data-override-customise[^>]*>Customise</);
    assert.match(standard, /data-override-reset[^>]*>Reset to standard text</);
    assert.match(standard, /<strong>5 to 8<\/strong>/);
    assert.match(standard, /Formatting help/);
    assert.match(standard, /Preview as customers see it/);
    assert.doesNotMatch(standard, /Choose description defaults/);

    const own = await render({ course });
    assert.match(own, /value="own" data-description-mode checked/);
    assert.doesNotMatch(own, /data-override-mode checked/);
    const added = await render({ course: null });
    assert.match(added, /value="standard" data-description-mode checked/);
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
        assert.match(html, /Facility runs/);
        assert.match(html, />Location<\/label>/);
        assert.match(html, /<select[^>]*name="facility_guid" required>/);
        assert.doesNotMatch(html, /name="facility_guids"/);
        assert.equal((html.match(/<span class="badge badge-warning[^"]*">Sport assignment needed<\/span>/g) || []).length, 1);
        assert.equal((html.match(/data-course-guid=/g) || []).length, 2);
        assert.doesNotMatch(html, /<form[^>]*action="\/admin\/courses\/faqs|<section[^>]*data-sport-faq-card|The FAQ could not be saved/);
    }
});

test('collapsed sport FAQ headings distinguish empty, single and multiple FAQs', async () => {
    for (const count of [0, 1, 2]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            currentProfile: { name: 'Admin', role: 'Administrator' }, isAdmin: true, canSwitchRole: false,
            area: 'admin', activePage: 'sports', error: '', sports: [sport],
            faqs: Array.from({ length: count }, (_, index) => ({ ...faq, guid: `faq-${index}` }))
        });
        const label = count === 0 ? 'No FAQs' : count === 1 ? '1 FAQ' : '2 FAQs';
        assert.ok(html.includes(`data-sport-faq-count>${label}</span>`));
        assert.match(html, /<output[^>]*data-faq-add-feedback aria-live="polite" hidden/);
        assert.match(html, count ? /badge-info/ : /badge-light text-muted/);
        assert.doesNotMatch(html, /<details[^>]*data-sport-faq-details[^>]* open/);
        assert.match(html, /querySelector\('\[data-sport-faq-count\]'\)\.replaceWith\(count\)/);
    }
});

test('sports directory groups FAQs under the matching sport with dropdown add and edit forms', async () => {
    for (const isAdmin of [false, true]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            currentProfile: { name: 'Manager', role: isAdmin ? 'Administrator' : 'Manager' },
            isAdmin, canSwitchRole: false, area: 'admin', activePage: 'sports', error: '',
            sports: [sport, { guid: 'other-sport', name: 'Swimming' }], faqs: [faq]
        });
        assert.equal(/<form[^>]*action="\/admin\/courses\/faqs"/.test(html), isAdmin);
        assert.equal(/<form[^>]*action="\/admin\/courses\/faqs\/update"/.test(html), isAdmin);
        assert.equal(/<form[^>]*action="\/admin\/courses\/faqs\/destroy"/.test(html), isAdmin);
        if (!isAdmin) continue;
        const tennis = html.match(/<article id="sport-[^"]+"[\s\S]*?<\/article>/)[0];
        const swimming = html.match(/<article id="sport-other-sport"[\s\S]*?<\/article>/)[0];
        assert.match(tennis, /<h4[^>]*>FAQs<\/h4>/);
        assert.match(tennis, /data-sport-faq-count>1 FAQ/);
        assert.match(tennis, /<summary[^>]*><h5[^>]*>What should I bring\?<\/h5><\/summary>/);
        assert.match(tennis, /<textarea[^>]*name="answer"[^>]*>&lt;b&gt;A racket&lt;\/b&gt;<\/textarea>/);
        assert.match(tennis, /data-editor-preview="false" data-faq-edit/);
        assert.ok(tennis.indexOf('>Add FAQ</h5>') < tennis.indexOf('>Existing FAQs</h5>'));
        assert.ok(tennis.indexOf('>Existing FAQs</h5>') < tennis.indexOf('data-faq-card='));
        assert.match(tennis, /data-cancel-edit>Cancel<\/button>\s*<button[^>]*form="remove-faq-[^"]+">Remove FAQ<\/button>\s*<button[^>]*>Save FAQ<\/button>/);
        assert.match(tennis, /aria-label="Remove FAQ: What should I bring\?"/);
        assert.match(tennis, /data-card-order-list="\/admin\/courses\/faqs\/order"/);
        assert.match(tennis, /data-card-drag/);
        assert.match(tennis, /data-card-move="up"/);
        assert.doesNotMatch(tennis, />Reorder FAQs<|action="\/admin\/courses\/faqs\/move"/);
        assert.match(tennis, /data-editor-disclosure>\s*<summary[^>]*><h5[^>]*>Add FAQ<\/h5><\/summary>/);
        assert.match(tennis, /<output[^>]*data-faq-feedback[^>]*aria-live="polite"[^>]*hidden/);
        assert.match(swimming, /data-sport-faq-count>No FAQs/);
        assert.doesNotMatch(swimming, /What should I bring/);
        assert.match(html, /async function refreshFaqs/);
    }
});

test('default section counts match FAQ badge styling for empty, singular and plural lists', async () => {
    for (const count of [0, 1, 2]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            currentProfile: { name: 'Admin', role: 'Administrator' }, isAdmin: true, canSwitchRole: false,
            area: 'admin', activePage: 'sports', error: '',
            sports: [{ ...sport, course_description_sections: Array.from({ length: count }, (_, index) => ({
                id: `section-${index}`, heading: 'Heading', text: 'Text'
            })) }],
            faqs: Array.from({ length: count }, (_, index) => ({ ...faq, guid: `faq-${index}` }))
        });
        const sectionBadge = html.match(/<span class="([^"]+)" data-sport-section-count>([^<]+)<\/span>/);
        const faqBadge = html.match(/<span class="([^"]+)" data-sport-faq-count>/);
        assert.equal(sectionBadge[1], faqBadge[1]);
        assert.equal(sectionBadge[2], count ? `${count} default section${count === 1 ? '' : 's'}` : 'No default sections');
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
    assert.doesNotMatch(html, /What should I bring\?|data-course-description|data-course-run|action="\/basket\/add"/);
});
