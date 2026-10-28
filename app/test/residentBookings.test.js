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
    t.mock.method(Bookings, 'findInAppFacilities', async () => []);
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
    assert.match(html, /<details class="panel" data-court-bookings>/);
    assert.match(html, /<details class="panel" data-course-bookings>/);
    assert.match(html, /Course bookings \(2\)/);
    assert.match(html, /Parent &lt;one&gt;<\/strong> \(you\)/);
    assert.match(html, /Child &lt;two&gt;<\/strong> \(child\)/);
    assert.match(html, /href="\/course-orders\/order-id"/);
    assert.match(html, /£15\.00/);
    assert.match(html, /data-local-booking-time/);
    assert.match(await render([]), /You and your children have no upcoming course bookings/);
});
