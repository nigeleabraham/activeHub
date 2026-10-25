const assert = require('node:assert/strict');
const test = require('node:test');
const { createGoogleMapsUrl, parseFacilityInput } = require('../facilityUtils');

const validInput = {
    name: '  Riverside Hall  ',
    address: '  10 River Street  ',
    postcode: '  AB1 2CD  ',
    coordinates: ' 51.5074, -0.1278 ',
    description: '  Community sports and event space.  ',
    booking_mode: 'in_app'
};

test('parses facility fields and decimal-degree coordinates', () => {
    assert.deepEqual(parseFacilityInput(validInput), {
        name: 'Riverside Hall',
        address: '10 River Street',
        postcode: 'AB1 2CD',
        description: 'Community sports and event space.',
        latitude: 51.5074,
        longitude: -0.1278,
        max_resident_bookings: 8,
        booking_mode: 'in_app',
        external_booking_url: null
    });
});

test('validates the per-resident booking limit', () => {
    assert.equal(parseFacilityInput({ ...validInput, max_resident_bookings: '3' }).max_resident_bookings, 3);
    for (const value of ['0', '-1', '101', '2.5', 'many']) {
        assert.equal(parseFacilityInput({ ...validInput, max_resident_bookings: value }), null);
    }
});

test('rejects missing required facility fields', () => {
    const input = { ...validInput, name: '   ' };
    assert.equal(parseFacilityInput(input), null);
});

test('rejects malformed coordinate pairs', () => {
    for (const coordinates of ['51.5', 'north, west', '51.5, -0.1, 10', '']) {
        assert.equal(parseFacilityInput({ ...validInput, coordinates }), null);
    }
});

test('rejects coordinates outside decimal-degree ranges', () => {
    assert.equal(parseFacilityInput({ ...validInput, coordinates: '90.01, 0' }), null);
    assert.equal(parseFacilityInput({ ...validInput, coordinates: '0, -180.01' }), null);
});

test('collects and normalizes an external booking URL', () => {
    const facility = parseFacilityInput({
        ...validInput,
        booking_mode: 'external',
        external_booking_url: ' https://book.example.test/facility '
    });

    assert.equal(facility.booking_mode, 'external');
    assert.equal(facility.external_booking_url, 'https://book.example.test/facility');
});

test('requires a valid HTTP or HTTPS URL for external booking', () => {
    for (const external_booking_url of ['', 'javascript:alert(1)', 'not a URL']) {
        assert.equal(parseFacilityInput({
            ...validInput,
            booking_mode: 'external',
            external_booking_url
        }), null);
    }
});

test('rejects unsupported booking modes', () => {
    assert.equal(parseFacilityInput({ ...validInput, booking_mode: 'phone' }), null);
});

test('creates a Google Maps URL with coordinates and zoom level 4', () => {
    const url = new URL(createGoogleMapsUrl(51.5074, -0.1278));

    assert.equal(url.origin, 'https://www.google.com');
    assert.equal(url.pathname, '/maps/search/');
    assert.equal(url.searchParams.get('api'), '1');
    assert.equal(url.searchParams.get('query'), '51.5074,-0.1278');
    assert.equal(url.searchParams.get('zoom'), '4');
});