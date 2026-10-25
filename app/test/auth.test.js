const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../middleware/auth');

const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('session value round-trips', () => {
    assert.equal(auth.readSessionValue(auth.createSessionValue(GUID)), GUID);
});

test('tampered or malformed session values are rejected', () => {
    const value = auth.createSessionValue(GUID);
    const other = '223e4567-e89b-42d3-a456-426614174000';
    assert.equal(auth.readSessionValue(`${other}.${value.split('.')[1]}`), null);
    assert.equal(auth.readSessionValue(`${GUID}.deadbeef`), null);
    assert.equal(auth.readSessionValue('nonsense'), null);
    assert.equal(auth.readSessionValue(undefined), null);
});

test('parseCookies reads multiple and malformed cookies', () => {
    assert.deepEqual(auth.parseCookies('a=1; b=hello%20world; c=%E0%A4%A'), { a: '1', b: 'hello world' });
});

test('administrator-only middleware rejects residents and coaches', () => {
    for (const role of ['Resident', 'Coach']) {
        let status;
        let rendered;
        let continued = false;
        const req = { profile: { role } };
        const res = {
            status(code) {
                status = code;
                return this;
            },
            render(view) {
                rendered = view;
                return this;
            }
        };

        auth.requireAdministrator(req, res, () => { continued = true; });

        assert.equal(status, 403);
        assert.equal(rendered, 'forbidden');
        assert.equal(continued, false);
    }
});

test('administrator-only middleware allows administrators and rejects signed-out requests', () => {
    let continued = false;
    auth.requireAdministrator(
        { profile: { role: auth.ADMINISTRATOR } },
        {},
        () => { continued = true; }
    );
    assert.equal(continued, true);

    let status;
    auth.requireAdministrator(
        { profile: null },
        { sendStatus(code) { status = code; } },
        () => assert.fail('signed-out requests must not continue')
    );
    assert.equal(status, 401);
});

test('permissions are granted by role and administrators hold all of them', () => {
    const custom = { guid: 'x', role: 'Receptionist', permissions: ['bookings.manage'] };
    assert.equal(auth.can(custom, 'bookings.manage'), true);
    assert.equal(auth.can(custom, 'roles.manage'), false);
    assert.equal(auth.can({ role: auth.ADMINISTRATOR }, 'roles.manage'), true);
    assert.equal(auth.can(null, 'bookings.manage'), false);
});

test('view-as cookie is bound to the administrator and rejects tampering', () => {
    const res = { append(_, value) { this.value = value; } };
    auth.setViewAs(res, GUID, 'Coach');
    const cookie = decodeURIComponent(res.value.split(';')[0].split('=')[1]);
    assert.equal(auth.readViewAs(cookie, GUID), 'Coach');
    assert.equal(auth.readViewAs(cookie, '223e4567-e89b-42d3-a456-426614174000'), null);
    const forged = `${Buffer.from('Administrator').toString('base64url')}.${cookie.split('.')[1]}`;
    assert.equal(auth.readViewAs(forged, GUID), null);
    assert.equal(auth.readViewAs(undefined, GUID), null);
});
