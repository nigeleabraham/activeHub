const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const express = require('express');
const auth = require('../middleware/auth');
const Profiles = require('../models/Profiles');
const Roles = require('../models/Roles');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

const GUID = '123e4567-e89b-42d3-a456-426614174000';
const profile = { guid: GUID, name: 'Multi Role', email: 'multi@example.test', role: 'Resident', roles: ['Coach', 'Resident'] };

test('role deletion rejects active assignments and reports unexpected failures', async t => {
    let members = 1;
    let failure;
    t.mock.method(Roles, 'findByGuid', async () => ({ guid: GUID, name: 'Coach', is_system: false, member_count: members }));
    const remove = t.mock.method(Roles, 'remove', async () => {
        if (failure) throw failure;
        return true;
    });
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(console, 'error', () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/roles/destroy').route.stack[0].handle;
    const invoke = async () => {
        let location;
        await handler({ profile, body: { guid: GUID } }, { redirect(value) { location = value; } });
        return location;
    };
    assert.equal(await invoke(), '/admin/roles?error=role-in-use');
    assert.equal(remove.mock.callCount(), 0);
    members = 0;
    failure = Object.assign(new Error('Concurrent assignment'), { code: 'ROLE_IN_USE' });
    assert.equal(await invoke(), '/admin/roles?error=role-in-use');
    failure = new Error('Database unavailable');
    assert.equal(await invoke(), '/admin/roles?error=delete-failed');
    assert.equal(audit.mock.callCount(), 0);
    failure = null;
    assert.equal(await invoke(), '/admin/roles');
    assert.equal(audit.mock.callCount(), 1);
});

function selectedCookie(role) {
    let cookie;
    auth.setViewAs({ append(_name, value) { cookie = value.split(';')[0]; } }, GUID, role);
    return cookie;
}

test('login selects the highest assigned role and replaces the previous role selection', async t => {
    t.mock.method(Profiles, 'findByGuid', async () => ({ ...profile }));
    const highest = t.mock.method(Roles, 'highestFor', async () => 'Coach');
    t.mock.method(Roles, 'permissionsFor', async () => ['bookings.manage']);
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const handler = router.stack.find(layer => layer.route?.path === '/login' && layer.route.methods.post).route.stack[0].handle;
    const cookies = [];
    let location;
    await handler({ body: { profile_guid: GUID } }, {
        append(_name, value) { cookies.push(value); }, redirect(value) { location = value; }
    });
    assert.equal(location, '/');
    assert.deepEqual(highest.mock.calls[0].arguments, [profile.roles]);
    const selected = auth.parseCookies(cookies.find(cookie => cookie.startsWith('activehub_view_as=')));
    assert.equal(auth.readViewAs(selected.activehub_view_as, GUID), 'Coach');
    assert.equal(audit.mock.calls[0].arguments[0].role, 'Coach');
});

test('administrators can switch to all existing roles; other profiles only to assigned roles', async t => {
    t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(Roles, 'names', async () => ['Administrator', 'Coach', 'Resident']);
    const handler = router.stack.find(layer => layer.route?.path === '/view-as').route.stack.at(-1).handle;
    for (const realProfile of [profile, { ...profile, role: 'Administrator', roles: ['Administrator'] },
        { ...profile, roles: ['Administrator', 'Resident'] }]) {
        for (const role of ['Coach', 'Administrator', 'Resident', 'Unknown']) {
            let status;
            let location;
            const cookies = [];
            await handler({ realProfile, profile: realProfile, body: { role } }, {
                sendStatus(value) { status = value; },
                redirect(value) { location = value; },
                append(_name, value) { cookies.push(value); }
            });
            if (realProfile.roles.includes(role) || (realProfile.roles.includes('Administrator') && role !== 'Unknown')) {
                assert.equal(location, '/');
                assert.equal(cookies.length, 2);
            } else {
                assert.equal(status, 403);
                assert.equal(cookies.length, 0);
            }
        }
    }
});

test('switching roles reloads the same URL and redirects inaccessible pages home', async t => {
    t.mock.method(Profiles, 'findByGuid', async () => ({ ...profile }));
    t.mock.method(Roles, 'permissionsFor', async () => []);
    t.mock.method(AuditLog, 'record', async () => {});
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(auth.loadProfile);
    app.get('/allowed', (_req, res) => res.send('allowed'));
    app.get('/denied', (_req, res) => res.sendStatus(403));
    app.get('/admin/facilities', (req, res) => res.send(req.originalUrl));
    app.use(router);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = `${auth.COOKIE_NAME}=${auth.createSessionValue(GUID)}`;
    const switchRole = async (role, returnTo) => {
        const response = await fetch(`${base}/view-as`, {
            method: 'POST', redirect: 'manual',
            headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ role, return_to: returnTo })
        });
        const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        return { response, cookie: `${session}; ${cookies}` };
    };
    for (const role of ['Coach', 'Resident']) {
        const target = '/allowed?filter=one%20two&sort=asc';
        const { response, cookie } = await switchRole(role, target);
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), target);
        const page = await fetch(base + target, { headers: { cookie }, redirect: 'manual' });
        assert.equal(page.status, 200);
        assert.equal(await page.text(), 'allowed');
        assert.match(page.headers.get('set-cookie'), /activehub_role_return=;.*Max-Age=0/);
    }
    for (const role of ['Coach', 'Resident']) {
        for (const target of [
            '/admin/facilities?admin_saved=facility-created',
            '/admin/facilities?filter=tennis&admin_saved=facility-updated&admin_saved_target=facility-123&page=2'
        ]) {
            const { response, cookie } = await switchRole(role, target);
            const expected = target.includes('filter=') ? '/admin/facilities?filter=tennis&page=2' : '/admin/facilities';
            assert.equal(response.headers.get('location'), expected);
            const page = await fetch(base + expected, { headers: { cookie }, redirect: 'manual' });
            assert.equal(page.status, 200);
            assert.equal(await page.text(), expected);
        }
    }
    const unchanged = await switchRole('Coach', '/admin/facilities?filter=tennis&section_created=filter');
    assert.equal(unchanged.response.headers.get('location'), '/admin/facilities?filter=tennis&section_created=filter');
    const sports = await switchRole('Coach', '/admin/sports?admin_saved=section-created&section_created=123&filter=one');
    assert.equal(sports.response.headers.get('location'), '/admin/sports?filter=one');
    const { response, cookie } = await switchRole('Coach', '/denied?facility=other');
    assert.equal(response.headers.get('location'), '/denied?facility=other');
    const denied = await fetch(`${base}/denied?facility=other`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(denied.status, 302);
    assert.equal(denied.headers.get('location'), '/');
    assert.match(denied.headers.get('set-cookie'), /activehub_role_return=;.*Max-Age=0/);
    const otherPage = await fetch(`${base}/denied`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(otherPage.status, 403);
    const ordinary = await fetch(`${base}/denied?facility=other`, { headers: { cookie: session }, redirect: 'manual' });
    assert.equal(ordinary.status, 403);
    const tampered = await fetch(`${base}/denied?facility=other`, {
        headers: { cookie: `${cookie}x` }, redirect: 'manual'
    });
    assert.equal(tampered.status, 403);
    for (const unsafe of ['//example.com', '/\\example.com', 'https://example.com', '/\r\nLocation: https://example.com']) {
        const result = await switchRole('Coach', unsafe);
        assert.equal(result.response.headers.get('location'), '/');
    }
});

test('active permissions come only from the selected assigned role and revoked selections reset', async t => {
    t.mock.method(Profiles, 'findByGuid', async () => ({ ...profile }));
    const permissions = t.mock.method(Roles, 'permissionsFor', async role => role === 'Coach' ? ['bookings.manage'] : []);
    for (const selected of ['Coach', 'Administrator', 'Removed role']) {
        const req = { headers: { cookie: `${auth.COOKIE_NAME}=${auth.createSessionValue(GUID)}; ${selectedCookie(selected)}` } };
        const cleared = [];
        const res = { locals: {}, append(_name, value) { cleared.push(value); } };
        let error;
        await auth.loadProfile(req, res, value => { error = value; });
        assert.equal(error, undefined);
        const expected = selected === 'Coach' ? 'Coach' : 'Resident';
        assert.equal(req.profile.role, expected);
        assert.equal(req.realProfile.role, 'Resident');
        assert.equal(permissions.mock.calls.at(-1).arguments[0], expected);
        assert.equal(auth.can(req.profile, 'bookings.manage'), expected === 'Coach');
        assert.equal(auth.can(req.profile, 'roles.manage'), false);
        assert.equal(res.locals.canSwitchRole, true);
        assert.deepEqual(res.locals.switchableRoles, ['Coach', 'Resident']);
        assert.equal(cleared.length, selected === 'Coach' ? 0 : 1);
    }
});

test('administrator assignment grants no administrator access while another role is active', async t => {
    t.mock.method(Profiles, 'findByGuid', async () => ({ ...profile, role: 'Administrator', roles: ['Administrator'] }));
    t.mock.method(Roles, 'names', async () => ['Administrator', 'Coach', 'Resident']);
    t.mock.method(Roles, 'permissionsFor', async () => []);
    const req = { headers: { cookie: `${auth.COOKIE_NAME}=${auth.createSessionValue(GUID)}; ${selectedCookie('Resident')}` } };
    const res = { locals: {}, append() {} };
    await auth.loadProfile(req, res, error => { if (error) throw error; });
    assert.equal(req.profile.role, 'Resident');
    assert.equal(auth.isAdministrator(req.profile), false);
    assert.equal(auth.can(req.profile, 'profiles.manage'), false);
    assert.deepEqual(res.locals.switchableRoles, ['Administrator', 'Coach', 'Resident']);
});

test('new roles are inherited dynamically and removing Administrator revokes inherited selections', async t => {
    let assigned = ['Administrator'];
    let available = ['Administrator', 'Resident'];
    t.mock.method(Profiles, 'findByGuid', async () => ({ ...profile, role: assigned[0], roles: assigned }));
    t.mock.method(Roles, 'names', async () => available);
    t.mock.method(Roles, 'permissionsFor', async () => []);
    assert.deepEqual(await auth.switchableRoles({ ...profile, roles: assigned }), available);
    available = [...available, 'New role'];
    const req = { headers: { cookie: `${auth.COOKIE_NAME}=${auth.createSessionValue(GUID)}; ${selectedCookie('New role')}` } };
    const res = { locals: {}, append() {} };
    await auth.loadProfile(req, res, error => { if (error) throw error; });
    assert.equal(req.profile.role, 'New role');
    assert.deepEqual(res.locals.switchableRoles, available);
    assigned = ['Resident'];
    await auth.loadProfile(req, res, error => { if (error) throw error; });
    assert.equal(req.profile.role, 'Resident');
    assert.deepEqual(res.locals.switchableRoles, ['Resident']);
    assert.equal(res.locals.canSwitchRole, false);
});

test('profile creation always assigns Resident and rejects unknown additional roles', async t => {
    t.mock.method(Roles, 'names', async () => ['Administrator', 'Coach', 'Resident']);
    const create = t.mock.method(Profiles, 'create', async values => ({ ...values, guid: GUID }));
    t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/profiles' && layer.route.methods.post).route.stack[0].handle;
    for (const [roles, valid] of [[['Coach', 'Resident'], true], ['Coach', true], [undefined, true], [[], true], [['Resident', 'Unknown'], false]]) {
        let location;
        const before = create.mock.callCount();
        await handler({ profile, body: { name: profile.name, email: profile.email, roles } }, {
            redirect(value) { location = value; }
        });
        assert.equal(location.includes('invalid-profile'), !valid);
        assert.equal(create.mock.callCount() - before, valid ? 1 : 0);
        if (valid) assert.deepEqual(create.mock.calls.at(-1).arguments[0].roles,
            [...new Set(['Resident', ...(Array.isArray(roles) ? roles : roles ? [roles] : [])])]);
    }
});

test('profile editing protects an Administrator assignment even when the default role is Resident', async t => {
    t.mock.method(Roles, 'names', async () => ['Administrator', 'Coach', 'Resident']);
    t.mock.method(Profiles, 'findByGuid', async () => ({ ...profile, roles: ['Administrator', 'Resident'] }));
    t.mock.method(Profiles, 'countAdministrators', async () => 1);
    const update = t.mock.method(Profiles, 'update', async () => assert.fail('Last administrator must not be removed'));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/profiles/update').route.stack[0].handle;
    let location;
    await handler({ profile, body: { guid: GUID, name: profile.name, email: profile.email, roles: 'Resident' } }, {
        redirect(value) { location = value; }
    });
    assert.equal(location, '/admin/profiles?error=last-administrator');
    assert.equal(update.mock.callCount(), 0);
});

test('removing your own active assignment returns to your accessible profile page', async t => {
    const adminProfile = { ...profile, role: 'Administrator', roles: ['Administrator', 'Resident'] };
    t.mock.method(Roles, 'names', async () => ['Administrator', 'Resident']);
    t.mock.method(Profiles, 'findByGuid', async () => adminProfile);
    t.mock.method(Profiles, 'countAdministrators', async () => 2);
    t.mock.method(Profiles, 'update', async () => ({ ...profile, roles: ['Resident'] }));
    t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/profiles/update').route.stack[0].handle;
    let location;
    const cookies = [];
    await handler({ profile: adminProfile, body: { guid: GUID, name: profile.name, email: profile.email, roles: 'Resident' } }, {
        redirect(value) { location = value; }, append(_name, value) { cookies.push(value); }
    });
    assert.equal(location, '/profile?saved=1');
    assert.equal(cookies.length, 1);
    assert.match(cookies[0], /Max-Age=0/);
});

test('profile checkboxes and navigation show every assigned role and the active selection', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/profiles.ejs'), {
        currentProfile: profile, profiles: [{ ...profile, credit_pence: 0 }],
        roles: ['Administrator', 'Coach', 'Resident'], error: '', activePage: 'profiles',
        area: 'admin', isAdmin: true, canSwitchRole: true, switchableRoles: profile.roles, viewingAs: null,
        currentUrl: '/admin/profiles?sort=name&order=asc'
    });

    test('facility assignment lists follow the Facility manager role in add and edit forms', async () => {
        const html = await ejs.renderFile(path.join(__dirname, '../views/profiles.ejs'), {
            currentProfile: profile, profiles: [{ ...profile, credit_pence: 0 }],
            roles: ['Administrator', 'Facility manager', 'Resident'], facilities: [{ guid: GUID, name: 'Test hall' }],
            error: '', activePage: 'profiles', area: 'admin', isAdmin: true, canSwitchRole: false
        });
        const script = html.match(/<script>\s*(function updateManagerFacilities\(form\)[\s\S]*?)<\/script>/)[1];
        const handlers = {};
        const forms = [false, true].map(checked => {
            const role = { checked };
            const admin = { checked: false };
            const input = { checked: true, disabled: false };
            const facilities = { hidden: false, disabled: false, querySelectorAll: () => [input] };
            const form = { querySelector: selector => selector === '[data-manager-facilities]' ? facilities :
                selector.includes('value="Administrator"') ? admin : role };
            role.form = form;
            role.matches = () => true;
            return { role, admin, input, facilities, form };
        });
        vm.runInNewContext(script, {
            document: {
                querySelectorAll: () => forms.map(item => item.form),
                addEventListener: (name, handler) => { handlers[name] = handler; }
            },
            setTimeout: callback => callback()
        });
        assert.equal(forms[0].facilities.hidden, true);
        assert.equal(forms[0].facilities.disabled, true);
        assert.equal(forms[1].facilities.hidden, false);
        assert.equal(forms[1].facilities.disabled, false);
        forms[0].role.checked = true;
        handlers.change({ target: forms[0].role });
        assert.equal(forms[0].facilities.hidden, false);
        assert.equal(forms[0].facilities.disabled, false);
        forms[0].role.checked = false;
        handlers.change({ target: forms[0].role });
        assert.equal(forms[0].facilities.hidden, true);
        assert.equal(forms[0].facilities.disabled, true);
        assert.equal(forms[0].input.checked, true);
        forms[0].role.checked = true;
        handlers.reset({ target: forms[0].form });
        assert.equal(forms[0].facilities.hidden, false);
        assert.equal(forms[0].facilities.disabled, false);
        forms[0].input.checked = false;
        forms[0].admin.checked = true;
        handlers.change({ target: { ...forms[0].role, form: forms[0].form } });
        assert.equal(forms[0].input.checked, true);
        assert.equal(forms[0].input.disabled, true);
        forms[0].admin.checked = false;
        handlers.change({ target: forms[0].role });
        assert.equal(forms[0].input.disabled, false);
    });
    assert.doesNotMatch(html, /<select[^>]*name="roles"/);
    assert.doesNotMatch(html, /<select[^>]*id="(?:edit-)?profile-role/);
    assert.match(html, /name="roles" value="Coach" checked/);
    assert.match(html, /name="roles" value="Resident" checked disabled/);
    assert.doesNotMatch(html, /name="roles" value="Administrator" checked/);
    assert.match(html, /for="view-as-role">Active role/);
    assert.match(html, /name="return_to" value="\/admin\/profiles\?sort=name&amp;order=asc"/);
    assert.match(html, /<option value="Resident" selected>/);
    assert.doesNotMatch(html, /<option value="Administrator"/);
    assert.doesNotMatch(html, /Return to Administrator/);
});
