const assert = require('node:assert/strict');
const test = require('node:test');
const { createGoogleMapsUrl, parseFacilityInput, resolveFacilityCoordinates } = require('../facilityUtils');

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
    for (const coordinates of ['51.5', 'north, west', '51.5, -0.1, 10', null, 12]) {
        assert.equal(parseFacilityInput({ ...validInput, coordinates }), null);
    }
});

test('blank or omitted coordinates request postcode resolution', () => {
    for (const coordinates of ['', '   ', undefined]) {
        const facility = parseFacilityInput({ ...validInput, coordinates });
        assert.equal(facility.latitude, null);
        assert.equal(facility.longitude, null);
    }
});

test('explicit coordinates bypass the postcode service', async t => {
    const lookup = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected lookup'); });
    const facility = parseFacilityInput(validInput);
    assert.equal(await resolveFacilityCoordinates(facility), facility);
    assert.equal(lookup.mock.callCount(), 0);
});

test('postcode resolution sends only the encoded postcode and supplies map/daylight coordinates', async t => {
    const lookup = t.mock.method(globalThis, 'fetch', async () => ({
        ok: true, status: 200,
        json: async () => ({ status: 200, result: { latitude: 51.5074, longitude: -0.1278 } })
    }));
    const facility = await resolveFacilityCoordinates(parseFacilityInput({ ...validInput, coordinates: '' }));
    assert.equal(facility.latitude, 51.5074);
    assert.equal(facility.longitude, -0.1278);
    assert.equal(lookup.mock.calls[0].arguments[0], 'https://api.postcodes.io/postcodes/AB1%202CD');
    assert.equal(lookup.mock.calls[0].arguments[1].redirect, 'error');
    assert.ok(lookup.mock.calls[0].arguments[1].signal instanceof AbortSignal);
});

test('postcode lookup rejects missing postcodes, outages and invalid locations explicitly', async t => {
    const lookup = t.mock.method(globalThis, 'fetch');
    const facility = parseFacilityInput({ ...validInput, coordinates: '' });
    for (const response of [
        { status: 404, ok: false },
        { status: 503, ok: false },
        { status: 200, ok: true, json: async () => ({ status: 200, result: { latitude: null, longitude: 0 } }) },
        { status: 200, ok: true, json: async () => ({ status: 200, result: { latitude: 91, longitude: 0 } }) }
    ]) {
        lookup.mock.mockImplementation(async () => response);
        await assert.rejects(resolveFacilityCoordinates(facility), { code: 'POSTCODE_LOOKUP_FAILED' });
    }
    for (const error of [new TypeError('Network failure'), new DOMException('Timed out', 'TimeoutError')]) {
        lookup.mock.mockImplementation(async () => { throw error; });
        await assert.rejects(resolveFacilityCoordinates(facility), {
            code: 'POSTCODE_LOOKUP_FAILED', message: /Try again or enter coordinates manually/
        });
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

test('facility create and update save resolved coordinates and expose lookup failures without saving', async t => {
    const Facilities = require('../models/Facilities');
    const Sports = require('../models/Sports');
    const OpeningHours = require('../models/OpeningHours');
    const router = require('../routes/front');
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const guid = '123e4567-e89b-42d3-a456-426614174000';
    t.mock.method(Sports, 'findAll', async () => [{ guid }]);
    t.mock.method(OpeningHours, 'findAll', async () => [{ guid, dawn_override: true, dusk_override: true }]);
    const lookup = t.mock.method(globalThis, 'fetch', async () => ({
        ok: true, status: 200,
        json: async () => ({ status: 200, result: { latitude: 51.5074, longitude: -0.1278 } })
    }));
    const create = t.mock.method(Facilities, 'create', async () => ({ guid }));
    const update = t.mock.method(Facilities, 'update', async () => ({ guid }));
    t.mock.method(console, 'error', () => {});
    for (const path of ['/facilities', '/facilities/update']) {
        const handler = admin.stack.findLast(layer => layer.route?.path === path && layer.route.methods.post).route.stack[0].handle;
        const body = { ...validInput, guid, sport_guids: [guid], coordinates: '', opening_hours_template_guid: guid };
        let result;
        const res = {
            redirect(location) { result = location; },
            status(status) { result = { status }; return this; },
            json(problem) { result.problem = problem; },
            sendStatus(status) { result = status; }
        };
        await handler({ body }, res);
        assert.equal(result, path.endsWith('/update') ? `/admin/facilities?admin_saved=facility-updated&admin_saved_target=facility-${guid}#facility-${guid}`
            : '/admin/facilities?admin_saved=facility-created');
        const saved = path.endsWith('/update') ? update.mock.calls[0].arguments[1] : create.mock.calls[0].arguments[0];
        assert.equal(saved.latitude, 51.5074);
        assert.equal(saved.longitude, -0.1278);
        assert.equal(saved.opening_hours_template_guid, guid);
        const schedule = OpeningHours.applyDaylightLimits({
            date: '2026-10-30', is_closed: false, opens_at: '06:00', closes_at: '22:00'
        }, { dawn_override: true, dusk_override: true }, saved);
        assert.equal(schedule.closes_at, '17:00');
        lookup.mock.mockImplementation(async () => ({ ok: false, status: 404 }));
        await handler({ body }, res);
        assert.equal(result.status, 422);
        assert.match(result.problem.error, /Postcode not found/);
        await handler({ body: { ...body, sport_guids: [] } }, res);
        assert.equal(result, 400);
        await handler({ body: { ...body, sport_guids: undefined } }, res);
        assert.equal(result, 400);
        lookup.mock.mockImplementation(async () => ({
            ok: true, status: 200,
            json: async () => ({ status: 200, result: { latitude: 51.5074, longitude: -0.1278 } })
        }));
    }
    assert.equal(create.mock.callCount(), 1);
    assert.equal(update.mock.callCount(), 1);
});