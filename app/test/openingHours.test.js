const assert = require('node:assert/strict');
const test = require('node:test');
const {
    isBookingWithinHours,
    isIntervalWithinSchedule
} = require('../models/OpeningHours');

const weekdaySchedule = {
    date: '2026-10-21',
    is_closed: false,
    opens_at: '08:00',
    closes_at: '18:00'
};

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