const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const vm = require('node:vm');
const Children = require('../models/Children');
const input = { name: 'Child', inherit_address: 'yes', inherit_parental_contact: 'yes',
    inherit_emergency_contact: 'yes', medical_concern: 'no', activity_limitation: 'no' };

test('switching child medical concern to No clears conditions and text before switching back to Yes', async () => {
    const listeners = new Map();
    const answer = { checked: true, addEventListener(_event, callback) { listeners.set(this, callback); } };
    const checks = ['asthma', 'other'].map(() => ({
        checked: true, addEventListener(_event, callback) { listeners.set(this, callback); },
        setCustomValidity(value) { this.validity = value; }
    }));
    const textarea = { value: 'Saved details' };
    const conditions = { querySelectorAll: () => checks, closest: () => ({ addEventListener() {} }) };
    const other = { querySelector: () => textarea };
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-child.ejs'), {
        child: Children.parse(input), parent: {}, activePage: 'profile', currentProfile: null,
        isAdmin: false, canSwitchRole: false, sports: [], siteTitle: 'ActiveHub',
        hasLogo: false, membershipScheme: 'Test card', error: ''
    });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    vm.runInNewContext(script, { document: {
        querySelectorAll(selector) { return selector === '[data-inheritance-group]' ? [] : [answer, ...checks]; },
        querySelector(selector) { return selector === '[data-child-conditions]' ? conditions : other; },
        getElementById(id) { return id === 'child-medical-yes' ? answer : checks[1]; }
    } });
    assert.equal(textarea.value, 'Saved details');
    answer.checked = false;
    listeners.get(answer)();
    assert.ok(checks.every(check => !check.checked));
    assert.equal(textarea.value, '');
    assert.equal(conditions.hidden, true);
    answer.checked = true;
    listeners.get(answer)();
    assert.ok(checks.every(check => !check.checked));
    assert.equal(textarea.value, '');
    assert.equal(conditions.hidden, false);
    assert.equal(checks[0].validity, 'Select at least one medical condition.');
});

test('child input validates independent health and inherited/overridden contact groups', () => {
    const parsed = Children.parse({ ...input, email: 'child@example.test', role: 'Administrator', medical_conditions: ['asthma'] });
    assert.equal(parsed.name, 'Child');
    assert.equal(parsed.address_line_1, null);
    assert.deepEqual(parsed.medical_conditions, []);
    assert.equal(parsed.email, undefined);
    assert.equal(parsed.role, undefined);
    assert.equal(Children.parse({ ...input, date_of_birth: '2020-02-29' }).date_of_birth, '2020-02-29');
    for (const change of [{ name: '' }, { name: ['Child'] }, { inherit_address: undefined },
        { medical_concern: 'yes' }, { date_of_birth: '2020-02-30' }, { date_of_birth: '2999-01-01' },
        { date_of_birth: ['2020-01-01'] }, { activity_limitation: 'invalid' }, { interest_sport_guids: ['invalid'] },
        { inherit_parental_contact: 'no', parental_contact_email: 'invalid' },
        { inherit_emergency_contact: 'no', emergency_contact_telephone: 'abc' }]) {
        assert.throws(() => Children.parse({ ...input, ...change }), Children.ChildInputError);
    }
    const custom = Children.parse({ ...input, inherit_parental_contact: 'no', parental_contact_email: 'guardian@example.test',
        medical_concern: 'yes', medical_conditions: ['other'], medical_other: 'Concern' });
    assert.equal(custom.parental_contact_email, 'guardian@example.test');
    assert.equal(custom.medical_other, 'Concern');
});

test('live child inheritance follows parent updates while independent groups and health remain unchanged', () => {
    const child = Children.parse({ ...input, inherit_emergency_contact: 'no', emergency_contact_name: 'Other guardian' });
    const parent = { name: 'Parent', email: 'parent@example.test', telephone: '123', address_line_1: 'First address',
        emergency_contact_name: 'Parent emergency contact', medical_concern: true };
    let resolved = Children.resolve(child, parent);
    assert.equal(resolved.parental_contact_email, 'parent@example.test');
    assert.equal(resolved.address_line_1, 'First address');
    assert.equal(resolved.emergency_contact_name, 'Other guardian');
    assert.equal(resolved.medical_concern, false);
    parent.address_line_1 = 'Updated address';
    parent.email = 'updated@example.test';
    resolved = Children.resolve(child, parent);
    assert.equal(resolved.address_line_1, 'Updated address');
    assert.equal(resolved.parental_contact_email, 'updated@example.test');
});

test('child editor offers inheritance, child health/membership/interests and no child personal email or login', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-child.ejs'), {
        child: Children.parse(input), parent: { name: 'Parent <one>', email: 'parent@example.test' },
        activePage: 'profile', currentProfile: { name: 'Parent', role: 'Resident' }, isAdmin: false, canSwitchRole: false,
        sports: [], siteTitle: 'ActiveHub', hasLogo: false, membershipScheme: 'Test card', error: ''
    });
    assert.match(html, /Parent &lt;one&gt;/);
    assert.match(html, /name="inherit_address"/);
    assert.match(html, /name="parental_contact_email"/);
    assert.match(html, /name="emergency_contact_telephone"/);
    assert.match(html, /Child’s health/);
    assert.doesNotMatch(html, /name="email"|name="telephone"|name="role"/);
    assert.match(html, /hidden disabled/);
});

test('child editing rejects other parents records and audit excludes profile contents', async t => {
    const router = require('../routes/children');
    const AuditLog = require('../models/AuditLog');
    const existing = t.mock.method(Children, 'find', async () => null);
    const save = t.mock.method(Children, 'save', async () => ({ guid: 'child-id' }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const handler = router.stack.find(layer => layer.route?.path === '/profile/children/:guid' && layer.route.methods.post).route.stack[0].handle;
    let status, redirect;
    const req = { profile: { guid: 'parent-id', name: 'Parent', role: 'Resident' }, params: { guid: 'child-id' }, body: input };
    const res = { sendStatus(code) { status = code; }, redirect(value) { redirect = value; } };
    await handler(req, res, error => assert.fail(error));
    assert.equal(status, 404);
    assert.equal(save.mock.callCount(), 0);
    existing.mock.mockImplementation(async () => ({ guid: 'child-id' }));
    await handler(req, res, error => assert.fail(error));
    assert.deepEqual(save.mock.calls[0].arguments, ['parent-id', 'child-id', input]);
    assert.equal(redirect, '/profile?child_saved=1#my-children');
    assert.deepEqual(audit.mock.calls[0].arguments[1].details, { self_service: true });
});

test('existing child sections use the shared editor but creation stays a single form', async () => {
    const locals = {
        child: { ...Children.parse(input), guid: 'child-id' }, parent: {},
        activePage: 'profile', currentProfile: null, isAdmin: false, canSwitchRole: false,
        sports: [], siteTitle: 'ActiveHub', hasLogo: false, membershipScheme: 'Test card', error: ''
    };
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-child.ejs'), locals);
    assert.match(html, /data-child-form data-profile-sections/);
    assert.equal((html.match(/data-profile-section="/g) || []).length, 7);
    assert.match(html, /Save and continue/);
    assert.match(html, /Discard changes/);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        assert.doesNotThrow(() => new vm.Script(script));
    }
    const creating = await ejs.renderFile(path.join(__dirname, '../views/resident-child.ejs'), {
        ...locals, child: Children.parse(input)
    });
    assert.doesNotMatch(creating, /data-child-form data-profile-sections/);
    assert.match(creating, />Create child profile<\/button>/);
});

test('child section saves enforce ownership, validate errors and return inline confirmation', async t => {
    const router = require('../routes/children');
    const find = t.mock.method(Children, 'find', async () => ({ guid: 'child-id' }));
    const save = t.mock.method(Children, 'save', async () => ({ guid: 'child-id', values: { membership_number: 'CARD' } }));
    t.mock.method(require('../models/AuditLog'), 'record', async () => {});
    const handler = router.stack.find(layer => layer.route?.path === '/profile/children/:guid' && layer.route.methods.post).route.stack[0].handle;
    let status, result;
    const res = { status(code) { status = code; return this; }, json(value) { result = value; }, sendStatus(code) { status = code; } };
    const req = { profile: { guid: 'owner' }, params: { guid: 'child-id' }, body: { section: 'membership', membership_number: 'CARD' } };
    await handler(req, res, assert.fail);
    assert.deepEqual(save.mock.calls[0].arguments, ['owner', 'child-id', req.body, 'membership']);
    assert.deepEqual(result, { saved: true, values: { membership_number: 'CARD' } });
    save.mock.mockImplementation(async () => { throw new Children.ChildInputError('Invalid child data.'); });
    await handler(req, res, assert.fail);
    assert.equal(status, 422);
    assert.equal(result.error, 'Invalid child data.');
    find.mock.mockImplementation(async () => null);
    await handler(req, res, assert.fail);
    assert.equal(status, 404);
    assert.equal(save.mock.callCount(), 2);
    req.body.section = 'unknown';
    await handler(req, res, assert.fail);
    assert.equal(status, 422);
});
