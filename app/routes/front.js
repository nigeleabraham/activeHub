const express = require('express');
const Facilities = require('./../models/Facilities');
const Courses = require('./../models/Courses');
const { parseFacilityInput } = require('./../facilityUtils');

const router = express.Router();
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCourseInput(body) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160 ||
        typeof body.facility_guid !== 'string' || !GUID_PATTERN.test(body.facility_guid)) {
        return null;
    }
    return { name: body.name.trim(), facility_guid: body.facility_guid };
}

// Home page route
router.get('/', async (req, res) => {
    try {
        const facilities = await Facilities.findAll();
        res.render('facilities', { facilities });
    } catch (error) {
        res.sendStatus(500);
    }
});

router.post('/facilities', async (req, res) => {
    const facility = parseFacilityInput(req.body);
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

    const facility = parseFacilityInput(req.body);
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
            totalCourses: courses.length
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


module.exports = router;