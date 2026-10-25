const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidEmail } = require('../validation');

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
