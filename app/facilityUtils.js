const DEFAULT_MAX_RESIDENT_BOOKINGS = 8;
const MAX_RESIDENT_BOOKINGS_LIMIT = 100;

function parseFacilityInput(body) {
    if (!body || typeof body !== 'object') {
        return null;
    }

    const facility = {};
    for (const field of ['name', 'address', 'postcode', 'description']) {
        if (typeof body[field] !== 'string' || !body[field].trim()) {
            return null;
        }
        facility[field] = body[field].trim();
    }

    const coordinates = typeof body.coordinates === 'string'
        ? body.coordinates.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/)
        : null;
    if (!coordinates) {
        return null;
    }

    facility.latitude = Number(coordinates[1]);
    facility.longitude = Number(coordinates[2]);
    if (!Number.isFinite(facility.latitude) || facility.latitude < -90 || facility.latitude > 90 ||
        !Number.isFinite(facility.longitude) || facility.longitude < -180 || facility.longitude > 180) {
        return null;
    }

    const limitText = body.max_resident_bookings === undefined || body.max_resident_bookings === ''
        ? String(DEFAULT_MAX_RESIDENT_BOOKINGS)
        : String(body.max_resident_bookings).trim();
    if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > MAX_RESIDENT_BOOKINGS_LIMIT) {
        return null;
    }
    facility.max_resident_bookings = Number(limitText);

    if (!['in_app', 'external'].includes(body.booking_mode)) {
        return null;
    }
    facility.booking_mode = body.booking_mode;

    if (facility.booking_mode === 'external') {
        if (typeof body.external_booking_url !== 'string' || body.external_booking_url.trim().length > 2048) {
            return null;
        }

        try {
            const externalBookingUrl = new URL(body.external_booking_url.trim());
            if (!['http:', 'https:'].includes(externalBookingUrl.protocol) || !externalBookingUrl.hostname) {
                return null;
            }
            facility.external_booking_url = externalBookingUrl.toString();
        } catch {
            return null;
        }
    } else {
        facility.external_booking_url = null;
    }

    return facility;
}

function createGoogleMapsUrl(latitude, longitude) {
    const url = new URL('https://www.google.com/maps/search/');
    url.searchParams.set('api', '1');
    url.searchParams.set('query', `${latitude},${longitude}`);
    url.searchParams.set('zoom', '4');
    return url.toString();
}

module.exports = { parseFacilityInput, createGoogleMapsUrl, DEFAULT_MAX_RESIDENT_BOOKINGS, MAX_RESIDENT_BOOKINGS_LIMIT };