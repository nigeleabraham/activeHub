const crypto = require('crypto');
const Profiles = require('./../models/Profiles');
const Roles = require('./../models/Roles');
const { PERMISSION_KEYS, adminPermissions } = require('../permissions');

// Simulated login: a signed cookie identifies the selected profile. Replace this module
// (cookie handling and loadProfile) with Auth0 later; routes only rely on req.profile and the permission helpers.
const COOKIE_NAME = 'activehub_profile';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW_AS_COOKIE = 'activehub_view_as';
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

// The selected role is signed against the profile and rechecked against current assignments on every request.
function setViewAs(res, profileGuid, roleName) {
    const encoded = Buffer.from(roleName).toString('base64url');
    res.append('Set-Cookie', `${VIEW_AS_COOKIE}=${encoded}.${sign(`view-as:${profileGuid}:${roleName}`)}; ${cookieAttributes()}`);
}

function clearViewAs(res) {
    res.append('Set-Cookie', `${VIEW_AS_COOKIE}=; ${cookieAttributes()}; Max-Age=0`);
}

function readViewAs(value, profileGuid) {
    if (typeof value !== 'string') return null;
    const separator = value.lastIndexOf('.');
    if (separator < 1) return null;
    const roleName = Buffer.from(value.slice(0, separator), 'base64url').toString();
    const signature = Buffer.from(value.slice(separator + 1));
    const expected = Buffer.from(sign(`view-as:${profileGuid}:${roleName}`));
    if (!roleName || signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
    return roleName;
}

function isAdministrator(profile) {
    return Boolean(profile) && profile.role === ADMINISTRATOR;
}

async function switchableRoles(profile) {
    const assigned = profile.roles || [profile.role];
    return assigned.includes(ADMINISTRATOR) ? Roles.names() : assigned;
}

// Administrators always hold every permission; other roles hold what the Roles page grants them.
function can(profile, permission) {
    if (!profile) return false;
    return isAdministrator(profile) || (profile.permissions || []).includes(permission);
}

function canAccessAdmin(profile, path = '/') {
    if (isAdministrator(profile)) return true;
    const permissions = path === '/' ? PERMISSION_KEYS : adminPermissions(path);
    return permissions.some(permission => can(profile, permission));
}

function requireAdminAccess(req, res, next) {
    if (canAccessAdmin(req.profile, req.path)) return next();
    return deny(req, res);
}

async function loadProfile(req, res, next) {
    try {
        const profileGuid = readSessionValue(parseCookies(req.headers.cookie)[COOKIE_NAME]);
        const cookies = parseCookies(req.headers.cookie);
        req.realProfile = profileGuid ? await Profiles.findByGuid(profileGuid) : null;
        req.profile = req.realProfile;
        res.locals.canSwitchRole = false;
        res.locals.viewingAs = null;
        if (req.profile) {
            const viewAs = readViewAs(cookies[VIEW_AS_COOKIE], req.profile.guid);
            const roleNames = await switchableRoles(req.realProfile);
            if (viewAs && roleNames.includes(viewAs)) {
                req.profile = { ...req.profile, role: viewAs };
                res.locals.viewingAs = viewAs !== req.realProfile.role ? viewAs : null;
            } else if (cookies[VIEW_AS_COOKIE]) {
                clearViewAs(res);
            }
            req.profile.permissions = await Roles.permissionsFor(req.profile.role);
            res.locals.canSwitchRole = roleNames.length > 1;
            res.locals.switchableRoles = roleNames;
        }
        res.locals.currentProfile = req.profile;
        res.locals.can = permission => can(req.profile, permission);
        res.locals.isAdmin = isAdministrator(req.profile);
        res.locals.canAccessAdmin = path => canAccessAdmin(req.profile, path);
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

function deny(req, res) {
    if (!req.profile) return res.sendStatus(401);
    return res.status(403).render('forbidden', { activePage: '' });
}

function requireAdministrator(req, res, next) {
    if (isAdministrator(req.profile)) return next();
    return deny(req, res);
}

module.exports = {
    COOKIE_NAME,
    ADMINISTRATOR,
    createSessionValue,
    readSessionValue,
    parseCookies,
    setSession,
    clearSession,
    setViewAs,
    clearViewAs,
    readViewAs,
    isAdministrator,
    switchableRoles,
    can,
    canAccessAdmin,
    requireAdminAccess,
    loadProfile,
    requireLogin,
    requireAdministrator
};
