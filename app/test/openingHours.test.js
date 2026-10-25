const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isBookingWithinHours,
    isIntervalWithinSchedule,
    applyDaylightLimits
} = require('../models/OpeningHours');

const weekdaySchedule = {
    date: '2026-10-21',
    is_closed: false,
    opens_at: '08:00',
    closes_at: '18:00'
};

const london = { latitude: 51.5074, longitude: -0.1278 };
const winter = { date: '2026-12-21', is_closed: false, opens_at: '06:00', closes_at: '22:00' };

test('October 30 allows the 16:00 to 17:00 slot with civil dusk while retaining the template cap', () => {
    const schedule = applyDaylightLimits({ ...winter, date: '2026-10-30' },
        { dusk_override: true }, london);
    assert.equal(schedule.closes_at, '17:00');
    assert.equal(isIntervalWithinSchedule(schedule, '2026-10-30T16:00:00Z', '2026-10-30T17:00:00Z'), true);
    const capped = applyDaylightLimits({ ...winter, date: '2026-10-30', closes_at: '16:30' },
        { dusk_override: true }, london);
    assert.equal(capped.closes_at, '16:30');
    assert.equal(isIntervalWithinSchedule(capped, '2026-10-30T16:00:00Z', '2026-10-30T17:00:00Z'), false);
});

test('daylight limits restrict winter hours to sunrise and civil dusk plus twenty minutes', () => {
    const schedule = applyDaylightLimits(winter, { dawn_override: true, dusk_override: true }, london);
    assert.ok(schedule.opens_at >= '08:00' && schedule.opens_at <= '08:10', schedule.opens_at);
    assert.equal(schedule.closes_at, '16:00');
    assert.equal(isIntervalWithinSchedule(schedule, '2026-12-21T08:00:00Z', '2026-12-21T09:00:00Z'), false);
    assert.equal(isIntervalWithinSchedule(schedule, '2026-12-21T09:00:00Z', '2026-12-21T10:00:00Z'), true);
    assert.equal(isIntervalWithinSchedule(schedule, '2026-12-21T16:00:00Z', '2026-12-21T17:00:00Z'), false);
});

test('daylight overrides are independent, disabled by default and never extend template hours', () => {
    assert.deepEqual(applyDaylightLimits(winter, {}, null), winter);
    const dawnOnly = applyDaylightLimits(winter, { dawn_override: true }, london);
    assert.equal(dawnOnly.closes_at, winter.closes_at);
    const duskOnly = applyDaylightLimits(winter, { dusk_override: true }, london);
    assert.equal(duskOnly.opens_at, winter.opens_at);
    const narrow = { ...winter, opens_at: '10:00', closes_at: '14:00' };
    assert.deepEqual(applyDaylightLimits(narrow, { dawn_override: true, dusk_override: true }, london), narrow);
    const closed = { ...winter, is_closed: true };
    assert.deepEqual(applyDaylightLimits(closed, { dawn_override: true }, null), closed);
    assert.equal(applyDaylightLimits({ ...winter, opens_at: '18:00' }, { dusk_override: true }, london).is_closed, true);
});

test('solar limits round inward and respect British summer time and facility location', () => {
    const SunCalc = require('suncalc');
    for (const date of ['2026-03-29', '2026-06-21', '2026-10-25', '2026-12-21']) {
        const schedule = applyDaylightLimits({ ...winter, date, opens_at: '00:00', closes_at: '23:59' },
            { dawn_override: true, dusk_override: true }, london);
        const events = SunCalc.getTimes(new Date(`${date}T12:00:00Z`), london.latitude, london.longitude);
        const offset = date === '2026-03-29' || date === '2026-06-21' ? '+01:00' : '+00:00';
        const opening = new Date(`${date}T${schedule.opens_at}:00${offset}`);
        const closing = new Date(`${date}T${schedule.closes_at}:00${offset}`);
        assert.ok(opening >= events.sunrise && opening - events.sunrise < 60000);
        assert.ok(closing <= events.dusk.getTime() + 1200000);
        assert.ok(events.dusk.getTime() + 1200000 - closing < 3600000);
        assert.ok(schedule.closes_at.endsWith(':00'));
    }
    const edinburgh = applyDaylightLimits(winter, { dawn_override: true, dusk_override: true },
        { latitude: 55.9533, longitude: -3.1883 });
    const londonSchedule = applyDaylightLimits(winter, { dawn_override: true, dusk_override: true }, london);
    assert.notEqual(edinburgh.opens_at, londonSchedule.opens_at);
});

test('invalid or unavailable solar coordinates fail explicitly instead of allowing unrestricted booking', () => {
    for (const location of [null, {}, { latitude: 91, longitude: 0 }, { latitude: 'invalid', longitude: 0 }]) {
        assert.throws(() => applyDaylightLimits(winter, { dawn_override: true }, location), /coordinates/);
    }
    assert.throws(() => applyDaylightLimits(winter, { dawn_override: true }, { latitude: 89, longitude: 0 }), /unavailable/);
});

test('enforces fixed weekly opening and closing times', () => {
    const fixedWeeklySchedule = {
        date: '2026-10-21',
        is_closed: false,
        opens_at: '08:00',
        closes_at: '16:30'
    };

    assert.equal(isIntervalWithinSchedule(
        fixedWeeklySchedule,
        '2026-10-21T15:30:00+01:00',
        '2026-10-21T16:30:00+01:00'
    ), true);
    assert.equal(isIntervalWithinSchedule(
        fixedWeeklySchedule,
        '2026-10-21T16:30:00+01:00',
        '2026-10-21T17:30:00+01:00'
    ), false);
});

test('accepts a booking interval within opening hours, including closing time', () => {
    assert.equal(isIntervalWithinSchedule(
        weekdaySchedule,
        '2026-10-21T17:00:00+01:00',
        '2026-10-21T18:00:00+01:00'
    ), true);
});

test('rejects intervals outside opening hours', () => {
    assert.equal(isIntervalWithinSchedule(
        weekdaySchedule,
        '2026-10-21T07:00:00+01:00',
        '2026-10-21T08:00:00+01:00'
    ), false);
    assert.equal(isIntervalWithinSchedule(
        weekdaySchedule,
        '2026-10-21T17:00:00+01:00',
        '2026-10-21T18:01:00+01:00'
    ), false);
});

test('rejects closed days and intervals crossing into another day', () => {
    assert.equal(isIntervalWithinSchedule(
        { ...weekdaySchedule, is_closed: true },
        '2026-10-21T09:00:00+01:00',
        '2026-10-21T10:00:00+01:00'
    ), false);
    assert.equal(isIntervalWithinSchedule(
        weekdaySchedule,
        '2026-10-21T23:00:00+01:00',
        '2026-10-22T00:00:00+01:00'
    ), false);
});

test('keeps facilities without an assigned template unrestricted', async () => {
    assert.equal(await isBookingWithinHours(
        null,
        '2026-10-21T23:00:00+01:00',
        '2026-10-22T00:00:00+01:00'
    ), true);
});

test('administrator template forms save independent daylight switches and render their state', async t => {
    const Hours = require('../models/OpeningHours');
    const router = require('../routes/front');
    const ejs = require('ejs');
    const path = require('node:path');
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const create = t.mock.method(Hours, 'create', async () => ({}));
    const handler = admin.stack.findLast(layer => layer.route?.path === '/opening-hours' && layer.route.methods.post).route.stack[0].handle;
    const body = { name: 'Test daylight', dawn_override: 'on' };
    for (let day = 0; day < 7; day++) {
        body[`day_${day}_opens_at`] = '08:00';
        body[`day_${day}_closes_at`] = '18:00';
    }
    await handler({ body }, { redirect(url) { assert.equal(url, '/admin/opening-hours'); } });
    assert.equal(create.mock.calls[0].arguments[0].dawn_override, true);
    assert.equal(create.mock.calls[0].arguments[0].dusk_override, false);
    const html = await ejs.renderFile(path.join(__dirname, '../views/opening-hours.ejs'), {
        templates: [{ guid: 'test', ...create.mock.calls[0].arguments[0] }],
        weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        activePage: 'opening-hours', currentProfile: null, isAdmin: true, canSwitchRole: false, area: 'admin'
    });
    assert.ok(html.includes('name="dawn_override" checked'));
    assert.ok(!html.includes('name="dusk_override" checked'));
    assert.equal((html.match(/name="dawn_override"/g) || []).length, 2);
    assert.equal((html.match(/name="dusk_override"/g) || []).length, 2);
});