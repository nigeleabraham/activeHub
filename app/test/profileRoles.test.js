const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const auth = require('../middleware/auth');
const Profiles = require('../models/Profiles');
const Roles = require('../models/Roles');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

const GUID = '123e4567-e89b-42d3-a456-426614174000';
const profile = { guid: GUID, name: 'Multi Role', email: 'multi@example.test', role: 'Resident', roles: ['Coach', 'Resident'] };

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
                assert.equal(cookies.length, 1);
            } else {
                assert.equal(status, 403);
                assert.equal(cookies.length, 0);
            }
        }
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
        area: 'admin', isAdmin: true, canSwitchRole: true, switchableRoles: profile.roles, viewingAs: null
    });
    assert.doesNotMatch(html, /<select[^>]*name="roles"/);
    assert.doesNotMatch(html, /<select[^>]*id="(?:edit-)?profile-role/);
    assert.match(html, /name="roles" value="Coach" checked/);
    assert.match(html, /name="roles" value="Resident" checked disabled/);
    assert.doesNotMatch(html, /name="roles" value="Administrator" checked/);
    assert.match(html, /for="view-as-role">Active role/);
    assert.match(html, /<option value="Resident" selected>/);
    assert.doesNotMatch(html, /<option value="Administrator"/);
    assert.doesNotMatch(html, /Return to Administrator/);
});
