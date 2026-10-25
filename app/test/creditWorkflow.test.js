const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const Credits = require('../models/Credits');
const Bookings = require('../models/Bookings');
const Profiles = require('../models/Profiles');
const Settings = require('../models/Settings');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');

const GUID = '123e4567-e89b-42d3-a456-426614174000';
const profile = { guid: GUID, name: 'Resident', email: 'resident@example.test', role: 'Resident' };

test('checkout distinguishes available balance, credit deduction and card remainder', async () => {
    for (const [availableCredit, credit, due] of [
        ['£50.00', '£10.00', '£0.00'],
        ['£4.00', '£4.00', '£6.00'],
        ['£0.00', '£0.00', '£10.00']
    ]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/resident-checkout.ejs'), {
            siteTitle: 'ActiveHub', hasLogo: false, currentProfile: profile, isAdmin: false,
            canSwitchRole: false, activePage: 'bookings', facility: { guid: GUID, name: 'Hall' },
            items: [], slotsJson: '[]', unitPrice: '£10.00', total: '£10.00',
            availableCredit, credit, due, fullyCovered: due === '£0.00', cardError: null, values: {}
        });
        assert.ok(html.includes(`You have <strong>${availableCredit}</strong> credit in your account.`));
        assert.ok(html.includes(`<strong>${credit}</strong> will be deducted from the account.`));
        assert.equal(html.includes(`The remaining <strong>${due}</strong> will be charged to your card.`), due !== '£0.00');
        assert.equal(html.includes('Confirm booking using credit'), due === '£0.00');
        assert.ok(!html.includes('covers this booking'));
    }
});

test('profile editing is separate from the credits and refunds page', async t => {
    t.mock.method(Settings, 'getAll', async () => ({ site_title: 'ActiveHub', credit_request_days: '30' }));
    t.mock.method(Settings, 'getLogo', async () => null);
    t.mock.method(Profiles, 'findByGuid', async () => profile);
    const update = t.mock.method(Profiles, 'updateDetails', async (_, details) => ({ ...profile, ...details }));
    t.mock.method(AuditLog, 'record', async () => {});
    const handler = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.get).route.stack[0].handle;
    let locals;
    await handler({ profile, query: {} }, { render(view, values) {
        assert.equal(view, 'resident-profile');
        locals = values;
    } });
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-profile.ejs'), {
        ...locals, currentProfile: profile, isAdmin: false, canSwitchRole: false
    });
    assert.ok(html.includes('action="/profile"'));
    assert.ok(html.includes('href="/credits-and-refunds"'));
    assert.ok(!html.includes('aria-labelledby="booking-credit"'));
    assert.ok(!html.includes('id="past-bookings"'));
    const save = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.post).route.stack[0].handle;
    let location;
    await save({ profile, body: { name: 'Updated Resident', email: profile.email } }, {
        redirect(value) { location = value; }
    });
    assert.equal(location, '/profile?saved=1');
    assert.equal(update.mock.calls[0].arguments[1].name, 'Updated Resident');
});

test('credit refund routes require login, enforce administrator access and use the signed-in owner', async t => {
    const requested = t.mock.method(Credits, 'requestRefund', async () => ({ requested_pence: 1000 }));
    const decided = t.mock.method(Credits, 'decideRefund', async () => ({
        credit_guid: GUID, booking_ref: 'AH-TEST', profile_guid: GUID, refunded_pence: 600
    }));
    t.mock.method(AuditLog, 'record', async () => {});
    const app = express();
    app.set('views', path.join(__dirname, '../views'));
    app.set('view engine', 'ejs');
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.profile = req.get('test-role') ? { ...profile, role: req.get('test-role') } : null;
        Object.assign(res.locals, {
            currentProfile: req.profile, isAdmin: req.profile?.role === 'Administrator',
            canSwitchRole: false, activePage: ''
        });
        next();
    });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function post(route, body, role) {
        return fetch(base + route, {
            method: 'POST', redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...(role ? { 'test-role': role } : {}) },
            body: new URLSearchParams(body)
        });
    }
    assert.equal((await post('/profile/credit-refunds', { credit_guid: GUID })).status, 401);
    assert.equal(requested.mock.callCount(), 0);
    let response = await post('/profile/credit-refunds', { credit_guid: GUID, profile_guid: 'another-user' }, 'Resident');
    assert.equal(response.headers.get('location'), '/credits-and-refunds?refund_requested=1#booking-credit');
    assert.deepEqual(requested.mock.calls[0].arguments, [GUID, GUID]);
    response = await post('/profile/credit-refunds', { credit_guid: 'invalid' }, 'Resident');
    assert.equal(response.status, 400);
    requested.mock.mockImplementation(async () => null);
    response = await post('/profile/credit-refunds', { credit_guid: GUID }, 'Resident');
    assert.equal(response.headers.get('location'), '/credits-and-refunds?refund_error=1#booking-credit');
    for (const role of ['Resident', 'Coach']) {
        response = await post('/admin/credit-refunds/decide', { request_guid: GUID, decision: 'approve' }, role);
        assert.equal(response.status, 403);
    }
    assert.equal(decided.mock.callCount(), 0);
    response = await post('/admin/credit-refunds/decide', { request_guid: GUID, decision: 'approve' }, 'Administrator');
    assert.equal(response.headers.get('location'), '/admin/credit-refunds?decision=approved');
    assert.deepEqual(decided.mock.calls[0].arguments, [GUID, true, profile.name, null]);
    response = await post('/admin/credit-refunds/decide', { request_guid: GUID, decision: 'invalid' }, 'Administrator');
    assert.equal(response.status, 400);
    decided.mock.mockImplementation(async () => null);
    response = await post('/admin/credit-refunds/decide', { request_guid: GUID, decision: 'decline', decline_comment: 'Not eligible' }, 'Administrator');
    assert.equal(response.headers.get('location'), '/admin/credit-refunds?error=1');
});

test('profile credit panel renders balances, booking references and every refund status', async () => {
    const defaults = {
        siteTitle: 'ActiveHub', organisationName: "Peck'em", hasLogo: false, saved: false, error: '', requested: false, autoApproved: false, profile,
        upcoming: [], past: [], expiredPendingRefunds: [], creditBalance: 1200, creditRequestDays: 30, refundRequested: false, refundError: false,
        currentProfile: profile, isAdmin: false, canSwitchRole: false, activePage: 'profile'
    };
    const baseCredit = {
        guid: GUID, booking_guid: GUID, booking_ref: 'AH-SOURCE', facility_name: '<Hall>', amount_pence: 1000,
        remaining_pence: 600, refundable: true, refund_status: null, expires_at: '2027-10-25T12:00:00Z', days_remaining: 365,
        payment_reference: 'PAY-<source>'
    };
    for (const [status, expected] of [
        [null, 'Request bank refund of £6.00'],
        ['pending', 'Refund requested &mdash; pending review'],
        ['approved', 'Bank refund accepted: £6.00'],
        ['declined', 'Bank refund declined.'],
        ['spent', 'Refund request closed: credit fully spent.']
    ]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/resident-credits.ejs'), {
            ...defaults, credits: [{ ...baseCredit, refund_status: status, refunded_pence: 600, decline_comment: '<Not eligible>' }],
            past: [{
                guid: GUID, booking_ref: 'AH-SOURCE', facility_name: 'Hall', option_name: 'Court', sport_name: 'Tennis',
                starts_at: '2026-10-20T12:00:00Z', ends_at: '2026-10-20T13:00:00Z', payment_status: 'paid',
                amount_pence: 1000, credit_applied_pence: 0, credited_at: '2026-10-21T12:00:00Z',
                credited_pence: 1000, address: 'Test road', postcode: 'TEST'
            }]
        });
        assert.ok(html.includes(expected), status);
        assert.ok(html.includes('Total available: £12.00'));
        assert.ok(html.includes('bookings that have passed in the last 30 days.'));
        assert.ok(html.includes('at the discretion of Peck&#39;em, this may not be refundable.'));
        assert.ok(html.includes('365 days remaining (rounded up).'));
        assert.ok(html.includes('datetime="2027-10-25T12:00:00.000Z"'));
        assert.ok(html.includes('<title>Credits and refunds |'));
        assert.ok(!html.includes('action="/profile"'));
        assert.ok(!html.includes('Upcoming bookings'));
        assert.ok(html.includes('AH-SOURCE'));
        assert.ok(html.includes('Payment ID: <code>PAY-&lt;source&gt;</code>'));
        assert.ok(html.includes('&lt;Hall&gt;'));
        assert.equal(html.includes('action="/credits-and-refunds/credit-refunds"'), status === null);
        if (status === 'declined') assert.ok(html.includes('Decline reason: &lt;Not eligible&gt;'));
        if (status === 'pending') {
            assert.ok(html.includes('Your bank refund request for £6.00 is waiting'));
            assert.ok(html.includes('You do not need to request it again.'));
            assert.equal((html.match(/Refund requested &mdash; pending review/g) || []).length, 1);
        }
    }
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-credits.ejs'), {
        ...defaults, credits: [{ ...baseCredit, refundable: false }]
    });

    assert.ok(html.includes('Non-refundable'));
    assert.ok(!html.includes('action="/credits-and-refunds/credit-refunds"'));
    const expiredHtml = await ejs.renderFile(path.join(__dirname, '../views/resident-credits.ejs'), {
        ...defaults, credits: [], creditBalance: 0,
        expiredPendingRefunds: [{ booking_ref: 'AH-EXPIRED', remaining_pence: 600 }]
    });
    assert.ok(expiredHtml.includes('You have no booking credits.'));
    assert.ok(expiredHtml.includes('AH-EXPIRED'));
    assert.ok(expiredHtml.includes('no longer available to spend'));
    assert.ok(!expiredHtml.includes('action="/credits-and-refunds/credit-refunds"'));
    const autoHtml = await ejs.renderFile(path.join(__dirname, '../views/resident-credits.ejs'), {
        ...defaults, autoApproved: true, credits: [{ ...baseCredit, auto_approved: true }]
    });
    assert.ok(autoHtml.includes('Automatically approved — your booking credit has been added.'));
    assert.equal((autoHtml.match(/Automatically approved/g) || []).length, 1);
    const persistentHtml = await ejs.renderFile(path.join(__dirname, '../views/resident-credits.ejs'), {
        ...defaults, credits: [{ ...baseCredit, auto_approved: true }]
    });
    assert.ok(!persistentHtml.includes('Automatically approved'));
    assert.ok(!html.includes('Automatically approved'));
});

test('both administrator decision routes reject missing decline comments and pass trimmed comments', async t => {
        const creditDecision = t.mock.method(Bookings, 'decideCreditRequest', async () => ({
            booking_guid: GUID, booking_ref: 'AH-TEST', reason: 'weather'
        }));
        const refundDecision = t.mock.method(Credits, 'decideRefund', async () => ({
            credit_guid: GUID, profile_guid: GUID, refunded_pence: 0
        }));
        const audit = t.mock.method(AuditLog, 'record', async () => {});
        const admin = router.stack.find(layer => layer.handle.stack).handle;
        for (const [route, mock, args] of [
            ['/credit-requests/decide', creditDecision, [GUID, false, profile.name, false, 'Not eligible', false]],
            ['/credit-refunds/decide', refundDecision, [GUID, false, profile.name, 'Not eligible']]
        ]) {
            const handler = admin.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
            for (const comment of [undefined, ' ', 'x'.repeat(501), '  Not eligible  ']) {
                let location;
                await handler({
                    profile, body: { request_guid: GUID, decision: 'decline', decline_comment: comment }
                }, { redirect(value) { location = value; } });
                assert.equal(location.includes('error=comment'), comment !== '  Not eligible  ');
            }
            assert.equal(mock.mock.callCount(), 1);
            assert.deepEqual(mock.mock.calls[0].arguments, args);
        }
        assert.ok(audit.mock.calls.every(call => call.arguments[1].details.decline_comment === 'Not eligible'));
});

test('administrator queue shows only pending requests as actionable and records accepted amounts', async () => {
    const baseRequest = {
        guid: GUID, booking_ref: 'AH-SOURCE', facility_name: 'Hall', profile_name: 'Resident',
        profile_email: 'resident@example.test', requested_pence: 1000, remaining_pence: 600
    };
    const html = await ejs.renderFile(path.join(__dirname, '../views/credit-refunds.ejs'), {
        currentProfile: { ...profile, role: 'Administrator' }, isAdmin: true, canSwitchRole: false,
        activePage: 'credit-refunds', area: 'admin', decision: '', error: false, declineError: false,
        requests: [
            { ...baseRequest, status: 'pending' },
            { ...baseRequest, status: 'approved', refunded_pence: 600, decided_by_name: 'Admin' },
            { ...baseRequest, status: 'declined' },
            { ...baseRequest, status: 'spent' }
        ]
    });

    assert.equal((html.match(/action="\/admin\/credit-refunds\/decide"/g) || []).length, 2);
    assert.ok(html.includes('Accepted £6.00'));
    assert.ok(html.includes('Closed: credit fully spent'));
});

test('resident credit request validates and tracks weather and discretionary reasons', async t => {
        const request = t.mock.method(Bookings, 'requestCredit', async () => ({ guid: GUID }));
        const audit = t.mock.method(AuditLog, 'record', async () => {});
        const handler = router.stack.find(layer => Array.isArray(layer.route?.path) && layer.route.path.includes('/credits-and-refunds/credit-requests')).route.stack[0].handle;
        async function submit(body) {
            let location;
            await handler({ body: { booking_guid: GUID, ...body }, profile }, {
                redirect(value) { location = value; },
                sendStatus(code) { assert.fail(`Unexpected HTTP ${code}`); }
            });

            return location;
        }
        for (const body of [
            { reason: 'invalid' }, { reason: 'discretionary', note: '   ' },
            { reason: 'discretionary', note: 'x'.repeat(501) }
        ]) {
            assert.match(await submit(body), /^\/credits-and-refunds\?error=/);
        }
        assert.equal(request.mock.callCount(), 0);
        assert.equal(await submit({ reason: 'discretionary', note: '  Facility closed early  ' }), '/credits-and-refunds?requested=1#past-bookings');
        assert.deepEqual(request.mock.calls[0].arguments, [GUID, GUID, 'discretionary', 'Facility closed early']);
        assert.equal(audit.mock.calls[0].arguments[1].details.reason, 'discretionary');
        assert.equal(await submit({ reason: 'weather', note: 'Stale hidden description' }), '/credits-and-refunds?requested=1#past-bookings');
        assert.deepEqual(request.mock.calls[1].arguments, [GUID, GUID, 'weather', null]);
        request.mock.mockImplementation(async () => ({ guid: GUID, auto_approved: true }));
        assert.equal(await submit({ reason: 'weather' }), '/credits-and-refunds?requested=auto#booking-credit');
        assert.equal(audit.mock.calls[2].arguments[1].details.auto_approved, true);
});

test('weather slot switch is validated, saved and audited', async t => {
    const set = t.mock.method(Settings, 'set', async () => {});
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/settings/credit-slot-auto-approval').route.stack[0].handle;
    for (const enabled of [undefined, 'yes', ['1'], '0', '1']) {
        let response;
        await handler({ profile, body: { enabled } }, {
            sendStatus(code) { response = code; }, redirect(location) { response = location; }
        });
        assert.equal(response, ['0', '1'].includes(enabled) ? '/admin/settings?saved=1' : 400);
    }
    assert.deepEqual(set.mock.calls.map(call => call.arguments), [
        ['credit_slot_auto_approval', '0'], ['credit_slot_auto_approval', '1']
    ]);
    assert.equal(audit.mock.calls[1].arguments[1].details.enabled, true);
});

test('weather slot controls and history render only as appropriate', async () => {
    const request = {
        guid: GUID, booking_ref: 'AH-WEATHER', facility_name: 'Hall', profile_name: 'Resident',
        profile_email: profile.email, requested_at: new Date(), starts_at: new Date(), ends_at: new Date(),
        amount_paid_pence: 1000, reason: 'weather', status: 'pending', note: null
    };
    for (const enabled of [false, true]) {
        const html = await ejs.renderFile(path.join(__dirname, '../views/credit-requests.ejs'), {
            currentProfile: profile, isAdmin: true, canSwitchRole: false, area: 'admin', activePage: 'credit-requests',
            declineError: false, decision: '', error: false, autoApprovalEnabled: enabled, creditRequestDays: 7,
            autoApprovalSlots: [{ ...request, refundable: true, approved_by_name: '<Admin>' }],
            requests: [request, { ...request, reason: 'discretionary', note: 'Court closed' },
                { ...request, status: 'approved', auto_approved: true }]
        });
        assert.equal((html.match(/name="approve_slot"/g) || []).length, enabled ? 1 : 0);
        assert.equal((html.match(/name="refundable"/g) || []).length, 1);
        assert.ok(html.includes('Weather credit is always refundable.'));
        assert.ok(!html.includes('name="refundable" value="1" checked'));
        assert.ok(html.includes('last 7 days'));
        assert.ok(html.includes('&lt;Admin&gt;'));
        assert.ok(html.includes('Auto-approved weather slot'));
        assert.equal(html.includes('saved slots are paused'), !enabled);
    }
});
