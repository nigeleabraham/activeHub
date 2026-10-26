const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

test('child birth dates display in day month year order without changing date input values', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/profile-editors.ejs'), 'utf8');
    const start = source.indexOf("value = new Intl.DateTimeFormat('en-GB'");
    const formatter = source.slice(start, source.indexOf(';', start) + 1);
    for (const [input, expected] of [['2023-01-01', '1 January 2023'], ['2020-02-29', '29 February 2020']]) {
        const context = { value: input };
        vm.runInNewContext(formatter, context);
        assert.equal(context.value, expected);
    }
    assert.match(source, /field\.name === 'date_of_birth' && value/);
});

test('profile section editors place Cancel before Save without changing admin button order', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/profile-editors.ejs'), 'utf8');
    assert.match(source, /cancel\.setAttribute\('data-cancel-edit', ''\)/);
    assert.match(source, /form\.append\(cancel, submit\)/);
});

test('profile save feedback is screen-reader-only and highlights changed values rather than the whole card', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/profile-editors.ejs'), 'utf8');
    assert.match(source, /feedback\.className = 'alert-success sr-only'/);
    assert.match(source, /if \(value\.textContent === previous\[index\]\) return/);
    assert.match(source, /value\.classList\.add\('admin-course-highlight'\)/);
    assert.match(source, /setTimeout\(\(\) => value\.classList\.remove\('admin-course-highlight'\), 2000\)/);
    assert.doesNotMatch(source, /section\.classList\.add\('admin-course-highlight'\)/);
});

test('profile panels swap in place without scrolling focus and restore their size when closed', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const workflow = source.slice(source.indexOf('function close(entry)'), source.indexOf('function reset(entry)'));
    const events = [];
    const focusOptions = [];
    const scrolls = [];
    const entry = {
        panel: { hidden: true },
        toggle: { hidden: false, setAttribute() {}, hasAttribute: () => true },
        form: {
            parentElement: null,
            hasAttribute: () => true,
            dispatchEvent: event => events.push(event.detail.open),
            querySelector: () => ({ focus: options => focusOptions.push(options) })
        }
    };
    const context = {
        entry, entries: [entry], active: null,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        window: { scrollX: 0, scrollY: 450, scrollTo: value => scrolls.push(value) }
    };
    vm.runInNewContext(`${workflow}; open(entry); close(entry);`, context);
    assert.deepEqual(events, [true, false]);
    assert.equal(focusOptions[0].preventScroll, true);
    assert.equal(scrolls[0].top, 450);
    assert.equal(scrolls[0].behavior, 'instant');
    assert.equal(entry.panel.hidden, true);
    assert.equal(entry.toggle.hidden, false);

    const template = await readFile(path.join(__dirname, '../views/partials/profile-editors.ejs'), 'utf8');
    const handler = template.slice(template.indexOf("form.addEventListener('profile-editor-toggle'"),
        template.indexOf('function refreshSummary()'));
    const classes = new Map();
    const content = {
        style: {}, getBoundingClientRect: () => ({ height: 420 }),
        classList: { toggle: (name, value) => classes.set(name, value) }
    };
    const summary = {};
    let toggle;
    vm.runInNewContext(handler, {
        content, summary, form: { addEventListener: (_name, listener) => { toggle = listener; } }
    });
    toggle({ detail: { open: true } });
    assert.equal(content.style.minHeight, '420px');
    assert.equal(classes.get('is-editing'), true);
    assert.equal(summary.inert, true);
    toggle({ detail: { open: false } });
    assert.equal(content.style.minHeight, '');
    assert.equal(classes.get('is-editing'), false);
    assert.equal(summary.inert, false);
});

test('shared editor confirms section saves, refreshes values and reset defaults, and keeps failures editable', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
    const save = source.slice(source.indexOf('async function save(entry, submitter)'),
        source.indexOf('function initializeEditors()'));
    for (const scenario of ['saved', 'invalid', 'unexpected-page', 'unconfirmed']) {
        const events = [];
        const field = { name: 'membership_number', type: 'text', tagName: 'INPUT', value: ' CARD ', defaultValue: '' };
        const button = { disabled: false };
        const notice = {};
        const form = {
            action: 'http://localhost/profile', elements: [field],
            reportValidity: () => true, querySelectorAll: () => [button],
            hasAttribute: attribute => attribute === 'data-profile-editor',
            closest: selector => selector === '[data-profile-section]' ? { querySelector: () => notice } : null,
            setAttribute() {}, removeAttribute() {},
            dispatchEvent: event => events.push(event.type)
        };
        const entry = { form, error: { hidden: true, focus() {} }, status: {} };
        const context = {
            URL, URLSearchParams, Event, saving: false, window: { scrollY: 0 },
            FormData: class { *[Symbol.iterator]() {} },
            fetch: async () => ({
                ok: scenario !== 'invalid', status: scenario === 'invalid' ? 422 : 200,
                url: 'http://localhost/profile',
                headers: { get: () => scenario === 'unexpected-page' ? 'text/html' : 'application/json' },
                json: async () => scenario === 'invalid' ? { error: 'Check the membership number.' }
                    : scenario === 'unconfirmed' ? {} : { saved: true, values: { membership_number: 'CARD' } }
            }),
            snapshot: () => JSON.stringify([field.value, field.defaultValue]),
            update() {}, resetNoticeFade: () => events.push('feedback-fade'),
            showError: (_entry, message) => { entry.error.hidden = false; entry.error.textContent = message; },
            console: { error() {} }, entry
        };
        const location = await vm.runInNewContext(`${save}; save(entry);`, context);
        assert.equal(form.inert, false);
        assert.equal(button.disabled, false);
        if (scenario === 'saved') {
            assert.equal(location, form.action);
            assert.equal(field.value, 'CARD');
            assert.equal(field.defaultValue, 'CARD');
            assert.deepEqual(events, ['profile-reset', 'profile-saved', 'profile-feedback', 'feedback-fade']);
            assert.ok(entry.baseline);
        } else {
            assert.equal(location, null);
            assert.equal(field.value, ' CARD ');
            assert.equal(field.defaultValue, '');
            assert.equal(entry.error.hidden, false);
            assert.ok(entry.error.textContent);
            assert.deepEqual(events, []);
        }
    }
});
