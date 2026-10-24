const express = require('express');
const Facilities = require('./../models/Facilities');
const Courses = require('./../models/Courses');
const Sports = require('./../models/Sports');
const Bookings = require('./../models/Bookings');
const OpeningHours = require('./../models/OpeningHours');
const Profiles = require('./../models/Profiles');
const AuditLog = require('./../models/AuditLog');
const auth = require('./../middleware/auth');
const { parseFacilityInput } = require('./../facilityUtils');

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

    return { name, rules };
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
        await AuditLog.record(profile, entry);
    } catch (error) {
        console.error('Unable to write audit log:', error);
    }
}

// Management actions: admin only, audited once the handler has redirected without an error.
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
    router.post(path, auth.requireAdministrator, async (req, res, next) => {
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
                recordAudit(req.profile, {
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
    res.redirect('/login');
});

router.use(auth.requireLogin);

router.get('/profiles', auth.requireAdministrator, async (req, res) => {
    try {
        res.render('profiles', { profiles: await Profiles.findAll(), roles: Profiles.ROLES, error: req.query.error, activePage: 'profiles' });
    } catch (error) {
        res.sendStatus(500);
    }
});

function parseProfileInput(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!name || name.length > 120 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !Profiles.ROLES.includes(body.role)) {
        return null;
    }
    return { name, email, role: body.role };
}

router.post('/profiles', auth.requireAdministrator, async (req, res) => {
    const profile = parseProfileInput(req.body);
    if (!profile) return res.redirect('/profiles?error=invalid-profile');
    try {
        const created = await Profiles.create(profile);
        await recordAudit(req.profile, { action: 'profile.create', entityType: 'profile', entityGuid: created.guid, entityLabel: created.name, details: { email: created.email, role: created.role } });
        return res.redirect('/profiles');
    } catch (error) {
        return res.redirect('/profiles?error=duplicate-email');
    }
});

router.post('/profiles/update', auth.requireAdministrator, async (req, res) => {
    const profile = parseProfileInput(req.body);
    const guid = req.body.guid;
    if (!profile || typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.redirect('/profiles?error=invalid-profile');
    try {
        const existing = await Profiles.findByGuid(guid);
        if (!existing) return res.sendStatus(404);
        if (existing.role === auth.ADMINISTRATOR && profile.role !== auth.ADMINISTRATOR &&
            await Profiles.countAdministrators() <= 1) {
            return res.redirect('/profiles?error=last-administrator');
        }
        const updated = await Profiles.update(guid, profile);
        await recordAudit(req.profile, {
            action: 'profile.update', entityType: 'profile', entityGuid: guid, entityLabel: updated.name,
            details: { from: { name: existing.name, email: existing.email, role: existing.role }, to: profile }
        });
        return res.redirect('/profiles');
    } catch (error) {
        return res.redirect('/profiles?error=duplicate-email');
    }
});

router.post('/profiles/destroy', auth.requireAdministrator, async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) return res.sendStatus(400);
    try {
        const existing = await Profiles.findByGuid(guid);
        if (!existing) return res.sendStatus(404);
        if (guid === req.profile.guid) return res.redirect('/profiles?error=delete-self');
        if (existing.role === auth.ADMINISTRATOR && await Profiles.countAdministrators() <= 1) {
            return res.redirect('/profiles?error=last-administrator');
        }
        await Profiles.remove(guid);
        await recordAudit(req.profile, { action: 'profile.delete', entityType: 'profile', entityGuid: guid, entityLabel: existing.name, details: { email: existing.email, role: existing.role } });
        return res.redirect('/profiles');
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.get('/audit', auth.requireAdministrator, async (req, res) => {
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

// Home page route
router.get('/', async (req, res) => {
    try {
        const [facilityRows, sports, openingHoursTemplates] = await Promise.all([
            Facilities.findAll(),
            Sports.findAll(),
            OpeningHours.findAll()
        ]);
        const facilities = await Promise.all(facilityRows.map(async facility => ({
            ...facility,
            today_opening_hours: await OpeningHours.getToday(facility.opening_hours_template_guid)
        })));
        res.render('facilities', { facilities, sports, openingHoursTemplates, activePage: 'facilities' });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/facilities', async (req, res) => {
    const facility = await parseFacilityForm(req.body);
    if (!facility) {
        return res.sendStatus(400);
    }

    try {
        await Facilities.create(facility);
        res.redirect('/');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/facilities/update', async (req, res) => {
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
        res.redirect('/');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/facilities/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid)) {
        return res.sendStatus(400);
    }

    try {
        await Facilities.remove(guid);
        res.redirect('/');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.get('/courses', async (req, res) => {
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

router.post('/courses', async (req, res) => {
    const course = parseCourseInput(req.body);
    if (!course) {
        return res.sendStatus(400);
    }

    try {
        await Courses.create(course);
        res.redirect('/courses');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/courses/update', async (req, res) => {
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
        res.redirect('/courses');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/courses/destroy', async (req, res) => {
    if (typeof req.body.guid !== 'string' || !GUID_PATTERN.test(req.body.guid)) {
        return res.sendStatus(400);
    }
    try {
        await Courses.remove(req.body.guid);
        res.redirect('/courses');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/facilities/courses/destroy', async (req, res) => {
    if (typeof req.body.guid !== 'string' || !GUID_PATTERN.test(req.body.guid)) {
        return res.sendStatus(400);
    }
    try {
        await Courses.remove(req.body.guid);
        res.redirect('/');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.get('/sports', async (req, res) => {
    try {
        const sports = await Sports.findAll();
        res.render('sports', { sports, activePage: 'sports' });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/sports', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 120) {
        return res.sendStatus(400);
    }
    try {
        await Sports.create(name);
        res.redirect('/sports');
    } catch (error) {
        res.sendStatus(400);
    }
});

router.post('/sports/update', async (req, res) => {
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
        res.redirect('/sports');
    } catch (error) {
        res.sendStatus(400);
    }
});

router.post('/sports/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) {
        return res.sendStatus(400);
    }
    try {
        await Sports.remove(guid);
        res.redirect('/sports');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.get('/opening-hours', async (req, res) => {
    try {
        const templates = await OpeningHours.findAll();
        res.render('opening-hours', { templates, weekdays: WEEKDAYS, activePage: 'opening-hours' });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/opening-hours', async (req, res) => {
    const template = parseOpeningHoursInput(req.body);
    if (!template) return res.sendStatus(400);
    try {
        await OpeningHours.create(template);
        res.redirect('/opening-hours');
    } catch (error) {
        res.sendStatus(400);
    }
});

router.post('/opening-hours/update', async (req, res) => {
    const guid = req.body.guid;
    const template = parseOpeningHoursInput(req.body);
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid) || !template) {
        return res.sendStatus(400);
    }
    try {
        const updated = await OpeningHours.update(guid, template);
        return updated ? res.redirect('/opening-hours') : res.sendStatus(404);
    } catch (error) {
        return res.sendStatus(400);
    }
});

router.post('/opening-hours/destroy', async (req, res) => {
    const guid = req.body.guid;
    if (typeof guid !== 'string' || !GUID_PATTERN.test(guid)) {
        return res.sendStatus(400);
    }
    try {
        await OpeningHours.remove(guid);
        res.redirect('/opening-hours');
    } catch (error) {
        res.sendStatus(500);
    }
});

router.get('/bookings', async (req, res) => {
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
            profiles: req.profile.role === auth.ADMINISTRATOR ? await Profiles.findAll() : [],
            error: req.query.error,
            created: Number.parseInt(req.query.created, 10) || 0,
            activePage: 'bookings'
        });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.get('/bookings/availability/:facilityGuid', async (req, res) => {
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
                9
            )
        ]);
        res.json({ options, bookings, schedules });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/bookings/resources', async (req, res) => {
    const resource = parseResourceInput(req.body);
    if (!resource) return res.sendStatus(400);
    try {
        const created = await Bookings.createResource(resource.facility_guid, resource.name);
        return created ? res.redirect('/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/bookings?error=duplicate-resource');
    }
});

router.post('/bookings/resources/update', async (req, res) => {
    const resource = parseResourceInput(req.body);
    if (!resource?.guid) return res.sendStatus(400);
    try {
        const updated = await Bookings.updateResource(resource.facility_guid, resource.guid, resource.name);
        return updated ? res.redirect('/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/bookings?error=duplicate-resource');
    }
});

router.post('/bookings/resources/destroy', async (req, res) => {
    const { facility_guid, resource_guid } = req.body;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(resource_guid || '')) {
        return res.sendStatus(400);
    }
    try {
        const removed = await Bookings.removeResource(facility_guid, resource_guid);
        return removed ? res.redirect('/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/bookings?error=resource-in-use');
    }
});

router.post('/bookings/options', async (req, res) => {
    const option = parseBookableOptionInput(req.body);
    if (!option) return res.sendStatus(400);
    try {
        await Bookings.createOption(option);
        return res.redirect('/bookings');
    } catch (error) {
        return res.redirect('/bookings?error=invalid-option');
    }
});

router.post('/bookings/options/update', async (req, res) => {
    const option = parseBookableOptionInput(req.body);
    if (!option?.guid) return res.sendStatus(400);
    try {
        const updated = await Bookings.updateOption(option);
        return updated ? res.redirect('/bookings') : res.sendStatus(404);
    } catch (error) {
        if (error.code === '23P01') return res.redirect('/bookings?error=booking-conflict');
        if (error.message.includes('current or future bookings')) return res.redirect('/bookings?error=option-booked');
        return res.redirect('/bookings?error=invalid-option');
    }
});

router.post('/bookings/options/destroy', async (req, res) => {
    const { facility_guid, option_guid } = req.body;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(option_guid || '')) {
        return res.sendStatus(400);
    }
    try {
        const removed = await Bookings.removeOption(facility_guid, option_guid);
        return removed ? res.redirect('/bookings') : res.sendStatus(404);
    } catch (error) {
        return res.redirect('/bookings?error=option-booked');
    }
});

router.post('/bookings/create', async (req, res) => {
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
            endDate
        );
        if (!withinOpeningHours) return res.redirect('/bookings?error=outside-opening-hours');

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
        return res.redirect('/bookings?created=1');
    } catch (error) {
        if (error.code === '23P01') return res.status(409).json({ code: 'booking-conflict' });
        return res.redirect('/bookings?error=invalid-booking');
    }
});

const MAX_BATCH_BOOKINGS = 50;

router.post('/bookings/create-batch', async (req, res) => {
    const { facility_guid } = req.body;
    let slots;
    try {
        slots = JSON.parse(req.body.slots || '[]');
    } catch (error) {
        return res.sendStatus(400);
    }
    if (!GUID_PATTERN.test(facility_guid || '') || !Array.isArray(slots) ||
        !slots.length || slots.length > MAX_BATCH_BOOKINGS) {
        return res.sendStatus(400);
    }
    const bookings = [];
    for (const slot of slots) {
        const startDate = new Date(slot?.starts_at);
        const endDate = new Date(slot?.ends_at);
        if (!GUID_PATTERN.test(slot?.option_guid || '') ||
            !Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
            return res.sendStatus(400);
        }
        bookings.push({
            facility_guid,
            option_guid: slot.option_guid,
            starts_at: startDate.toISOString(),
            ends_at: endDate.toISOString(),
            profile_guid: req.profile.guid
        });
    }
    try {
        const facilities = await Bookings.findInAppFacilities();
        const facility = facilities.find(item => item.guid === facility_guid);
        if (!facility) return res.sendStatus(404);
        for (const booking of bookings) {
            const withinOpeningHours = await OpeningHours.isBookingWithinHours(
                facility.opening_hours_template_guid,
                new Date(booking.starts_at),
                new Date(booking.ends_at)
            );
            if (!withinOpeningHours) return res.redirect('/bookings?error=outside-opening-hours');
        }
        const createdBookings = await Bookings.createBookings(bookings);
        for (const [index, booking] of bookings.entries()) {
            await recordAudit(req.profile, {
                action: 'booking.create', entityType: 'booking', entityGuid: createdBookings?.[index]?.guid,
                entityLabel: facility.name, details: { starts_at: booking.starts_at, ends_at: booking.ends_at, option_guid: booking.option_guid }
            });
        }
        return res.redirect(`/bookings?created=${bookings.length}`);
    } catch (error) {
        if (error.code === '23P01') return res.status(409).json({ code: 'booking-conflict' });
        return res.redirect('/bookings?error=invalid-booking');
    }
});

router.post('/bookings/cancel', async (req, res) => {
    const { facility_guid, booking_guid } = req.body;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(booking_guid || '')) {
        return res.sendStatus(400);
    }
    try {
        const booking = await Bookings.findBooking(facility_guid, booking_guid);
        if (!booking) return res.sendStatus(404);
        if (!auth.canCancelBooking(req.profile, booking)) return res.status(403).render('forbidden', { activePage: '' });
        const removed = await Bookings.removeBooking(facility_guid, booking_guid);
        if (!removed) return res.sendStatus(404);
        await recordAudit(req.profile, {
            action: 'booking.cancel', entityType: 'booking', entityGuid: booking_guid, entityLabel: booking.facility_name,
            details: { option: booking.option_name, starts_at: booking.starts_at, ends_at: booking.ends_at, booked_by: booking.profile_name }
        });
        return res.redirect('/bookings');
    } catch (error) {
        return res.sendStatus(500);
    }
});

router.post('/bookings/assign', auth.requireAdministrator, async (req, res) => {
    const { facility_guid, booking_guid } = req.body;
    const profileGuid = req.body.profile_guid || null;
    if (!GUID_PATTERN.test(facility_guid || '') || !GUID_PATTERN.test(booking_guid || '') ||
        (profileGuid && !GUID_PATTERN.test(profileGuid))) {
        return res.sendStatus(400);
    }
    try {
        const booking = await Bookings.findBooking(facility_guid, booking_guid);
        const assignee = profileGuid ? await Profiles.findByGuid(profileGuid) : null;
        if (!booking || (profileGuid && !assignee)) return res.sendStatus(404);
        await Bookings.assignBooking(facility_guid, booking_guid, profileGuid);
        await recordAudit(req.profile, {
            action: 'booking.assign', entityType: 'booking', entityGuid: booking_guid, entityLabel: booking.facility_name,
            details: { from: booking.profile_name || null, to: assignee?.name || null, starts_at: booking.starts_at }
        });
        return res.redirect('/bookings');
    } catch (error) {
        return res.sendStatus(500);
    }
});


module.exports = router;