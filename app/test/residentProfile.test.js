const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

test('customer profile has six independently editable cards and a no-script save form', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-profile.ejs'), {
        siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident', role: 'Resident' },
        isAdmin: false, canSwitchRole: false, saved: false, error: '', sports: [],
        profile: { name: 'A & B', email: 'resident@example.com' }
    });
    const headings = [...html.matchAll(/<h2 id="my-[^"]*"[^>]*>([^<]+)<\/h2>/g)].map(match => match[1]);
    assert.deepEqual(headings, ['My name', 'My contact details', 'My address', 'My health', 'My membership', 'My interests']);
    assert.match(html, /id="my-children-heading">My children/);
    assert.match(html, /href="\/profile\/children\/new">Add child/);
    assert.equal((html.match(/Not yet available\./g) || []).length, 0);
    assert.match(html, /GLL Better Card membership number/);
    assert.match(html, /name="membership_number" type="text" maxlength="120"/);
    assert.ok(html.includes('No sports are available yet.'));
    assert.match(html, /<form method="POST" action="\/profile" data-profile-sections>/);
    assert.equal((html.match(/data-profile-section="/g) || []).length, 6);
    assert.match(html, /form\.setAttribute\('data-profile-editor', ''\)/);
    assert.match(html, /Save and continue/);
    assert.match(html, /Discard changes/);
    assert.match(html, /name="name"[^>]*required[^>]*value="A &amp; B"/);
    assert.match(html, /name="email"[^>]*required[^>]*value="resident@example.com"/);
    assert.equal((html.match(/type="submit">Save changes/g) || []).length, 1);
    assert.equal((html.match(/class="col-12 mb-4"/g) || []).length, 6);
    assert.match(html, /<div class="site-bar">/);
    assert.match(html, /<header class="page-head">/);
    assert.match(html, /href="\/">&larr; Back to home/);
    assert.match(html, /action="\/logout"/);
    for (const field of ['telephone', 'emergency_contact_name', 'emergency_contact_telephone',
        'address_line_1', 'address_line_2', 'town_city', 'county', 'postcode']) {
        assert.ok(html.includes(`name="${field}"`));
    }
});

test('child archive reuses deletion animation and confirms removal before animating', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-profile.ejs'), {
        siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident', role: 'Resident' },
        isAdmin: false, canSwitchRole: false, saved: false, error: '', sports: [],
        profile: { name: 'Resident', email: 'resident@example.com' },
        familyMembers: [{ guid: 'child-guid', name: 'Child' }]
    });
    assert.match(html, /action="\/profile\/family-members\/remove" data-child-archive/);
    assert.match(html, /data-child-archive-error hidden/);
    assert.match(html, /async function animateDeletion\(row\)/);
    assert.match(html, /prefers-reduced-motion: reduce/);
    assert.match(html, /destination\.searchParams\.get\('family_saved'\) !== '1'/);
    assert.match(html, /input\.value === guid/);
    assert.ok(html.indexOf('await animateDeletion(row)') < html.indexOf('row.remove()'));
    assert.match(html, /status\.textContent = 'Child archived\.'/);
    assert.match(html, /error\.hidden = false/);
    assert.match(html, /grid-column: span 3/);
    assert.match(html, /\.children-list > li \{[^}]*border: 1px solid #6c757d; padding: 0\.75rem;/);
    assert.match(html, /@media \(min-width: 768px\)[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\) max-content max-content\)/);
    assert.match(html, /@media \(min-width: 1200px\)[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\) max-content max-content\)/);
});

test('customer contact updates validate fields and use the signed-in profile only', async t => {
    const Profiles = require('../models/Profiles');
    const AuditLog = require('../models/AuditLog');
    const router = require('../routes/front');
    t.mock.method(Profiles, 'findByGuid', async () => ({ name: 'Resident', email: 'resident@example.com' }));
    t.mock.method(AuditLog, 'record', async () => {});
    const update = t.mock.method(Profiles, 'updateDetails', async () => ({ guid: 'own-profile', name: 'Resident' }));
    const handler = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.post).route.stack[0].handle;
    const body = { name: 'Resident', email: 'resident@example.com', telephone: ' +44 (0)20 1234-5678 ',
        emergency_contact_name: ' Contact Person ', emergency_contact_telephone: ' 07700 900123 ', guid: 'someone-else', role: 'Administrator',
        address_line_1: ' 1 Test Street ', address_line_2: ' Flat 2 ', town_city: ' London ', county: '', postcode: ' NW1 1AA ',
        medical_concern: 'no', activity_limitation: 'no' };
    let location;
    const res = { redirect(value) { location = value; } };
    await handler({ profile: { guid: 'own-profile', name: 'Resident', role: 'Resident' }, body }, res);
    assert.equal(location, '/profile?saved=1');
    assert.deepEqual(update.mock.calls[0].arguments, ['own-profile', { name: 'Resident', email: 'resident@example.com',
        telephone: '+44 (0)20 1234-5678', emergency_contact_name: 'Contact Person', emergency_contact_telephone: '07700 900123',
        address_line_1: '1 Test Street', address_line_2: 'Flat 2', town_city: 'London', county: null, postcode: 'NW1 1AA',
        medical_concern: false, medical_conditions: [], medical_other: null, activity_limitation: 'no', interest_sport_guids: [],
        membership_number: null }]);
    for (const invalid of [{ telephone: ['123'] }, { telephone: 'abc' }, { telephone: '+' },
        { emergency_contact_name: 'x'.repeat(121) }, { emergency_contact_telephone: '1'.repeat(41) },
        { address_line_1: ['Address'] }, { address_line_2: 'x'.repeat(161) },
        { town_city: 'x'.repeat(121) }, { county: 'x'.repeat(121) }, { postcode: 'x'.repeat(21) },
        { membership_number: ['123'] }, { membership_number: 'x'.repeat(121) }]) {
        await handler({ profile: { guid: 'own-profile' }, body: { ...body, ...invalid } }, res);
        assert.equal(location, '/profile?error=invalid');
    }
    assert.equal(update.mock.callCount(), 1);
    await handler({ profile: { guid: 'own-profile' }, body: { ...body, telephone: '', emergency_contact_name: '', emergency_contact_telephone: '',
        address_line_1: '', address_line_2: '', town_city: '', county: '', postcode: '' } }, res);
    assert.equal(update.mock.calls.at(-1).arguments[1].telephone, null);
    for (const field of ['address_line_1', 'address_line_2', 'town_city', 'county', 'postcode']) {
        assert.equal(update.mock.calls.at(-1).arguments[1][field], null);
    }
});

test('profile section saves validate and update only the selected section', async t => {
    const Profiles = require('../models/Profiles');
    const AuditLog = require('../models/AuditLog');
    const Sports = require('../models/Sports');
    const router = require('../routes/front');
    t.mock.method(Profiles, 'findByGuid', async () => ({ guid: 'owner', name: 'Resident', email: 'resident@example.com' }));
    const update = t.mock.method(Profiles, 'updateDetails', async () => ({ guid: 'owner', name: 'Resident', email: 'resident@example.com' }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(Sports, 'findAll', async () => []);
    const handler = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.post).route.stack[0].handle;
    let status, result;
    const res = { status(code) { status = code; return this; }, json(value) { result = value; } };
    const req = body => ({ profile: { guid: 'owner' }, body });
    await handler(req({ section: 'membership', membership_number: '  CARD-1  ', name: 'Injected', medical_concern: 'invalid' }), res);
    assert.deepEqual(result, { saved: true, values: { membership_number: 'CARD-1' } });
    assert.equal(update.mock.calls[0].arguments[0], 'owner');
    assert.equal(update.mock.calls[0].arguments[2], 'membership');
    assert.equal(update.mock.calls[0].arguments[1].name, 'Profile');
    assert.deepEqual(audit.mock.calls[0].arguments[1].details, { section: 'membership', self_service: true });
    await handler(req({ section: 'interests' }), res);
    assert.deepEqual(result.values, { interest_sport_guids: [] });
    for (const body of [{ section: 'unknown' }, { section: ['name'] }, { section: 'name', name: '' },
        { section: 'contact', email: 'invalid' }, { section: 'health', medical_concern: 'yes', activity_limitation: 'no' }]) {
        await handler(req(body), res);
        assert.equal(status, 422);
        assert.ok(result.error);
    }
    assert.equal(update.mock.callCount(), 2);
});

test('membership scheme setting validates, saves and supplies the profile field label', async t => {
    t.mock.method(require('../models/CourseOrders'), 'familyMembers', async () => []);
    const Settings = require('../models/Settings');
    const Profiles = require('../models/Profiles');
    const Sports = require('../models/Sports');
    const AuditLog = require('../models/AuditLog');
    const router = require('../routes/front');
    const settings = { ...Settings.DEFAULTS };
    t.mock.method(Settings, 'getAll', async () => settings);
    t.mock.method(Settings, 'getLogo', async () => null);
    const set = t.mock.method(Settings, 'set', async (key, value) => { settings[key] = value; });
    t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(Sports, 'findAll', async () => []);
    t.mock.method(Profiles, 'findByGuid', async () => ({ name: 'Resident', email: 'resident@example.com',
        membership_number: 'ABC <123>' }));
    const update = t.mock.method(Profiles, 'updateDetails', async () => ({ guid: 'own-profile', name: 'Resident' }));
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const saveScheme = admin.stack.find(layer => layer.route?.path === '/settings/membership-scheme').route.stack[0].handle;
    let location;
    const res = { redirect(value) { location = value; } };
    for (const value of [undefined, '', '   ', ['Scheme'], 'x'.repeat(61)]) {
        await saveScheme({ body: { membership_scheme: value } }, res);
        assert.equal(location, '/admin/settings?error=membership');
    }
    assert.equal(set.mock.callCount(), 0);
    await saveScheme({ profile: {}, body: { membership_scheme: '  Community &  Leisure ' } }, res);
    assert.equal(location, '/admin/settings?saved=1');
    assert.deepEqual(set.mock.calls[0].arguments, ['membership_scheme', 'Community & Leisure']);
    const get = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.get).route.stack[0].handle;
    let locals;
    await get({ profile: { guid: 'own-profile' }, query: {} }, { render(view, values) { locals = values; } });
    assert.equal(locals.membershipScheme, 'Community & Leisure');
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-profile.ejs'), {
        ...locals, currentProfile: { name: 'Resident', role: 'Resident' }, isAdmin: false, canSwitchRole: false
    });
    assert.match(html, /Community &amp; Leisure membership number/);
    assert.match(html, /value="ABC &lt;123&gt;"/);
    const post = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.post).route.stack[0].handle;
    for (const [value, expected] of [['  ABC 123-X ', 'ABC 123-X'], ['', null]]) {
        await post({ profile: { guid: 'own-profile' }, body: {
            name: 'Resident', email: 'resident@example.com', medical_concern: 'no',
            activity_limitation: 'no', membership_number: value
        } }, res);
        assert.equal(location, '/profile?saved=1');
        assert.equal(update.mock.calls.at(-1).arguments[1].membership_number, expected);
    }
});

test('health answers validate conditional details, clear stale data and stay out of audit messages', async t => {
    const Profiles = require('../models/Profiles');
    const AuditLog = require('../models/AuditLog');
    const router = require('../routes/front');
    t.mock.method(Profiles, 'findByGuid', async () => ({ name: 'Resident', email: 'resident@example.com' }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    const update = t.mock.method(Profiles, 'updateDetails', async () => ({ guid: 'own-profile', name: 'Resident' }));
    const handler = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.post).route.stack[0].handle;
    const body = { name: 'Resident', email: 'resident@example.com', medical_concern: 'yes',
        medical_conditions: ['asthma', 'epilepsy', 'epipen', 'other'], medical_other: ' A concern ',
        activity_limitation: 'limited_a_little' };
    let location;
    const res = { redirect(value) { location = value; } };
    const submit = changes => handler({ profile: { guid: 'own-profile', name: 'Resident' }, body: { ...body, ...changes } }, res);
    for (const invalid of [
        { medical_concern: undefined }, { medical_concern: ['yes'] }, { medical_concern: 'maybe' },
        { activity_limitation: undefined }, { activity_limitation: ['no'] }, { activity_limitation: 'unknown' },
        { medical_conditions: undefined }, { medical_conditions: [] }, { medical_conditions: ['unknown'] },
        { medical_conditions: [['asthma']] }, { medical_conditions: {} },
        { medical_other: undefined }, { medical_other: ['text'] }, { medical_other: '   ' },
        { medical_other: 'x'.repeat(1001) }
    ]) {
        await submit(invalid);
        assert.equal(location, '/profile?error=invalid');
    }
    assert.equal(update.mock.callCount(), 0);
    await submit({});
    assert.equal(location, '/profile?saved=1');
    assert.deepEqual(update.mock.calls.at(-1).arguments[1].medical_conditions, body.medical_conditions);
    assert.equal(update.mock.calls.at(-1).arguments[1].medical_other, 'A concern');
    assert.equal(update.mock.calls.at(-1).arguments[1].activity_limitation, 'limited_a_little');
    await submit({ medical_conditions: 'asthma', medical_other: 'stale' });
    assert.deepEqual(update.mock.calls.at(-1).arguments[1].medical_conditions, ['asthma']);
    assert.equal(update.mock.calls.at(-1).arguments[1].medical_other, null);
    await submit({ medical_concern: 'no', activity_limitation: 'limited_a_lot' });
    assert.equal(update.mock.calls.at(-1).arguments[1].medical_concern, false);
    assert.deepEqual(update.mock.calls.at(-1).arguments[1].medical_conditions, []);
    assert.equal(update.mock.calls.at(-1).arguments[1].medical_other, null);
    assert.equal(update.mock.calls.at(-1).arguments[1].activity_limitation, 'limited_a_lot');
    for (const call of audit.mock.calls) {
        assert.deepEqual(call.arguments[1].details, {
            from: { name: 'Resident', email: 'resident@example.com' },
            to: { name: 'Resident', email: 'resident@example.com' }, self_service: true
        });
    }
});

    test('sport interests validate current sports, save selections and allow clearing all', async t => {
        const Profiles = require('../models/Profiles');
        const Sports = require('../models/Sports');
        const AuditLog = require('../models/AuditLog');
        const router = require('../routes/front');
        const sport = { guid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Tennis & more' };
        const second = { guid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Netball' };
        t.mock.method(Sports, 'findAll', async () => [sport, second]);
        t.mock.method(Profiles, 'findByGuid', async () => ({ name: 'Resident', email: 'resident@example.com' }));
        t.mock.method(AuditLog, 'record', async () => {});
        const update = t.mock.method(Profiles, 'updateDetails', async () => ({ guid: 'own-profile', name: 'Resident' }));
        const handler = router.stack.find(layer => layer.route?.path === '/profile' && layer.route.methods.post).route.stack[0].handle;
        let location;
        const submit = interests => handler({ profile: { guid: 'own-profile' }, body: {
            name: 'Resident', email: 'resident@example.com', medical_concern: 'no', activity_limitation: 'no',
            interest_sport_guids: interests
        } }, { redirect(value) { location = value; } });
        for (const invalid of ['invalid', {}, [sport.guid, {}], ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']]) {
            await submit(invalid);
            assert.equal(location, '/profile?error=invalid');
        }
        assert.equal(update.mock.callCount(), 0);
        for (const [submitted, expected] of [
            [sport.guid, [sport.guid]],
            [[sport.guid.toUpperCase(), second.guid, sport.guid], [sport.guid, second.guid]],
            [undefined, []]
        ]) {
            await submit(submitted);
            assert.equal(location, '/profile?saved=1');
            assert.deepEqual(update.mock.calls.at(-1).arguments[1].interest_sport_guids, expected);
        }
        const html = await ejs.renderFile(path.join(__dirname, '../views/resident-profile.ejs'), {
            siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident', role: 'Resident' },
            isAdmin: false, canSwitchRole: false, saved: false, error: '', sports: [sport, second],
            profile: { name: 'Resident', email: 'resident@example.com', interest_sport_guids: [sport.guid] }
        });
        assert.match(html, /Tennis &amp; more/);
        assert.match(html, new RegExp(`name="interest_sport_guids" value="${sport.guid}" checked`));
        assert.match(html, new RegExp(`name="interest_sport_guids" value="${second.guid}" >`));
        assert.equal((html.match(/class="col-12 col-md-6 col-lg-4 mb-2"/g) || []).length, 2);
    });
test('health form reloads saved answers and toggles conditional controls accessibly', async () => {
    const vm = require('node:vm');
    const html = await ejs.renderFile(path.join(__dirname, '../views/resident-profile.ejs'), {
        siteTitle: 'ActiveHub', hasLogo: false, currentProfile: { name: 'Resident', role: 'Resident' },
        isAdmin: false, canSwitchRole: false, saved: false, error: '', sports: [],
        profile: { name: 'Resident', email: 'resident@example.com', medical_concern: true,
            medical_conditions: ['asthma', 'other'], medical_other: '<script>private</script>', activity_limitation: 'limited_a_lot' }
    });
    assert.match(html, /id="medical-concern-yes"[^>]*required checked/);
    assert.match(html, /id="medical-condition-asthma"[^>]*checked/);
    assert.match(html, /id="medical-condition-other"[^>]*checked/);
    assert.match(html, /id="activity-limitation-limited_a_lot"[^>]*required checked/);
    assert.ok(html.includes('&lt;script&gt;private&lt;/script&gt;'));
    const listeners = [];
    const input = checked => ({ checked, addEventListener(event, callback) { listeners.push(callback); },
        setCustomValidity(message) { this.validationMessage = message; } });
    const yes = input(true);
    const no = input(false);
    const checkboxes = [input(true), input(false), input(false), input(true)];
    const conditions = { querySelectorAll: () => checkboxes, closest: () => ({ addEventListener() {} }) };
    const otherDetails = {};
    const otherInput = { value: 'Saved medical concern' };
    const elements = { 'medical-concern-yes': yes, 'medical-condition-other': checkboxes[3],
        'medical-conditions': conditions, 'medical-other-details': otherDetails, 'medical-other': otherInput };
    vm.runInNewContext([...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].at(-1)[1], {
        document: { querySelectorAll: () => [yes, no], getElementById: id => elements[id] }
    });
    assert.equal(conditions.hidden, false);
    assert.equal(conditions.disabled, false);
    assert.equal(checkboxes[0].checked, true);
    assert.equal(checkboxes[3].checked, true);
    assert.equal(otherInput.value, 'Saved medical concern');
    assert.equal(otherInput.required, true);
    yes.checked = false;
    listeners[1]();
    assert.equal(conditions.hidden, true);
    assert.ok(checkboxes.every(checkbox => !checkbox.checked));
    assert.equal(otherInput.value, '');
    assert.equal(otherInput.required, false);
    // A change in either direction clears selections, even if hidden controls were modified.
    checkboxes[1].checked = true;
    otherInput.value = 'Unsaved concern';
    yes.checked = true;
    listeners[0]();
    assert.ok(checkboxes.every(checkbox => !checkbox.checked));
    assert.equal(otherInput.value, '');
    assert.equal(conditions.hidden, false);
    assert.equal(conditions.disabled, false);
    assert.ok(checkboxes[0].validationMessage);
    checkboxes[3].checked = true;
    listeners[5]();
    assert.equal(checkboxes[0].validationMessage, '');
    assert.equal(otherDetails.hidden, false);
    assert.equal(otherInput.disabled, false);
    assert.equal(otherInput.required, true);
    yes.checked = false;
    listeners[1]();
    assert.ok(checkboxes.every(checkbox => !checkbox.checked));
    assert.equal(conditions.hidden, true);
    assert.equal(checkboxes[0].validationMessage, '');
    assert.equal(otherInput.disabled, true);
    assert.equal(otherInput.required, false);
});
