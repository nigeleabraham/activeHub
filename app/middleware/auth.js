const crypto = require('crypto');
const Profiles = require('./../models/Profiles');

// Simulated login: a signed cookie identifies the selected profile. Replace this module
// (cookie handling and loadProfile) with Auth0 later; routes only rely on req.profile and the permission helpers.
const COOKIE_NAME = 'activehub_profile';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMINISTRATOR = 'Administrator';

const secret = process.env.SESSION_SECRET ||
    crypto.createHash('sha256').update(`activehub-session:${process.env.DATABASE_URL || 'dev'}`).digest('hex');

function sign(value) {
    return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function createSessionValue(profileGuid) {
    return `${profileGuid}.${sign(profileGuid)}`;
}

function readSessionValue(value) {
    if (typeof value !== 'string') return null;
    const separator = value.lastIndexOf('.');
    if (separator < 1) return null;
    const profileGuid = value.slice(0, separator);
    const signature = Buffer.from(value.slice(separator + 1));
    const expected = Buffer.from(sign(profileGuid));
    if (!GUID_PATTERN.test(profileGuid) || signature.length !== expected.length ||
        !crypto.timingSafeEqual(signature, expected)) {
        return null;
    }
    return profileGuid;
}

function parseCookies(header) {
    const cookies = {};
    for (const part of (header || '').split(';')) {
        const index = part.indexOf('=');
        if (index < 1) continue;
        try {
            cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
        } catch (error) {
            // Ignore malformed cookie values.
        }
    }
    return cookies;
}

function cookieAttributes() {
    return `Path=/; HttpOnly; SameSite=Lax${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;
}

function setSession(res, profileGuid) {
    res.append('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(createSessionValue(profileGuid))}; ${cookieAttributes()}`);
}

function clearSession(res) {
    res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes()}; Max-Age=0`);
}

function isAdministrator(profile) {
    return Boolean(profile) && profile.role === ADMINISTRATOR;
}

// Administrators can do everything; Residents and Coaches can book and cancel their own bookings.
function canCancelBooking(profile, booking) {
    if (!profile || !booking) return false;
    return isAdministrator(profile) || booking.profile_guid === profile.guid;
}

async function loadProfile(req, res, next) {
    try {
        const profileGuid = readSessionValue(parseCookies(req.headers.cookie)[COOKIE_NAME]);
        req.profile = profileGuid ? await Profiles.findByGuid(profileGuid) : null;
        res.locals.currentProfile = req.profile;
        res.locals.isAdmin = isAdministrator(req.profile);
        next();
    } catch (error) {
        next(error);
    }
}

function requireLogin(req, res, next) {
    if (req.profile) return next();
    if (req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
    return res.sendStatus(401);
}

function requireAdministrator(req, res, next) {
    if (isAdministrator(req.profile)) return next();
    if (!req.profile) return res.sendStatus(401);
    return res.status(403).render('forbidden', { activePage: '' });
}

module.exports = {
    COOKIE_NAME,
    ADMINISTRATOR,
    createSessionValue,
    readSessionValue,
    parseCookies,
    setSession,
    clearSession,
    isAdministrator,
    canCancelBooking,
    loadProfile,
    requireLogin,
    requireAdministrator
};
