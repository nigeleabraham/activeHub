const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

test('bookings loads course places using only the signed-in owner and renders collapsed sections with attendees', async t => {
    const Orders = require('../models/CourseOrders');
    const Bookings = require('../models/Bookings');
    const Settings = require('../models/Settings');
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Bookings, 'findUpcomingForProfile', async () => []);
    const places = [
        { attendee_name: 'Parent <one>', member_guid: null, course_name: 'Adult course' },
        { attendee_name: 'Child <two>', member_guid: 'child-id', course_name: 'Child course' }
    ].map(booking => ({
        ...booking, order_guid: 'order-id', run_name: 'Tuesday class', facility_name: 'Hall',
        booking_ref: 'TEST-REF', amount_pence: 1500,
        sessions: [{ starts_at: '2027-01-01T10:00:00Z', ends_at: '2027-01-01T11:00:00Z' }]
    }));
    const upcoming = t.mock.method(Orders, 'upcomingForProfile', async () => places);
    const router = require('../routes/front');
    const handler = router.stack.find(layer => layer.route?.path === '/bookings' && layer.route.methods.get).route.stack[0].handle;
    let locals;
    await handler({ profile: { guid: 'owner', credit_pence: 0 }, query: { profile_guid: 'other' } }, {
        render(view, values) { assert.equal(view, 'resident-bookings'); locals = values; },
        sendStatus: assert.fail
    });
    assert.deepEqual(upcoming.mock.calls[0].arguments, ['owner']);
    const render = courseBookings => ejs.renderFile(path.join(__dirname, '../views/resident-bookings.ejs'), {
        ...locals, courseBookings, currentProfile: null, isAdmin: false, canSwitchRole: false
    });
    const html = await render(places);
    assert.match(html, /<h1 class="mb-2">My bookings<\/h1>/);
    assert.match(html, /<details class="panel" data-court-bookings>/);
    assert.match(html, /<details class="panel" data-course-bookings>/);
    assert.doesNotMatch(html, /<div[^>]*data-booking-calendar/);
    assert.match(html, /href="\/court-bookings">Book a court or space/);
    assert.match(html, /href="\/courses">Browse course bookings/);
    assert.match(html, /Course bookings \(2\)/);
    assert.match(html, /Parent &lt;one&gt;<\/strong> \(you\)/);
    assert.match(html, /Child &lt;two&gt;<\/strong> \(child\)/);
    assert.match(html, /href="\/course-orders\/order-id"/);
    assert.match(html, /£15\.00/);
    assert.match(html, /data-local-booking-time/);
    assert.match(await render([]), /You and your children have no upcoming course bookings/);
});

test('court booking page renders only the court booking flow and links to the shared booking history', async t => {
    const Bookings = require('../models/Bookings');
    const Settings = require('../models/Settings');
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Bookings, 'findInAppFacilities', async () => [{
        guid: 'facility', name: 'Hall', address: 'High Street', postcode: 'AB1 2CD', max_resident_bookings: 4
    }]);
    t.mock.method(Bookings, 'findUpcomingForProfile', async () => []);
    t.mock.method(Bookings, 'findOptions', async () => [{
        guid: 'option', name: 'Court one', sport_name: 'Tennis'
    }]);
    const router = require('../routes/front');
    const handler = router.stack.find(layer => layer.route?.path === '/court-bookings' && layer.route.methods.get).route.stack[0].handle;
    let locals;
    await handler({ profile: { guid: 'owner', role: 'Resident', credit_pence: 500 }, query: { facility: 'facility' } }, {
        render(view, values) { assert.equal(view, 'resident-court-bookings'); locals = values; },
        sendStatus: assert.fail
    });
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-court-bookings.ejs'), {
        ...locals, currentProfile: { name: 'Parent' }, isAdmin: false, canSwitchRole: false
    });
    assert.match(html, /<h1 class="mb-2">Court bookings<\/h1>/);
    assert.match(html, /data-booking-calendar/);
    assert.match(html, /Court one/);
    assert.match(html, /href="\/bookings">View all my bookings/);
    assert.match(html, /href="\/courses">Looking to book a course/);
    assert.doesNotMatch(html, /data-course-bookings/);
});

test('customer home links to distinct court, course and shared booking pages', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/home.ejs'), {
        siteTitle: 'ActiveHub', hasLogo: false,
        currentProfile: { name: 'Resident', role: 'Resident' },
        isAdmin: false, activePage: 'home', canSwitchRole: false,
        viewingAs: null, switchableRoles: [], basketItemCount: 0
    });
    const activeSection = html.match(/<section[^>]*aria-labelledby="get-active-heading">([\s\S]*?)<\/section>/)[1];
    const accountSection = html.match(/<section[^>]*aria-labelledby="my-account-heading">([\s\S]*?)<\/section>/)[1];
    assert.match(activeSection, /href="\/facilities"[\s\S]*?<h3[^>]*>Facilities<\/h3>/);
    assert.match(activeSection, /href="\/court-bookings"[\s\S]*?<h3[^>]*>Book a court or space<\/h3>/);
    assert.match(activeSection, /href="\/courses"[\s\S]*?<h3[^>]*>Book a course<\/h3>/);
    assert.match(activeSection, /🥇[\s\S]*?<h3[^>]*>Book a course<\/h3>/);
    assert.match(accountSection, /href="\/profile"[\s\S]*?<h3[^>]*>My profile<\/h3>/);
    assert.match(accountSection, /href="\/credits-and-refunds"[\s\S]*?<h3[^>]*>Credits and refunds<\/h3>/);
    assert.match(accountSection, /href="\/bookings"[\s\S]*?<h3[^>]*>My bookings<\/h3>/);
    assert.match(html, /<h2[^>]*id="get-active-heading">Get Active<\/h2>/);
    assert.match(html, /<h2[^>]*id="my-account-heading">My Account<\/h2>/);
    assert.match(html, /<nav class="customer-top-navigation" aria-label="Main navigation">/);
    assert.ok(html.indexOf('class="brand-hero"') < html.indexOf('class="customer-navigation-bar"'));
    assert.ok(html.indexOf('class="customer-navigation-bar"') < html.indexOf('<main'));
    assert.match(html, /<summary><span class="admin-navigation-label">Get Active<\/span><\/summary>/);
    assert.match(html, /<summary><span class="admin-navigation-label">My Account<\/span><\/summary>/);
    assert.doesNotMatch(html, /<summary><span class="admin-navigation-label">Administration<\/span><\/summary>/);
});

test('customer navigation exposes the three page groups and only shows administration when permitted', async () => {
    const navigation = path.join(__dirname, '../views/partials/customer-navigation.ejs');
    const render = canAccessAdmin => ejs.renderFile(navigation, {
        currentProfile: { name: 'Resident', role: 'Resident', permissions: [] },
        isAdmin: false, area: 'resident', activePage: 'court-bookings',
        canSwitchRole: false, viewingAs: null, switchableRoles: [],
        canAccessAdmin: () => canAccessAdmin
    });
    const residentHtml = await render(false);
    const adminHtml = await render(true);
    for (const [html, hasAdmin] of [[residentHtml, false], [adminHtml, true]]) {
        assert.match(html, /<summary><span class="admin-navigation-label">Get Active<\/span><\/summary>/);
        assert.match(html, /href="\/facilities">Facilities<\/a>/);
        assert.match(html, /href="\/court-bookings" aria-current="page">Book a court or space<\/a>/);
        assert.match(html, /href="\/courses">Book a course<\/a>/);
        assert.match(html, /<summary><span class="admin-navigation-label">My Account<\/span><\/summary>/);
        assert.match(html, /href="\/profile">My profile<\/a>/);
        assert.match(html, /href="\/credits-and-refunds">Credits and refunds<\/a>/);
        assert.match(html, /href="\/bookings">My bookings<\/a>/);
        assert.equal(html.includes('<summary><span class="admin-navigation-label">Administration</span></summary>'), hasAdmin);
    }
});
