const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const Credits = require('../models/Credits');
const router = require('../routes/front');
const ejs = require('ejs');
const path = require('node:path');
const Profiles = require('../models/Profiles');
const Settings = require('../models/Settings');
const GUID = '123e4567-e89b-42d3-a456-426614174000';

test('refund history is limited by completion dates and 50-row pagination', async t => {
    const query = t.mock.method(Pool.prototype, 'query', async sql =>
        ({ rows: sql.includes('COUNT(*)') ? [{ count: 51 }] : [{ guid: 'refund' }] }));
    assert.deepEqual(await Credits.searchRefundHistory({ from: '2026-10-01', to: '2026-10-31', page: 2 }),
        { entries: [{ guid: 'refund' }], total: 51, pageSize: 50 });
    for (const call of query.mock.calls) {
        assert.match(call.arguments[0], /r.status <> 'pending'/);
        assert.match(call.arguments[0], /r.decided_at >= \$1::date::timestamp AT TIME ZONE 'Europe\/London'/);
        assert.match(call.arguments[0], /r.decided_at < \(\$2::date \+ 1\)::timestamp AT TIME ZONE 'Europe\/London'/);
    }
    assert.deepEqual(query.mock.calls[0].arguments[1], ['2026-10-01', '2026-10-31', null, 50, 50]);
    await Credits.searchRefundHistory({ from: '2026-10-01', to: '2026-10-31', profileGuid: GUID });
    const filtered = query.mock.calls.slice(-2);
    for (const call of filtered) {
        assert.match(call.arguments[0], /c.profile_guid = \$3/);
        assert.equal(call.arguments[1][2], GUID);
    }
    await Credits.findRefundRequests({ pendingOnly: true });
    assert.match(query.mock.calls.at(-1).arguments[0], /WHERE r.status = 'pending'/);
    const count = query.mock.callCount();
    for (const values of [{}, { from: '2026-01-01', to: '2026-03-04' },
        { from: '2026-11-02', to: '2026-11-01' }, { from: '2026-02-30', to: '2026-03-01' },
        { from: '2026-11-01', to: '2026-11-05', page: 0 }]) {
        await assert.rejects(Credits.searchRefundHistory(values), RangeError);
    }
    assert.equal(query.mock.callCount(), count);
});

test('refund page queries only pending requests until both dates are supplied', async t => {
    t.mock.method(Settings, 'getAll', async () => ({ ...Settings.DEFAULTS }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.find(layer => layer.route?.path === '/credit-refunds').route.stack[0].handle;
    const pending = t.mock.method(Credits, 'findRefundRequests', async () => []);
    const history = t.mock.method(Credits, 'searchRefundHistory', async () => ({ entries: [], total: 0, pageSize: 50 }));
    let data;
    const res = { render(_view, value) { data = value; }, status(code) { this.code = code; return this; }, send() {} };
    await handler({ query: {} }, res);
    assert.equal(history.mock.callCount(), 0);
    assert.deepEqual(pending.mock.calls[0].arguments, [{ pendingOnly: true }]);
    assert.equal(data.searched, false);
    for (const query of [{ from: '2026-11-01' }, { to: '2026-11-02' },
        { from: '2026-01-01', to: '2026-03-04' }, { page: '0' }]) {
        await handler({ query }, res);
        assert.equal(res.code, 400);
    }
    assert.equal(pending.mock.callCount(), 1);
    await handler({ query: { from: '2026-11-01', to: '2026-11-05', page: '2' } }, res);
    assert.deepEqual(history.mock.calls[0].arguments, [{ from: '2026-11-01', to: '2026-11-05', page: 2, profileGuid: null }]);
    t.mock.method(Profiles, 'findByGuid', async () => ({ guid: GUID, name: 'Rita Resident' }));
    await handler({ query: { from: '2026-11-01', to: '2026-11-05', profile: GUID } }, res);
    assert.equal(history.mock.calls.at(-1).arguments[0].profileGuid, GUID);
    assert.equal(data.filters.profile, GUID);
    assert.equal(data.selectedProfile.name, 'Rita Resident');
    const calls = history.mock.callCount();
    for (const profile of ['invalid', [GUID], {}]) {
        await handler({ query: { profile } }, res);
        assert.equal(res.code, 400);
    }
    assert.equal(history.mock.callCount(), calls);
});

test('refund history view starts empty and pagination preserves both dates', async () => {
    const values = {
        currentProfile: null, isAdmin: false, canSwitchRole: false, activePage: 'credit-refunds',
        decision: '', declineError: false, error: false, requests: [], searched: false,
        filters: { from: '', to: '' }, history: { entries: [], total: 0, pageSize: 50 }, page: 1
    };
    const view = path.join(__dirname, '../views/credit-refunds.ejs');
    const initial = await ejs.renderFile(view, values);
    assert.match(initial, /<title>Refund requests \| ActiveHub<\/title>/);
    assert.match(initial, /<h1 class="h2 mb-1">Refund requests<\/h1>/);
    assert.doesNotMatch(initial, /Credit refunds/);
    assert.match(initial, /Select From and To dates to load refund history/);
    assert.match(initial, /class="bg-white border rounded shadow-sm p-4 mb-5" aria-labelledby="pending-refunds"/);
    assert.match(initial, /class="bg-white border rounded shadow-sm p-4 mb-4" aria-labelledby="closed-refunds"/);
    assert.equal((initial.match(/<header class="border-bottom pb-3 mb-4">/g) || []).length, 2);
    assert.match(initial, /0 awaiting action/);
    assert.match(initial, /mark them as done/);
    assert.doesNotMatch(initial, /<table/);
    assert.match(initial, /name="from" type="date" value="" required/);
    assert.match(initial, /name="to" type="date" value="" required/);
    assert.match(initial, /id="refund-profile-search" type="search"/);
    assert.match(initial, /<output class="sr-only" data-refund-profile-status aria-live="polite"/);
    assert.match(initial, /type="hidden" name="profile" value=""/);
    assert.doesNotMatch(initial, /data-refund-all-profiles/);
    assert.match(initial, /if \(!event.target.value.trim\(\)\) finder.reset\(\{ guid: '', name: 'All profiles' \}\)/);
    assert.match(initial, /function attachProfileSearch/);
    const searched = await ejs.renderFile(view, { ...values, searched: true, page: 2,
        filters: { from: '2026-11-01', to: '2026-11-05', profile: GUID },
        selectedProfile: { guid: GUID, name: 'Rita Resident', email: 'rita@example.test' },
        history: { entries: [], total: 101, pageSize: 50 } });
    assert.match(searched, /Page 2 of 3/);
    assert.ok(searched.includes(`from=2026-11-01&amp;to=2026-11-05&amp;profile=${GUID}&amp;page=3#closed-refunds`));
    assert.ok(searched.includes(`type="hidden" name="profile" value="${GUID}"`));
    assert.match(searched, /id="refund-profile-search" type="search" value="Rita Resident"/);
});
