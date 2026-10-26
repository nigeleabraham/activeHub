const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const CourseOrders = require('../models/CourseOrders');
const Settings = require('../models/Settings');
const routes = require('../routes/courseBasket');

const owner = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';

test('basket button displays the current item count, including an empty basket', async () => {
    for (const count of [0, 1, 12]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/partials/basket-button.ejs'), {
            currentProfile: { guid: owner }, basketItemCount: count
        });
        assert.ok(html.includes(`Basket (${count})`));
        assert.match(html, /href="\/basket"/);
    }
});

test('basket return locations stay within customer course and facility pages', () => {
    for (const value of ['/courses', '/courses#course-heading-123', '/facilities#hall']) {
        assert.equal(CourseOrders.returnPath(value), value);
    }
    for (const value of ['//example.com', 'https://example.com', '/admin', '/courses/../admin', ['/courses'], '/courses?next=evil']) {
        assert.equal(CourseOrders.returnPath(value), '/courses');
    }
    assert.throws(() => CourseOrders.add(owner, 'invalid', 'self', '/courses'), /Choose/);
    assert.throws(() => CourseOrders.add(owner, [owner], 'self', '/courses'), /Choose/);
    assert.throws(() => CourseOrders.pay(owner, 'invalid', {}, 'SIM'), /Reload/);
});

test('basket actions use the signed-in owner, redirect after adding and isolate family members', async t => {
    const router = routes({ simulateCardPayment: () => ({ reference: 'SIM-TEST' }) });
    const handler = endpoint => router.stack.find(layer => layer.route?.path === endpoint).route.stack[0].handle;
    const add = t.mock.method(CourseOrders, 'add', async () => {});
    const family = t.mock.method(CourseOrders, 'addFamilyMember', async () => {});
    let location;
    const res = { redirect(value) { location = value; } };
    const next = error => assert.fail(error);
    await handler('/basket/add')({ profile: { guid: owner },
        body: { profile_guid: other, run_guid: 'run', member_guid: 'member', return_to: '/facilities' } }, res, next);
    assert.deepEqual(add.mock.calls[0].arguments, [owner, 'run', 'member', '/facilities']);
    assert.equal(location, '/basket');
    await handler('/profile/family-members')({ profile: { guid: owner }, body: { name: 'Child', profile_guid: other } }, res, next);
    assert.deepEqual(family.mock.calls[0].arguments, [owner, 'Child']);
    assert.equal(location, '/profile?family_saved=1#my-children');
});

test('declined simulated payment preserves basket; successful payment passes quote and redirects to owned order', async t => {
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(CourseOrders, 'basket', async () => ({ valid: true }));
    t.mock.method(CourseOrders, 'orders', async () => []);
    const pay = t.mock.method(CourseOrders, 'pay', async () => ({ guid: 'order' }));
    let decline = true;
    const router = routes({ simulateCardPayment: () => decline ? { error: 'Card declined.' } : { reference: 'SIM-TEST' } });
    const handler = router.stack.find(layer => layer.route?.path === '/basket/pay').route.stack[0].handle;
    let status, locals, location;
    const res = { status(code) { status = code; return this; }, render(view, values) { locals = values; },
        redirect(value) { location = value; } };
    const req = { profile: { guid: owner }, body: { total: '1500', credit: '1000', token: owner } };
    await handler(req, res, error => assert.fail(error));
    assert.equal(status, 422);
    assert.equal(locals.cardError, 'Card declined.');
    assert.equal(pay.mock.callCount(), 0);
    decline = false;
    await handler(req, res, error => assert.fail(error));
    assert.deepEqual(pay.mock.calls[0].arguments, [owner, owner, { total: 1500, credit: 1000 }, 'SIM-TEST']);
    assert.equal(location, '/course-orders/order');
});

test('basket renders contents, source link, remove, totals and simulated checkout without leaking card values', async () => {
    const basket = { return_to: '/courses#course-heading-test', valid: true, revision: owner,
        items: [{ guid: other, course_name: '<Course>', run_name: 'Tuesday', facility_name: 'Hall', attendee_name: '<Child>',
            remaining_sessions: 3, amount_pence: 1500 }], total: 1500, credit: 500, due: 1000 };
    for (const checkout of [false, true]) {
        const html = await ejs.renderFile(path.join(__dirname, checkout ? '../views/resident-checkout.ejs' : '../views/resident-basket.ejs'), {
            basket, checkout, orders: [], message: '', money: pence => `£${(pence / 100).toFixed(2)}`,
            total: '£15.00', credit: '£5.00', due: '£10.00', fullyCovered: false, cardError: '', values: {},
            siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident', role: 'Resident' },
            isAdmin: false, canSwitchRole: false
        });
        assert.match(html, /&lt;Course&gt;/);
        assert.match(html, /&lt;Child&gt;/);
        assert.match(html, checkout ? /href="\/basket"/ : /href="\/courses#course-heading-test"/);
        if (!checkout) assert.match(html, /action="\/basket\/remove"/);
        assert.match(html, /£15.00/);
        assert.match(html, /£10.00/);
        assert.match(html, checkout ? /action="\/basket\/pay"/ : /action="\/basket\/checkout"/);
        if (checkout) {
            assert.match(html, /simulated payment/);
            assert.doesNotMatch(html, /name="card_number"[^>]*value=/);
        }
    }
});

test('course run controls include saved family members and replace purchase controls for sold-out runs', async () => {
    const filename = path.join(__dirname, '../views/partials/course-run-details.ejs');
    const values = {
        run: { guid: owner, name: 'Tuesday', facility_name: 'Hall', sessions: [], capacity: 10, spaces_remaining: 0,
            current_price_pence: 500, full_price_pence: 500, remaining_sessions: 1, total_sessions: 1 },
        currentProfile: { name: 'Resident' }, familyMembers: [{ guid: other, name: 'Child' }], returnTo: '/facilities'
    };
    const soldOut = await ejs.renderFile(filename, values);
    assert.match(soldOut, /Sold out/);
    assert.doesNotMatch(soldOut, /action="\/basket\/add"|Add to basket/);
    const html = await ejs.renderFile(filename, { ...values, run: { ...values.run, spaces_remaining: 2 } });
    assert.match(html, /Spaces remaining: 2/);
    assert.match(html, /value="self">Resident \(myself\)/);
    assert.match(html, /value="123e4567-e89b-42d3-a456-426614174001">Child/);
    assert.match(html, /Who is attending\?/);
    assert.match(html, /class="btn btn-primary btn-block"[^>]*>Add to basket &mdash; &pound;5\.00/);
    assert.match(html, /name="checkout" value="1">Checkout/);
    const withBasket = await ejs.renderFile(filename, { ...values, basketItemCount: 2, run: { ...values.run, spaces_remaining: 2 } });
    assert.match(withBasket, /name="checkout" value="1">Add to basket and checkout/);
    assert.doesNotMatch(soldOut, /name="checkout"/);
});

test('direct checkout adds the selected place before redirecting to Payment without posting twice', async t => {
    const add = t.mock.method(CourseOrders, 'add', async () => {});
    const router = routes({ simulateCardPayment: () => assert.fail('Adding must not charge') });
    const handler = router.stack.find(layer => layer.route?.path === '/basket/add').route.stack[0].handle;
    let redirect;
    const res = { redirect(...args) { redirect = args; } };
    const req = { profile: { guid: owner }, body: {
        run_guid: 'run', member_guid: 'child', return_to: '/courses', checkout: '1'
    } };
    await handler(req, res, assert.fail);
    assert.deepEqual(add.mock.calls[0].arguments, [owner, 'run', 'child', '/courses']);
    assert.deepEqual(redirect, [303, '/basket/checkout']);
    assert.ok(router.stack.some(layer => layer.route?.path === '/basket/checkout' && layer.route.methods.get));
    add.mock.mockImplementation(async () => { throw new Error('Add failed'); });
    redirect = null;
    let failure;
    await handler(req, res, error => { failure = error; });
    assert.equal(failure.message, 'Add failed');
    assert.equal(redirect, null);
});

test('basket checkout uses the existing payment page and invalid baskets stay in the basket', async t => {
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(CourseOrders, 'orders', async () => []);
    const basket = { valid: true, total: 1500, credit: 500, due: 1000 };
    t.mock.method(CourseOrders, 'basket', async () => basket);
    const router = routes({ simulateCardPayment: () => assert.fail('Checkout must not charge') });
    const handler = router.stack.find(layer => layer.route?.path === '/basket/checkout').route.stack[0].handle;
    let view, locals;
    const res = { status() { return this; }, render(name, values) { view = name; locals = values; } };
    await handler({ profile: { guid: owner } }, res, assert.fail);
    assert.equal(view, 'resident-checkout');
    assert.equal(locals.due, '£10.00');
    assert.equal(locals.fullyCovered, false);
    basket.credit = 1500;
    basket.due = 0;
    await handler({ profile: { guid: owner } }, res, assert.fail);
    assert.equal(locals.fullyCovered, true);
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-checkout.ejs'), {
        ...locals, basket: { ...basket, revision: owner, items: [] },
        currentProfile: null, isAdmin: false, canSwitchRole: false
    });
    assert.match(html, /action="\/basket\/pay"/);
    assert.match(html, /name="token" value="123e4567-e89b-42d3-a456-426614174000"/);
    assert.match(html, /Confirm enrolment using credit/);
    assert.doesNotMatch(html, /name="card_number"/);
    basket.valid = false;
    await handler({ profile: { guid: owner } }, res, assert.fail);
    assert.equal(view, 'resident-basket');
});
