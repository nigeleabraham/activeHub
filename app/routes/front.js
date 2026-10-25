const crypto = require('crypto');
const express = require('express');
const Facilities = require('./../models/Facilities');
const Courses = require('./../models/Courses');
const Sports = require('./../models/Sports');
const Bookings = require('./../models/Bookings');
const Credits = require('./../models/Credits');
const OpeningHours = require('./../models/OpeningHours');
const Profiles = require('./../models/Profiles');
const Roles = require('./../models/Roles');
const Settings = require('./../models/Settings');
const { PERMISSIONS, PERMISSION_KEYS } = require('./../permissions');
const AuditLog = require('./../models/AuditLog');
const auth = require('./../middleware/auth');
const { parseFacilityInput } = require('./../facilityUtils');
const { isValidEmail, parseDeclineComment, parseBookingMonths } = require('./../validation');

const router = express.Router();
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseCourseInput(body) {
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160 ||
        typeof body.facility_guid !== 'string' || !GUID_PATTERN.test(body.facility_guid) || description.length > 10000) {
        return null;
    }
    return { name: body.name.trim(), facility_guid: body.facility_guid, description: description || null };
}

function parseOpeningHoursInput(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return null;
    const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);

    const rules = [];
    for (let day = 0; day < 7; day++) {
        if (body[`day_${day}_closed`] === 'on') continue;
        const opensAt = body[`day_${day}_opens_at`];
        const closesAt = body[`day_${day}_closes_at`];
        if (!validTime(opensAt) || !validTime(closesAt) || closesAt <= opensAt) return null;
        rules.push({ day_of_week: day, opens_at: opensAt, closes_at: closesAt });
    }

    return { name, rules, dawn_override: body.dawn_override === 'on', dusk_override: body.dusk_override === 'on' };
}

function parseResourceInput(body) {
    const { facility_guid, guid } = body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!GUID_PATTERN.test(facility_guid || '') || (guid !== undefined && !GUID_PATTERN.test(guid)) ||
        !name || name.length > 120) {
        return null;
    }
    return { facility_guid, guid, name };
}

function parseBookableOptionInput(body) {
    const { facility_guid, guid, sport_guid } = body;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const resourceGuids = body.resource_guids === undefined
        ? []
        : Array.isArray(body.resource_guids) ? body.resource_guids : [body.resource_guids];
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(sport_guid || '') ||
        (guid !== undefined && !GUID_PATTERN.test(guid)) || !name || name.length > 120 ||
        !resourceGuids.length || resourceGuids.some(resourceGuid => !GUID_PATTERN.test(resourceGuid))) {
        return null;
    }
    return { facility_guid, guid, sport_guid, name, resource_guids: [...new Set(resourceGuids)] };
}

async function parseFacilityForm(body) {
    const facility = parseFacilityInput(body);
    if (!facility) {
        return null;
    }

    const submittedSports = body.sport_guids === undefined
        ? []
        : Array.isArray(body.sport_guids) ? body.sport_guids : [body.sport_guids];
    if (submittedSports.length > 100 || submittedSports.some(guid => typeof guid !== 'string' || !GUID_PATTERN.test(guid))) {
        return null;
    }

    const selectedGuids = [...new Set(submittedSports)];
    const availableSports = await Sports.findAll();
    const availableGuids = new Set(availableSports.map(sport => sport.guid));
    if (selectedGuids.some(guid => !availableGuids.has(guid))) {
        return null;
    }

    const openingHoursTemplateGuid = body.opening_hours_template_guid || null;
    if (openingHoursTemplateGuid && !GUID_PATTERN.test(openingHoursTemplateGuid)) {
        return null;
    }
    const hoursTemplates = await OpeningHours.findAll();
    if (openingHoursTemplateGuid && !hoursTemplates.some(template => template.guid === openingHoursTemplateGuid)) {
        return null;
    }

    return {
        ...facility,
        sport_guids: selectedGuids,
        opening_hours_template_guid: openingHoursTemplateGuid
    };
}


async function recordAudit(profile, entry) {
    try {
        // While an administrator is viewing as another role, the audit trail still names them as the administrator.
        await AuditLog.record(profile.actualRole ? { ...profile, role: profile.actualRole } : profile, entry);
    } catch (error) {
        console.error('Unable to write audit log:', error);
    }
}

// Everything under /admin is administrator-only. Residents and coaches never reach these routes.
const ADMIN_LINKS = [
    { href: '/admin/facilities', title: 'Facilities', text: 'Venues, descriptions and opening hours templates' },
    { href: '/admin/courses', title: 'Courses', text: 'Courses offered at each facility' },
    { href: '/admin/sports', title: 'Sports', text: 'The sports facilities can offer' },
    { href: '/admin/opening-hours', title: 'Opening hours', text: 'Weekly schedules and exceptions' },
    { href: '/admin/bookings', title: 'Bookings', text: 'Book and manage slots for any profile' },
    { href: '/admin/credit-requests', title: 'Credit requests', text: 'Weather and discretionary credit requests from residents' },
    { href: '/admin/credit-refunds', title: 'Credit refunds', text: 'Review requests to transfer booking credit to a bank account' },
    { href: '/admin/refunds', title: 'Refunds', text: 'Find a booking and refund it as account credit' },
    { href: '/admin/profiles', title: 'Profiles', text: 'People and the role each one holds' },
    { href: '/admin/roles', title: 'Roles', text: 'Create roles and assign responsibilities' },
    { href: '/admin/settings', title: 'Settings', text: 'The title and logo shown on the public home page' },
    { href: '/admin/audit', title: 'Audit', text: 'A record of who changed what, and when' }
];
const admin = express.Router();
admin.use(auth.requireAdministrator, (req, res, next) => {
    res.locals.area = 'admin';
    next();
});

// Management actions: audited once the handler has redirected without an error.
const labelFrom = body => (typeof body.name === 'string' ? body.name.trim() : null);
const findLabel = async (list, guid) => (await list).find(item => item.guid === guid)?.name || null;

const MANAGEMENT_ACTIONS = {
    '/facilities': { action: 'facility.create', entity: 'facility', label: labelFrom },
    '/facilities/update': { action: 'facility.update', entity: 'facility', label: labelFrom },
    '/facilities/destroy': { action: 'facility.delete', entity: 'facility', label: b => findLabel(Facilities.findAll(), b.guid) },
    '/courses': { action: 'course.create', entity: 'course', label: labelFrom },
    '/courses/update': { action: 'course.update', entity: 'course', label: labelFrom },
    '/courses/destroy': { action: 'course.delete', entity: 'course', label: b => findLabel(Courses.findAll(), b.guid) },
    '/facilities/courses/destroy': { action: 'course.delete', entity: 'course', label: b => findLabel(Courses.findAll(), b.guid) },
    '/sports': { action: 'sport.create', entity: 'sport', label: labelFrom },
    '/sports/update': { action: 'sport.update', entity: 'sport', label: labelFrom },
    '/sports/destroy': { action: 'sport.delete', entity: 'sport', label: b => findLabel(Sports.findAll(), b.guid) },
    '/opening-hours': { action: 'opening_hours.create', entity: 'opening_hours', label: labelFrom },
    '/opening-hours/update': { action: 'opening_hours.update', entity: 'opening_hours', label: labelFrom },
    '/opening-hours/destroy': { action: 'opening_hours.delete', entity: 'opening_hours', label: b => findLabel(OpeningHours.findAll(), b.guid) },
    '/bookings/resources': { action: 'resource.create', entity: 'resource', label: labelFrom },
    '/bookings/resources/update': { action: 'resource.update', entity: 'resource', label: labelFrom, guid: b => b.guid },
    '/bookings/resources/destroy': { action: 'resource.delete', entity: 'resource', guid: b => b.resource_guid,
        label: b => findLabel(Bookings.findResources(b.facility_guid), b.resource_guid) },
    '/bookings/options': { action: 'option.create', entity: 'bookable_option', label: labelFrom },
    '/bookings/options/update': { action: 'option.update', entity: 'bookable_option', label: labelFrom, guid: b => b.guid },
    '/bookings/options/destroy': { action: 'option.delete', entity: 'bookable_option', guid: b => b.option_guid,
        label: b => findLabel(Bookings.findOptions(b.facility_guid), b.option_guid) }
};

for (const [path, definition] of Object.entries(MANAGEMENT_ACTIONS)) {
    admin.post(path, async (req, res, next) => {
        const body = req.body || {};
        let label = null;
        try {
            label = (await definition.label(body)) || null;
        } catch (error) {
            // The audit label is best effort.
        }
        const entityGuid = definition.guid ? definition.guid(body) : body.guid || null;
        res.on('finish', () => {
            const location = res.getHeader('Location') || '';
            if (res.statusCode >= 300 && res.statusCode < 400 && !String(location).includes('error=')) {
                void recordAudit(req.profile, {
                    action: definition.action,
                    entityType: definition.entity,
                    entityGuid: GUID_PATTERN.test(entityGuid || '') ? entityGuid : null,
                    entityLabel: label
                });
            }
        });
        next();
    });
}

router.get('/login', async (req, res) => {
    try {
        res.render('login', { profiles: await Profiles.findAll(), activePage: '' });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/login', async (req, res) => {
    const guid = req.body.profile_guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.sendStatus(400);
    try {
        const profile = await Profiles.findByGuid(guid);
        if (!profile) return res.sendStatus(404);
        profile.permissions = await Roles.permissionsFor(profile.role);
        auth.setSession(res, profile.guid);
        await recordAudit(profile, { action: 'auth.login', entityType: 'profile', entityGuid: profile.guid, entityLabel: profile.name });
        return res.redirect('/');
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.post('/logout', async (req, res) => {
    if (req.profile) {
        await recordAudit(req.profile, { action: 'auth.logout', entityType: 'profile', entityGuid: req.profile.guid, entityLabel: req.profile.name });
    }
    auth.clearSession(res);
    auth.clearViewAs(res);
    res.redirect('/login');
});

router.post('/view-as', auth.requireLogin, async (req, res) => {
    if (!req.realProfile || req.realProfile.role !== auth.ADMINISTRATOR) return res.sendStatus(403);
    const role = typeof req.body.role === 'string' ? req.body.role : '';
    try {
        if (!role || role === auth.ADMINISTRATOR) {
            auth.clearViewAs(res);
            await recordAudit(req.realProfile, { action: 'auth.view_as', entityType: 'role', entityLabel: auth.ADMINISTRATOR, details: { view_as: auth.ADMINISTRATOR } });
            return res.redirect('/');
        }
        if (!(await Roles.names()).includes(role)) return res.sendStatus(400);
        auth.setViewAs(res, req.realProfile.guid, role);
        await recordAudit(req.realProfile, { action: 'auth.view_as', entityType: 'role', entityLabel: role, details: { view_as: role } });
        return res.redirect('/');
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.get('/site-logo', async (req, res) => {
    try {
        const logo = await Settings.getLogo();
        if (!logo) return res.sendStatus(404);
        res.set({
            'Content-Type': logo.content_type,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'Cache-Control': 'no-cache'
        });
        return res.send(logo.data);
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.use(auth.requireLogin);

// Residents may only book up to a month ahead.
function latestResidentBookingStart(now = new Date()) {
    const limit = new Date(now);
    limit.setMonth(limit.getMonth() + 1);
    return limit;
}

const availabilityHandler = ({ resident = false } = {}) => async (req, res) => {
    const { facilityGuid } = req.params;
    const startsAt = new Date(req.query.start);
    const endsAt = new Date(req.query.end);
    if (!GUID_PATTERN.test(facilityGuid) || !Number.isFinite(startsAt.getTime()) ||
        !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt ||
        endsAt - startsAt > 8 * 24 * 60 * 60 * 1000) {
        return res.sendStatus(400);
    }

    try {
        const facilities = await Bookings.findInAppFacilities();
        const facility = facilities.find(item => item.guid === facilityGuid);
        if (!facility) {
            return res.sendStatus(404);
        }
        const [options, bookings, schedules] = await Promise.all([
            Bookings.findOptions(facilityGuid),
            Bookings.findBookings(facilityGuid, startsAt.toISOString(), endsAt.toISOString()),
            OpeningHours.getSchedules(
                facility.opening_hours_template_guid,
                startsAt,
                9,
                facility
            )
        ]);
        res.json({
            options,
            // Residents see which slots are taken, but not who took them.
            bookings: resident
                ? bookings.map(({ profile_guid, profile_name, booked_by_guid, booked_by_name, ...booking }) => booking)
                : bookings,
            schedules
        });
    } catch (error) {
        res.sendStatus(500);
    }
};

const MAX_BATCH_BOOKINGS = 50;

const BOOKINGS_PATH = '/admin/bookings';

// Placeholder price until real pricing exists; payments are simulated.
const SIMULATED_SLOT_PRICE_PENCE = 500;

const formatPounds = pence => `£${(pence / 100).toFixed(2)}`;

// Validates a batch of slots. Returns { status }, { redirect } or { facility, bookings, assigneesByGuid }.
async function prepareBatch(req, { resident }) {
    const bookingsPath = resident ? '/bookings' : '/admin/bookings';
    const { facility_guid } = req.body;
    let slots;
    try {
        slots = JSON.parse(req.body.slots || '[]');
    } catch (error) {
        return { status: 400 };
    }
    if (!GUID_PATTERN.test(facility_guid || '') || !Array.isArray(slots) ||
        !slots.length || slots.length > MAX_BATCH_BOOKINGS) {
        return { status: 400 };
    }
    const bookings = [];
    for (const slot of slots) {
        const startDate = new Date(slot?.starts_at);
        const endDate = new Date(slot?.ends_at);
        // Residents can only book for themselves.
        const profileGuid = resident ? req.profile.guid : slot?.profile_guid;
        if (!GUID_PATTERN.test(slot?.option_guid || '') ||
            !Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate ||
            typeof profileGuid !== 'string' || !GUID_PATTERN.test(profileGuid)) {
            return { status: 400 };
        }
        if (resident && (endDate <= new Date() || startDate > latestResidentBookingStart())) {
            return { redirect: `${bookingsPath}?error=too-far-ahead` };
        }
        bookings.push({
            facility_guid,
            option_guid: slot.option_guid,
            starts_at: startDate.toISOString(),
            ends_at: endDate.toISOString(),
            profile_guid: profileGuid,
            booked_by_guid: req.profile.guid
        });
    }
    const facilities = await Bookings.findInAppFacilities();
    const facility = facilities.find(item => item.guid === facility_guid);
    if (!facility) return { status: 404 };
    const options = await Bookings.findOptions(facility_guid);
    const monthFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', month: 'numeric' });
    for (const booking of bookings) {
        const option = options.find(item => item.guid === booking.option_guid);
        if (!option) return { status: 404 };
        if (!option.allowed_months.includes(Number(monthFormatter.format(new Date(booking.starts_at)))) ||
            !option.allowed_months.includes(Number(monthFormatter.format(new Date(new Date(booking.ends_at).getTime() - 1))))) {
            return { redirect: `${bookingsPath}?error=month-unavailable` };
        }
    }
    if (resident) {
        const existing = await Bookings.countUpcomingForProfile(req.profile.guid, facility_guid);
        if (existing + bookings.length > facility.max_resident_bookings) {
            return { redirect: `${bookingsPath}?error=booking-limit` };
        }
    }
    const assigneeGuids = [...new Set(bookings.map(booking => booking.profile_guid).filter(Boolean))];
    const assignees = await Promise.all(assigneeGuids.map(guid => Profiles.findByGuid(guid)));
    if (assignees.some(assignee => !assignee)) return { status: 404 };
    for (const booking of bookings) {
        const withinOpeningHours = await OpeningHours.isBookingWithinHours(
            facility.opening_hours_template_guid,
            new Date(booking.starts_at),
            new Date(booking.ends_at),
            facility
        );
        if (!withinOpeningHours) return { redirect: `${bookingsPath}?error=outside-opening-hours` };
    }
    return { facility, bookings, assigneesByGuid: new Map(assignees.map(assignee => [assignee.guid, assignee])) };
}

async function saveBatch(req, { facility, bookings, assigneesByGuid }, payment = {}) {
    const createdBookings = await Bookings.createBookings(bookings.map(booking => ({ ...booking, ...payment })));
    for (const [index, booking] of bookings.entries()) {
        await recordAudit(req.profile, {
            action: 'booking.create', entityType: 'booking', entityGuid: createdBookings?.[index]?.guid,
            entityLabel: facility.name,
            details: {
                starts_at: booking.starts_at,
                ends_at: booking.ends_at,
                reference: createdBookings?.[index]?.booking_ref,
                option_guid: booking.option_guid,
                booked_for: assigneesByGuid.get(booking.profile_guid)?.name || null,
                ...(payment.payment_status ? { payment_status: payment.payment_status, payment_reference: payment.payment_reference } : {})
            }
        });
    }
}

const createBatchHandler = async (req, res) => {
    try {
        const prepared = await prepareBatch(req, { resident: false });
        if (prepared.status) return res.sendStatus(prepared.status);
        if (prepared.redirect) return res.redirect(prepared.redirect);
        await saveBatch(req, prepared);
        return res.redirect(`/admin/bookings?created=${prepared.bookings.length}`);
    } catch (error) {
        if (error.code === '23P01') return res.status(409).json({ code: 'booking-conflict' });
        if (error.code === 'OPTION_MONTH_UNAVAILABLE') return res.redirect('/admin/bookings?error=month-unavailable');
        return res.redirect('/admin/bookings?error=invalid-booking');
    }
};

// Applies the profile's credit first; the remainder (if any) goes to the card.
function priceBatch(count, creditPence) {
    const total = count * SIMULATED_SLOT_PRICE_PENCE;
    const credit = Math.min(Math.max(creditPence, 0), total);
    return { total, credit, due: total - credit };
}

// Spreads the credit over the slots in order so each booking records what it cost and how it was paid.
function allocateCredit(count, credit) {
    let left = credit;
    return Array.from({ length: count }, () => {
        const applied = Math.min(left, SIMULATED_SLOT_PRICE_PENCE);
        left -= applied;
        return applied;
    });
}

async function renderCheckout(req, res, prepared, { cardError, values = {} } = {}) {
    const [settings, hasLogo, options] = await Promise.all([
        Settings.getAll(),
        Settings.getLogo().then(Boolean),
        Bookings.findOptions(prepared.facility.guid)
    ]);
    const pricing = priceBatch(prepared.bookings.length, req.profile.credit_pence);
    const optionsByGuid = new Map(options.map(option => [option.guid, option]));
    const items = [...prepared.bookings]
        .sort((first, second) => first.starts_at.localeCompare(second.starts_at))
        .map(booking => ({ ...booking, option_name: optionsByGuid.get(booking.option_guid)?.name || 'Court' }));
    return res.status(cardError ? 422 : 200).render('resident-checkout', {
        activePage: 'bookings',
        siteTitle: settings.site_title,
        hasLogo,
        facility: prepared.facility,
        items,
        slotsJson: JSON.stringify(prepared.bookings.map(({ option_guid, starts_at, ends_at }) => ({ option_guid, starts_at, ends_at }))),
        total: formatPounds(pricing.total),
        credit: formatPounds(pricing.credit),
        availableCredit: formatPounds(req.profile.credit_pence),
        due: formatPounds(pricing.due),
        fullyCovered: pricing.due === 0,
        unitPrice: formatPounds(SIMULATED_SLOT_PRICE_PENCE),
        cardError,
        values
    });
}

// Luhn check so obviously mistyped card numbers are caught, as a real gateway would.
function passesLuhn(digits) {
    let sum = 0;
    for (let index = 0; index < digits.length; index++) {
        let digit = Number(digits[digits.length - 1 - index]);
        if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
        sum += digit;
    }
    return sum % 10 === 0;
}

// Simulated card check. Card details are never stored or logged.
function simulateCardPayment(body) {
    const name = typeof body.card_name === 'string' ? body.card_name.trim() : '';
    const number = typeof body.card_number === 'string' ? body.card_number.replace(/[\s-]/g, '') : '';
    const expiry = typeof body.card_expiry === 'string' ? body.card_expiry.trim().match(/^(\d{2})\s*\/\s*(\d{2})$/) : null;
    const cvc = typeof body.card_cvc === 'string' ? body.card_cvc.trim() : '';
    if (!name || name.length > 100) return { error: 'Enter the name on the card.' };
    if (!/^\d{13,19}$/.test(number) || !passesLuhn(number)) return { error: 'Enter a valid card number.' };
    const month = expiry ? Number(expiry[1]) : 0;
    const year = expiry ? 2000 + Number(expiry[2]) : 0;
    const now = new Date();
    if (!expiry || month < 1 || month > 12 || year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
        return { error: 'Enter a valid expiry date (MM/YY).' };
    }
    if (!/^\d{3,4}$/.test(cvc)) return { error: 'Enter the 3 or 4 digit security code.' };
    if (number.endsWith('0002')) return { error: 'Your card was declined. Try a different card. You have not been charged.' };
    return { reference: `SIM-${crypto.randomBytes(5).toString('hex').toUpperCase()}` };
}

const residentCheckoutHandler = async (req, res) => {
    try {
        const prepared = await prepareBatch(req, { resident: true });
        if (prepared.status) return res.sendStatus(prepared.status);
        if (prepared.redirect) return res.redirect(prepared.redirect);
        return await renderCheckout(req, res, prepared);
    } catch (error) {
        return res.redirect('/bookings?error=invalid-booking');
    }
};

const residentPayHandler = async (req, res) => {
    try {
        const prepared = await prepareBatch(req, { resident: true });
        if (prepared.status) return res.sendStatus(prepared.status);
        if (prepared.redirect) return res.redirect(prepared.redirect);
        // Re-read the balance so a stale checkout page can't spend credit twice.
        const fresh = await Profiles.findByGuid(req.profile.guid);
        const pricing = priceBatch(prepared.bookings.length, fresh.credit_pence);
        let reference = null;
        if (pricing.due > 0) {
            const payment = simulateCardPayment(req.body);
            if (payment.error) {
                return await renderCheckout(req, res, prepared, {
                    cardError: payment.error,
                    values: { card_name: String(req.body.card_name || '').slice(0, 100) }
                });
            }
            reference = payment.reference;
        } else {
            reference = `CREDIT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        }
        const allocation = allocateCredit(prepared.bookings.length, pricing.credit);
        const items = prepared.bookings.map((booking, index) => ({
            ...booking,
            payment_status: pricing.due > 0 ? 'paid' : 'credit',
            payment_reference: reference,
            amount_pence: SIMULATED_SLOT_PRICE_PENCE,
            credit_applied_pence: allocation[index],
            amount_paid_pence: SIMULATED_SLOT_PRICE_PENCE
        }));
        const createdBookings = await Bookings.createBookings(items, { profile_guid: req.profile.guid, pence: pricing.credit });
        for (const [index, booking] of items.entries()) {
            await recordAudit(req.profile, {
                action: 'booking.create', entityType: 'booking', entityGuid: createdBookings?.[index]?.guid,
                entityLabel: prepared.facility.name,
                details: {
                    starts_at: booking.starts_at, ends_at: booking.ends_at, option_guid: booking.option_guid,
                    reference: createdBookings?.[index]?.booking_ref, booked_for: req.profile.name, payment_status: booking.payment_status,
                    payment_reference: reference, credit_applied: formatPounds(booking.credit_applied_pence)
                }
            });
        }
        return res.redirect(`/bookings?created=${prepared.bookings.length}&paid=${encodeURIComponent(formatPounds(pricing.due))}&credit=${encodeURIComponent(formatPounds(pricing.credit))}`);
    } catch (error) {
        if (error.code === '23P01') return res.redirect('/bookings?error=booking-conflict');
        if (error.code === 'OPTION_MONTH_UNAVAILABLE') return res.redirect('/bookings?error=month-unavailable');
        if (error.code === 'INSUFFICIENT_CREDIT') return res.redirect('/bookings?error=invalid-booking');
        return res.redirect('/bookings?error=invalid-booking');
    }
};

// Only paid bookings that belong to a profile can be refunded, and only for what was paid.
const isRefundable = booking =>
    Boolean(booking.profile_guid) && booking.amount_paid_pence > 0 && !booking.credited_at;
// Only the card portion can be refunded outside ActiveHub; credit that was spent stays as credit.
const externalRefundPence = booking => booking.amount_paid_pence - (booking.credit_applied_pence || 0);
const isExternallyRefundable = booking => externalRefundPence(booking) > 0 && !booking.credited_at;

const cancelBookingHandler = async (req, res) => {
    const { facility_guid, booking_guid } = req.body;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(booking_guid || '')) {
        return res.sendStatus(400);
    }
    try {
        const booking = await Bookings.findBooking(facility_guid, booking_guid);
        if (!booking) return res.sendStatus(404);
        // Credit is capped at what was actually paid (card plus credit), never the court fee, so a free
        // booking made by an admin can't be turned into credit. The amount comes from the stored booking.
        const creditPence = req.body.credit === '1' && isRefundable(booking) ? booking.amount_paid_pence : 0;
        const removed = creditPence
            ? await Bookings.removeBookingWithCredit(facility_guid, booking_guid, booking.profile_guid, creditPence, req.profile.name, req.body.refundable === '1')
            : await Bookings.removeBooking(facility_guid, booking_guid);
        if (!removed) return res.sendStatus(404);
        await recordAudit(req.profile, {
            action: 'booking.cancel', entityType: 'booking', entityGuid: booking_guid, entityLabel: booking.facility_name,
            details: {
                reference: booking.booking_ref, option: booking.option_name, starts_at: booking.starts_at, ends_at: booking.ends_at, booked_for: booking.profile_name,
                ...(creditPence ? { credited: formatPounds(creditPence), refundable: req.body.refundable === '1' } : {})
            }
        });
        // In-page cancels update the list without a reload.
        if (req.get('X-Requested-With') === 'fetch') return res.sendStatus(204);
        return res.redirect(BOOKINGS_PATH);
    } catch (error) {
        return res.sendStatus(500);
    }
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

admin.get('/refunds', async (req, res) => {
    try {
        const text = name => typeof req.query[name] === 'string' ? req.query[name].trim().slice(0, 100) : '';
        const date = name => DATE_PATTERN.test(req.query[name] || '') && !Number.isNaN(Date.parse(req.query[name])) ? req.query[name] : '';
        const filters = { reference: text('reference'), profile: text('profile'), location: text('location'), from: date('from'), to: date('to') };
        const searched = Object.values(filters).some(Boolean);
        const results = searched ? await Bookings.search(filters) : { bookings: [], truncated: false };
        res.render('refunds', {
            activePage: 'refunds',
            filters,
            searched,
            bookings: results.bookings.map(booking => ({
                ...booking,
                refundable: !booking.refunded_at && isRefundable(booking),
                externallyRefundable: !booking.refunded_at && isExternallyRefundable(booking),
                externalPence: externalRefundPence(booking)
            })),
            truncated: results.truncated,
            done: ['credit', 'external'].includes(req.query.done) ? req.query.done : '',
            doneRef: typeof req.query.ref === 'string' ? req.query.ref.slice(0, 20) : '',
            doneAmount: /^£\d+\.\d{2}$/.test(req.query.amount || '') ? req.query.amount : '',
            error: typeof req.query.error === 'string' ? req.query.error : ''
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/refunds/refund', async (req, res) => {
    const { facility_guid, booking_guid } = req.body;
    const external = req.body.method === 'external';
    const returnQuery = typeof req.body.return_to === 'string' && req.body.return_to.startsWith('/admin/refunds?')
        ? new URLSearchParams(req.body.return_to.slice('/admin/refunds?'.length).split('#')[0])
        : new URLSearchParams();
    const withParams = params => {
        const query = new URLSearchParams();
        for (const key of ['reference', 'profile', 'location', 'from', 'to']) {
            if (returnQuery.has(key)) query.set(key, returnQuery.get(key));
        }
        for (const [key, value] of Object.entries(params)) query.set(key, value);
        return query.toString();
    };
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(booking_guid || '')) return res.sendStatus(400);
    try {
        const booking = await Bookings.findBooking(facility_guid, booking_guid);
        if (!booking) return res.redirect('/admin/refunds?' + withParams({ error: 'not-found' }));
        const details = { reference: booking.booking_ref, option: booking.option_name, starts_at: booking.starts_at, ends_at: booking.ends_at, booked_for: booking.profile_name };
        if (external) {
            if (!isExternallyRefundable(booking)) return res.redirect('/admin/refunds?' + withParams({ error: 'not-refundable' }));
            const pence = externalRefundPence(booking);
            if (!await Bookings.cancelWithExternalRefund(facility_guid, booking_guid, pence, req.profile.name)) {
                return res.redirect('/admin/refunds?' + withParams({ error: 'not-found' }));
            }
            await recordAudit(req.profile, {
                action: 'booking.cancel', entityType: 'booking', entityGuid: booking_guid, entityLabel: booking.facility_name,
                details: { ...details, refunded_externally: formatPounds(pence) }
            });
            return res.redirect('/admin/refunds?' + withParams({ done: 'external', ref: booking.booking_ref, amount: formatPounds(pence) }));
        }
        if (!isRefundable(booking)) return res.redirect('/admin/refunds?' + withParams({ error: 'not-refundable' }));
        const credited = await Bookings.addCreditToBooking(facility_guid, booking_guid, req.profile.name, req.body.refundable === '1');
        if (!credited) return res.redirect('/admin/refunds?' + withParams({ error: 'not-refundable' }));
        await recordAudit(req.profile, {
            action: 'booking.credit', entityType: 'booking', entityGuid: booking_guid, entityLabel: booking.facility_name,
            details: { ...details, credited: formatPounds(credited), refundable: req.body.refundable === '1' }
        });
        return res.redirect('/admin/refunds?' + withParams({ done: 'credit', ref: booking.booking_ref, amount: formatPounds(credited) }));
    } catch (error) {
        return res.sendStatus(500);
    }
});

admin.get('/credit-requests', async (req, res) => {
    try {
        const settings = await Settings.getAll();
        res.render('credit-requests', {
            activePage: 'credit-requests',
            declineError: req.query.error === 'comment',
            requests: await Bookings.findCreditRequests(),
            autoApprovalEnabled: settings.credit_slot_auto_approval === '1',
            autoApprovalSlots: await Bookings.findAutoApprovalSlots(),
            creditRequestDays: await Settings.getCreditRequestDays(),
            decision: ['approved', 'declined'].includes(req.query.decision) ? req.query.decision : '',
            decisionRef: typeof req.query.ref === 'string' ? req.query.ref.slice(0, 20) : '',
            error: req.query.error === '1'
        });
    } catch (error) {
        console.error('Unable to load credit requests:', error);
        res.sendStatus(500);
    }
});

admin.post('/settings/credit-request-period', async (req, res) => {
    const days = Settings.parseCreditRequestDays(req.body.days);
    if (days === null) return res.redirect('/admin/settings?error=days');
    try {
        const previous = await Settings.getCreditRequestDays();
        await Settings.set('credit_request_days', String(days));
        await recordAudit(req.profile, {
            action: 'settings.credit_request_days', entityType: 'setting', entityLabel: 'Credit request day limit',
            details: { from: previous, to: days }
        });
        return res.redirect('/admin/settings?window_saved=1');
    } catch (error) {
        console.error('Unable to save credit request day limit:', error);
        return res.sendStatus(500);
    }
});

admin.post('/credit-requests/decide', async (req, res) => {
    const { request_guid } = req.body;
    if (!GUID_PATTERN.test(request_guid || '') || !['approve', 'decline'].includes(req.body.decision)) return res.sendStatus(400);
    const declineComment = req.body.decision === 'decline' ? parseDeclineComment(req.body.decline_comment) : null;
    if (req.body.decision === 'decline' && !declineComment) return res.redirect('/admin/credit-requests?error=comment');
    try {
        const approve = req.body.decision === 'approve';
        const approveSlot = req.body.approve_slot === '1';
        const result = await Bookings.decideCreditRequest(request_guid, approve, req.profile.name, req.body.refundable === '1', declineComment, approveSlot);
        if (!result) return res.redirect('/admin/credit-requests?error=1');
        await recordAudit(req.profile, {
            action: approve ? 'credit-request.approve' : 'credit-request.decline', entityType: 'booking', entityGuid: result.booking_guid,
            entityLabel: 'Booking credit request',
            details: { reference: result.booking_ref, reason: result.reason, note: result.note, ...(approve ? { credited: formatPounds(result.credited), refundable: result.refundable, slot_approved: result.slot_approved || false, auto_approved_count: result.auto_approved_count || 0, starts_at: result.starts_at, ends_at: result.ends_at } : { decline_comment: declineComment }) }
        });
        return res.redirect(`/admin/credit-requests?${new URLSearchParams({ decision: approve ? 'approved' : 'declined', ref: result.booking_ref })}`);
    } catch (error) {
        console.error('Unable to decide credit request:', error);
        return res.sendStatus(500);
    }
});

admin.post('/settings/credit-slot-auto-approval', async (req, res) => {
    if (!['0', '1'].includes(req.body.enabled)) return res.sendStatus(400);
    try {
        await Settings.set('credit_slot_auto_approval', req.body.enabled);
        await recordAudit(req.profile, {
            action: 'settings.credit_slot_auto_approval', entityType: 'setting', entityLabel: 'Weather slot auto-approval',
            details: { enabled: req.body.enabled === '1' }
        });
        return res.redirect('/admin/settings?saved=1');
    } catch (error) {
        console.error('Unable to save weather slot auto-approval setting:', error);
        return res.sendStatus(500);
    }
});

admin.post('/settings/credit-lifetime', async (req, res) => {
    const days = Settings.parseCreditLifetimeDays(req.body.days);
    if (days === null) return res.redirect('/admin/settings?error=lifetime');
    try {
        const settings = await Settings.getAll();
        await Settings.set('credit_lifetime_days', String(days));
        await recordAudit(req.profile, {
            action: 'settings.credit_lifetime_days', entityType: 'setting', entityLabel: 'Credit lifetime',
            details: { from: settings.credit_lifetime_days, to: days }
        });
        return res.redirect('/admin/settings?saved=1');
    } catch (error) {
        console.error('Unable to save credit lifetime:', error);
        return res.sendStatus(500);
    }
});

admin.get('/credit-refunds', async (req, res) => {
    try {
        res.render('credit-refunds', {
            activePage: 'credit-refunds',
            declineError: req.query.error === 'comment',
            requests: await Credits.findRefundRequests(),
            decision: ['approved', 'declined'].includes(req.query.decision) ? req.query.decision : '',
            error: req.query.error === '1'
        });
    } catch (error) {
        console.error('Unable to load credit refund requests:', error);
        res.sendStatus(500);
    }
});

admin.post('/credit-refunds/decide', async (req, res) => {
    const { request_guid, decision } = req.body;
    if (!GUID_PATTERN.test(request_guid || '') || !['approve', 'decline'].includes(decision)) return res.sendStatus(400);
    const declineComment = decision === 'decline' ? parseDeclineComment(req.body.decline_comment) : null;
    if (decision === 'decline' && !declineComment) return res.redirect('/admin/credit-refunds?error=comment');
    try {
        const approve = decision === 'approve';
        const result = await Credits.decideRefund(request_guid, approve, req.profile.name, declineComment);
        if (!result) return res.redirect('/admin/credit-refunds?error=1');
        await recordAudit(req.profile, {
            action: approve ? 'credit-refund.approve' : 'credit-refund.decline',
            entityType: 'credit', entityGuid: result.credit_guid, entityLabel: result.booking_ref,
            details: { profile_guid: result.profile_guid, refunded: formatPounds(result.refunded_pence), ...(!approve ? { decline_comment: declineComment } : {}) }
        });
        return res.redirect(approve ? '/admin/credit-refunds?decision=approved' : '/admin/credit-refunds?decision=declined');
    } catch (error) {
        console.error('Unable to decide credit refund request:', error);
        return res.sendStatus(500);
    }
});

admin.get('/bookings/availability/:facilityGuid', availabilityHandler());
admin.post('/bookings/create-batch', createBatchHandler);
admin.post('/bookings/cancel', cancelBookingHandler);

// Resident bookings: own bookings only, and no cancelling.
router.get('/bookings/availability/:facilityGuid', availabilityHandler({ resident: true }));
router.post('/bookings/checkout', residentCheckoutHandler);
router.post('/bookings/pay', residentPayHandler);
router.get('/profile', async (req, res) => {
    try {
        const [settings, logo, profile] = await Promise.all([
            Settings.getAll(), Settings.getLogo(), Profiles.findByGuid(req.profile.guid)
        ]);
        if (!profile) return res.sendStatus(404);
        return res.render('resident-profile', {
            activePage: 'profile', siteTitle: settings.site_title, hasLogo: Boolean(logo), profile,
            saved: req.query.saved === '1',
            error: ['invalid', 'duplicate-email'].includes(req.query.error) ? req.query.error : ''
        });
    } catch (error) {
        console.error('Unable to load profile:', error);
        return res.sendStatus(500);
    }
});

router.get('/credits-and-refunds', async (req, res) => {
    try {
        const [settings, hasLogo, past, profile, credits, expiredPendingRefunds] = await Promise.all([
            Settings.getAll(),
            Settings.getLogo().then(Boolean),
            Bookings.findRecentPastForProfile(req.profile.guid),
            Profiles.findByGuid(req.profile.guid),
            Credits.findForProfile(req.profile.guid),
            Credits.findExpiredPendingRefunds(req.profile.guid)
        ]);
        res.render('resident-credits', {
            activePage: 'credits-and-refunds',
            siteTitle: settings.site_title,
            hasLogo,
            profile: { name: profile?.name || req.profile.name, email: profile?.email || req.profile.email },
            error: ['invalid-reason', 'description-required', 'not-eligible'].includes(req.query.error) ? req.query.error : '',
            requested: req.query.requested === '1',
            autoApproved: req.query.requested === 'auto',
            creditBalance: credits.reduce((sum, credit) => sum + credit.remaining_pence, 0),
            creditRequestDays: Settings.parseCreditRequestDays(settings.credit_request_days),
            organisationName: settings.organisation_name,
            credits,
            expiredPendingRefunds,
            refundRequested: req.query.refund_requested === '1',
            refundError: req.query.refund_error === '1',
            past
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post(['/credits-and-refunds/credit-refunds', '/profile/credit-refunds'], async (req, res) => {
    const { credit_guid } = req.body;
    if (!GUID_PATTERN.test(credit_guid || '')) return res.sendStatus(400);
    try {
        const result = await Credits.requestRefund(req.profile.guid, credit_guid);
        if (!result) return res.redirect('/credits-and-refunds?refund_error=1#booking-credit');
        await recordAudit(req.profile, {
            action: 'credit-refund.request', entityType: 'credit', entityGuid: credit_guid,
            entityLabel: 'Bank refund request', details: { requested: formatPounds(result.requested_pence) }
        });
        return res.redirect('/credits-and-refunds?refund_requested=1#booking-credit');
    } catch (error) {
        console.error('Unable to request credit refund:', error);
        return res.sendStatus(500);
    }
});

router.post('/profile', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    if (!name || name.length > 120 || email.length > 254 || !isValidEmail(email)) {
        return res.redirect('/profile?error=invalid');
    }
    try {
        const existing = await Profiles.findByGuid(req.profile.guid);
        if (!existing) return res.sendStatus(404);
        const updated = await Profiles.updateDetails(req.profile.guid, { name, email });
        await recordAudit(req.profile, {
            action: 'profile.update', entityType: 'profile', entityGuid: updated.guid, entityLabel: updated.name,
            details: { from: { name: existing.name, email: existing.email }, to: { name, email }, self_service: true }
        });
        return res.redirect('/profile?saved=1');
    } catch (error) {
        return error.code === '23505' ? res.redirect('/profile?error=duplicate-email') : res.sendStatus(500);
    }
});

router.post(['/credits-and-refunds/credit-requests', '/profile/credit-requests'], async (req, res) => {
    const { booking_guid } = req.body;
    if (!GUID_PATTERN.test(booking_guid || '')) return res.sendStatus(400);
    const reason = req.body.reason;
    const note = reason === 'discretionary' && typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!['weather', 'discretionary'].includes(reason)) return res.redirect('/credits-and-refunds?error=invalid-reason#past-bookings');
    if ((reason === 'discretionary' && !note) || note.length > 500) return res.redirect('/credits-and-refunds?error=description-required#past-bookings');
    try {
        const created = await Bookings.requestCredit(req.profile.guid, booking_guid, reason, note || null);
        if (!created) return res.redirect('/credits-and-refunds?error=not-eligible#past-bookings');
        await recordAudit(req.profile, {
            action: 'credit-request.create', entityType: 'booking', entityGuid: booking_guid, entityLabel: 'Booking credit request',
            details: { reason, auto_approved: created.auto_approved === true, ...(note ? { note } : {}) }
        });
        return res.redirect(created.auto_approved
            ? '/credits-and-refunds?requested=auto#booking-credit'
            : '/credits-and-refunds?requested=1#past-bookings');
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.get('/bookings', async (req, res) => {
    try {
        const [settings, hasLogo, facilityRows, myBookings] = await Promise.all([
            Settings.getAll(),
            Settings.getLogo().then(Boolean),
            Bookings.findInAppFacilities(),
            Bookings.findUpcomingForProfile(req.profile.guid)
        ]);
        const facilities = (await Promise.all(facilityRows.map(async facility => ({
            guid: facility.guid,
            limit: facility.max_resident_bookings,
            used: myBookings.filter(booking => booking.facility_guid === facility.guid).length,
            name: facility.name,
            address: facility.address,
            postcode: facility.postcode,
            options: await Bookings.findOptions(facility.guid)
        })))).filter(facility => facility.options.length);
        res.render('resident-bookings', {
            activePage: 'bookings',
            siteTitle: settings.site_title,
            hasLogo,
            facilities,
            myBookings,
            selectedFacilityGuid: facilities.some(facility => facility.guid === req.query.facility)
                ? req.query.facility : facilities[0]?.guid,
            maxDate: latestResidentBookingStart().toISOString(),
            error: typeof req.query.error === 'string' ? req.query.error : undefined,
            created: Number.parseInt(req.query.created, 10) || 0,
            paid: /^£\d+\.\d{2}$/.test(req.query.paid || '') ? req.query.paid : undefined,
            creditUsed: /^£\d+\.\d{2}$/.test(req.query.credit || '') ? req.query.credit : undefined,
            creditBalance: req.profile.credit_pence
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

// Old bookmarks and the former resident URLs now live under /admin.
router.get('/', async (req, res) => {
    try {
        const settings = await Settings.getAll();
        res.render('home', { activePage: 'home', siteTitle: settings.site_title, hasLogo: Boolean(await Settings.getLogo()) });
    } catch (error) {
        res.sendStatus(500);
    }
});
router.get('/facilities', async (req, res) => {
    try {
        const [settings, hasLogo, facilityRows, sports] = await Promise.all([
            Settings.getAll(),
            Settings.getLogo().then(Boolean),
            Facilities.findAll(),
            Sports.findAll()
        ]);
        const facilities = await Promise.all(facilityRows.map(async facility => {
            const week = await OpeningHours.getSchedules(facility.opening_hours_template_guid, new Date(), 7, facility);
            const isWebUrl = /^https?:\/\//i.test(facility.external_booking_url || '');
            return {
                guid: facility.guid,
                name: facility.name,
                address: facility.address,
                postcode: facility.postcode,
                latitude: Number(facility.latitude),
                longitude: Number(facility.longitude),
                google_maps_url: facility.google_maps_url,
                description: facility.description,
                external_booking_url: isWebUrl ? facility.external_booking_url : null,
                booking_mode: facility.booking_mode,
                sports: facility.sports,
                courses: facility.courses,
                today: week ? week[0] : null,
                week
            };
        }));
        const offeredSportGuids = new Set(facilities.flatMap(facility => facility.sports.map(sport => sport.guid)));
        res.render('resident-facilities', {
            activePage: 'facilities',
            siteTitle: settings.site_title,
            hasLogo,
            facilities,
            sports: sports.filter(sport => offeredSportGuids.has(sport.guid))
        });
    } catch (error) {
        res.sendStatus(500);
    }
});
router.get('/courses', (req, res) => res.redirect('/admin/courses'));
router.get('/book', (req, res) => res.redirect('/admin/bookings'));
// Old admin bookmarks.
for (const path of ['/sports', '/opening-hours', '/profiles', '/roles', '/audit']) {
    router.get(path, (req, res) => res.redirect(`/admin${path}`));
}


admin.get('/profiles/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2 || query.length > 100) return res.json({ profiles: [] });
    try {
        return res.json({ profiles: await Profiles.search(query) });
    } catch (error) {
        return res.sendStatus(500);
    }
});

admin.get('/profiles', async (req, res) => {
    try {
        res.render('profiles', { profiles: await Profiles.findAll(), roles: await Roles.names(), error: req.query.error, activePage: 'profiles' });
    } catch (error) {
        res.sendStatus(500);
    }
});

function parseProfileInput(body, roleNames) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!name || name.length > 120 || email.length > 254 || !isValidEmail(email) ||
        !roleNames.includes(body.role)) {
        return null;
    }
    return { name, email, role: body.role };
}

function parseRoleInput(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const submitted = body.permissions === undefined ? [] : Array.isArray(body.permissions) ? body.permissions : [body.permissions];
    if (!name || name.length > 60 || description.length > 300 ||
        submitted.some(permission => !PERMISSION_KEYS.includes(permission))) {
        return null;
    }
    return { name, description: description || null, permissions: [...new Set(submitted)] };
}

admin.get('/roles', async (req, res) => {
    try {
        res.render('roles', { roles: await Roles.findAll(), permissions: PERMISSIONS, error: req.query.error, activePage: 'roles' });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/roles', async (req, res) => {
    const role = parseRoleInput(req.body);
    if (!role) return res.redirect('/admin/roles?error=invalid-role');
    try {
        const created = await Roles.create(role);
        await recordAudit(req.profile, { action: 'role.create', entityType: 'role', entityGuid: created.guid, entityLabel: created.name, details: { permissions: role.permissions } });
        return res.redirect('/admin/roles');
    } catch (error) {
        return res.redirect('/admin/roles?error=duplicate-role');
    }
});

admin.post('/roles/update', async (req, res) => {
    const guid = req.body.guid;
    const role = parseRoleInput(req.body);
    if (!role || typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.redirect('/admin/roles?error=invalid-role');
    try {
        const existing = await Roles.findByGuid(guid);
        if (!existing) return res.sendStatus(404);
        // The Administrator role has every permission by definition and cannot be edited.
        if (existing.is_system) return res.redirect('/admin/roles?error=system-role');
        await Roles.update(guid, role);
        await recordAudit(req.profile, {
            action: 'role.update', entityType: 'role', entityGuid: guid, entityLabel: role.name,
            details: { from: { name: existing.name, permissions: existing.permissions }, to: { name: role.name, permissions: role.permissions } }
        });
        return res.redirect('/admin/roles');
    } catch (error) {
        return res.redirect('/admin/roles?error=duplicate-role');
    }
});

admin.post('/roles/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.sendStatus(400);
    try {
        const existing = await Roles.findByGuid(guid);
        if (!existing) return res.sendStatus(404);
        if (existing.is_system) return res.redirect('/admin/roles?error=system-role');
        if (existing.member_count > 0) return res.redirect('/admin/roles?error=role-in-use');
        await Roles.remove(guid);
        await recordAudit(req.profile, { action: 'role.delete', entityType: 'role', entityGuid: guid, entityLabel: existing.name });
        return res.redirect('/admin/roles');
    } catch (error) {
        return res.redirect('/admin/roles?error=role-in-use');
    }
});

admin.post('/profiles', async (req, res) => {
    const profile = parseProfileInput(req.body, await Roles.names());
    if (!profile) return res.redirect('/admin/profiles?error=invalid-profile');
    try {
        const created = await Profiles.create(profile);
        await recordAudit(req.profile, { action: 'profile.create', entityType: 'profile', entityGuid: created.guid, entityLabel: created.name, details: { email: created.email, role: created.role } });
        return res.redirect('/admin/profiles');
    } catch (error) {
        return res.redirect('/admin/profiles?error=duplicate-email');
    }
});

admin.post('/profiles/update', async (req, res) => {
    const profile = parseProfileInput(req.body, await Roles.names());
    const guid = req.body.guid;
    if (!profile || typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.redirect('/admin/profiles?error=invalid-profile');
    try {
        const existing = await Profiles.findByGuid(guid);
        if (!existing) return res.sendStatus(404);
        if (existing.role === auth.ADMINISTRATOR && profile.role !== auth.ADMINISTRATOR &&
            await Profiles.countAdministrators() <= 1) {
            return res.redirect('/admin/profiles?error=last-administrator');
        }
        const updated = await Profiles.update(guid, profile);
        await recordAudit(req.profile, {
            action: 'profile.update', entityType: 'profile', entityGuid: guid, entityLabel: updated.name,
            details: { from: { name: existing.name, email: existing.email, role: existing.role }, to: profile }
        });
        return res.redirect('/admin/profiles');
    } catch (error) {
        return res.redirect('/admin/profiles?error=duplicate-email');
    }
});

admin.post('/profiles/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.sendStatus(400);
    try {
        const existing = await Profiles.findByGuid(guid);
        if (!existing) return res.sendStatus(404);
        if (guid === req.profile.guid) return res.redirect('/admin/profiles?error=delete-self');
        if (existing.role === auth.ADMINISTRATOR && await Profiles.countAdministrators() <= 1) {
            return res.redirect('/admin/profiles?error=last-administrator');
        }
        await Profiles.remove(guid);
        await recordAudit(req.profile, { action: 'profile.delete', entityType: 'profile', entityGuid: guid, entityLabel: existing.name, details: { email: existing.email, role: existing.role } });
        return res.redirect('/admin/profiles');
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.get('/cookies', async (req, res) => {
    try {
        const settings = await Settings.getAll();
        res.render('cookies', { activePage: 'cookies', siteTitle: settings.site_title, hasLogo: Boolean(await Settings.getLogo()) });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.get('/settings', async (req, res) => {
    try {
        const settings = await Settings.getAll();
        res.render('settings', {
            activePage: 'settings',
            siteTitle: settings.site_title,
            hasLogo: Boolean(await Settings.getLogo()),
            maxLength: Settings.SITE_TITLE_MAX_LENGTH,
            organisationName: settings.organisation_name,
            organisationError: req.query.error === 'organisation',
            creditRequestDays: await Settings.getCreditRequestDays(),
            autoApprovalEnabled: settings.credit_slot_auto_approval === '1',
            creditLifetimeDays: settings.credit_lifetime_days,
            lifetimeError: req.query.error === 'lifetime',
            windowSaved: req.query.window_saved === '1',
            windowError: req.query.error === 'days',
            saved: req.query.saved === '1',
            error: req.query.error === 'invalid-title'
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

// The browser sends the chosen file as the raw request body; the custom content type also blocks cross-site form posts.
admin.post('/settings/logo', express.raw({ type: Settings.LOGO_TYPES, limit: Settings.LOGO_MAX_BYTES }), async (req, res) => {
    const contentType = (req.get('content-type') || '').split(';')[0].trim();
    if (!Settings.LOGO_TYPES.includes(contentType) || !Buffer.isBuffer(req.body) || !req.body.length) {
        return res.sendStatus(415);
    }
    if (contentType === 'image/svg+xml' && !/<svg[\s>]/i.test(req.body.toString('utf8', 0, 4096))) {
        return res.sendStatus(400);
    }
    try {
        await Settings.setLogo(contentType, req.body);
        await recordAudit(req.profile, { action: 'settings.logo_update', entityType: 'setting', entityLabel: 'site_logo', details: { content_type: contentType, bytes: req.body.length } });
        return res.sendStatus(204);
    } catch (error) {
        return res.sendStatus(500);
    }
});

admin.post('/settings/logo/remove', async (req, res) => {
    try {
        await Settings.removeLogo();
        await recordAudit(req.profile, { action: 'settings.logo_remove', entityType: 'setting', entityLabel: 'site_logo' });
        return res.redirect('/admin/settings?saved=1');
    } catch (error) {
        return res.sendStatus(500);
    }
});

admin.post('/settings/organisation', async (req, res) => {
    const name = typeof req.body.organisation_name === 'string' ? req.body.organisation_name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > Settings.SITE_TITLE_MAX_LENGTH) return res.redirect('/admin/settings?error=organisation');
    try {
        const previous = (await Settings.getAll()).organisation_name;
        await Settings.set('organisation_name', name);
        await recordAudit(req.profile, {
            action: 'settings.update', entityType: 'setting', entityLabel: 'organisation_name',
            details: { from: previous, to: name }
        });
        return res.redirect('/admin/settings?saved=1');
    } catch (error) {
        console.error('Unable to save organisation name:', error);
        return res.sendStatus(500);
    }
});

admin.post('/settings', async (req, res) => {
    const title = typeof req.body.site_title === 'string' ? req.body.site_title.trim().replace(/\s+/g, ' ') : '';
    if (!title || title.length > Settings.SITE_TITLE_MAX_LENGTH) {
        return res.redirect('/admin/settings?error=invalid-title');
    }
    try {
        const previous = (await Settings.getAll()).site_title;
        await Settings.set('site_title', title);
        await recordAudit(req.profile, {
            action: 'settings.update', entityType: 'setting', entityLabel: 'site_title',
            details: { from: previous, to: title }
        });
        return res.redirect('/admin/settings?saved=1');
    } catch (error) {
        return res.sendStatus(500);
    }
});

admin.get('/audit', async (req, res) => {
    const profileGuid = GUID_PATTERN.test(req.query.profile || '') ? req.query.profile : null;
    const action = typeof req.query.action === 'string' && req.query.action.length <= 60 ? req.query.action || null : null;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    try {
        const [result, actions, profiles] = await Promise.all([
            AuditLog.search({ profileGuid, action, page }),
            AuditLog.findActions(),
            Profiles.findAll()
        ]);
        res.render('audit', { ...result, actions, profiles, filters: { profile: profileGuid, action }, page, activePage: 'audit' });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.get('/', (req, res) => res.render('admin-home', { activePage: 'admin-home', links: ADMIN_LINKS }));

admin.get('/facilities', async (req, res) => {
    try {
        const [facilityRows, sports, openingHoursTemplates] = await Promise.all([
            Facilities.findAll(),
            Sports.findAll(),
            OpeningHours.findAll()
        ]);
        const facilities = await Promise.all(facilityRows.map(async facility => ({
            ...facility,
            today_opening_hours: await OpeningHours.getToday(facility.opening_hours_template_guid, new Date(), facility)
        })));
        res.render('facilities', { facilities, sports, openingHoursTemplates, activePage: 'facilities' });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/facilities', async (req, res) => {
    const facility = await parseFacilityForm(req.body);
    if (!facility) {
        return res.sendStatus(400);
    }

    try {
        await Facilities.create(facility);
        res.redirect('/admin/facilities');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/facilities/update', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid)) {
        return res.sendStatus(400);
    }

    const facility = await parseFacilityForm(req.body);
    if (!facility) {
        return res.sendStatus(400);
    }

    try {
        const updatedFacility = await Facilities.update(guid, facility);
        if (!updatedFacility) {
            return res.sendStatus(404);
        }
        res.redirect('/admin/facilities');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/facilities/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid)) {
        return res.sendStatus(400);
    }

    try {
        await Facilities.remove(guid);
        res.redirect('/admin/facilities');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.get('/courses', async (req, res) => {
    try {
        const [courses, facilities] = await Promise.all([
            Courses.findAll(),
            Facilities.findAll()
        ]);
        const coursesByFacility = new Map();
        for (const course of courses) {
            const facilityCourses = coursesByFacility.get(course.facility_guid) || [];
            facilityCourses.push(course);
            coursesByFacility.set(course.facility_guid, facilityCourses);
        }
        const courseGroups = facilities.map(facility => ({
            ...facility,
            courses: coursesByFacility.get(facility.guid) || []
        }));
        res.render('courses', {
            courseGroups,
            facilities,
            totalCourses: courses.length,
            activePage: 'courses'
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/courses', async (req, res) => {
    const course = parseCourseInput(req.body);
    if (!course) {
        return res.sendStatus(400);
    }

    try {
        await Courses.create(course);
        res.redirect('/admin/courses');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/courses/update', async (req, res) => {
    if (typeof req.body.guid !== 'string' || !GUID_PATTERN.test(req.body.guid)) {
        return res.sendStatus(400);
    }
    const course = parseCourseInput(req.body);
    if (!course) {
        return res.sendStatus(400);
    }

    try {
        const updatedCourse = await Courses.update(req.body.guid, course);
        if (!updatedCourse) {
            return res.sendStatus(404);
        }
        res.redirect('/admin/courses');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/courses/destroy', async (req, res) => {
    if (typeof req.body.guid !== 'string' || !GUID_PATTERN.test(req.body.guid)) {
        return res.sendStatus(400);
    }
    try {
        await Courses.remove(req.body.guid);
        res.redirect('/admin/courses');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/facilities/courses/destroy', async (req, res) => {
    if (typeof req.body.guid !== 'string' || !GUID_PATTERN.test(req.body.guid)) {
        return res.sendStatus(400);
    }
    try {
        await Courses.remove(req.body.guid);
        res.redirect('/admin/facilities');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.get('/sports', async (req, res) => {
    try {
        const sports = await Sports.findAll();
        res.render('sports', { sports, activePage: 'sports' });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/sports', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 120) {
        return res.sendStatus(400);
    }
    try {
        await Sports.create(name);
        res.redirect('/admin/sports');
    } catch (error) {
        res.sendStatus(400);
    }
});

admin.post('/sports/update', async (req, res) => {
    const guid = req.body.guid;
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid) || !name || name.length > 120) {
        return res.sendStatus(400);
    }
    try {
        const updatedSport = await Sports.update(guid, name);
        if (!updatedSport) {
            return res.sendStatus(404);
        }
        res.redirect('/admin/sports');
    } catch (error) {
        res.sendStatus(400);
    }
});

admin.post('/sports/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) {
        return res.sendStatus(400);
    }
    try {
        await Sports.remove(guid);
        res.redirect('/admin/sports');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.get('/opening-hours', async (req, res) => {
    try {
        const templates = await OpeningHours.findAll();
        res.render('opening-hours', { templates, weekdays: WEEKDAYS, activePage: 'opening-hours' });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/opening-hours', async (req, res) => {
    const template = parseOpeningHoursInput(req.body);
    if (!template) return res.sendStatus(400);
    try {
        await OpeningHours.create(template);
        res.redirect('/admin/opening-hours');
    } catch (error) {
        res.sendStatus(400);
    }
});

admin.post('/opening-hours/update', async (req, res) => {
    const guid = req.body.guid;
    const template = parseOpeningHoursInput(req.body);
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid) || !template) {
        return res.sendStatus(400);
    }
    try {
        const updated = await OpeningHours.update(guid, template);
        return updated ? res.redirect('/admin/opening-hours') : res.sendStatus(404);
    } catch (error) {
        return res.sendStatus(400);
    }
});

admin.post('/opening-hours/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) {
        return res.sendStatus(400);
    }
    try {
        await OpeningHours.remove(guid);
        res.redirect('/admin/opening-hours');
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.get('/bookings', async (req, res) => {
    try {
        const facilityRows = await Bookings.findInAppFacilities();
        const facilities = await Promise.all(facilityRows.map(async facility => {
            const [sports, resources, options, bookings] = await Promise.all([
                Bookings.findFacilitySports(facility.guid),
                Bookings.findResources(facility.guid),
                Bookings.findOptions(facility.guid),
                Bookings.findBookings(facility.guid)
            ]);
            return { ...facility, sports, resources, options, bookings };
        }));
        res.render('bookings', {
            facilities,
            error: req.query.error,
            created: Number.parseInt(req.query.created, 10) || 0,
            activePage: 'bookings'
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

admin.post('/bookings/resources', async (req, res) => {
    const resource = parseResourceInput(req.body);
    if (!resource) return res.sendStatus(400);
    try {
        const created = await Bookings.createResource(resource.facility_guid, resource.name);
        return created ? res.redirect('/admin/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/admin/bookings?error=duplicate-resource');
    }
});

admin.post('/bookings/resources/update', async (req, res) => {
    const resource = parseResourceInput(req.body);
    if (!resource?.guid) return res.sendStatus(400);
    try {
        const updated = await Bookings.updateResource(resource.facility_guid, resource.guid, resource.name);
        return updated ? res.redirect('/admin/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/admin/bookings?error=duplicate-resource');
    }
});

admin.post('/bookings/resources/destroy', async (req, res) => {
    const { facility_guid, resource_guid } = req.body;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(resource_guid || '')) {
        return res.sendStatus(400);
    }
    try {
        const removed = await Bookings.removeResource(facility_guid, resource_guid);
        return removed ? res.redirect('/admin/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/admin/bookings?error=resource-in-use');
    }
});

admin.post('/bookings/options', async (req, res) => {
    const option = parseBookableOptionInput(req.body);
    if (!option) return res.sendStatus(400);
    try {
        await Bookings.createOption(option);
        return res.redirect('/admin/bookings');
    } catch (error) {
        return res.redirect('/admin/bookings?error=invalid-option');
    }
});

admin.post('/bookings/options/months', (req, res) => {
    return res.redirect('/admin/bookings?error=sport-months-moved');
});

admin.post('/bookings/sports/months', async (req, res) => {
    const { facility_guid, sport_guid } = req.body;
    const months = parseBookingMonths(req.body.allowed_months);
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(sport_guid || '') || months === null) {
        return res.sendStatus(400);
    }
    try {
        const updated = await Bookings.updateSportMonths(facility_guid, sport_guid, months);
        if (!updated) return res.sendStatus(404);
        await recordAudit(req.profile, {
            action: 'facility-sport.months', entityType: 'sport', entityGuid: sport_guid,
            entityLabel: 'Allowed booking months', details: { facility_guid, allowed_months: months }
        });
        return res.redirect('/admin/bookings');
    } catch (error) {
        console.error('Unable to save allowed booking months:', error);
        return res.sendStatus(500);
    }
});

admin.post('/bookings/options/update', async (req, res) => {
    const option = parseBookableOptionInput(req.body);
    if (!option?.guid) return res.sendStatus(400);
    try {
        const updated = await Bookings.updateOption(option);
        return updated ? res.redirect('/admin/bookings') : res.sendStatus(404);
    } catch (error) {
        if (error.code === '23P01') return res.redirect('/admin/bookings?error=booking-conflict');
        if (error.message.includes('current or future bookings')) return res.redirect('/admin/bookings?error=option-booked');
        return res.redirect('/admin/bookings?error=invalid-option');
    }
});

admin.post('/bookings/options/destroy', async (req, res) => {
    const { facility_guid, option_guid } = req.body;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(option_guid || '')) {
        return res.sendStatus(400);
    }
    try {
        const removed = await Bookings.removeOption(facility_guid, option_guid);
        return removed ? res.redirect('/admin/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/admin/bookings?error=option-booked');
    }
});

admin.post('/bookings/create', async (req, res) => {
    const { facility_guid, option_guid, starts_at, ends_at } = req.body;
    const startDate = new Date(starts_at);
    const endDate = new Date(ends_at);
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(option_guid || '') ||
        !Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
        return res.sendStatus(400);
    }
    try {
        const facilities = await Bookings.findInAppFacilities();
        const facility = facilities.find(item => item.guid === facility_guid);
        if (!facility) return res.sendStatus(404);
        const withinOpeningHours = await OpeningHours.isBookingWithinHours(
            facility.opening_hours_template_guid,
            startDate,
            endDate,
            facility
        );
        if (!withinOpeningHours) return res.redirect('/admin/bookings?error=outside-opening-hours');

        const created = await Bookings.createBooking({
            facility_guid,
            option_guid,
            starts_at: startDate.toISOString(),
            ends_at: endDate.toISOString(),
            profile_guid: req.profile.guid
        });
        await recordAudit(req.profile, {
            action: 'booking.create', entityType: 'booking', entityGuid: created?.guid,
            entityLabel: facility.name, details: { starts_at: created?.starts_at, ends_at: created?.ends_at, option_guid }
        });
        return res.redirect('/admin/bookings?created=1');
    } catch (error) {
        if (error.code === '23P01') return res.status(409).json({ code: 'booking-conflict' });
        if (error.code === 'OPTION_MONTH_UNAVAILABLE') return res.redirect('/admin/bookings?error=month-unavailable');
        return res.redirect('/admin/bookings?error=invalid-booking');
    }
});

router.use('/admin', admin);

module.exports = router;
