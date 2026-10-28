const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRunInput, priceForRemainingSessions, compareCourses, compareRuns } = require('../courseRuns');
const path = require('node:path');
const ejs = require('ejs');

const weekly = { name: 'Tuesday', price: '100.00', capacity: '12', schedule_mode: 'weekly',
    start_date: '2027-01-01', end_date: '2027-01-31', weekday: '2', start_time: '18:00', end_time: '19:00' };

test('courses sort by youngest age or school year, then unknown audiences alphabetically', () => {
    const names = ['Advanced invitation only', 'School year: years 8+', 'School year: years 2/3',
        'School year: year 1 & 2', 'Pre-school gymnastics (age 3-4)',
        'School year: reception/year 1', 'Intermediate invitation only', 'Ages 10-12'];
    assert.deepEqual(names.map((name, index) => ({ name, guid: String(index) })).sort(compareCourses).map(c => c.name),
        ['Pre-school gymnastics (age 3-4)', 'School year: reception/year 1', 'School year: year 1 & 2',
            'School year: years 2/3', 'Ages 10-12', 'School year: years 8+',
            'Advanced invitation only', 'Intermediate invitation only']);
});

test('runs sort Sunday to Saturday then UK start time, using schedules before labels', () => {
    const run = (name, starts, facility = 'Hall') => ({ name, guid: name, facility_name: facility,
        sessions: starts ? [{ starts_local: starts }] : [] });
    const runs = [run('Sunday', '2027-01-03 09:00'), run('Thursday early', '2027-01-07 13:45'),
        run('Tuesday late', '2027-01-05 14:30'), run('No schedule', ''),
        run('Monday draft 10:00', ''), run('Tuesday early', '2027-01-12 13:45'),
        run('Thursday late', '2027-01-07 14:30'), run('Misleading Friday label', '2027-01-04 08:00'),
        run('Saturday', '2027-01-02 09:00'), run('Sunday draft 08:00', '')];
    assert.deepEqual(runs.sort(compareRuns).map(r => r.name),
        ['Sunday draft 08:00', 'Sunday', 'Misleading Friday label', 'Monday draft 10:00', 'Tuesday early', 'Tuesday late',
            'Thursday early', 'Thursday late', 'Saturday', 'No schedule']);
    assert.ok(compareRuns(run('One', '2027-01-05 13:45', 'A hall'),
        run('Two', '2027-01-05 13:45', 'Z hall')) < 0);
});

test('school year sorting handles optional colons and long whitespace without changing age order', () => {
    const course = name => ({ name, guid: name });
    for (const name of ['School year 2', 'School years: 2/3', 'School year : 2', 'Year\t:\t2']) {
        assert.ok(compareCourses(course(name), course('Age 7')) < 0);
        assert.ok(compareCourses(course(name), course('Age 5')) > 0);
    }
    const whitespace = ' '.repeat(100000);
    assert.ok(compareCourses(course(`School year${whitespace}2`), course('Age 7')) < 0);
    assert.ok(compareCourses(course(`School year${whitespace}unknown`), course('Age 7')) > 0);
});

test('weekly run generation includes matching dates and retains full price in pennies', () => {
    const run = parseRunInput(weekly);
    assert.equal(run.full_price_pence, 10000);
    assert.equal(run.capacity, 12);
    assert.deepEqual(run.sessions.map(session => session.starts_local),
        ['2027-01-05 18:00', '2027-01-12 18:00', '2027-01-19 18:00', '2027-01-26 18:00']);
    assert.equal(parseRunInput({ ...weekly, price: '0' }).full_price_pence, 0);
    for (const change of [
        { name: '' }, { name: ['Tuesday'] }, { price: '-1' }, { price: '1.001' }, { price: '1e2' },
        { capacity: '0' }, { capacity: '1.5' }, { start_date: '2027-02-30' },
        { end_date: '2026-01-01' }, { end_date: '2030-01-01' }, { weekday: ['2'] },
        { start_time: '25:00' }, { end_time: '17:00' }, { end_date: '2027-01-01' },
        { schedule_mode: 'unknown' }
    ]) assert.equal(parseRunInput({ ...weekly, ...change }), null, JSON.stringify(change));
});

test('weekly generation includes both endpoints and crosses leap days and year boundaries', () => {
    for (const [start_date, end_date, weekday, dates] of [
        ['2028-02-22', '2028-03-07', '2', ['2028-02-22', '2028-02-29', '2028-03-07']],
        ['2026-12-29', '2027-01-05', '2', ['2026-12-29', '2027-01-05']],
        ['2027-01-05', '2027-01-05', '2', ['2027-01-05']]
    ]) {
        const run = parseRunInput({ ...weekly, start_date, end_date, weekday });
        assert.deepEqual(run.sessions.map(session => session.starts_local),
            dates.map(date => `${date} 18:00`));
    }
});

test('individual session editing validates dates, duplicates, overlaps and preserves UK wall times', () => {
    const input = { ...weekly, schedule_mode: 'individual', sessions: '2027-04-05 18:00 19:00\n2027-03-22 18:00 19:00' };
    assert.deepEqual(parseRunInput(input).sessions, [
        { starts_local: '2027-03-22 18:00', ends_local: '2027-03-22 19:00' },
        { starts_local: '2027-04-05 18:00', ends_local: '2027-04-05 19:00' }
    ]);
    for (const sessions of ['', [], '2027-02-30 18:00 19:00', '2027-01-01 19:00 18:00',
        '2027-01-01 18:00 19:00\n2027-01-01 18:30 19:30',
        '2027-01-01 18:00 19:00\n2027-01-01 18:00 19:00', '2027-01-01 25:00 26:00']) {
        assert.equal(parseRunInput({ ...input, sessions }), null);
    }
});

test('remaining session price divides before rounding once and never exceeds full price', () => {
    for (const [full, count, remaining, expected] of [
        [10000, 10, 10, 10000], [10000, 10, 7, 7000], [1000, 3, 2, 667],
        [1000, 3, 1, 333], [1000, 3, 0, 0], [0, 10, 5, 0], [1, 2, 1, 1]
    ]) assert.equal(priceForRemainingSessions(full, count, remaining), expected);
    assert.throws(() => priceForRemainingSessions(100, 0, 0));
    assert.throws(() => priceForRemainingSessions(100, 3, 4));
});

test('citizen course card displays inherited details once, FAQs first and separate facility run prices', async () => {
    const course = { guid: 'course', name: 'Shared course', description: '<bold>Shared description</bold><bullet><ul>Item</ul></bullet>',
        sport_guids: ['sport'], runs: [
            { guid: 'one', facility_name: 'First hall', name: 'Tuesday', full_price_pence: 10000,
                current_price_pence: 7500, remaining_sessions: 3, total_sessions: 4, capacity: 12,
                sessions: [{ starts_local: '2027-01-01 18:00', ends_local: '2027-01-01 19:00' }] },
            { guid: 'two', facility_name: 'Second hall', name: 'Saturday', full_price_pence: 8000,
                current_price_pence: 4000, remaining_sessions: 2, total_sessions: 4, capacity: 8, sessions: [] }
        ] };
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-courses.ejs'), {
        siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident', role: 'Resident' },
        isAdmin: false, canSwitchRole: false, activePage: 'courses', courses: [course],
        courseGroups: [{ name: 'Tennis', courses: [course], faqs: [{ question: 'Question?', answer: 'Answer' }] }]
    });

    assert.equal((html.match(/Shared description/g) || []).length, 1);
    assert.equal((html.match(/href="\/basket"/g) || []).length, 1);
    assert.match(html, /<header class="page-head">[\s\S]*?basket-button[\s\S]*?<svg[^>]*[\s\S]*?aria-hidden="true"/);
    assert.match(html, /<strong>Shared description<\/strong>/);
    assert.match(html, /<details class="mb-3" data-course-description>\s*<summary>Course description<\/summary>/);
    assert.ok(html.indexOf('</details>', html.indexOf('data-course-description')) < html.indexOf('data-course-run'));
    assert.match(html, /<li><u>Item<\/u><\/li>/);
    assert.equal((html.match(/>Shared course<\/h2>/g) || []).length, 1);
    assert.ok(html.indexOf('data-sport-faqs') < html.indexOf('data-course-run'));
    assert.ok(html.indexOf('data-sport-faqs') < html.indexOf('<section class="course-card'));
    assert.match(html, /<h4 class="h5">Friday, 18:00–19:00<\/h4>/);
    assert.match(html, /Choose a class \(2\)/);
    assert.match(html, /<details class="mb-3" data-course-runs>\s*<summary[^>]*>Choose a class \(2\)<\/summary>/);
    assert.doesNotMatch(html, /<details[^>]*data-course-runs[^>]*\bopen\b/);
    assert.match(html, /<h4 class="h5">Saturday<\/h4>/);
    assert.match(html, /Who is attending\?/);
    assert.match(html, /Add to basket &mdash; &pound;75\.00/);
    assert.match(html, /<summary>Dates and price details<\/summary>/);
    assert.equal((html.match(/Session length: 60 minutes\./g) || []).length, 1);
    assert.equal((html.match(/Session length:/g) || []).length, 1);
    assert.match(html, /&pound;75\.00/);
    assert.match(html, /&pound;40\.00/);
    assert.match(html, /Spaces remaining: 12/);
    assert.doesNotMatch(html, /Maximum spaces:/);
    assert.match(html, /<th scope="col">Date<\/th><th scope="col">Time<\/th><th scope="col">Location<\/th>/);
    assert.match(html, /<td>Friday, 01\/01\/2027<\/td>/);
    assert.match(html, /<td class="text-nowrap">18:00–19:00<\/td>/);
    assert.match(html, /<td>First hall<\/td>/);
    assert.match(html, /class="table-responsive mt-2"/);
});

test('customer run details show session lengths including variable durations and singular minutes', async () => {
    const run = { name: 'Tuesday', facility_name: 'Hall', current_price_pence: 1000,
        full_price_pence: 1000, remaining_sessions: 2, total_sessions: 2, capacity: 12,
        sessions: [
            { starts_local: '2027-01-05 13:45', ends_local: '2027-01-05 14:30' },
            { starts_local: '2027-01-12 13:45', ends_local: '2027-01-12 15:00' }
        ] };
    const filename = path.join(__dirname, '../views/partials/course-run-details.ejs');
    assert.match(await ejs.renderFile(filename, { run }), /Session length: 45–75 minutes\./);
    run.sessions = [{ starts_local: '2027-01-05 13:45', ends_local: '2027-01-05 13:46' }];
    assert.match(await ejs.renderFile(filename, { run }), /Session length: 1 minute\./);
});

test('course description tags render bold, underline and bullets while escaping other HTML', async () => {
    const filename = path.join(__dirname, '../views/partials/faq-answer.ejs');
    const html = await ejs.renderFile(filename, {
        boldText: true,
        answer: 'Line one\n<bold>Bold</bold> <ul>Underlined</ul><bullet><bold>Item</bold></bullet><script>alert(1)</script><bold class="x">Literal</bold>'
    });
    assert.match(html, /Line one\n<strong>Bold<\/strong> <u>Underlined<\/u>/);
    assert.match(html, /<ul[^>]*><li><strong>Item<\/strong><\/li><\/ul>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;bold class=&#34;x&#34;&gt;Literal&lt;\/bold&gt;/);
    assert.doesNotMatch(html, /<script|color: #003e90/);
    const unpaired = await ejs.renderFile(filename, { boldText: true, answer: '<bold>Unfinished' });
    assert.match(unpaired, /&lt;bold&gt;Unfinished/);
});

test('email tags create safe mailto links in descriptions and FAQs', async () => {
    const filename = path.join(__dirname, '../views/partials/faq-answer.ejs');
    for (const boldText of [true, false]) {
        const html = await ejs.renderFile(filename, {
            boldText, answer: '<bullet>Contact <email>gym+team@example.com</email></bullet>'
        });
        assert.match(html, /<a href="mailto:gym%2Bteam%40example.com">gym\+team@example.com<\/a>/);
        assert.match(html, /<li>Contact <a/);
    }
    for (const address of ['not an address', 'javascript:alert(1)', 'a@example.com?subject=x',
        'a@example.com" onclick="alert(1)', '<bold>a@example.com</bold>', 'a'.repeat(255) + '@example.com']) {
        const html = await ejs.renderFile(filename, { answer: `<email>${address}</email>` });
        assert.doesNotMatch(html, /<a /);
        assert.match(html, /&lt;email&gt;/);
    }
    const html = await ejs.renderFile(filename, { answer: '<email>a@example.com' });
    assert.match(html, /&lt;email&gt;a@example.com/);
});
