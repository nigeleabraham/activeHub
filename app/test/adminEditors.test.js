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

test('credit decisions bypass generated Edit and Cancel controls', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const start = source.indexOf("        if ((!new URL(form.action).pathname");
    const guard = source.slice(start, source.indexOf('        if (!form.id)', start));
    let skipped = false;
    vm.runInNewContext(`(function () { ${guard} throw new Error('Decision entered editor setup'); })()`, {
        URL,
        form: {
            action: 'http://localhost/admin/credit-requests/decide',
            matches(selector) {
                skipped = selector.includes('[action="/admin/credit-requests/decide"]');
                return skipped;
            },
            querySelector() { return {}; }
        }
    });
    assert.equal(skipped, true);
});

test('collapsed bookings management cards use compact spacing without changing expanded cards', async () => {
    const source = await readFile(path.join(__dirname, '../views/bookings.ejs'), 'utf8');
    assert.match(source, /\[data-booking-management-card\] \{ padding: 0\.75rem 1rem !important; \}/);
    assert.match(source, /\[data-booking-management-card\] > \[data-facility-bookings\] > summary \{ min-height: 1\.75rem; \}/);
    assert.match(source, /> summary \{ min-height: 1\.75rem; margin-bottom: 0 !important; \}/);
    assert.match(source, /<section class="bg-white border rounded shadow-sm p-4 mb-4" aria-labelledby="facility-<%= facility.guid %>" data-booking-management-card>/);
    const flow = await readFile(path.join(__dirname, '../views/partials/booking-flow.ejs'), 'utf8');
    assert.match(flow, /<details class="admin-disclosure" data-facility-bookings/);
    assert.match(flow, /facility.name %> — Bookings<\/h2>/);
    assert.doesNotMatch(flow, />Bookings<\/summary>/);
});

test('facility deletion explains its effects and cancellation prevents submission', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const start = source.indexOf('        if (form.matches(\'form[action="/admin/facilities/destroy"]\'))');
    const script = source.slice(start, source.indexOf('        const facilityDelete =', start));
    for (const accepted of [false, true]) {
        let prevented = false;
        let focused = false;
        let prompt;
        const context = vm.createContext({
            form: {
                matches() { return true; },
                dataset: { facilityDeleteName: 'Hall & "courts"' },
                querySelector() { return { focus() { focused = true; } }; }
            },
            event: { preventDefault() { prevented = true; } },
            window: { confirm(message) { prompt = message; return accepted; } }
        });
        vm.runInContext(`(function () { ${script} })()`, context);
        assert.ok(prompt.includes('Delete facility "Hall & "courts""?'));
        assert.match(prompt, /bookings, booking resources and options, sport assignments, and course runs and sessions/);
        assert.match(prompt, /Shared course details and runs at other facilities are kept/);
        assert.match(prompt, /does not issue refunds and cannot be undone/);
        assert.match(prompt, /Select Cancel to keep this facility/);
        assert.equal(prevented, !accepted);
        assert.equal(focused, !accepted);
    }
});

test('sport deletion confirmation names the current sport and cancellation prevents deletion', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const start = source.indexOf('            if (sportDelete) {', source.indexOf('const directoryDelete ='));
    const script = source.slice(start, source.indexOf('            const button =', start));
    for (const accepted of [false, true]) {
        let focused = false;
        let proceeded = false;
        let prompt;
        const context = vm.createContext({
            sportDelete: true,
            form: {
                closest() { return { dataset: { sportName: 'Renamed Tennis' } }; },
                querySelector() { return { focus() { focused = true; } }; }
            },
            window: { confirm(message) { prompt = message; return accepted; } },
            proceed() { proceeded = true; }
        });
        vm.runInContext(`(function () { ${script}\nproceed(); })()`, context);
        assert.match(prompt, /Delete sport "Renamed Tennis"\?/);
        assert.match(prompt, /standard course description, FAQs and facility assignments/);
        assert.match(prompt, /Select Cancel to keep this sport/);
        assert.equal(proceeded, accepted);
        assert.equal(focused, !accepted);
    }
});

test('course deletion confirmation names the course and cancellation stops deletion', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const start = source.indexOf('            if (form.matches(\'form[action="/admin/courses/destroy"]\'))');
    const script = source.slice(start, source.indexOf('            if (runDelete', start));
    for (const accepted of [false, true]) {
        let focused = false;
        let proceeded = false;
        let prompt;
        vm.runInNewContext(`(function () { ${script} proceed(); })()`, {
            form: {
                matches() { return true; },
                closest() { return { dataset: { courseName: 'Junior tennis' } }; },
                querySelector() { return { focus() { focused = true; } }; }
            },
            window: { confirm(message) { prompt = message; return accepted; } },
            proceed() { proceeded = true; }
        });
        assert.match(prompt, /Delete course "Junior tennis"\?/);
        assert.match(prompt, /all its runs and sessions at every facility/);
        assert.match(prompt, /Facilities, sports and their shared descriptions and FAQs are kept/);
        assert.match(prompt, /does not issue refunds and cannot be undone/);
        assert.match(prompt, /Select Cancel to keep this course/);
        assert.equal(proceeded, accepted);
        assert.equal(focused, !accepted);
    }
    assert.match(source, /operation === 'deleted' && sourceRow[\s\S]*?course deletion could not be confirmed[\s\S]*?await animateDeletion\(sourceRow\)/);
});

test('deleted course shows its title in a banner that stays inside the fading card', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const start = source.indexOf('            const deletionNotice =', source.indexOf('    async function refreshCourses('));
    const script = source.slice(start, source.indexOf('\n        }', start));
    let notice;
    let animated = false;
    const row = {
        dataset: { courseName: 'Tennis & <beginners>' },
        querySelector(selector) {
            assert.equal(selector, '[data-course-delete-slot]');
            return { append(value) { notice = value; } };
        }
    };
    await vm.runInNewContext(`(async () => { ${script} })()`, {
        sourceRow: row,
        document: { createElement(tag) {
            assert.equal(tag, 'output');
            return { setAttribute(name, value) { this[name] = value; } };
        } },
        async animateDeletion(value) {
            assert.equal(value, row);
            assert.equal(notice.textContent, '"Tennis & <beginners>" deleted successfully.');
            assert.match(notice.className, /alert-danger/);
            assert.equal(notice.title, notice.textContent);
            assert.equal(notice['aria-live'], 'polite');
            assert.equal(notice['data-course-delete-feedback'], '');
            animated = true;
        }
    });
    assert.equal(animated, true);
});

test('sport deletion adds a red title banner and border before the card animation', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const start = source.indexOf("        if (type === 'sport') {", source.indexOf('    async function refreshDirectory('));
    const script = source.slice(start, source.indexOf('        await animateDeletion(row,', start));
    assert.match(source, /await animateDeletion\(row, type === 'sport' \? 1000 : 0, type === 'sport' \? 800 \/ 0\.75 : 800\)/);
    let notice;
    const classes = new Set();
    vm.runInNewContext(script, {
        type: 'sport',
        row: {
            querySelector(selector) {
                assert.equal(selector, '[data-sport-edit-feedback]');
                return { replaceChildren(value) { notice = value; } };
            },
            classList: { add(value) { classes.add(value); } }
        },
        document: { createElement() { return { setAttribute(name, value) { this[name] = value; } }; } }
    });
    assert.equal(notice.textContent, 'Sport deleted.');
    assert.equal(notice.className, 'alert alert-danger mb-0');
    assert.equal(notice['aria-live'], 'polite');
    assert.ok(classes.has('admin-sport-deleting'));
    const styles = await readFile(path.join(__dirname, '../views/sports.ejs'), 'utf8');
    assert.match(styles, /border-color: #dc3545 !important;\s*outline: 3px solid #dc3545/);
});

test('facility deletion verifies removal before animating and focuses the remaining card or Add facility', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const script = source.slice(source.indexOf('    async function refreshDirectory('), source.indexOf("<%- include('card-order-behaviour')"));
    for (const last of [false, true]) {
        let removed = false;
        let animated = false;
        let focused = false;
        let replaced = false;
        let confirmed = false;
        const target = { focus() { focused = true; } };
        const remaining = { querySelector() { return target; } };
        const row = {
            getAttribute(name) { return name === 'data-facility-guid' ? 'deleted-guid' : 'Town hall'; },
            remove() { assert.equal(animated, true); removed = true; }
        };
        const count = {};
        const feedback = {};
        const newList = { querySelectorAll() { return confirmed ? [] : [row]; } };
        const list = { replaceWith(value) { assert.equal(value, newList); replaced = true; } };
        const directory = {
            querySelectorAll() { return removed ? (last ? [] : [remaining]) : [row, ...(last ? [] : [remaining])]; },
            querySelector(selector) {
                if (selector === '[data-facility-count]') return count;
                if (selector === '[data-facility-feedback]') return feedback;
                if (selector === '[data-facility-list]') return list;
                return last ? null : remaining;
            }
        };
        const form = { closest(selector) {
            if (selector === '[data-facilities-directory]') return directory;
            assert.equal(selector, '[data-facility-guid]');
            return row;
        } };
        const context = vm.createContext({
            form, response: { async text() { return ''; } }, entries: [], active: null,
            DOMParser: class { parseFromString() { return { querySelector(selector) {
                if (selector === '[data-facility-list]') return newList;
                if (selector === '[data-facility-count]') return { textContent: last ? '0' : '1' };
                return null;
            } }; } },
            async animateDeletion(value) { assert.equal(value, row); animated = true; },
            document: { querySelector(selector) { assert.equal(selector, '#add-facility-panel > summary'); return target; } }
        });
        vm.runInContext(script, context);
        await assert.rejects(vm.runInContext("refreshDirectory(form, response, 'facility')", context), /deletion could not be confirmed/);
        assert.equal(animated, false);
        confirmed = true;
        await vm.runInContext("refreshDirectory(form, response, 'facility')", context);
        assert.equal(removed, true);
        assert.equal(focused, true);
        assert.equal(replaced, last);
        assert.equal(count.textContent, last ? '0' : '1');
        assert.equal(feedback.textContent, '"Town hall" deleted successfully.');
    }
});

test('formatted text saves collapse and focus their panel with a quick green outline', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const script = source.slice(source.indexOf('    const textSaveCleanups ='), source.indexOf('    async function animateRunDeletion('));
    const classes = new Set();
    let focused = false;
    let cleanup;
    let notice;
    let fades = 0;
    const listeners = new Set();
    const entry = {
        form: { action: 'http://localhost/admin/courses/faqs/save' },
        toggle: {
            focus() { focused = true; },
            querySelector(selector) {
                return selector === '[data-text-save-slot]' ? { append(value) { notice = value; } } : notice;
            }
        },
        details: {
            open: true,
            addEventListener(type, listener) { assert.equal(type, 'animationend'); listeners.add(listener); },
            removeEventListener(type, listener) { listeners.delete(listener); },
            scrollIntoView(options) { assert.equal(options.behavior, 'instant'); },
            classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); } }
        }
    };
    const context = vm.createContext({
        entry, active: entry, close(item) { item.details.open = false; },
        URL,
        document: { createElement(tag) {
            assert.equal(tag, 'output');
            return { setAttribute() {} };
        } },
        resetNoticeFade(value, fade) {
            assert.equal(value, notice);
            assert.equal(fade, false);
            fades++;
        },
        window: {
            matchMedia() { return { matches: false }; },
            clearTimeout() {},
            setTimeout(callback, delay) { assert.equal(delay, 1500); cleanup = callback; }
        }
    });
    vm.runInContext(script, context);
    vm.runInContext('finishTextSave(entry)', context);
    assert.equal(entry.details.open, false);
    assert.equal(focused, true);
    assert.equal(context.active, null);
    assert.equal(notice.textContent, 'FAQs saved.');
    assert.equal(notice.hidden, false);
    for (const [action, message] of [
        ['/admin/sports/update', 'Sport details updated.'],
        ['/admin/sports/course-defaults', 'Course defaults saved.']
    ]) {
        entry.form.action = `http://localhost${action}`;
        vm.runInContext('finishTextSave(entry)', context);
        assert.equal(notice.textContent, message);
    }
    assert.equal(fades, 3);
    assert.match(source, /\[data-text-save-feedback\]\[hidden\] \{ display: none !important; \}/);
    assert.deepEqual([...classes], ['admin-text-saved']);
    assert.equal(cleanup, undefined);
    assert.equal(listeners.size, 1);
    const finishAnimation = [...listeners][0];
    finishAnimation({ target: notice, animationName: 'admin-text-notice-saved' });
    assert.equal(notice.hidden, false);
    finishAnimation({ target: entry.details, animationName: 'admin-text-saved' });
    assert.equal(classes.size, 0);
    assert.equal(notice.hidden, true);
    assert.equal(listeners.size, 0);
    context.window.matchMedia = () => ({ matches: true });
    vm.runInContext('finishTextSave(entry)', context);
    assert.equal(notice.hidden, false);
    cleanup();
    assert.equal(notice.hidden, true);
    assert.equal(classes.size, 0);
    assert.equal(listeners.size, 0);
    assert.match(source, /\.admin-text-saved \[data-text-save-feedback\] \{ animation: admin-text-notice-saved 1\.5s ease-in-out both; \}/);
    assert.match(source, /\[data-text-save-feedback\] \{\s*transition: none;/);
    assert.match(source, /@keyframes admin-text-notice-saved \{\s*0%, 25% \{ opacity: 1; \}\s*100% \{ opacity: 0; \}/);
    assert.match(source, /form\[action="\/admin\/sports\/update"\]'\)\) \{\s*finishTextSave\(entry\)/);
    assert.match(source, /row\.querySelector\('\[data-sport-details\] > summary h3'\)\.textContent = name/);
    assert.match(source, /field\.tagName === 'INPUT' && field\.name === 'name'/);
});

test('run deletion clears save feedback and holds a visible red outline before fading', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const script = source.slice(source.indexOf('    async function animateRunDeletion('), source.indexOf('    function focusSavedCourseRun('));
    const classes = new Set(['admin-run-saved']);
    const panel = { hidden: false };
    let release;
    let faded = false;
    let scrolled = false;
    const run = {
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); }
        },
        querySelector(selector) {
            return selector === '[data-edit-panel]' ? panel : {
                setAttribute(name, value) {
                    assert.equal(name, 'aria-expanded');
                    assert.equal(value, 'false');
                }
            };
        },
        scrollIntoView(options) {
            assert.equal(options.behavior, 'instant');
            scrolled = true;
        }
    };
    const context = vm.createContext({
        run,
        window: { setTimeout(callback, delay) {
            assert.equal(delay, 1200);
            release = callback;
        } },
        async animateDeletion(node) { assert.equal(node, run); faded = true; }
    });
    vm.runInContext(script, context);
    const completion = vm.runInContext('animateRunDeletion(run)', context);
    assert.equal(panel.hidden, true);
    assert.equal(scrolled, true);
    assert.deepEqual([...classes], ['admin-run-deleting']);
    assert.equal(faded, false);
    release();
    await completion;
    assert.equal(faded, true);
    assert.match(source, /\.admin-run-deleting \{ animation: none; border-color: #dc3545; box-shadow: 0 0 0 3px #dc3545; \}/);
});

test('saved course runs close their editor and focus the run inside expanded ancestors', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const script = source.slice(source.indexOf('    function focusSavedCourseRun('), source.indexOf('    async function refreshCourses('));
    const group = { tagName: 'DETAILS', open: false, parentElement: null };
    const course = { tagName: 'DETAILS', open: false, parentElement: group };
    const runs = { tagName: 'DETAILS', open: false, parentElement: course };
    const panel = { hidden: false };
    let focused = false;
    let scrolled = false;
    let finishHighlight;
    const highlighted = new Set();
    const toggle = {
        setAttribute(name, value) {
            assert.equal(name, 'aria-expanded');
            assert.equal(value, 'false');
        },
        focus(options) {
            assert.equal(options.preventScroll, true);
            focused = true;
        }
    };
    const run = {
        dataset: { runGuid: 'saved-run' }, parentElement: runs,
        classList: {
            add(name) { highlighted.add(name); },
            remove(name) { highlighted.delete(name); }
        },
        querySelector(selector) {
            if (selector === '[data-edit-panel]') return panel;
            assert.equal(selector, '[data-edit-toggle]');
            return toggle;
        },
        scrollIntoView(options) {
            assert.equal(options.block, 'nearest');
            scrolled = true;
        }
    };
    const row = {
        querySelectorAll(selector) {
            assert.equal(selector, '[data-admin-run-card]');
            return [{ dataset: { runGuid: 'other-run' } }, run];
        }
    };
    const context = vm.createContext({
        row,
        window: { setTimeout(callback, delay) {
            assert.equal(delay, 1500);
            finishHighlight = callback;
        } }
    });
    vm.runInContext(script, context);
    vm.runInContext("focusSavedCourseRun(row, 'saved-run')", context);
    assert.equal(panel.hidden, true);
    assert.equal(focused, true);
    assert.equal(scrolled, true);
    assert.ok(group.open && course.open && runs.open);
    assert.deepEqual([...highlighted], ['admin-run-saved']);
    finishHighlight();
    assert.equal(highlighted.size, 0);
    assert.match(source, /@keyframes admin-run-border-saved \{\s*0%, 25% \{ border-color: #28a745; box-shadow: 0 0 0 2px #28a745; \}\s*100% \{ border-color: #dee2e6; box-shadow: 0 0 0 2px transparent; \}/);
    assert.match(source, /\.admin-run-saved \{ animation: admin-run-border-saved 1\.5s ease-in-out; \}/);
    assert.match(source, /\.admin-run-saved \{ animation: none; border-color: #28a745; box-shadow: 0 0 0 2px #28a745; \}/);
    assert.throws(() => vm.runInContext("focusSavedCourseRun(row, 'missing')", context), /saved course run could not be found/);
    assert.match(source, /const runSave = \['\/admin\/courses\/runs', '\/admin\/courses\/runs\/update'\]/);
    assert.match(source, /else if \(runSave\) \{\s*focusSavedCourseRun\(changed, savedRunGuid\);/);
    assert.match(source, /!previousRunGuids\.has\(run\.dataset\.runGuid\)/);
});

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
                    assert.equal(delay, 1500);
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
    assert.match(sports, /action="\/admin\/courses\/faqs\/save"/);
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
        'credit-requests', 'credit-refunds', 'profiles', 'roles', 'audit', 'settings']) {
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
        let finishHighlight;
        let animationEnd;
        const reducedMotion = hash === 'edit-another-item';
        const highlights = new Set();
        const notice = {
            style: {},
            classList: { add() {} },
            setAttribute() {},
            focus(options) { assert.equal(options.preventScroll, true); focused = true; },
            scrollIntoView(options) { assert.equal(options.block, 'nearest'); scrolled = true; }
        };
        const facilityName = 'Riverside & <Sports> Hall';
        const card = {
            addEventListener(event, callback) { assert.equal(event, 'animationend'); animationEnd = callback; },
            removeEventListener(event, callback) { assert.equal(callback, animationEnd); animationEnd = null; },
            classList: { add(name) { highlights.add(name); }, remove(name) { highlights.delete(name); } },
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
                setTimeout(callback, delay) { assert.equal(delay, 1500); finishHighlight = callback; },
                matchMedia() { return { matches: reducedMotion }; },
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
        assert.equal(notice.textContent, type === 'facility' ? 'Facility updated.' : `"${facilityName}" updated successfully.`);
        assert.equal(consumed.search, '');
        assert.equal(consumed.hash, `#${hash}`);
        onLoad();
        assert.equal(focused, true);
        assert.equal(scrolled, true);
        assert.equal(highlights.has('admin-facility-saved'), type === 'facility');
        if (type === 'facility') {
            assert.equal(finishFade, undefined);
            if (reducedMotion) finishHighlight();
            else {
                assert.equal(finishHighlight, undefined);
                animationEnd({ target: notice, animationName: 'admin-text-notice-saved' });
                assert.notEqual(notice.style.visibility, 'hidden');
                animationEnd({ target: card, animationName: 'admin-facility-saved' });
            }
            assert.equal(highlights.size, 0);
            assert.equal(animationEnd, null);
        } else finishFade();
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
            assert.match(disclosure, /<details class="admin-disclosure admin-form-section" data-editor-disclosure>\s*<summary class="admin-card-summary"><h4[^>]*>Sport details<\/h4> <span data-text-save-slot><\/span><\/summary>/);
            assert.match(disclosure, /<h4 id="sport-details-heading-sport-one" class="h6 d-inline mb-0">Sport details/);
            assert.match(disclosure, /<h4 class="h6 d-inline mb-0" id="course-defaults-heading-sport-one">Course defaults/);
            assert.match(disclosure, /<h4 class="h6 d-inline mb-0">FAQs<\/h4>/);
            assert.match(disclosure, /<details id="course-defaults-sport-one" class="admin-disclosure admin-form-section" data-sport-section-details data-editor-disclosure>\s*<summary class="admin-card-summary"><h4[^>]*>Course defaults/);
            assert.doesNotMatch(disclosure, /data-editor-inline|data-edit-toggle|data-edit-panel|>Edit course defaults</);
            assert.match(disclosure, /action="\/admin\/sports\/course-defaults"/);
            assert.match(disclosure, /<label for="edit-sport-name-sport-one">Sport name<\/label>/);
            assert.match(disclosure, />Update<\/button>/);
            const nameForm = disclosure.match(/<form[^>]*action="\/admin\/sports\/update"[\s\S]*?<\/form>/)[0];
            assert.ok(nameForm.indexOf('data-cancel-edit') < nameForm.indexOf('type="submit"'));
            assert.doesNotMatch(disclosure, /action="\/admin\/sports\/destroy"/);
            assert.match(card, /<\/details>\s*<form method="POST" action="\/admin\/sports\/destroy" data-sport-delete>[\s\S]*aria-label="Delete sport: Tennis">Delete sport<\/button>/);
            assert.equal((card.replace(disclosure, '').match(/<button/g) || []).length, 1);
            assert.doesNotMatch(html, /aria-controls="edit-sport-/);
            assert.match(disclosure, />Save course defaults</);
            assert.doesNotMatch(disclosure, />Add section<\/h5>/);
            assert.doesNotMatch(html.match(/<form[^>]*action="\/admin\/sports\/update"[\s\S]*?<\/form>/)[0], /description-sections/);
            assert.match(html, /select, textarea, \[data-description-sections\]/);
        }
        else assert.match(html, /No sports have been added/);
        assert.match(html, /<details id="add-sport-panel"[^>]*data-editor-disclosure>\s*<summary class="admin-card-summary"><h2 id="add-sport-heading"[^>]*>Add sport<\/h2><\/summary>\s*<p class="small text-muted">All fields are required unless marked optional.<\/p>\s*<form method="POST" action="\/admin\/sports"/);
        assert.match(html, /document\.querySelector\('#add-sport-panel > summary'\)/);
        assert.match(html, /\.sports-admin #add-sport-panel:not\(\[open\]\) \{ padding: 0\.75rem 1rem !important; \}/);
        assert.match(html, /\.sports-admin #add-sport-panel:not\(\[open\]\) > summary,\s*\.sports-admin \[data-sport-details\]:not\(\[open\]\) > summary \{ min-height: 1\.75rem; \}/);
        const addForm = html.match(/<form[^>]*action="\/admin\/sports"[\s\S]*?<\/form>/)[0];
        assert.match(addForm, /<fieldset class="admin-form-section">\s*<legend class="admin-form-section-title">Sport details<\/legend>/);
        assert.match(html, /\.sports-admin main \.form-control \{ max-width: none; \}/);
        const nameForm = html.match(/<form[^>]*action="\/admin\/sports\/update"[\s\S]*?<\/form>/);
        if (nameForm) {
            assert.doesNotMatch(nameForm[0], /form-row|col-auto|form-group col/);
            assert.match(nameForm[0], /d-flex justify-content-end/);
        }
        assert.ok(addForm.indexOf('</fieldset>') < addForm.indexOf('data-cancel-edit'));
        assert.match(addForm, /<legend class="admin-form-section-title">Course defaults <small class="text-muted">Optional<\/small><\/legend>/);
        assert.match(addForm, /<label for="new-sport-description">Course description <small class="text-muted">Optional<\/small><\/label>/);
        assert.match(addForm, /<label for="new-sport-faqs">FAQs <small class="text-muted">Optional<\/small><\/label>/);
        assert.match(addForm, /id="new-sport-description" name="course_description"/);
        assert.match(addForm, /id="new-sport-faqs" name="faq_text"/);
        assert.match(addForm, /d-flex justify-content-end/);
        assert.ok(addForm.indexOf('data-cancel-edit>Cancel') < addForm.indexOf('type="submit">Add sport'), 'Cancel precedes Add sport');
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

test('deletion reading interval precedes animation and also applies with reduced motion', async () => {
    const helper = await readFile(path.join(__dirname, '../views/partials/deletion-animation.ejs'), 'utf8');
    for (const reduced of [false, true]) {
        let release;
        let animated = false;
        let completed = false;
        const animate = vm.runInNewContext(`${helper}\nanimateDeletion`, {
            window: {
                setTimeout(callback, delay) { assert.equal(delay, 1000); release = callback; },
                matchMedia() { return { matches: reduced }; }
            }
        });
        const row = { style: {}, animate(frames, options) {
            assert.equal(options.duration, 800 / 0.75);
            animated = true;
            return { finished: Promise.resolve() };
        } };
        const pending = animate(row, 1000, 800 / 0.75).then(() => { completed = true; });
        assert.equal(animated, false);
        assert.equal(completed, false);
        release();
        await pending;
        assert.equal(animated, !reduced);
        assert.equal(completed, true);
    }
});

test('admin navigation groups every page once and marks the current page and section', async () => {
    const html = await ejs.renderFile(navigation, { ...locals, activePage: 'court-configuration' });
    const nav = html.match(/<nav[\s\S]*?<\/nav>/)[0];
    const groups = [...nav.matchAll(/<details class="([^"]+)">[\s\S]*?<summary><span class="admin-navigation-label">([^<]+)<\/span><\/summary>([\s\S]*?)<\/details>/g)];
    assert.deepEqual(groups.map(group => group[2]), ['Home Pages', 'Facilities management', 'Bookings management', 'Audit', 'System Admin']);
    assert.deepEqual(groups.map(group => [...group[3].matchAll(/href="([^"]+)"/g)].map(match => match[1])), [
        ['/admin', '/'],
        ['/admin/facilities', '/admin/courses', '/admin/sports', '/admin/opening-hours'],
        ['/admin/bookings', '/admin/booking-search', '/admin/course-bookings', '/admin/course-management', '/admin/credit-requests', '/admin/credit-refunds'],
        ['/admin/credit-requests/history', '/admin/credit-refunds/history', '/admin/audit'],
        ['/admin/profiles', '/admin/roles', '/admin/settings']
    ]);
    assert.match(groups[1][1], /admin-navigation-group-current/);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 0);
    assert.doesNotMatch(nav, /href="\/admin\/court-configuration"/);
    assert.match(nav, /href="\/admin\/bookings"[^>]*>Court bookings<\/a>/);
    assert.match(nav, /href="\/admin\/booking-search"[^>]*>Court bookings search<\/a>/);

    const bookingsHtml = await ejs.renderFile(navigation, { ...locals, activePage: 'bookings' });
    assert.match(bookingsHtml, /href="\/admin\/court-configuration"/);
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

    test('course directory groups single-sport courses once and categorises multiple sports as Multisports', async () => {
        const courses = [
            { guid: 'tennis-course', name: 'Tennis class', sport_guids: ['tennis'] },
            { guid: 'swimming-course', name: 'Swimming class', sport_guids: ['swimming'] },
            { guid: 'mixed-course', name: 'Mixed class', sport_guids: ['tennis', 'swimming'] },
            { guid: 'unassigned-course', name: 'Unassigned class', sport_guids: [] }
        ];
        const html = await ejs.renderFile(path.join(__dirname, '../views/courses.ejs'), {
            ...locals, activePage: 'courses', courses, facilities: [],
            sports: [{ guid: 'tennis', name: 'Tennis' }, { guid: 'swimming', name: 'Swimming' },
                { guid: 'archery', name: 'Archery' }]
        });
        for (const [group, course] of [
            ['tennis', 'tennis-course'], ['swimming', 'swimming-course'],
            ['multisports', 'mixed-course'], ['unassigned', 'unassigned-course']
        ]) {
            const section = html.split(`data-course-sport-group="${group}"`)[1].split('<section class="mb-4" data-course-sport-group=')[0];
            assert.ok(section.includes(`data-course-guid="${course}"`));
            assert.equal((html.match(new RegExp(`data-course-guid="${course}"`, 'g')) || []).length, 1);
        }
        assert.match(html, /id="course-group-multisports"[^>]*>Multisports<\/h2>/);
        assert.match(html, /data-course-count>4<\/span>/);
        assert.deepEqual([...html.matchAll(/data-course-sport-group="([^"]+)"/g)].map(match => match[1]),
            ['multisports', 'unassigned', 'swimming', 'tennis']);
        assert.doesNotMatch(html, /data-course-sport-group="archery"/);
        assert.equal((html.match(/<details class="admin-disclosure bg-white border rounded shadow-sm p-4" data-course-group-disclosure>/g) || []).length, 4);
        assert.match(html, /\[data-course-group-disclosure\]:not\(\[open\]\) \{ padding: 0\.75rem 1rem !important; \}/);
        assert.doesNotMatch(html, /<details[^>]*data-course-group-disclosure[^>]*\bopen\b/);
    });
    assert.match(html, /<details id="add-course-panel-directory"[^>]*data-editor-disclosure>\s*<summary class="admin-card-summary">\s*<h2 id="add-course-heading"[^>]*>Add course<\/h2>\s*<span data-course-add-feedback/);
    assert.match(html, /#add-course-panel-directory:not\(\[open\]\) \{ padding: 0\.75rem 1rem !important; \}/);
    assert.match(html, /data-admin-save-placeholder>You can add, remove, and edit courses and course runs here\. Assign sports and descriptions to courses, and configure locations, sessions, prices and spaces for each run\./);
    assert.match(html, /#add-course-panel-directory:not\(\[open\]\) > summary \{ min-height: 1\.75rem; margin-bottom: 0 !important; \}/);
    assert.match(html, /\.admin-course-card:has\(> \[data-course-edit\]:not\(\[open\]\)\) \{ padding: 0\.75rem 1rem !important; \}/);
    assert.match(html, /\[data-course-edit\]:not\(\[open\]\) > summary \{ min-height: 1\.75rem; margin-bottom: 0 !important; \}/);
    assert.match(html, /<span data-course-delete-slot class="ml-2"><\/span>/);
    assert.match(html, /\[data-course-delete-feedback\] \{\s*position: absolute;\s*top: 50%;\s*transform: translateY\(-50%\);/);
    assert.match(html, /> \[data-course-delete\] \{\s*top: 0\.625rem !important;\s*right: 1rem !important;/);
    assert.match(html, /id="add-course-directory"[^>]*data-editor-success-inline/);
    assert.match(html, /data-course-facility/);
    assert.match(html, /data-course-list/);
    assert.match(html, /data-course-guid="course-one" data-course-name="Tennis coaching"/);
    assert.match(html, /<output class="alert alert-success" data-course-feedback aria-live="polite" aria-atomic="true"/);
    assert.match(html, /data-course-count/);
    const addForm = html.match(/<form[^>]*id="add-course-directory"[\s\S]*?<\/form>/)[0];
    assert.doesNotMatch(addForm, /data-course-add-feedback/);
    assert.match(addForm, /<div class="mb-2" data-formatting-help>/);
    assert.match(addForm, /list-unstyled d-flex flex-wrap small text-muted/);
    assert.doesNotMatch(addForm, /<summary[^>]*>Formatting help<\/summary>/);
    assert.ok(addForm.indexOf('data-cancel-edit') < addForm.indexOf('type="submit"'));
    assert.doesNotMatch(html, /data-edit-toggle[^>]*aria-controls="(?:add-course-panel|edit-course)-/);
    const card = html.match(/<article id="course-course-one"[\s\S]*?<\/article>/)[0];
    const disclosure = card.match(/<details class="admin-disclosure" data-course-edit data-editor-disclosure>[\s\S]*<\/details>/)[0];
    assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
    const summary = disclosure.match(/<summary class="admin-card-summary"[^>]*>([\s\S]*?)<\/summary>/)[1];
    assert.equal(summary.replace(/<[^>]+>/g, '').trim(), 'Tennis coaching');
    assert.ok(!card.includes('data-course-description'), 'Course description is not replayed on the card');
    assert.match(disclosure, /<\/summary>\s*<form method="POST" action="\/admin\/courses\/update" data-editor-preview="false" data-editor-label="Edit Tennis coaching">/);
    const runsDisclosure = disclosure.match(/<details[^>]*data-course-runs-disclosure>[\s\S]*?<\/details>/)[0];
    assert.doesNotMatch(runsDisclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
    assert.match(runsDisclosure, /<summary class="admin-card-summary">\s*<h4[^>]*>3\. Course runs<\/h4>\s*<span class="badge badge-info ml-2">0<\/span>/);
    assert.match(runsDisclosure, /Expand to manage runs\. Each run has its own location, schedule, price and spaces\./);
    assert.match(html, /\.admin-form-section > summary > \.course-runs-title \{\s*font-size: 1\.1rem;\s*font-weight: 600;/);
    assert.match(runsDisclosure, /action="\/admin\/courses\/runs"/);
    assert.match(disclosure, /No course runs yet\. Add one below\./);
    assert.match(disclosure, />Add course run<\/button>/);
    assert.doesNotMatch(html, /facility runs?/i);
    assert.ok(disclosure.indexOf('/admin/courses/update') < disclosure.indexOf('Course runs'));
    assert.doesNotMatch(disclosure, /action="\/admin\/courses\/destroy"/);
    assert.match(card.replace(disclosure, ''), /action="\/admin\/courses\/destroy"[\s\S]*aria-label="Delete Tennis coaching">Delete<\/button>/);
    const editForm = html.match(/<form[^>]*action="\/admin\/courses\/update"[\s\S]*?<\/form>/)[0];
    assert.doesNotMatch(editForm, /name="facility_guid"/);
    assert.ok(editForm.indexOf('data-cancel-edit') < editForm.indexOf('type="submit"'));
    assert.match(editForm, /data-cancel-edit data-cancel-immediate>Cancel/);
    assert.doesNotMatch(addForm, /data-cancel-immediate/);
    assert.match(html, /if \(cancel\.hasAttribute\('data-cancel-immediate'\)\) \{\s*reset\(owner\);\s*proceed\(\{ kind: 'close' \}\);\s*return;/);
    assert.doesNotMatch(editForm, /name="facility_guids"/);
    assert.match(editForm, /name="sport_guids" value="sport-one" checked/);
    assert.match(html, /'\[data-course-edit\] > summary'/);
    assert.match(html, /card\.querySelector\('#add-course-panel-directory > summary'\)/);
    assert.match(html, /\{ kind: 'collapse', entry \}/);
    assert.match(html, /main \.form-control,\s*main \.custom-select \{ max-width: none; \}/);
    const template = await readFile(path.join(__dirname, '../views/courses.ejs'), 'utf8');
    assert.match(template, /class="admin-run-card rounded p-2 mb-2" data-admin-run-card/);
    assert.match(template, /class="h6 mb-0 text-break"/);
    assert.match(template, /class="small mt-1 mb-0">Full price:/);
    assert.match(template, /data-run-delete-confirm="Delete course run &quot;<%= run\.name %>&quot; for &quot;<%= course\.name %>&quot; at <%= run\.facility_name %>\?/);
    assert.match(html, /if \(runDelete && !window\.confirm\(form\.dataset\.runDeleteConfirm\)\) return;/);
    assert.match(html, /await animateRunDeletion\(sourceRun\);/);
    assert.match(html, /const remainingRuns = Array\.from\(changed\.querySelectorAll\('\[data-admin-run-card\]'\)\)/);
    assert.match(html, /runDelete && response\.status === 409/);
    assert.match(html, /if \(operation === 'updated' && changed\) \{\s*changed\.querySelector\('\[data-course-edit\]'\)\.open = false;/);
    assert.match(html, /if \(operation === 'updated'\) targetRow\?\.scrollIntoView\(\{ block: 'nearest', behavior: 'instant' \}\)/);
    assert.match(html, /@keyframes admin-course-saved \{\s*0%, 25% \{ border-color: #28a745; outline-color: #28a745; \}\s*100% \{ border-color: #dee2e6; outline-color: transparent; \}/);
    assert.match(card, /class="admin-course-card bg-white rounded/);
    assert.match(html, /targetRow\?\.scrollIntoView\(\{ block: 'nearest', behavior: 'instant' \}\);\s*if \(operation === 'updated' && changed\) \{\s*changed\.classList\.add\('admin-course-highlight'\)/);
    for (const action of ['/admin/courses/runs/update', '/admin/courses/runs']) {
        const runForm = [...template.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
            .find(match => match[0].includes(`action="${action}"`))[0];
        assert.ok(runForm.indexOf('data-cancel-edit') < runForm.indexOf('type="submit"'));
    }
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

test('settings reveal actions only for changed values and leave the logo separate', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const script = source.slice(source.indexOf('    function snapshot(form) {'), source.indexOf('    function close(entry) {'));
    const context = vm.createContext({ document: {
        body: { classList: { contains() { return true; } } }, activeElement: null
    } });
    vm.runInContext(`${script}\nthis.snapshot = snapshot; this.update = update;`, context);
    for (const [type, initial, changed] of [['text', 'Council', 'Library'], ['number', '30', '12'], ['select-one', '1', '0']]) {
        const field = { name: 'setting', type, value: initial, checked: false, disabled: false,
            tagName: type === 'select-one' ? 'SELECT' : 'INPUT', selectedOptions: [{ value: initial }] };
        const actions = { hidden: false, contains() { return false; } };
        const entry = {
            form: { elements: [field], classList: { toggle() {} },
                hasAttribute() { return false; }, querySelector() { return actions; } },
            status: {}
        };
        entry.baseline = context.snapshot(entry.form);
        for (const [value, isDirty] of [[initial, false], [changed, true], [initial, false]]) {
            field.value = value;
            field.selectedOptions[0].value = value;
            context.update(entry);
            assert.equal(actions.hidden, !isDirty, `${type}: ${value}`);
            assert.equal(entry.status.textContent, isDirty ? 'Unsaved changes' : '');
        }
    }
    assert.match(source, /classList\.contains\('settings-admin'\) && form\.hasAttribute\('data-admin-logo'\)/);
});

test('settings use visible grouped sections and preserve independent forms and logo upload', async () => {
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
    const main = html.match(/<main\b[\s\S]*?<\/main>/)[0];
    assert.doesNotMatch(main, /<details|<summary/);
    const identity = main.match(/<section[^>]*aria-labelledby="site-identity-heading">[\s\S]*?<\/section>/)[0];
    for (const id of ['site-title-heading', 'organisation-heading', 'site-logo-heading']) {
        assert.ok(identity.includes(`id="${id}"`));
    }
    assert.doesNotMatch(identity, /id="membership-scheme-heading"/);
    assert.equal((identity.match(/data-editor-inline/g) || []).length, 3);
    const creditSettings = main.match(/<section[^>]*aria-labelledby="credit-request-settings-heading">[\s\S]*?<\/section>/)[0];
    assert.equal((creditSettings.match(/data-editor-inline/g) || []).length, 4);
    assert.match(creditSettings, />Credit and refund settings<\/h2>/);
    assert.match(creditSettings, /id="refunds-heading"/);
    assert.match(creditSettings, /id="request-window"/);
    assert.match(creditSettings, /id="credit-lifetime-heading"/);
    assert.match(creditSettings, /id="auto-approval-heading"/);
    assert.match(creditSettings, /action="\/admin\/settings\/credit-slot-auto-approval"/);
    const actions = ['', '/organisation', '/logo', '/membership-scheme', '/booking-search-days',
        '/refunds', '/credit-request-period', '/credit-lifetime', '/credit-slot-auto-approval'];
    actions.forEach(action => {
        const form = main.match(new RegExp(`<form[^>]*action="/admin/settings${action}"[^>]*>[\\s\\S]*?</form>`))[0];
        assert.match(form, /data-editor-inline/);
        assert.match(form, /data-editor-label="[^"]+" data-editor-preview="false"/);
        assert.equal((form.match(/data-cancel-edit/g) || []).length, 1);
        assert.ok(form.indexOf('data-cancel-edit') < form.indexOf('type="submit"'));
        if (action !== '/logo') {
            assert.match(form, /class="settings-field-actions"/);
            assert.match(form, /class="settings-actions"/);
            assert.doesNotMatch(form, /class="settings-actions"[^>]*hidden/);
        }
    });
    for (const id of ['site-identity-heading', 'membership-scheme-heading', 'booking-search-settings-heading', 'credit-request-settings-heading']) {
        assert.ok(main.includes(`href="#${id}"`));
        assert.ok(main.includes(`id="${id}"`));
    }
    assert.match(html, /\.settings-admin main \.form-control \{ max-width: none; \}/);
    assert.match(html, /data-admin-save-placeholder>Edit a setting directly/);
    assert.match(html, /\.settings-actions\[hidden\] \{ display: none; \}/);
    assert.match(html, /\.settings-field-actions \{ display: flex; flex-wrap: wrap;/);
    assert.match(html, /@media \(max-width: 767\.98px\)/);
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
    assert.match(html, /<details id="add-facility-panel"[^>]*data-editor-disclosure>\s*<summary class="admin-card-summary"><h2 id="add-facility-heading"[^>]*>Add facility<\/h2><\/summary>/);
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
        assert.ok(form.indexOf('data-cancel-edit') < form.indexOf('type="submit"'), 'Cancel precedes the primary facility action');
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
    assert.equal((html.match(/<form[^>]*action="\/admin\/facilities\/destroy"/g) || []).length, 2);
    assert.equal((html.match(/data-facility-delete-name="Hall &amp; courts"/g) || []).length, 2);
    for (const attribute of ['data-facilities-directory', 'data-facility-list', 'data-facility-count', 'data-facility-feedback', 'data-facility-error']) {
        assert.ok(html.includes(attribute));
    }
    assert.match(html, /data-facility-guid="123e4567-e89b-42d3-a456-426614174000" data-facility-name="Hall &amp; courts"/);
    assert.match(html, /class="admin-facility-card bg-white rounded/);
    assert.match(html, /\.admin-facility-card:has\(> \[data-facility-edit\]:not\(\[open\]\)\) \{ padding: 0\.75rem 1rem !important; \}/);
    assert.match(html, /#add-facility-panel:not\(\[open\]\) \{ padding: 0\.75rem 1rem !important; \}/);
    assert.match(html, /\[data-facility-edit\]:not\(\[open\]\) > summary,\s*#add-facility-panel:not\(\[open\]\) > summary \{ min-height: 1\.75rem; margin-bottom: 0 !important; \}/);
    assert.match(html, /\[data-facility-edit\]:not\(\[open\]\) \[data-facility-edit-feedback\] \{ height: 1\.5rem !important; \}/);
    assert.match(html, /\.admin-course-highlight, \.admin-facility-saved \{ outline: 3px solid transparent; animation: admin-course-saved 1\.5s ease-in-out; \}/);
    assert.match(html, /\.admin-facility-saved \[data-admin-save-confirmation\] \{ transition: none; animation: admin-text-notice-saved 1\.5s ease-in-out both; \}/);
    assert.match(html, /event\.target === facilityCard && event\.animationName === 'admin-facility-saved'/);
    assert.match(html, /border-top: 4px solid var\(--camden-navy\)/);
    assert.match(html, /border-radius: 0 !important;\s*box-shadow: none !important/);
    assert.match(html, /aria-label="Delete facility: Hall &amp; courts">Delete facility<\/button>/);
    assert.match(html, /Manage facilities and their booking arrangements/);
    assert.match(html, /\[data-facility-edit-feedback\] > output \{\s*font-size: 0\.75rem;/);
    const cards = [...html.matchAll(/<article id="facility-[\s\S]*?<\/article>/g)].map(match => match[0]);
    assert.equal(cards.length, 2);
    for (const card of cards) {
        const disclosure = card.match(/<details class="admin-disclosure" data-facility-edit data-editor-disclosure>[\s\S]*<\/details>/)[0];
        assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen\b/);
        const summary = disclosure.match(/<summary class="admin-card-summary">([\s\S]*?)<\/summary>/)[1];
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
        options: [{ guid: 'court-one', name: 'Court 1', sport_guid: 'tennis', sport_name: 'Tennis', price_pence: 750, resources: [resource] }],
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
        ['Add bookable court', 'options'], ['Court 1 <span class="text-muted font-weight-normal">· Tennis · &pound;7.50 per hour</span>', 'options/update']
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
