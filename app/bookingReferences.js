const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_ATTEMPTS = 10;

function generate(prefix) {
    let suffix = '';
    for (let i = 0; i < 6; i++) {
        suffix += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    return `${prefix}-${suffix}`;
}

async function insert(client, prefix, query, values) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const result = await client.query(query, [...values, generate(prefix)]);
        if (result.rowCount) return result.rows[0];
    }
    throw new Error('Could not generate a unique booking reference after 10 attempts.');
}

module.exports = { generate, insert };
