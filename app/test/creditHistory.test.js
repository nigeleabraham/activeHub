const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Bookings = require('../models/Bookings');
const Credits = require('../models/Credits');
const Settings = require('../models/Settings');
const Profiles = require('../models/Profiles');
const auth = require('../middleware/auth');
const router = require('../routes/front');
const ejs = require('ejs');
const path = require('node:path');
const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('credit history limits entries and totals to the same dates and selected user', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async sql =>
        ({ rows: sql.includes('COUNT(*)') ? [{ count: 51 }] : [{ guid: 'request' }] }));
    t.mock.method(Credits, 'fundingForBookings', async rows => rows);
    const result = await Bookings.searchCreditHistory({ from: '2026-10-01', to: '2026-10-31', profileGuid: GUID, page: 2 });
    assert.deepEqual(result, { entries: [{ guid: 'request' }], total: 51, pageSize: 50 });
    assert.deepEqual(query.mock.calls[0].arguments[1], [null, '2026-10-01', '2026-10-31', GUID, 50]);
    assert.match(query.mock.calls[0].arguments[0], /requests.status <> 'pending'/);
    assert.match(query.mock.calls[0].arguments[0], /requests.profile_guid = \$4/);
    assert.match(query.mock.calls[0].arguments[0], /LIMIT 50 OFFSET \$5/);
    assert.deepEqual(query.mock.calls[1].arguments[1], ['2026-10-01', '2026-10-31', GUID]);
    assert.match(query.mock.calls[1].arguments[0], /status <> 'pending'/);
    for (const call of query.mock.calls) assert.match(call.arguments[0], /Europe\/London/);
    const count = query.mock.callCount();
    for (const filters of [{}, { from: '2026-01-01', to: '2026-03-04' },
        { from: '2026-11-02', to: '2026-11-01' }, { from: '2026-11-01', to: '2026-11-02', page: 0 }]) {
        await assert.rejects(Bookings.searchCreditHistory(filters), RangeError);
    }
    assert.equal(query.mock.callCount(), count);
});

test('credit queue and history query independently and preserve old history links', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const queue = admin.stack.find(layer => layer.route?.path === '/credit-requests').route.stack[0].handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/credit-requests/history').route.stack[0].handle;
    t.mock.method(Settings, 'getAll', async () => ({}));
    t.mock.method(Settings, 'getCreditRequestDays', async () => 7);
    t.mock.method(Bookings, 'findAutoApprovalSlots', async () => []);
    t.mock.method(Profiles, 'findByGuid', async () => ({ guid: GUID, name: 'Rita Resident' }));
    const pending = t.mock.method(Bookings, 'findCreditRequests', async () => []);
    const history = t.mock.method(Bookings, 'searchCreditHistory', async () => ({ entries: [], total: 0, pageSize: 50 }));
    let data;
    const res = { render(_view, value) { data = value; }, status(code) { this.code = code; return this; }, send() {},
        redirect(url) { this.url = url; } };
    await queue({ query: {} }, res);
    assert.equal(data.historyPage, false);
    await queue({ query: { from: '2026-11-01', to: '2026-11-05', profile: GUID, page: '2' } }, res);
    assert.equal(res.url, `/admin/credit-requests/history?from=2026-11-01&to=2026-11-05&profile=${GUID}&page=2#decided-heading`);
    await handler({ query: {} }, res);
    assert.deepEqual(pending.mock.calls[0].arguments, ['pending']);
    assert.equal(history.mock.callCount(), 0);
    assert.equal(data.searched, false);
    assert.equal(data.historyPage, true);
    assert.equal(data.fromQueue, false);
    assert.equal(data.activePage, 'credit-request-history');
    for (const query of [{ from: '2026-11-01' }, { profile: 'invalid' }, { page: '0' },
        { from: '2026-01-01', to: '2026-03-04' }]) {
        await handler({ query }, res);
        assert.equal(res.code, 400);
    }
    assert.equal(pending.mock.callCount(), 1);
    await handler({ query: { from: '2026-11-01', to: '2026-11-05', profile: GUID, page: '2' } }, res);
    assert.deepEqual(history.mock.calls[0].arguments, [{ from: '2026-11-01', to: '2026-11-05', page: 2, profileGuid: GUID }]);
    assert.equal(data.filters.profile, GUID);
    assert.equal(pending.mock.callCount(), 1);
    await handler({ query: { from_queue: '1' } }, res);
    assert.equal(data.fromQueue, true);
});

test('credit request history remains administrator-only', () => {
    assert.equal(auth.canAccessAdmin({ role: 'Administrator' }, '/credit-requests/history'), true);
    for (const permission of ['bookings.manage', 'profiles.manage', 'audit.view']) {
        assert.equal(auth.canAccessAdmin({ role: 'Staff', permissions: [permission] }, '/credit-requests/history'), false);
    }
});

test('credit history starts empty, renders the shared finder and preserves pagination filters', async () => {
    const values = {
        currentProfile: null, isAdmin: false, canSwitchRole: false, activePage: 'credit-requests',
        decision: '', declineError: false, error: false, requests: [], searched: false, historyPage: true,
        autoApprovalEnabled: false, creditRequestDays: 7, autoApprovalSlots: [],
        filters: { from: '', to: '' }, history: { entries: [], total: 0, pageSize: 50 }, page: 1
    };
    const view = path.join(__dirname, '../views/credit-requests.ejs');
    const initial = await ejs.renderFile(view, values);
    const queue = await ejs.renderFile(view, { ...values, historyPage: false });
    assert.match(queue, /href="\/admin\/credit-requests\/history\?from_queue=1">Search credit request history/);
    assert.doesNotMatch(initial, /Back to pending credit requests/);
    const fromQueue = await ejs.renderFile(view, { ...values, fromQueue: true, searched: true, page: 2,
        filters: { from: '2026-11-01', to: '2026-11-05' }, history: { entries: [], total: 101, pageSize: 50 } });
    assert.match(fromQueue, /Back to pending credit requests/);
    assert.match(fromQueue, /name="from_queue" value="1"/);
    assert.match(fromQueue, /history\?from_queue=1">Clear/);
    assert.match(fromQueue, /from_queue=1&amp;page=3#decided-heading/);
    assert.doesNotMatch(queue, /aria-labelledby="decided-heading"|id="credit-profile-search"/);
    assert.match(initial, /Select From and To dates to load credit history/);
    assert.doesNotMatch(initial, /aria-labelledby="pending-heading"|aria-labelledby="auto-slots-heading"/);
    assert.match(initial, /p-4 mb-4" aria-labelledby="decided-heading"/);
    assert.doesNotMatch(initial, /<table/);
    assert.match(initial, /class="sr-only" data-credit-profile-status/);
    assert.match(initial, /if \(!event.target.value.trim\(\)\) finder.reset/);
    const html = await ejs.renderFile(view, { ...values, searched: true, page: 2,
        filters: { from: '2026-11-01', to: '2026-11-05', profile: GUID },
        history: { entries: [], total: 101, pageSize: 50 } });
    assert.match(html, /Page 2 of 3/);
    assert.ok(html.includes(`profile=${GUID}&amp;page=3#decided-heading`));
    assert.match(html, /action="\/admin\/credit-requests\/history#decided-heading"/);
    const declined = await ejs.renderFile(view, { ...values, searched: true, fromQueue: true,
        filters: { from: '2026-11-01', to: '2026-11-05', profile: GUID },
        history: { entries: [{ guid: GUID, booking_ref: 'AH-DECLINED', status: 'declined',
            starts_at: '2026-11-01T10:00:00Z', decided_at: '2026-11-02T10:00:00Z',
            reason: 'weather', decline_comment: '<Original reason>' }], total: 1, pageSize: 50 } });
    assert.match(declined, /action="\/admin\/credit-requests\/reopen"/);
    assert.match(declined, />Reopen request<\/button>/);
    assert.match(declined, /&lt;Original reason&gt;/);
    assert.ok(declined.includes(`name="profile" value="${GUID}"`));
    assert.equal((declined.match(/name="from_queue" value="1"/g) || []).length, 2);
    assert.doesNotMatch(declined, /action="\/admin\/credit-requests\/refundability"/);
});
