const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSessions, parsePrice, summary } = require('../scripts/importCamdenCourses');

test('Camden session import extracts dates, UK wall times and factual locations', () => {
    const html = `Session Times</h4><table><tr><th>Date</th><th>Times</th><th>Location</th></tr>
        <tr><td>Tuesday 3 Nov 2026</td><td>13:45 - 14:30</td><td>Talacre Sports Centre (Gymnasium)</td></tr></table>`;
    assert.deepEqual(parseSessions(html), [{ starts_local: '2026-11-03 13:45', ends_local: '2026-11-03 14:30',
        location: 'Talacre Sports Centre (Gymnasium)' }]);
    assert.throws(() => parseSessions('Unavailable'), /Missing source session table/);
    assert.throws(() => parseSessions(html.replace('3 Nov 2026', 'unknown')), /Unrecognised/);
});

test('Camden full price is derived from original count, not the reduced advertised total', () => {
    const html = 'Per session: <span>£14.00</span><br />Total cost: <span>£98.00</span><br />There are 7 weeks remaining of a 15 week course.';
    assert.deepEqual(parsePrice(html), { full_price_pence: 21000, original_sessions: 15,
        advertised_remaining: 7, advertised_price_pence: 9800 });
    assert.throws(() => parsePrice(html.replace('£98.00', '£99.00')), /do not agree/);
    assert.throws(() => parsePrice(''), /Missing source/);
    assert.match(summary('Preschool'), /maximum capacity/);
    assert.match(summary('Preschool'), /complete original session schedule/);
});

test('Camden text extraction handles nested opening brackets and long unmatched tag prefixes', () => {
    const table = location => `Session Times</h4><table><tr><td>Tuesday 3 Nov 2026</td>
        <td>13:45 - 14:30</td><td>${location}</td></tr></table>`;
    assert.equal(parseSessions(table('A <<span>Hall</span> &amp; &quot;Gym&quot;'))[0].location,
        'A Hall & "Gym"');
    assert.throws(() => parsePrice('<'.repeat(100000)), /Missing source/);
});

test('Camden summaries remove only the trailing term label and its surrounding whitespace', () => {
    const description = summary('Preschool');
    assert.equal(summary('Preschool \t autumn TERM 2026 \n'), description);
    assert.equal(summary(`Preschool${' '.repeat(100000)}Autumn term 2026`), description);
    const unchanged = `Preschool${' '.repeat(100000)}other term`;
    assert.ok(summary(unchanged).startsWith(`${unchanged}.`));
    assert.ok(summary('Autumn term 2026 Preschool').startsWith('Autumn term 2026 Preschool.'));
});
