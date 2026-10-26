const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('node:path');
const auth = require('../middleware/auth');
const { PERMISSION_KEYS } = require('../permissions');

const areas = [
    ['facilities.manage', '/facilities'],
    ['courses.manage', '/courses'],
    ['sports.manage', '/sports'],
    ['opening_hours.manage', '/opening-hours'],
    ['bookings.manage', '/bookings'],
    ['profiles.manage', '/profiles'],
    ['roles.manage', '/roles'],
    ['audit.view', '/audit']
];

test('each management permission allows only its area, dashboard and documented shared endpoints', () => {
    for (const [permission, area] of areas) {
        const profile = { role: 'Custom role', permissions: [permission] };
        assert.equal(auth.canAccessAdmin(profile), true);
        for (const [, target] of areas) {
            for (const suffix of ['', '/update', '/destroy']) {
                assert.equal(auth.canAccessAdmin(profile, target + suffix), target === area, `${permission}: ${target + suffix}`);
            }
        }
        assert.equal(auth.canAccessAdmin(profile, '/court-configuration'), permission === 'bookings.manage');
        assert.equal(auth.canAccessAdmin(profile, '/profiles/search'), ['profiles.manage', 'bookings.manage'].includes(permission));
        assert.equal(auth.canAccessAdmin(profile, '/facilities/courses/destroy'), permission === 'courses.manage');
        for (const target of ['/settings', '/settings/logo', '/refunds', '/credit-requests/decide', '/credit-refunds/decide', '/unknown']) {
            assert.equal(auth.canAccessAdmin(profile, target), false);
        }
    }
    assert.equal(auth.canAccessAdmin({ role: 'Resident', permissions: [] }), false);
    assert.equal(auth.canAccessAdmin(null), false);
    for (const target of ['/settings', '/refunds', '/roles', '/']) {
        assert.equal(auth.canAccessAdmin({ role: 'Administrator' }, target), true);
    }
});

test('dashboard menu hides unavailable areas for every configured permission', async () => {
    for (const [permission, area] of areas) {
        const profile = { name: 'Staff', role: 'Staff', permissions: [permission] };
        const html = await ejs.renderFile(path.join(__dirname, '../views/admin-home.ejs'), {
            currentProfile: profile, isAdmin: false, canSwitchRole: false, area: 'admin',
            activePage: 'admin-home', links: [], canAccessAdmin: target => auth.canAccessAdmin(profile, target)
        });
        assert.match(html, /href="\/admin"/);
        for (const [, target] of areas) {
            assert.equal(html.includes(`href="/admin${target}"`), target === area);
        }
        for (const target of ['/settings', '/refunds', '/credit-requests', '/credit-refunds']) {
            assert.equal(html.includes(`href="/admin${target}"`), false);
        }
        assert.match(html, /admin-editor/);
    }
    assert.equal(areas.length, PERMISSION_KEYS.length);
});
