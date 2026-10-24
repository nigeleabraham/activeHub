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

test('booking cancel permissions', () => {
    const admin = { guid: 'a', role: 'Administrator' };
    const coach = { guid: 'c', role: 'Coach' };
    assert.equal(auth.canCancelBooking(admin, { profile_guid: 'c' }), true);
    assert.equal(auth.canCancelBooking(admin, { profile_guid: null }), true);
    assert.equal(auth.canCancelBooking(coach, { profile_guid: 'c' }), true);
    assert.equal(auth.canCancelBooking(coach, { profile_guid: 'x' }), false);
    assert.equal(auth.canCancelBooking(coach, { profile_guid: null }), false);
    assert.equal(auth.canCancelBooking(null, { profile_guid: 'c' }), false);
});
