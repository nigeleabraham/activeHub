const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidEmail, parseDeclineComment } = require('../validation');

test('decline comments are required, trimmed and limited to 500 characters', () => {
    for (const value of [undefined, null, [], '', '   ', 'x'.repeat(501)]) {
        assert.equal(parseDeclineComment(value), null);
    }
    assert.equal(parseDeclineComment('  Not eligible  '), 'Not eligible');
    assert.equal(parseDeclineComment('x'.repeat(500)), 'x'.repeat(500));
});

test('isValidEmail accepts addresses with a non-whitespace local and dotted domain', () => {
    for (const email of ['person@example.com', 'first.last+tag@example.co.uk']) {
        assert.equal(isValidEmail(email), true, email);
    }
});

test('isValidEmail rejects malformed addresses and whitespace', () => {
    for (const email of ['', 'plain-address', '@example.com', 'person@localhost', 'person@example.', 'person@@example.com', 'person name@example.com']) {
        assert.equal(isValidEmail(email), false, email);
    }
});
