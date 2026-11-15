const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const databaseUrl = process.env.FACILITY_MANAGER_TEST_DATABASE_URL;

test('facility managers are limited to assigned facilities', { skip: !databaseUrl }, async t => {
    assert.ok(new URL(databaseUrl).pathname.endsWith('_test'), 'Use a dedicated database whose name ends in _test');
    process.env.DATABASE_URL = databaseUrl;
    const pools = new Set();
    const connect = Pool.prototype.connect;
    t.mock.method(Pool.prototype, 'connect', function (...args) {
        pools.add(this);
        return connect.apply(this, args);
    });
    t.after(async () => Promise.all([...pools].map(pool => pool.end())));
    const db = new Pool({ connectionString: databaseUrl });
    await db.query(`CREATE TABLE roles (guid uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
        description text, is_system boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);
    const legacyRole = (await db.query("INSERT INTO roles (name) VALUES ('facility manager') RETURNING guid")).rows[0];
    for (const name of ['Facilities', 'OpeningHours', 'Courses', 'Sports', 'Settings', 'Roles', 'Profiles', 'AuditLog', 'Bookings', 'CourseOrders']) {
        await require(`../models/${name}`).initialize();
    }
    const Roles = require('../models/Roles');
    const Profiles = require('../models/Profiles');
    const Courses = require('../models/Courses');
    const auth = require('../middleware/auth');
    const managerRole = (await Roles.findAll()).find(role => role.name === 'Facility manager');
    assert.equal(managerRole.guid, legacyRole.guid);
    assert.equal(managerRole.is_system, true);
    await db.query("INSERT INTO role_permissions (role_guid, permission) VALUES ($1,'roles.manage')", [managerRole.guid]);
    assert.deepEqual((await Roles.permissionsFor(managerRole.name)).sort(),
        ['bookings.manage', 'course_bookings.view', 'courses.manage', 'facilities.manage']);
    assert.equal(await Roles.remove(managerRole.guid), false);
    assert.equal(await Roles.highestFor(['Resident', 'Facility manager']), 'Facility manager');
    await Roles.initialize();
    assert.equal((await Roles.findByGuid(managerRole.guid)).is_system, true);

    const facilities = [];
    for (const name of ['Assigned hall', 'Other hall', 'Second assigned hall']) {
        facilities.push((await db.query(`INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
            VALUES ($1, 'Road', 'AB1 2CD', 0, 0, '', '') RETURNING guid`, [name])).rows[0].guid);
    }
    let manager = await Profiles.create({
        name: 'Manager test', email: 'manager@example.test', roles: ['Facility manager'], managed_facility_guids: [facilities[0], facilities[2]]
    });
    assert.deepEqual((await Profiles.findByGuid(manager.guid)).managed_facility_guids.sort(), [facilities[0], facilities[2]].sort());
    const course = (await db.query("INSERT INTO courses (name) VALUES ('Shared test course') RETURNING guid")).rows[0].guid;
    const runs = [];
    for (const [index, facility] of facilities.entries()) {
        runs.push((await db.query('INSERT INTO course_runs (course_guid, facility_guid, name) VALUES ($1,$2,$3) RETURNING guid',
            [course, facility, `Run ${index}`])).rows[0].guid);
    }
    await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at) VALUES
        ($1, '2020-03-29 23:30 Europe/London', '2020-03-29 23:45 Europe/London'),
        ($1, '2090-10-30 18:00 Europe/London', '2090-10-30 19:00 Europe/London'),
        ($2, '2090-02-01 10:00 Europe/London', '2090-02-01 11:00 Europe/London')`, [runs[0], runs[2]]);
    await db.query('INSERT INTO site_settings (key, value) VALUES ($1, $2)', [
        'camden_course_import:https://example.test/sessions', JSON.stringify({
            guid: runs[2], original_sessions: 10, advertised_remaining: 1
        })
    ]);
    await Courses.backfillRunDates(db);
    let dates = await Courses.findRuns();
    assert.equal(dates.find(run => run.guid === runs[0]).start_date, '2020-03-29');
    assert.equal(dates.find(run => run.guid === runs[0]).end_date, '2090-10-30');
    assert.equal(dates.find(run => run.guid === runs[1]).start_date, null);
    assert.equal(dates.find(run => run.guid === runs[1]).end_date, null);
    assert.equal(dates.find(run => run.guid === runs[2]).start_date, null);
    assert.equal(dates.find(run => run.guid === runs[2]).end_date, '2090-02-01');
    assert.equal(dates.find(run => run.guid === runs[2]).incomplete_history, true);
    assert.equal(dates.find(run => run.guid === runs[0]).booking_status, 'in_progress');
    assert.equal(dates.find(run => run.guid === runs[2]).booking_status, 'unknown');
    await db.query(`INSERT INTO course_sessions (run_guid, starts_at, ends_at)
        VALUES ($1, '2020-03-29 23:30 Europe/London', '2020-03-29 23:45 Europe/London')`, [runs[2]]);
    assert.equal((await Courses.findRuns()).find(run => run.guid === runs[2]).booking_status, 'in_progress');
    await db.query("DELETE FROM course_sessions WHERE run_guid = $1 AND starts_at < '2021-01-01'", [runs[2]]);
    const savedDetails = { name: 'Date test', facility_guid: facilities[2], full_price_pence: 500, capacity: 3,
        sessions: [{ starts_local: '2090-02-08 10:00', ends_local: '2090-02-08 11:00' },
            { starts_local: '2090-02-01 10:00', ends_local: '2090-02-01 11:00' }] };
    const createdRun = await Courses.saveRun(null, course, savedDetails);
    dates = await Courses.findRuns({ availableOnly: true });
    assert.equal(dates.find(run => run.guid === createdRun.guid).start_date, '2090-02-01');
    assert.equal(dates.find(run => run.guid === createdRun.guid).end_date, '2090-02-08');
    assert.equal(dates.find(run => run.guid === createdRun.guid).booking_status, 'upcoming');
    await db.query(`UPDATE course_runs SET start_date = (statement_timestamp() AT TIME ZONE 'Europe/London')::date + 1
        WHERE guid = $1`, [createdRun.guid]);
    assert.equal((await Courses.findRuns({ availableOnly: true })).find(run => run.guid === createdRun.guid).booking_status, 'upcoming');
    await db.query(`UPDATE course_runs SET start_date = (statement_timestamp() AT TIME ZONE 'Europe/London')::date
        WHERE guid = $1`, [createdRun.guid]);
    assert.equal((await Courses.findRuns({ availableOnly: true })).find(run => run.guid === createdRun.guid).booking_status, 'in_progress');
    await Courses.saveRun(createdRun.guid, course, { ...savedDetails,
        sessions: [{ starts_local: '2020-03-29 23:30', ends_local: '2020-03-29 23:45' },
            { starts_local: '2090-02-08 10:00', ends_local: '2090-02-08 11:00' }] });
    const availableRun = (await Courses.findRuns({ availableOnly: true })).find(run => run.guid === createdRun.guid);
    assert.equal(availableRun.start_date, '2020-03-29');
    assert.equal(availableRun.end_date, '2090-02-08');
    assert.equal(availableRun.booking_status, 'in_progress');
    assert.equal(availableRun.sessions.length, 1);
    await Courses.saveRun(runs[2], course, { ...savedDetails, original_start_date: '2090-01-01' });
    await Courses.backfillRunDates(db);
    dates = await Courses.findRuns();
    assert.equal(dates.find(run => run.guid === runs[2]).start_date, '2090-01-01');
    assert.equal(dates.find(run => run.guid === runs[2]).end_date, '2090-02-08');
    await assert.rejects(Courses.saveRun(runs[2], course, { ...savedDetails, original_start_date: '2090-03-01' }),
        error => error.code === 'INVALID_RUN_START_DATE');
    assert.equal((await Courses.findRuns()).find(run => run.guid === runs[2]).start_date, '2090-01-01');
    await Courses.saveRun(runs[2], course, { ...savedDetails, original_start_date: '' });
    assert.equal((await Courses.findRuns()).find(run => run.guid === runs[2]).start_date, null);
    await Courses.removeRun(createdRun.guid, course);
    const order = (await db.query(`INSERT INTO course_orders (profile_guid, checkout_token, total_pence, credit_pence, payment_reference)
        VALUES ($1, $2, 0, 0, 'test') RETURNING guid`, [manager.guid, crypto.randomUUID()])).rows[0].guid;
    const enrolment = (await db.query(`INSERT INTO course_enrolments
        (order_guid, run_guid, profile_guid, attendee_name, course_name, run_name, facility_name, sessions, amount_pence, credit_applied_pence, booking_ref)
        VALUES ($1,$2,$3,'Other attendee','Shared test course','Run 1','Other hall','[]',0,0,'AH-MANAGER-TEST') RETURNING guid`,
    [order, runs[1], manager.guid])).rows[0].guid;
    await db.query(`INSERT INTO course_enrolments
        (order_guid, run_guid, profile_guid, attendee_name, course_name, run_name, facility_name, sessions, amount_pence, credit_applied_pence, booking_ref)
        VALUES ($1,$2,$3,'Assigned attendee','Shared test course','Run 0','Assigned hall','[]',0,0,'AH-ASSIGNED-COURSE')`,
    [order, runs[0], manager.guid]);
    const sport = (await db.query('SELECT guid FROM sports LIMIT 1')).rows[0].guid;
    for (const [index, facility] of facilities.slice(0, 2).entries()) {
        await db.query('INSERT INTO facility_sports (facility_guid, sport_guid) VALUES ($1,$2)', [facility, sport]);
        const option = (await db.query(`INSERT INTO bookable_options (facility_guid, sport_guid, name, price_pence)
            VALUES ($1,$2,'Court',0) RETURNING guid`, [facility, sport])).rows[0].guid;
        await db.query(`INSERT INTO bookings (facility_guid, option_guid, starts_at, ends_at, profile_guid, booking_ref)
            VALUES ($1,$2,'2030-01-02T10:00:00Z','2030-01-02T11:00:00Z',$3,$4)`,
        [facility, option, manager.guid, index ? 'AH-OTHER-COURT' : 'AH-ASSIGNED-COURT']);
    }

    const express = require('express');
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../views'));
    app.locals.moment = require('moment');
    app.use(express.urlencoded({ extended: false }));
    app.use(auth.loadProfile);
    app.use(require('../routes/front'));
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    let viewCookie;
    auth.setViewAs({ append(_header, value) { viewCookie = value.split(';')[0]; } }, manager.guid, 'Facility manager');
    const cookie = `${auth.COOKIE_NAME}=${auth.createSessionValue(manager.guid)}; ${viewCookie}`;
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, options = {}) => fetch(base + url, {
        ...options, redirect: 'manual', headers: { cookie, ...(options.headers || {}) }
    });
    const post = (url, values) => request(url, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values)
    });
    let invalidDate = await post('/admin/courses/runs/update', {
        guid: runs[2], course_guid: course, facility_guid: facilities[2], name: 'Date test', price: '5.00',
        capacity: '3', schedule_mode: 'individual', sessions: '2090-02-01 10:00 11:00', original_start_date: '2090-03-01'
    });
    assert.equal(invalidDate.status, 422);
    assert.match((await invalidDate.json()).error, /no later than the first listed session/);
    const administrator = (await Profiles.findAll()).find(profile => profile.roles.includes('Administrator'));
    const adminCookie = `${auth.COOKIE_NAME}=${auth.createSessionValue(administrator.guid)}`;
    const adminPost = (guid, cookieValue) => fetch(base + '/admin/facilities/destroy', {
        method: 'POST', redirect: 'manual',
        headers: { cookie: cookieValue, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ guid })
    });
    let adminView;
    auth.setViewAs({ append(_header, value) { adminView = value.split(';')[0]; } }, administrator.guid, 'Facility manager');
    let switched = await fetch(base + '/admin/facilities', { headers: { cookie: `${adminCookie}; ${adminView}` } });
    assert.match(await switched.text(), /Other hall/);
    const newFacility = (await db.query(`INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description)
        VALUES ('New hall', 'Road', 'AB1 2CD', 0, 0, '', '') RETURNING guid`)).rows[0].guid;
    switched = await fetch(base + '/admin/facilities', { headers: { cookie: `${adminCookie}; ${adminView}` } });
    assert.match(await switched.text(), /New hall/);
    assert.ok((await Profiles.allFacilityGuids()).includes(newFacility));
    assert.equal((await adminPost(newFacility, `${adminCookie}; ${adminView}`)).status, 403);
    const customRole = await Roles.create({ name: 'Facility editor', description: null, permissions: ['facilities.manage'] });
    const editor = await Profiles.create({ name: 'Facility editor', email: 'editor@example.test', roles: [customRole.name] });
    let editorView;
    auth.setViewAs({ append(_header, value) { editorView = value.split(';')[0]; } }, editor.guid, customRole.name);
    const editorCookie = `${auth.COOKIE_NAME}=${auth.createSessionValue(editor.guid)}; ${editorView}`;
    assert.equal((await adminPost(newFacility, editorCookie)).status, 403);
    const editorPage = await fetch(base + '/admin/facilities', { headers: { cookie: editorCookie } });
    assert.doesNotMatch(await editorPage.text(), /<form[^>]+action="\/admin\/facilities\/destroy"/);
    const adminPage = await fetch(base + '/admin/facilities', { headers: { cookie: adminCookie } });
    assert.match(await adminPage.text(), /<form[^>]+action="\/admin\/facilities\/destroy"/);
    assert.equal((await adminPost(newFacility, adminCookie)).status, 302);
    assert.equal((await db.query('SELECT 1 FROM facilities WHERE guid = $1', [newFacility])).rowCount, 0);
    let response = await fetch(base + '/admin/profiles', { headers: { cookie: adminCookie } });
    const profileHtml = await response.text();
    assert.equal(response.status, 200);
    assert.match(profileHtml, /Facility manager facilities/);
    assert.match(profileHtml, /Managed facilities: Assigned hall, Second assigned hall/);
    response = await fetch(base + '/admin/profiles', {
        method: 'POST', redirect: 'manual', headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['name', 'UI manager'], ['email', 'ui-manager@example.test'],
            ['roles', 'Facility manager'], ['managed_facility_guids', facilities[0]], ['managed_facility_guids', facilities[2]]])
    });
    assert.equal(response.status, 302);
    const uiManager = (await Profiles.findAll()).find(profile => profile.email === 'ui-manager@example.test');
    assert.deepEqual(uiManager.managed_facility_guids.sort(), [facilities[0], facilities[2]].sort());
    await db.query(`INSERT INTO credits (profile_guid, facility_name, amount_pence, remaining_pence, expires_at)
        VALUES ($1, 'Assigned hall', 1234, 1234, now() + interval '1 day')`, [uiManager.guid]);
    response = await fetch(`${base}/admin/profiles/delete-preview?guid=${uiManager.guid}`, { headers: { cookie: adminCookie } });
    assert.deepEqual(await response.json(), { name: 'UI manager', credit_pence: 1234 });
    const deleteProfile = (body, accept = 'text/html') => fetch(base + '/admin/profiles/destroy', {
        method: 'POST', redirect: 'manual',
        headers: { cookie: adminCookie, 'content-type': 'application/x-www-form-urlencoded', accept },
        body: new URLSearchParams(body)
    });
    response = await deleteProfile({ guid: uiManager.guid });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /delete-confirm/);
    response = await fetch(base + response.headers.get('location'), { headers: { cookie: adminCookie } });
    const confirmation = await response.text();
    assert.match(confirmation, /Active credit: £12\.34/);
    assert.match(confirmation, /No refund is issued/);
    response = await deleteProfile({ guid: uiManager.guid, confirmed_credit_pence: '1000' }, 'application/json');
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /credit changed/i);
    assert.ok(await Profiles.findByGuid(uiManager.guid));
    response = await deleteProfile({ guid: uiManager.guid, confirmed_credit_pence: '1000' });
    assert.match(response.headers.get('location'), /error=credit-changed/);
    response = await deleteProfile({ guid: uiManager.guid, confirmed_credit_pence: '1234' });
    assert.equal(response.status, 302);
    assert.equal(await Profiles.findByGuid(uiManager.guid), null);
    response = await request('/admin/facilities');
    let html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Assigned hall/);
    assert.match(html, /Second assigned hall/);
    assert.doesNotMatch(html, /Other hall/);
    assert.doesNotMatch(html, /<form[^>]+action="\/admin\/facilities\/destroy"/);
    assert.match(html, /action="\/admin\/facilities\/update"/);
    const facilityInput = { guid: facilities[0], name: 'Assigned hall', address: 'Updated road',
        postcode: 'AB1 2CD', description: 'Updated description', coordinates: '0, 0',
        booking_mode: 'in_app', sport_guids: sport };
    assert.equal((await post('/admin/facilities/update', facilityInput)).status, 302);
    assert.equal((await db.query('SELECT address FROM facilities WHERE guid = $1', [facilities[0]])).rows[0].address, 'Updated road');
    assert.equal((await post('/admin/facilities/update', { ...facilityInput, guid: facilities[1] })).status, 403);
    response = await request('/admin/courses');
    html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Run 0/);
    assert.doesNotMatch(html, /Run 1/);
    assert.doesNotMatch(html, /action="\/admin\/courses\/update"/);
    assert.match(html, /Run dates: 29\/03\/2020 to 30\/10\/2090/);
    assert.match(html, /Run dates: Start date unknown to 08\/02\/2090/);
    assert.match(html, /name="original_start_date"/);
    assert.equal((await request(`/admin/bookings/availability/${facilities[1]}?start=2026-01-01&end=2026-01-02`)).status, 403);
    assert.equal((await post('/admin/bookings/resources', { facility_guid: facilities[1], name: 'Forbidden' })).status, 403);
    response = await request('/admin/court-configuration');
    html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Assigned hall/);
    assert.match(html, /Second assigned hall/);
    assert.doesNotMatch(html, /Other hall/);
    const external = (await db.query(`INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description, booking_mode, external_booking_url)
        VALUES ('Assigned external hall', 'Road', 'AB1 2CD', 0, 0, '', '', 'external', 'https://example.test/booking') RETURNING guid`)).rows[0].guid;
    await db.query(`INSERT INTO facilities (name, address, postcode, latitude, longitude, google_maps_url, description, booking_mode, external_booking_url)
        VALUES ('Unassigned external hall', 'Road', 'AB1 2CD', 0, 0, '', '', 'external', 'https://example.test/booking')`);
    manager = await Profiles.update(manager.guid, { ...manager, roles: ['Facility manager'], managed_facility_guids: [facilities[0], facilities[2], external] });
    response = await request('/admin/court-configuration');
    html = await response.text();
    assert.match(html, /Assigned hall/);
    assert.match(html, /Second assigned hall/);
    assert.match(html, /Facilities with external booking/);
    assert.match(html, /Assigned external hall/);
    assert.match(html, /Court bookings for this facility are made on another website/);
    assert.match(html, new RegExp(`href="/admin/facilities#facility-${external}"`));
    assert.doesNotMatch(html, /Unassigned external hall/);
    assert.doesNotMatch(html, /No assigned in-app-managed facilities are available/);
    const externalCard = html.match(/<article[^>]*data-external-court-facility>[\s\S]*?<\/article>/)[0];
    assert.doesNotMatch(externalCard, /<form|\/admin\/bookings\/(?:resources|options|sports)/);
    manager = await Profiles.update(manager.guid, { ...manager, roles: ['Facility manager'], managed_facility_guids: [external] });
    response = await request('/admin/court-configuration');
    html = await response.text();
    assert.match(html, /Assigned external hall/);
    assert.doesNotMatch(html, /Second assigned hall|Unassigned external hall|No assigned in-app-managed facilities are available/);
    assert.doesNotMatch(html, /<article[^>]* data-court-facility>/);
    manager = await Profiles.update(manager.guid, { ...manager, roles: ['Facility manager'], managed_facility_guids: [facilities[0], facilities[2]] });
    const assigned = facilities[0];
    const other = facilities[1];
    const otherResource = (await db.query("INSERT INTO booking_resources (facility_guid, name) VALUES ($1,'Other resource') RETURNING guid", [other])).rows[0].guid;
    const otherOption = (await db.query("SELECT guid FROM bookable_options WHERE facility_guid = $1", [other])).rows[0].guid;
    assert.equal((await post('/admin/bookings/resources', { facility_guid: assigned, name: 'Managed resource' })).status, 302);
    const resource = (await db.query("SELECT guid FROM booking_resources WHERE facility_guid = $1 AND name = 'Managed resource'", [assigned])).rows[0].guid;
    assert.equal((await post('/admin/bookings/resources/update', { facility_guid: assigned, guid: resource, name: 'Renamed resource' })).status, 302);
    assert.equal((await db.query('SELECT name FROM booking_resources WHERE guid = $1', [resource])).rows[0].name, 'Renamed resource');
    const optionInput = { facility_guid: assigned, sport_guid: sport, name: 'Managed court', price: '12.34', resource_guids: resource };
    assert.equal((await post('/admin/bookings/options', optionInput)).status, 302);
    const option = (await db.query("SELECT guid FROM bookable_options WHERE facility_guid = $1 AND name = 'Managed court'", [assigned])).rows[0].guid;
    assert.equal((await post('/admin/bookings/options/update', { ...optionInput, guid: option, name: 'Renamed court' })).status, 302);
    assert.equal((await db.query('SELECT name FROM bookable_options WHERE guid = $1', [option])).rows[0].name, 'Renamed court');
    assert.equal((await post('/admin/bookings/sports/months', { facility_guid: assigned, sport_guid: sport, allowed_months: '3' })).status, 302);
    assert.deepEqual((await db.query('SELECT allowed_months FROM facility_sports WHERE facility_guid = $1 AND sport_guid = $2', [assigned, sport])).rows[0].allowed_months, [3]);
    for (const [url, body] of [
        ['/admin/bookings/resources', { facility_guid: other, name: 'Denied' }],
        ['/admin/bookings/resources/update', { facility_guid: other, guid: otherResource, name: 'Denied' }],
        ['/admin/bookings/resources/destroy', { facility_guid: other, resource_guid: otherResource }],
        ['/admin/bookings/options', { ...optionInput, facility_guid: other, resource_guids: otherResource }],
        ['/admin/bookings/options/update', { ...optionInput, facility_guid: other, guid: otherOption, resource_guids: otherResource }],
        ['/admin/bookings/options/destroy', { facility_guid: other, option_guid: otherOption }],
        ['/admin/bookings/sports/months', { facility_guid: other, sport_guid: sport, allowed_months: '4' }]
    ]) assert.equal((await post(url, body)).status, 403, url);
    assert.equal((await post('/admin/bookings/resources/update', { facility_guid: assigned, guid: otherResource, name: 'Denied' })).status, 404);
    assert.equal((await post('/admin/bookings/resources/destroy', { facility_guid: assigned, resource_guid: otherResource })).status, 404);
    assert.equal((await post('/admin/bookings/options/update', { ...optionInput, guid: otherOption })).status, 404);
    assert.equal((await post('/admin/bookings/options/destroy', { facility_guid: assigned, option_guid: otherOption })).status, 404);
    response = await post('/admin/bookings/options', { ...optionInput, name: 'Cross-facility court', resource_guids: otherResource });
    assert.match(response.headers.get('location'), /error=invalid-option/);
    assert.equal((await db.query("SELECT 1 FROM bookable_options WHERE name = 'Cross-facility court'")).rowCount, 0);
    assert.equal((await db.query('SELECT name FROM booking_resources WHERE guid = $1', [otherResource])).rows[0].name, 'Other resource');
    assert.deepEqual((await db.query('SELECT allowed_months FROM facility_sports WHERE facility_guid = $1 AND sport_guid = $2', [other, sport])).rows[0].allowed_months, [1,2,3,4,5,6,7,8,9,10,11,12]);
    assert.equal((await post('/admin/bookings/options/destroy', { facility_guid: assigned, option_guid: option })).status, 302);
    assert.equal((await post('/admin/bookings/resources/destroy', { facility_guid: assigned, resource_guid: resource })).status, 302);
    assert.equal((await db.query('SELECT 1 FROM bookable_options WHERE guid = $1', [option])).rowCount, 0);
    assert.equal((await db.query('SELECT 1 FROM booking_resources WHERE guid = $1', [resource])).rowCount, 0);
    assert.equal((await post('/admin/facilities/destroy', { guid: facilities[1] })).status, 403);
    assert.equal((await post('/admin/facilities/destroy', { guid: facilities[0] })).status, 403);
    assert.equal((await db.query('SELECT 1 FROM facilities WHERE guid = $1', [facilities[0]])).rowCount, 1);
    assert.equal((await post('/admin/courses/update', { guid: course })).status, 403);
    assert.equal((await post('/admin/facilities/courses/destroy', { guid: course })).status, 403);
    assert.equal((await post('/admin/courses/runs/destroy', { guid: runs[1], course_guid: course })).status, 403);
    assert.equal((await post('/admin/courses/runs/update', { guid: runs[1], course_guid: course, facility_guid: facilities[0] })).status, 403);
    assert.equal((await request(`/admin/course-bookings?view=register&run=${runs[1]}`)).status, 404);
    assert.equal((await request(`/admin/course-management/${enrolment}`)).status, 404);
    assert.equal((await request(`/admin/course-management?facility=${facilities[1]}&course=all&run=all`)).status, 403);
    assert.equal((await request(`/admin/course-bookings?view=register&run=${runs[0]}`)).status, 200);
    response = await request(`/admin/course-management?facility=${facilities[0]}&course=all&run=all`);
    html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Assigned attendee/);
    assert.doesNotMatch(html, /Other attendee/);
    response = await request('/admin/booking-search?from=2030-01-02&to=2030-01-02');
    html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /AH-ASSIGNED-COURT/);
    assert.doesNotMatch(html, /AH-OTHER-COURT/);
    assert.equal(await Courses.removeRun(runs[1], course, [facilities[0]]), null);

    await db.query('DELETE FROM facilities WHERE guid = $1', [facilities[2]]);
    assert.deepEqual((await Profiles.findByGuid(manager.guid)).managed_facility_guids, [facilities[0]]);
    manager = await Profiles.update(manager.guid, { ...manager, roles: ['Facility manager'], managed_facility_guids: [] });
    assert.deepEqual((await Profiles.findByGuid(manager.guid)).managed_facility_guids, []);
    response = await request('/admin/facilities');
    html = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(html, /Assigned hall|Other hall/);
    assert.equal((await post('/admin/bookings/resources', { facility_guid: facilities[0], name: 'Forbidden' })).status, 403);
    response = await request('/admin/court-configuration');
    html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /No assigned in-app-managed facilities are available/);
    assert.doesNotMatch(html, /Assigned hall|Other hall/);
    assert.equal((await post('/admin/bookings/sports/months', { facility_guid: facilities[0], sport_guid: sport, allowed_months: '3' })).status, 403);
});
