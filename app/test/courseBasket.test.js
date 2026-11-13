const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const CourseOrders = require('../models/CourseOrders');
const Settings = require('../models/Settings');
const routes = require('../routes/courseBasket');

const owner = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';

test('JSON course additions return a redirect or conflict details without rendering or changing the requested attendee', async t => {
    const add = t.mock.method(CourseOrders, 'add', async () => {});
    const router = routes({ simulateCardPayment: () => ({ reference: 'SIM' }) });
    const handler = router.stack.find(layer => layer.route?.path === '/basket/add').route.stack[0].handle;
    const req = { profile: { guid: owner }, body: { run_guid: other, member_guid: 'self', return_to: '/courses' },
        get: header => header === 'Accept' ? 'application/json' : undefined };
    const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; } };
    await handler(req, res, assert.fail);
    assert.deepEqual(res.body, { redirect: '/basket' });
    req.body.checkout = '1';
    await handler(req, res, assert.fail);
    assert.deepEqual(res.body, { redirect: '/basket/checkout' });
    add.mock.mockImplementation(async () => { throw new CourseOrders.BasketError('Child already has a place in Gymnastics, Tuesday class.'); });
    await handler(req, res, assert.fail);
    assert.equal(res.code, 409);
    assert.match(res.body.message, /Child.*Gymnastics.*Tuesday/);
    assert.deepEqual(add.mock.calls.at(-1).arguments, [owner, other, 'self', '/courses']);
});

test('course booking popup presents server conflicts and preserves the attendee and checkout choice', async () => {
    const vm = require('node:vm');
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/course-basket-return.ejs'));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    let submit;
    let opened = 0;
    let request;
    const message = {};
    const button = { disabled: false };
    const form = { getAttribute: () => '/basket/add', querySelectorAll: () => [button] };
    const dialog = { showModal() { opened++; } };
    const location = { pathname: '/courses', assign: assert.fail };
    vm.runInNewContext(script, {
        document: {
            getElementById: id => id === 'course-booking-dialog' ? dialog : message,
            addEventListener(_event, listener) { submit = listener; },
            querySelectorAll: () => []
        },
        location, window: { scrollY: 100 }, sessionStorage: { setItem() {}, getItem: () => null },
        FormData: class extends Map { constructor() { super([['run_guid', other], ['member_guid', owner]]); } },
        URLSearchParams, console,
        fetch: async (_url, options) => {
            request = options;
            return { ok: false, headers: { get: () => 'application/json' },
                json: async () => ({ message: 'Child already booked on Tuesday Gymnastics.' }) };
        }
    });
    let prevented = false;
    await submit({ target: form, submitter: { name: 'checkout', value: '1' }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(opened, 1);
    assert.equal(message.textContent, 'Child already booked on Tuesday Gymnastics.');
    assert.equal(request.body.get('member_guid'), owner);
    assert.equal(request.body.get('checkout'), '1');
    assert.equal(button.disabled, false);
    assert.match(html, /<dialog[^>]*aria-labelledby="course-booking-dialog-heading"[^>]*aria-describedby=/);
});

test('basket omits confirmed order history and does not load previous orders', async t => {
    const basket = { return_to: '/courses', items: [], valid: false };
    t.mock.method(CourseOrders, 'basket', async () => basket);
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    const orders = t.mock.method(CourseOrders, 'orders', async () => assert.fail('Basket must not query order history'));
    const router = routes({ simulateCardPayment: () => ({ reference: 'SIM' }) });
    const handler = router.stack.find(layer => layer.route?.path === '/basket').route.stack[0].handle;
    let locals;
    await handler({ profile: { guid: owner } }, {
        status(code) { assert.equal(code, 200); return this; },
        render(view, values) { assert.equal(view, 'resident-basket'); locals = values; }
    }, assert.fail);
    assert.equal(orders.mock.callCount(), 0);
    assert.equal(Object.hasOwn(locals, 'orders'), false);
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-basket.ejs'), {
        ...locals, currentProfile: null, isAdmin: false, canSwitchRole: false,
        orders: [{ guid: other, created_at: new Date(), total_pence: 1000 }]
    });
    assert.match(html, /Your basket is empty/);
    assert.doesNotMatch(html, /Your confirmed orders|previous-course-orders|view confirmation/);
});

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
    for (const value of ['/courses', '/courses#course-heading-123', '/facilities#hall', '/court-bookings']) {
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
    assert.deepEqual(pay.mock.calls[0].arguments, [owner, owner, { total: 1500, credit: 1000 }, 'SIM-TEST', undefined]);
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
    assert.match(html, /Confirm booking using credit/);
    assert.doesNotMatch(html, /name="card_number"/);
    basket.valid = false;
    await handler({ profile: { guid: owner } }, res, assert.fail);
    assert.equal(view, 'resident-basket');
});

test('court basket actions preserve the signed-in owner and offer basket or direct checkout', async t => {
    const add = t.mock.method(CourseOrders, 'addCourts', async () => {});
    const router = routes({ simulateCardPayment: () => assert.fail('Adding must not charge') });
    const handler = router.stack.find(layer => layer.route?.path === '/basket/courts').route.stack[0].handle;
    const slots = [{ option_guid: other, starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T11:00:00Z' }];
    for (const checkout of [undefined, '1']) {
        let redirect;
        await handler({ profile: { guid: owner, role: 'Resident' },
            body: { slots: JSON.stringify(slots), checkout, profile_guid: other } },
        { redirect(...args) { redirect = args; } }, assert.fail);
        assert.deepEqual(redirect, [303, checkout ? '/basket/checkout' : '/basket']);
    }
    assert.deepEqual(add.mock.calls[0].arguments, [owner, slots, 'Resident']);
});

test('court basket rejects malformed selections with visible feedback without adding anything', async t => {
    const add = t.mock.method(CourseOrders, 'addCourts', async () => {});
    t.mock.method(CourseOrders, 'basket', async () => ({ valid: false, items: [] }));
    t.mock.method(CourseOrders, 'orders', async () => []);
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    const router = routes({});
    const handler = router.stack.find(layer => layer.route?.path === '/basket/courts').route.stack[0].handle;
    let status;
    await handler({ profile: { guid: owner }, body: { slots: '{' } }, {
        status(code) { status = code; return this; },
        render(view, locals) { assert.equal(view, 'resident-basket'); assert.match(locals.message, /Choose valid court slots/); }
    }, assert.fail);
    assert.equal(status, 409);
    assert.equal(add.mock.callCount(), 0);
    add.mock.restore();
    for (const slots of [[], null, [{}], [{ option_guid: other, starts_at: 'bad', ends_at: 'bad' }]]) {
        assert.throws(() => CourseOrders.addCourts(owner, slots), /Choose valid/);
    }
});

test('mixed basket and confirmation show court times alongside course attendees', async () => {
    const items = [
        { guid: owner, kind: 'court', option_name: '<Tennis court>', facility_name: 'Park',
            starts_at: '2030-01-01T10:00:00Z', ends_at: '2030-01-01T11:00:00Z', amount_pence: 500, booking_ref: 'COURT' },
        { guid: other, course_name: 'Swimming', run_name: 'Tuesday', facility_name: 'Pool',
            attendee_name: '<Child>', remaining_sessions: 2, sessions: [], amount_pence: 1000, booking_ref: 'COURSE' }
    ];
    const basket = { items, valid: true, revision: owner, return_to: '/court-bookings', total: 1500, credit: 500, due: 1000 };
    for (const view of ['resident-basket', 'resident-checkout', 'resident-course-order']) {
        const html = await ejs.renderFile(path.join(__dirname, `../views/${view}.ejs`), {
            basket, order: { guid: owner, items, total_pence: 1500, credit_pence: 500 }, orders: [], message: '',
            money: pence => `£${(pence / 100).toFixed(2)}`, total: '£15.00', credit: '£5.00', due: '£10.00',
            fullyCovered: false, cardError: '', values: {}, siteTitle: 'ActiveHub', hasLogo: false,
            currentProfile: { name: 'Resident', role: 'Resident' }, isAdmin: false, canSwitchRole: false
        });
        assert.match(html, /&lt;Tennis court&gt;/);
        assert.match(html, /Swimming/);
        assert.match(html, /&lt;Child&gt;/);
        assert.match(html, /2030-01-01T10:00:00.000Z/);
        assert.match(html, /£15.00/);
        assert.doesNotMatch(html, /undefined|Invalid Date|NaN/);
    }
});
