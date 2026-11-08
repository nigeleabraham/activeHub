const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const { readFile } = require('node:fs/promises');

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

test('FAQ additions highlight only the confirmed new card and announce beside the heading', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const script = source.slice(source.indexOf('    function highlightAddedCard('), source.indexOf('    async function save('));
    for (const addedIds of [[], ['new'], ['new', 'another']]) {
        let reset = false;
        let replacements = 0;
        let initialized = false;
        let fadeStarted = false;
        let finishHighlight;
        const notice = { hidden: true, textContent: '' };
        const highlighted = new Set();
        const focused = [];
        const scrolled = [];
        const row = id => ({
            dataset: { faqCard: id },
            classList: {
                add(name) { assert.equal(name, 'section-added-highlight'); highlighted.add(id); },
                remove(name) { assert.equal(name, 'section-added-highlight'); highlighted.delete(id); }
            },
            querySelector(selector) {
                assert.equal(selector, 'summary');
                return { focus() { focused.push(id); } };
            },
            scrollIntoView() { scrolled.push(id); }
        });
        const previous = row('existing');
        const list = { querySelectorAll: () => [previous, ...addedIds.map(row)] };
        const count = {};
        const card = {
            id: 'sport-faq-one',
            querySelectorAll: () => [previous],
            querySelector(selector) {
                if (selector === '[data-faq-add-feedback]') return notice;
                return { replaceWith() { replacements++; } };
            }
        };
        const form = {
            isConnected: true, inert: true,
            closest: () => card,
            hasAttribute: () => false,
            reset() { reset = true; }
        };
        const entry = { form };
        const context = {
            entry, response: { text: async () => '' }, entries: [entry],
            DOMParser: class {
                parseFromString() {
                    return { getElementById: () => ({
                        querySelector: selector => selector === '[data-sport-faq-list]' ? list : count
                    }) };
                }
            },
            initializeEditors() { initialized = true; },
            resetNoticeFade(node, fade) {
                assert.equal(node, notice);
                assert.equal(fade, true);
                fadeStarted = true;
            },
            window: {
                setTimeout(callback, delay) {
                    assert.equal(delay, 2500);
                    finishHighlight = callback;
                }
            }
        };
        vm.createContext(context);
        vm.runInContext(script, context);
        const result = vm.runInContext('refreshFaqs(entry, response)', context);
        if (addedIds.length !== 1) {
            await assert.rejects(result, /FAQ change could not be confirmed/);
            assert.equal(replacements, 0);
            assert.equal(reset, false);
            assert.equal(highlighted.size, 0);
            continue;
        }
        await result;
        assert.equal(replacements, 2);
        assert.equal(initialized, true);
        assert.equal(reset, true);
        assert.equal(notice.hidden, false);
        assert.equal(notice.textContent, 'FAQ added successfully.');
        assert.equal(fadeStarted, true);
        assert.deepEqual([...highlighted], ['new']);
        assert.deepEqual(focused, ['new']);
        assert.deepEqual(scrolled, ['new']);
        assert.equal(form.inert, false);
        finishHighlight();
        assert.equal(highlighted.size, 0);
    }
    const sports = await readFile(path.join(__dirname, '../views/sports.ejs'), 'utf8');
    assert.match(sports, /<summary[^>]*>.*<output[^>]*data-faq-add-feedback.*aria-live="polite".*<\/summary>/);
    assert.match(sports, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sports-admin \.section-added-highlight > details \{ animation: none; background-color: #d4edda;/);
});

test('every admin navigation renders the shared editor workflow with valid JavaScript', async () => {
    for (const activePage of ['facilities', 'courses', 'sports', 'opening-hours', 'bookings', 'court-configuration', 'profiles', 'roles', 'settings', 'credit-requests', 'credit-refunds']) {
        const html = await ejs.renderFile(navigation, { ...locals, activePage });
        assert.match(html, /dialog\.className = 'admin-unsaved-dialog'/);
        assert.match(html, /Save and continue/);
        assert.match(html, /Discard changes/);
        assert.match(html, /Keep editing/);
        assert.match(html, /Changes saved successfully\./);
        assert.match(html, /\.admin-editor-dirty \{ border-left: 4px solid #805b00 !important;/);
        assert.match(html, /resetNoticeFade\(notice, operation === 'added'\)/);
        assert.match(html, /notice\.classList\.toggle\('sr-only', operation !== 'added'\)/);
        assert.match(html, /row\.animate\(/);
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

test('admin header uses the configured logo or title and links to admin home', async () => {
    for (const hasLogo of [true, false]) {
        const html = await ejs.renderFile(navigation, {
            ...locals, adminBrand: { title: 'Community & Sport', hasLogo }
        });
        assert.match(html, /<header class="admin-site-header">/);
        assert.match(html, /class="admin-site-brand" href="\/admin" aria-label="Community &amp; Sport admin home"/);
        assert.match(html, /Administration/);
        assert.equal(html.includes('src="/site-logo"'), hasLogo);
        if (!hasLogo) assert.match(html, /class="admin-site-title">Community &amp; Sport<\/span>/);
        assert.ok(html.indexOf('class="admin-site-brand"') < html.indexOf('class="admin-navigation"'));
    }
});

test('all admin pages place navigation before main content in document order', async () => {
    for (const view of ['admin-home', 'facilities', 'courses', 'sports', 'opening-hours', 'bookings',
        'credit-requests', 'credit-refunds', 'refunds', 'profiles', 'roles', 'audit', 'settings']) {
        const source = await readFile(path.join(__dirname, `../views/${view}.ejs`), 'utf8');
        assert.equal((source.match(/include\('partials\/navigation'\)/g) || []).length, 1, view);
        assert.ok(source.indexOf("include('partials/navigation')") < source.indexOf('<main'), view);
    }
});

test('admin branding loads for GETs only and does not hide settings errors', async t => {
    const router = require('../routes/front');
    const Settings = require('../models/Settings');
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const branding = admin.stack[1].handle;
    const settings = t.mock.method(Settings, 'getAll', async () => ({ site_title: 'Community Sport' }));
    const logo = t.mock.method(Settings, 'getLogo', async () => ({ content_type: 'image/png' }));
    for (const method of ['GET', 'POST']) {
        const res = { locals: {} };
        let continued = false;
        await branding({ method }, res, () => { continued = true; });
        assert.equal(continued, true);
        assert.equal(res.locals.area, 'admin');
        assert.deepEqual(res.locals.adminBrand, method === 'GET' ? { title: 'Community Sport', hasLogo: true } : undefined);
    }
    assert.equal(settings.mock.callCount(), 1);
    assert.equal(logo.mock.callCount(), 1);
    logo.mock.mockImplementation(async () => null);
    const res = { locals: {} };
    await branding({ method: 'GET' }, res, () => {});
    assert.equal(res.locals.adminBrand.hasLogo, false);
    settings.mock.mockImplementation(async () => { throw new Error('Settings unavailable'); });
    await assert.rejects(branding({ method: 'GET' }, { locals: {} }, () => assert.fail('must not continue')), /Settings unavailable/);
});

test('facility, sport and template confirmations fade alongside names without removing space', async () => {
    const html = await ejs.renderFile(navigation, locals);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const confirmation = script.slice(script.indexOf('    const pageUrl ='), script.indexOf('    const dialog ='));
    for (const [type, hash] of [
        ['facility', 'facility-one'], ['facility', 'edit-another-item'],
        ['sport', 'sport-one'], ['sport', 'edit-another-item'],
        ['template', 'template-one'], ['template', 'edit-another-item'],
        ['profile', 'profile-one'], ['profile', 'edit-another-item']
    ]) {
        let inserted;
        let consumed;
        let onLoad;
        let focused = false;
        let scrolled = false;
        let finishFade;
        const notice = {
            style: {},
            classList: { add() {} },
            setAttribute() {},
            focus(options) { assert.equal(options.preventScroll, true); focused = true; },
            scrollIntoView(options) { assert.equal(options.block, 'nearest'); scrolled = true; }
        };
        const facilityName = 'Riverside & <Sports> Hall';
        const card = {
            dataset: { sportName: facilityName, profileName: facilityName },
            matches: selector => selector === (['sport', 'profile'].includes(type) ? `[data-${type}-guid]` : 'article'),
            querySelector(selector) {
                if (selector !== 'h3') {
                    assert.equal(selector, `[data-${type}-edit-feedback]`);
                    return { append(node) { inserted = node; } };
                }
                assert.equal(selector, 'h3');
                return { textContent: ` ${facilityName} ` };
            },
            before(node) { inserted = node; }
        };
        vm.runInNewContext(confirmation, {
            URL,
            resetNoticeFade(node, fade, onHidden) {
                assert.equal(node, notice);
                assert.equal(fade, true);
                finishFade = onHidden;
            },
            window: {
                sessionStorage: { getItem() { return null; }, removeItem() {} },
                location: { href: `http://localhost/admin/${type === 'profile' ? 'profiles' : type === 'sport' ? 'sports' : type === 'template' ? 'opening-hours' : 'facilities'}?admin_saved=${type}-updated&admin_saved_target=${type}-one#${hash}` },
                history: { state: null, replaceState(_state, _title, url) { consumed = new URL(url); } },
                addEventListener(event, callback) { assert.equal(event, 'load'); onLoad = callback; }
            },
            document: {
                createElement(tag) { assert.equal(tag, 'output'); return notice; },
                querySelector() { return { querySelector() { return { after() { assert.fail('Banner placed at page header'); } }; } }; },
                getElementById(id) { return id === `${type}-one` ? card : null; }
            }
        });
        assert.equal(inserted, notice);
        assert.equal(notice.textContent, `"${facilityName}" updated successfully.`);
        assert.equal(consumed.search, '');
        assert.equal(consumed.hash, `#${hash}`);
        onLoad();
        assert.equal(focused, true);
        assert.equal(scrolled, true);
        finishFade();
        assert.equal(notice.style.visibility, 'hidden');
        assert.notEqual(notice.hidden, true);
    }
});

test('profile creation and editing return action-specific confirmations only after success', async t => {
    const Profiles = require('../models/Profiles');
    const Roles = require('../models/Roles');
    const AuditLog = require('../models/AuditLog');
    const router = require('../routes/front');
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    const profile = { guid, name: 'Alex & <Team>', email: 'alex@example.com', role: 'Resident', roles: ['Resident'] };
    t.mock.method(Roles, 'names', async () => ['Resident', 'Administrator']);
    t.mock.method(AuditLog, 'record', async () => {});
    const create = t.mock.method(Profiles, 'create', async () => profile);
    t.mock.method(Profiles, 'findByGuid', async () => profile);
    const update = t.mock.method(Profiles, 'update', async () => profile);
    for (const [route, expected] of [
        ['/profiles', '/admin/profiles?admin_saved=profile-created'],
        ['/profiles/update', `/admin/profiles?admin_saved=profile-updated&admin_saved_target=profile-${guid}#profile-${guid}`]
    ]) {
        const handler = admin.stack.findLast(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;
        let location;
        await handler({ body: profile, profile: locals.currentProfile }, { redirect(value) { location = value; } });
        assert.equal(location, expected);
    }
    create.mock.mockImplementation(async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    update.mock.mockImplementation(async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    for (const route of ['/profiles', '/profiles/update']) {
        let location;
        const handler = admin.stack.findLast(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;
        await handler({ body: profile, profile: locals.currentProfile }, { redirect(value) { location = value; } });
        assert.equal(location, '/admin/profiles?error=duplicate-email');
    }
});

test('profiles expose stable feedback slots and in-place deletion hooks', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/profiles.ejs'), {
        ...locals, error: '', roles: ['Resident'],
        profiles: [{ guid: 'profile-one', name: 'Alex & <Team>', email: 'alex@example.com', role: 'Resident', credit_pence: 0 }]
    });
    for (const marker of ['data-admin-save-placeholder', 'data-profiles-directory', 'data-profile-count',
        'data-profile-list', 'data-profile-guid', 'data-profile-name', 'data-profile-edit-feedback',
        'data-profile-feedback', 'data-profile-error']) assert.ok(html.includes(marker), marker);
    assert.match(html, /data-profile-name="Alex &amp; &lt;Team&gt;"/);
    assert.match(html, /action="\/admin\/profiles" data-editor-label="Add profile"/);
    const empty = await ejs.renderFile(path.join(__dirname, '../views/profiles.ejs'), {
        ...locals, error: '', roles: ['Resident'], profiles: []
    });
    assert.match(empty, /No profiles have been added yet/);
});

test('sport update redirects to the saved sport only after success', async t => {
    const Sports = require('../models/Sports');
    const router = require('../routes/front');
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    const update = t.mock.method(Sports, 'update', async () => ({ guid }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/sports/update').route.stack[0].handle;
    let location;
    let status;
    const res = { redirect(value) { location = value; }, sendStatus(value) { status = value; } };
    await handler({ body: { guid, name: ' Tennis ' } }, res);
    assert.equal(location, `/admin/sports?admin_saved=sport-updated&admin_saved_target=sport-${guid}#sport-${guid}`);
    assert.deepEqual(update.mock.calls[0].arguments, [guid, 'Tennis']);
    location = undefined;
    update.mock.mockImplementation(async () => null);
    await handler({ body: { guid, name: 'Tennis' } }, res);
    assert.equal(status, 404);
    assert.equal(location, undefined);
});

test('course defaults save independently of the sport name and reject invalid sections', async t => {
    const Sports = require('../models/Sports');
    const router = require('../routes/front');
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    const save = t.mock.method(Sports, 'updateCourseDefaults', async () => ({ guid }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/sports/course-defaults').route.stack[0].handle;
    let location, status;
    const res = { redirect(value) { location = value; }, sendStatus(value) { status = value; } };
    await handler({ body: { guid, course_description_sections: '[]' } }, res);
    assert.deepEqual(save.mock.calls[0].arguments, [guid, []]);
    assert.match(location, /admin_saved=sport-updated/);
    await handler({ body: { guid, course_description_sections: '{}' } }, res);
    assert.equal(status, 400);
    assert.equal(save.mock.calls.length, 1);
    save.mock.mockImplementation(async () => null);
    await handler({ body: { guid, course_description_sections: '[]' } }, res);
    assert.equal(status, 404);
});

test('sports directory exposes deletion feedback and keeps an empty replacement list', async () => {
    for (const sports of [[], [{ guid: 'sport-one', name: 'Tennis' }]]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/sports.ejs'), {
            ...locals, activePage: 'sports', sports, faqs: [], error: ''
        });
        assert.match(html, /<title>Sports and Course Descriptions \| ActiveHub<\/title>/);
        assert.match(html, /<h1 class="h2 mb-1">Sports and Course Descriptions<\/h1>/);
        assert.match(html, /<body class="bg-light sports-admin">/);
        assert.match(html, /\.sports-admin main details:not\(\[open\]\) > summary\s*\{\s*min-height: 1\.5rem;/);
        assert.match(html, /\.sports-admin \[data-sport-guid\]:has\(> details:not\(\[open\]\)\)/);
        assert.match(html, /\.sports-admin \[data-faq-card\]:has\(> details:not\(\[open\]\)\) > button/);
        assert.match(html, /href="\/admin\/sports"[^>]*>Sports and Course Descriptions<\/a>/);
        assert.match(html, /data-sports-directory/);
        assert.match(html, /data-admin-save-placeholder>You can add, remove, and edit sports here\. These can then be assigned to the sports facilities\.<\/p>/);
        assert.match(html, /data-sport-count/);
        assert.match(html, /data-sport-list/);
        assert.match(html, /data-sport-error role="alert" tabindex="-1" hidden/);
        assert.match(html, /<output class="sr-only" data-sport-feedback aria-live="polite"/);
        if (sports.length) assert.match(html, /data-sport-guid="sport-one" data-sport-name="Tennis"/);
        if (sports.length) {
            const card = html.match(/<article id="sport-sport-one"[\s\S]*?<\/article>/)[0];
            const disclosure = card.match(/<details class="admin-disclosure" data-sport-details>[\s\S]*<\/details>/)[0];
            assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
            const summary = disclosure.match(/<summary class="admin-card-summary"[^>]*>([\s\S]*?)<\/summary>/)[1];
            assert.match(summary, /<h3 class="h5 d-inline mb-0 text-break">Tennis<\/h3>\s*<span data-sport-edit-feedback/);
            assert.equal(summary.replace(/<[^>]+>/g, '').trim(), 'Tennis');
            assert.match(disclosure, /<details class="admin-disclosure admin-form-section" data-editor-disclosure>\s*<summary class="admin-card-summary"><h4[^>]*>Sport details<\/h4><\/summary>/);
            assert.match(disclosure, /<h4 id="sport-details-heading-sport-one" class="h6 d-inline mb-0">Sport details/);
            assert.match(disclosure, /<h4 class="h6 d-inline mb-0" id="course-defaults-heading-sport-one">Course defaults/);
            assert.match(disclosure, /<h4 class="h6 d-inline mb-0">FAQs<\/h4>/);
            assert.match(disclosure, /<details id="course-defaults-sport-one" class="admin-disclosure admin-form-section" data-sport-section-details>\s*<summary class="admin-card-summary"><h4[^>]*>Course defaults/);
            assert.doesNotMatch(disclosure, /data-editor-inline|data-edit-toggle|data-edit-panel|>Edit course defaults</);
            assert.match(disclosure, /action="\/admin\/sports\/course-sections\/create"/);
            assert.match(disclosure, /<label for="edit-sport-name-sport-one">Sport name<\/label>/);
            assert.match(disclosure, />Update<\/button>/);
            assert.doesNotMatch(disclosure, /action="\/admin\/sports\/destroy"/);
            assert.match(card, /<\/details>\s*<form method="POST" action="\/admin\/sports\/destroy" data-sport-delete>[\s\S]*aria-label="Delete sport: Tennis">Delete sport<\/button>/);
            assert.equal((card.replace(disclosure, '').match(/<button/g) || []).length, 1);
            assert.doesNotMatch(html, /aria-controls="edit-sport-/);
            assert.doesNotMatch(disclosure, /action="\/admin\/sports\/course-defaults"|>Save course defaults</);
            assert.match(disclosure, /data-editor-disclosure>\s*<summary[^>]*><h5 class="h6 d-inline mb-0">Add section<\/h5><\/summary>/);
            assert.doesNotMatch(html.match(/action="\/admin\/sports\/update"[\s\S]*?<\/form>/)[0], /description-sections/);
            assert.match(html, /select, textarea, \[data-description-sections\]/);
        }
        else assert.match(html, /No sports have been added/);
        assert.match(html, /<details id="add-sport-panel"[^>]*data-editor-disclosure>\s*<summary class="h5 mb-0"><h2 id="add-sport-heading"[^>]*>Add sport<\/h2><\/summary>\s*<form method="POST" action="\/admin\/sports"/);
        assert.match(html, /document\.querySelector\('#add-sport-panel > summary'\)/);
    }
});

test('sport add confirmation fades before restoring the default guidance in the same location', async () => {
    const html = await ejs.renderFile(navigation, locals);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const confirmation = script.slice(script.indexOf('    const noticeTimers ='), script.indexOf('    const dialog ='));
    let replacement;
    const classes = new Set();
    const timers = new Map();
    const notice = {
        style: {},
        classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } },
        setAttribute() {},
    };
    const placeholder = { style: {}, after(node) { replacement = node; } };
    const header = { after() { assert.fail('Confirmation must replace the guidance'); } };
    vm.runInNewContext(confirmation, {
        URL,
        window: {
            sessionStorage: { getItem() { return null; }, removeItem() {} },
            location: { href: 'http://localhost/admin/sports?admin_saved=1' },
            history: { state: null, replaceState() {} },
            setTimeout(callback, delay) { timers.set(delay, callback); return delay; }
        },
        document: {
            createElement() { return notice; },
            querySelector() {
                return { querySelector(selector) { return selector === 'header' ? header : placeholder; } };
            },
            getElementById() { return null; }
        }
    });
    assert.equal(replacement, notice);
    assert.equal(placeholder.style.visibility, 'hidden');
    assert.equal(notice.textContent, 'Changes saved successfully.');
    assert.deepEqual([...timers.keys()], [4000, 4500]);
    timers.get(4000)();
    assert.equal(classes.has('admin-notice-fading'), true);
    assert.equal(replacement, notice);
    timers.get(4500)();
    assert.equal(replacement, notice);
    assert.equal(notice.style.visibility, 'hidden');
    assert.equal(placeholder.style.visibility, '');
    assert.notEqual(notice.hidden, true);
});

test('shared deletion animation waits for fade completion and respects reduced motion', async () => {
    const html = await ejs.renderFile(navigation, locals);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const helper = script.slice(script.indexOf('    async function animateDeletion('), script.indexOf('    async function refreshDirectory('));
    for (const reduced of [false, true]) {
        let finish;
        let completed = false;
        let animated = false;
        const row = {
            style: {},
            animate(frames, options) {
                animated = true;
                assert.equal(frames[0].backgroundColor, '#f8d7da');
                assert.equal(frames.at(-1).opacity, 0);
                assert.equal(options.duration, 800);
                return { finished: new Promise(resolve => { finish = resolve; }) };
            }
        };
        const animate = vm.runInNewContext(`${helper}\nanimateDeletion`, {
            window: { matchMedia: () => ({ matches: reduced }) }
        });
        const pending = animate(row).then(() => { completed = true; });
        assert.equal(row.style.backgroundColor, '#f8d7da');
        assert.equal(animated, !reduced);
        if (!reduced) {
            assert.equal(completed, false);
            finish();
        }
        await pending;
        assert.equal(completed, true);
    }
});

test('admin navigation groups every page once and marks the current page and section', async () => {
    const html = await ejs.renderFile(navigation, { ...locals, activePage: 'court-configuration' });
    const nav = html.match(/<nav[\s\S]*?<\/nav>/)[0];
    const groups = [...nav.matchAll(/<details class="([^"]+)">[\s\S]*?<summary><span class="admin-navigation-label">([^<]+)<\/span><\/summary>([\s\S]*?)<\/details>/g)];
    assert.deepEqual(groups.map(group => group[2]), ['Home Pages', 'Facilities management', 'Bookings management', 'System Admin']);
    assert.deepEqual(groups.map(group => [...group[3].matchAll(/href="([^"]+)"/g)].map(match => match[1])), [
        ['/admin', '/'],
        ['/admin/facilities', '/admin/courses', '/admin/sports', '/admin/opening-hours', '/admin/court-configuration'],
        ['/admin/bookings', '/admin/credit-requests', '/admin/credit-refunds', '/admin/refunds'],
        ['/admin/profiles', '/admin/roles', '/admin/audit', '/admin/settings']
    ]);
    assert.match(groups[1][1], /admin-navigation-group-current/);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
    assert.match(nav, /href="\/admin\/court-configuration" aria-current="page"/);
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

test('course cards expand from the title to the edit form with runs below and delete kept separate', async () => {
    const course = { guid: 'course-one', name: 'Tennis coaching', description: '', facility_guids: ['facility-one'], sport_guids: ['sport-one'] };
    const facility = { guid: 'facility-one', name: 'Sports centre', address: '1 High Street', postcode: 'SW1A 1AA', courses: [course] };
    const html = await ejs.renderFile(path.join(__dirname, '../views/courses.ejs'), {
        ...locals, activePage: 'courses', courses: [course], facilities: [facility],
        sports: [{ guid: 'sport-one', name: 'Tennis' }], faqs: [], error: ''
    });
    assert.match(html, /<details id="add-course-panel-directory"[^>]*data-editor-disclosure>\s*<summary class="h5 mb-0">\s*<h2 id="add-course-heading"[^>]*>Add course<\/h2>\s*<span data-course-add-feedback/);
    assert.match(html, /id="add-course-directory"[^>]*data-editor-success-inline/);
    assert.match(html, /data-course-facility/);
    assert.match(html, /data-course-list/);
    assert.match(html, /data-course-guid="course-one" data-course-name="Tennis coaching"/);
    assert.match(html, /<output class="alert alert-success" data-course-feedback aria-live="polite" aria-atomic="true"/);
    assert.match(html, /data-course-count/);
    const addForm = html.match(/<form[^>]*id="add-course-directory"[\s\S]*?<\/form>/)[0];
    assert.doesNotMatch(addForm, /data-course-add-feedback/);
    assert.doesNotMatch(html, /data-edit-toggle[^>]*aria-controls="(?:add-course-panel|edit-course)-/);
    const card = html.match(/<article id="course-course-one"[\s\S]*?<\/article>/)[0];
    const disclosure = card.match(/<details class="admin-disclosure" data-course-edit data-editor-disclosure>[\s\S]*<\/details>/)[0];
    assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
    const summary = disclosure.match(/<summary class="admin-card-summary"[^>]*>([\s\S]*?)<\/summary>/)[1];
    assert.equal(summary.replace(/<[^>]+>/g, '').trim(), 'Tennis coaching');
    assert.ok(!card.includes('data-course-description'), 'Course description is not replayed on the card');
    assert.match(disclosure, /<\/summary>\s*<form method="POST" action="\/admin\/courses\/update" data-editor-preview="false" data-editor-label="Edit Tennis coaching">/);
    assert.match(disclosure, /class="admin-form-section-title">Facility runs \(0\)<\/h4>/);
    assert.ok(disclosure.indexOf('/admin/courses/update') < disclosure.indexOf('Facility runs'));
    assert.doesNotMatch(disclosure, /action="\/admin\/courses\/destroy"/);
    assert.match(card.replace(disclosure, ''), /action="\/admin\/courses\/destroy"[\s\S]*aria-label="Delete Tennis coaching">Delete<\/button>/);
    const editForm = html.match(/<form[^>]*action="\/admin\/courses\/update"[\s\S]*?<\/form>/)[0];
    assert.doesNotMatch(editForm, /name="facility_guid"/);
    assert.doesNotMatch(editForm, /name="facility_guids"/);
    assert.match(editForm, /name="sport_guids" value="sport-one" checked/);
    assert.match(html, /'\[data-course-edit\] > summary'/);
    assert.match(html, /card\.querySelector\('#add-course-panel-directory > summary'\)/);
    assert.match(html, /\{ kind: 'collapse', entry \}/);
    assert.match(html, /main \.form-control,\s*main \.custom-select \{ max-width: none; \}/);
});

test('course updates accept sport and facility assignments', async t => {
    const Courses = require('../models/Courses');
    const router = require('../routes/front');
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    const update = t.mock.method(Courses, 'update', async () => ({ guid, facility_guid: guid }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/courses/update' && layer.route.methods.post).route.stack[0].handle;
    for (const facilityGuid of [guid, '123e4567-e89b-42d3-a456-426614174001']) {
        let location;
        await handler({ body: { guid, name: ' Tennis ', description: ' Coaching ', facility_guid: facilityGuid, sport_guids: [guid], start_date: '2026-10-01', end_date: '2026-12-01' } }, {
            redirect(value) { location = value; },
            sendStatus(value) { assert.fail(`Unexpected status ${value}`); }
        });

        assert.equal(location, `/admin/courses?admin_saved=course-updated&admin_saved_target=course-${guid}#course-${guid}`);
        assert.deepEqual(update.mock.calls.at(-1).arguments, [guid, { name: 'Tennis', description: 'Coaching', sport_guids: [guid] }]);
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
        const req = { body: { guid, name: 'Tennis', facility_guid: guid, sport_guids: guid, start_date: '2026-10-01', end_date: '2026-12-01' } };
        await handler(req, res);
        assert.equal(location, `/admin/courses?admin_saved=${confirmation}`);
        operation.mock.mockImplementation(async () => { throw new Error('Database unavailable'); });
        location = undefined;
        await handler(req, res);
        assert.equal(status, 500);
        assert.equal(location, undefined);
    }
});

test('settings use title-led facility-style cards and preserve the logo upload workflow', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/settings.ejs'), {
        ...locals,
        saved: false,
        error: null,
        maxLength: 60,
        siteTitle: 'ActiveHub',
        organisationError: false,
        organisationName: 'Council',
        hasLogo: true,
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
    assert.match(html, /type="submit" form="remove-site-logo">Remove logo/);
    assert.match(html, /<form id="remove-site-logo" method="POST" action="\/admin\/settings\/logo\/remove" hidden><\/form>/);
    const logoActions = html.slice(html.indexOf('action="/admin/settings/logo"'), html.indexOf('id="remove-site-logo"'));
    assert.ok(logoActions.indexOf('>Cancel</button>') < logoActions.indexOf('>Remove logo</button>'));
    assert.ok(logoActions.indexOf('>Remove logo</button>') < logoActions.indexOf('>Upload logo</button>'));
    assert.equal((logoActions.match(/btn-sm/g) || []).length, 3);
    assert.doesNotMatch(html, /getElementById\('logo-upload'\)\.addEventListener/);
    const identity = html.match(/<section class="mb-3" aria-labelledby="site-identity-heading">[\s\S]*?<\/section>/)[0];
    for (const id of ['site-title-heading', 'organisation-heading', 'site-logo-heading']) {
        assert.ok(identity.includes(`id="${id}"`));
    }
    assert.doesNotMatch(identity, /id="membership-scheme-heading"/);
    assert.equal((identity.match(/<details\b/g) || []).length, 1);
    assert.equal((identity.match(/<summary\b/g) || []).length, 1);
    assert.equal((identity.match(/data-editor-inline/g) || []).length, 3);
    const creditSettings = html.match(/<section class="mb-3" aria-labelledby="credit-request-settings-heading">[\s\S]*?<\/section>/)[0];
    assert.equal((creditSettings.match(/<details\b/g) || []).length, 1);
    assert.equal((creditSettings.match(/<summary\b/g) || []).length, 1);
    assert.equal((creditSettings.match(/data-editor-inline/g) || []).length, 3);
    assert.match(creditSettings, />Credit and refund settings<\/h2>/);
    assert.match(creditSettings, /id="refunds-heading"/);
    assert.match(creditSettings, /id="request-window"/);
    assert.match(creditSettings, /id="credit-lifetime-heading"/);
    const cards = [
        ...[...identity.matchAll(/<div class="admin-form-section[^"]*" data-settings-item>[\s\S]*?<\/form>/g)].map(match => match[0]),
        html.match(/<details class="[^"]+" data-editor-disclosure>[\s\S]*?<\/details>/)[0],
        ...[...creditSettings.matchAll(/<div class="admin-form-section[^"]*" data-credit-settings-item>[\s\S]*?<\/form>/g)].map(match => match[0]),
        [...html.matchAll(/<details class="[^"]+" data-editor-disclosure>[\s\S]*?<\/details>/g)].at(-1)[0]
    ];
    assert.equal(cards.length, 8);
    const actions = ['', '/organisation', '/logo', '/membership-scheme',
        '/refunds', '/credit-request-period', '/credit-lifetime', '/credit-slot-auto-approval'];
    const titles = ['Site title', 'Organisation name', 'Logo', 'Membership scheme',
        'Bank and external refunds', 'Credit request period', 'Credit lifetime', 'Weather credit slot auto-approval'];
    cards.forEach((card, index) => {
        if (index < 3 || (index >= 4 && index <= 6)) {
            assert.match(card, /data-editor-inline/);
            assert.ok(card.includes(`>${titles[index]}</h3>`));
            assert.doesNotMatch(card, /<details|<summary/);
        } else {
            assert.match(card, /<details class="admin-disclosure[^"]*" data-editor-disclosure>/);
            assert.ok(card.includes(`>${titles[index]}</h2></summary>`));
        }
        assert.ok(card.includes(`action="/admin/settings${actions[index]}"`));
        assert.match(card, /data-editor-label="[^"]+" data-editor-preview="false"/);
        assert.equal((card.match(/data-cancel-edit/g) || []).length, 1);
        assert.ok(card.indexOf('data-cancel-edit') < card.indexOf('type="submit"'));
        assert.doesNotMatch(card, /<details[^>]*\bopen\b/);
    });
    assert.match(html, /\.settings-admin main \.form-control \{ max-width: none; \}/);
    assert.match(html, /data-admin-save-placeholder>Expand a setting to edit it/);
    assert.match(html, /name="credit-slot-auto-approval"|name="enabled"/);
    assert.match(html, /name="days" type="number" min="1" max="365"/);
    assert.match(html, /name="days" type="number" min="1" max="36500"/);
});

test('opening hours templates has a collapsible add card and reserved guidance', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/opening-hours.ejs'), {
        ...locals, activePage: 'opening-hours', templates: [],
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    });
    assert.match(html, /<h1[^>]*>Opening hours templates<\/h1>/);
    assert.match(html, /href="\/admin\/opening-hours"[^>]*>Opening hours templates/);
    assert.match(html, /<details id="add-template-panel"[^>]*data-editor-disclosure>\s*<summary class="h5 mb-0"><h2 id="new-template-heading"[^>]*>Add template<\/h2><\/summary>/);
    assert.doesNotMatch(html, /data-edit-toggle[^>]*aria-controls="add-template-panel"/);
    assert.match(html, /document\.querySelector\('#add-template-panel > summary'\)/);
    assert.match(html, /class="admin-save-feedback mb-4"/);
    assert.match(html, /data-admin-save-placeholder>You can add, remove, and edit opening hours templates/);
    assert.match(html, /data-template-list>\s*<p[^>]*>No opening-hours templates yet\.<\/p>\s*<\/div>/);
    const form = html.match(/<form[^>]*action="\/admin\/opening-hours"[\s\S]*?<\/form>/)[0];
    assert.equal((form.match(/data-day-rule/g) || []).length, 7);
    assert.match(form, /data-cancel-edit>Cancel/);
    assert.match(form, /name="dawn_override"/);
    assert.match(form, /name="dusk_override"/);
});

test('facility creation drops down from a single card title with grouped fields and optional advanced coordinates', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/facilities.ejs'), {
        ...locals, facilities: [], sports: [], openingHoursTemplates: []
    });
    assert.match(html, /<details id="add-facility-panel"[^>]*data-editor-disclosure>\s*<summary class="h5 mb-0"><h2 id="add-facility-heading"[^>]*>Add facility<\/h2><\/summary>/);
    const disclosure = html.match(/<details id="add-facility-panel"[\s\S]*?<\/form>\s*<\/details>/)[0];
    assert.doesNotMatch(disclosure, /data-edit-panel|data-edit-toggle|facility-add-toggle|fa-chevron-down/);
    assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
    assert.match(html, /if \(!details\.hasAttribute\('data-editor-disclosure'\)\)/);
    assert.match(html, /main \.facility-details-fields \.form-control \{ max-width: none; \}/);
    assert.match(html, /data-admin-save-placeholder>You can add, remove, and edit facilities here/);
    assert.doesNotMatch(html, /card\.scrollIntoView|Facility created\./);
    for (const title of ['Add facility', 'Facility details', 'Activities', 'Booking arrangements', 'Advanced location settings']) {
        assert.ok(html.includes(title));
    }
    assert.match(html, /type="radio" name="booking_mode" value="in_app" checked required/);
    assert.match(html, /type="radio" name="booking_mode" value="external"\s+required/);
    assert.match(html, /Create facility/);
    assert.equal((html.match(/id="add-facility-panel"/g) || []).length, 1);
    assert.equal((html.match(/>Add facility<\/h2>/g) || []).length, 1);
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
        ...locals, facilities: [facility, { ...facility, guid: 'second', booking_mode: 'in_app',
            courses: [{ guid: 'course-one', name: 'Junior tennis' }] }],
        sports: [sport, { guid: 'netball', name: 'Netball' }], openingHoursTemplates: [template]
    });
    const forms = [...html.matchAll(/<form\b[^>]*data-facility-form[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
    assert.equal(forms.length, 3);
    for (const form of forms) {
        assert.doesNotMatch(form, /max-width/);
        assert.doesNotMatch(form, /form-group col-md-8|form-group col-md-4/);
        assert.match(form, /fieldset class="admin-form-section facility-details-fields"/);
        assert.equal((form.match(/<fieldset class="admin-form-section/g) || []).length, 3);
        assert.equal((form.match(/<legend class="admin-form-section-title">/g) || []).length, 3);
        const order = ['name', 'address', 'postcode', 'description'].map(name => form.indexOf(`name="${name}"`));
        assert.deepEqual([...order].sort((a, b) => a - b), order);
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
    const cards = [...html.matchAll(/<article id="facility-[\s\S]*?<\/article>/g)].map(match => match[0]);
    assert.equal(cards.length, 2);
    for (const card of cards) {
        const disclosure = card.match(/<details class="admin-disclosure" data-facility-edit data-editor-disclosure>[\s\S]*<\/details>/)[0];
        assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
        const summary = disclosure.match(/<summary class="admin-card-summary pr-5">([\s\S]*?)<\/summary>/)[1];
        assert.match(summary, /<h3 class="h5 d-inline mb-0 text-break">Hall &amp; courts<\/h3>/);
        assert.match(summary, /data-facility-edit-feedback/);
        assert.equal(summary.replace(/<[^>]+>/g, '').trim(), 'Hall &amp; courts');
        assert.match(disclosure, /data-facility-form/);
        assert.match(disclosure, /data-editor-label="Edit Hall &amp; courts"/);
        const outside = card.replace(disclosure, '');
        for (const replayed of ['1 High Street, SW1A 1AA', 'Open in Google Maps', 'Booking method:', 'Open external booking site', 'Closed today', 'data-facility-summary', '>Edit facility<']) {
            assert.ok(!card.includes(replayed), replayed);
        }
        assert.match(outside, /action="\/admin\/facilities\/destroy"/);
        assert.doesNotMatch(disclosure, /action="\/admin\/facilities\/destroy"/);
    }
    assert.doesNotMatch(cards[0], /Courses \(/);
    const courses = cards[1].match(/<section class="admin-form-section[^"]*"[^>]*>[\s\S]*?<\/section>/)[0];
    assert.ok(cards[1].indexOf('data-facility-form') < cards[1].indexOf(courses), 'Courses follow the form');
    assert.match(courses, /<h4 id="facility-courses-heading-second" class="admin-form-section-title">Courses \(1\)<\/h4>/);
    assert.match(courses, /Junior tennis/);
    assert.match(courses, /action="\/admin\/facilities\/courses\/destroy"[\s\S]*value="course-one"/);
    assert.match(courses, /href="\/admin\/courses">Manage courses/);
    assert.match(html, /form\.parentElement\.hasAttribute\('data-editor-disclosure'\) \|\| form\.parentElement\.querySelectorAll\('form'\)\.length === 1/);
    assert.match(html, /\.admin-disclosure\[open\] > summary \{ margin-bottom: 1rem !important; \}/);
    assert.doesNotMatch(html, /article:has\(/);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, target] of html.matchAll(/<label[^>]*for="([^"]+)"/g)) {
        assert.ok(ids.includes(target), `Missing label target ${target}`);
    }
});

test('court configuration facilities, sports, resources and courts expand from their titles', async () => {
    const sport = { guid: 'tennis', name: 'Tennis', allowed_months: [1, 2] };
    const resource = { guid: 'net', name: 'Net A', claim_count: 1 };
    const facility = {
        guid: 'centre', name: 'Sports centre', address: '1 High Street', postcode: 'SW1A 1AA',
        sports: [sport], resources: [resource],
        options: [{ guid: 'court-one', name: 'Court 1', sport_guid: 'tennis', sport_name: 'Tennis', resources: [resource] }],
        bookings: []
    };
    const html = await ejs.renderFile(path.join(__dirname, '../views/bookings.ejs'), {
        ...locals, activePage: 'court-configuration', facilities: [facility], error: undefined, created: 0
    });
    const card = html.match(/<article id="court-facility-centre"[\s\S]*<\/section>\s*<\/details>\s*<\/article>/)[0];
    const outer = card.match(/<details class="admin-disclosure">\s*<summary class="admin-card-summary">([\s\S]*?)<\/summary>/);
    assert.match(outer[1], /<h2 id="facility-centre" class="h5 d-inline mb-0 text-break">Sports centre<\/h2>/);
    assert.ok(!card.includes('1 High Street'), 'Address is not replayed on the card');
    for (const title of ['Sport booking months', 'Resources (1)', 'Bookable courts (1)']) {
        assert.ok(card.includes(`class="admin-form-section-title">${title}</h3>`), title);
    }
    for (const [title, action] of [
        ['Tennis', 'sports/months'], ['Add resource', 'resources'], ['Net A', 'resources/update'],
        ['Add bookable court', 'options'], ['Court 1 <span class="text-muted font-weight-normal">· Tennis</span>', 'options/update']
    ]) {
        const pattern = new RegExp(`<details class="admin-disclosure" data-editor-disclosure>\\s*<summary class="admin-card-summary"[^>]*><h4 class="h6 d-inline mb-0[^"]*">${title}</h4>[\\s\\S]*?</summary>\\s*<form method="POST" action="/admin/bookings/${action}"`);
        assert.match(card, pattern, title);
    }
    for (const action of ['resources/destroy', 'options/destroy']) {
        const form = card.match(new RegExp(`<form class="position-absolute"[^>]*action="/admin/bookings/${action}"`));
        assert.ok(form, action);
        assert.ok(card.lastIndexOf('</details>', form.index) > card.lastIndexOf('<details', form.index), `${action} sits outside the expander`);
    }
    assert.ok(!card.includes('>Edit court claims<') && !card.includes('Uses: Net A'));
    assert.equal((card.match(/data-editor-preview="false"/g) || []).length, 3);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, target] of html.matchAll(/<label[^>]*for="([^"]+)"/g)) {
        assert.ok(ids.includes(target), `Missing label target ${target}`);
    }
});
