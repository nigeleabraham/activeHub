const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const ejs = require('ejs');
const path = require('node:path');
const Sports = require('../models/Sports');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');
const { adminPermissions } = require('../permissions');
const { readFile } = require('node:fs/promises');

const guid = '123e4567-e89b-42d3-a456-426614174000';
const id = '123e4567-e89b-42d3-a456-426614174001';
const otherId = '123e4567-e89b-42d3-a456-426614174002';
const original = [{ id, heading: 'Age', text: 'Original' }, { id: otherId, heading: 'Refunds', text: 'Unchanged' }];

test('creating sport defaults and FAQs commits together and rolls back FAQ failures', async t => {
    for (const failing of [false, true]) {
        const queries = [];
        const connection = t.mock.method(Pool.prototype, 'connect', async () => ({
            async query(sql, values) {
                queries.push({ sql, values });
                if (sql.startsWith('INSERT INTO sports')) return { rows: [{ guid }] };
                if (failing && sql.startsWith('INSERT INTO sport_course_faqs')) throw new Error('FAQ failure');
                return { rows: [] };
            },
            release() { queries.push({ sql: 'release' }); }
        }));
        if (failing) await assert.rejects(Sports.create('New sport', original, ' FAQs '), /FAQ failure/);
        else assert.equal((await Sports.create('New sport', original, ' FAQs ')).guid, guid);
        assert.equal(queries[0].sql, 'BEGIN');
        assert.deepEqual(queries.find(query => query.sql.startsWith('INSERT INTO sport_course_faqs')).values, [guid, 'FAQs']);
        assert.equal(queries.at(-2).sql, failing ? 'ROLLBACK' : 'COMMIT');
        assert.equal(queries.at(-1).sql, 'release');
        connection.mock.restore();
    }
});

test('sport creation accepts formatted defaults and restricts FAQ creation to Administrators', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/sports' && layer.route.methods.post).route.stack[0].handle;
    const save = t.mock.method(Sports, 'create', async () => ({ guid }));
    let status;
    let location;
    const response = { sendStatus(value) { status = value; }, redirect(value) { location = value; } };
    await handler({ profile: { role: 'Administrator' }, body: { name: ' New sport ',
        course_description: '<bold>Details</bold>', faq_text: '<bold>Question</bold>\nAnswer' } }, response);
    assert.equal(location, '/admin/sports');
    const args = save.mock.calls[0].arguments;
    assert.equal(args[0], 'New sport');
    assert.equal(args[1][0].text, '<bold>Details</bold>');
    assert.equal(args[1][0].heading, '');
    assert.equal(args[2], '<bold>Question</bold>\nAnswer');
    await handler({ profile: { role: 'Sports manager' }, body: { name: 'Sport', faq_text: 'Not allowed' } }, response);
    assert.equal(status, 403);
    await handler({ profile: { role: 'Administrator' }, body: { name: 'Sport', course_description: 'x'.repeat(1020001) } }, response);
    assert.equal(status, 400);
    assert.equal(save.mock.callCount(), 1);
    await handler({ profile: { role: 'Sports manager' }, body: { name: 'Sport', course_description: 'Default' } }, response);
    assert.equal(save.mock.callCount(), 2);
});

test('saving one sport description preserves legacy customized courses atomically', async t => {
    const queries = [];
    const custom = { guid: otherId, description_sport_guid: guid,
        description_overrides: { [id]: { heading: 'Age', text: 'Custom' } },
        description_sections: [{ id: guid, heading: '', text: 'Extra' }] };
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, values) {
            queries.push({ sql, values });
            if (sql.startsWith('SELECT course_description_sections')) return { rows: [{ course_description_sections: original }] };
            if (sql.startsWith('SELECT guid')) return { rows: [custom] };
            return { rows: [] };
        },
        release() { queries.push({ sql: 'release' }); }
    }));
    await Sports.updateCourseDescription(guid, '<bold>One block</bold>\nDescription');
    const savedCourse = queries.find(query => query.sql.startsWith('UPDATE courses'));
    assert.equal(savedCourse.values[1], '<bold>Age</bold>\nCustom\n\n<bold>Refunds</bold>\nUnchanged\n\nExtra');
    assert.match(savedCourse.sql, /description_sport_guid=NULL/);
    const savedSport = queries.find(query => query.sql.startsWith('UPDATE sports'));
    assert.deepEqual(JSON.parse(savedSport.values[1]), [{ id, heading: '', text: '<bold>One block</bold>\nDescription' }]);
    assert.ok(queries.indexOf(savedCourse) < queries.indexOf(savedSport));
    assert.deepEqual(queries.slice(-2).map(query => query.sql), ['COMMIT', 'release']);
});

test('single sport description route accepts plain formatted text and rejects invalid size', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const handler = admin.stack.findLast(layer => layer.route?.path === '/sports/course-defaults').route.stack[0].handle;
    const save = t.mock.method(Sports, 'updateCourseDescription', async () => ({ guid }));
    let location;
    await handler({ body: { guid, course_description: '<bold>Description</bold>' } },
        { redirect(value) { location = value; } });
    assert.equal(save.mock.calls[0].arguments[1], '<bold>Description</bold>');
    assert.match(location, /admin_saved=sport-updated/);
    t.mock.method(console, 'warn', () => {});
    let status;
    await handler({ body: { guid, course_description: 'x'.repeat(1020001) } },
        { sendStatus(value) { status = value; } });
    assert.equal(status, 400);
    assert.equal(save.mock.callCount(), 1);
});

test('single sport description conversion rolls back if preserving a course fails', async t => {
    const queries = [];
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql) {
            queries.push(sql);
            if (sql.startsWith('SELECT course_description_sections')) return { rows: [{ course_description_sections: original }] };
            if (sql.startsWith('SELECT guid')) return { rows: [{ guid: otherId, description_sport_guid: guid,
                description_overrides: {}, description_sections: [{ id, heading: '', text: 'Keep me' }] }] };
            if (sql.startsWith('UPDATE courses')) throw new Error('Preservation failed');
            return { rows: [] };
        },
        release() { queries.push('release'); }
    }));
    await assert.rejects(Sports.updateCourseDescription(guid, 'New default'), /Preservation failed/);
    assert.equal(queries.some(sql => sql.startsWith('UPDATE sports')), false);
    assert.deepEqual(queries.slice(-2), ['ROLLBACK', 'release']);
});

test('individual section changes lock the current sport and preserve other sections and IDs', async t => {
    let stored = structuredClone(original);
    const queries = [];
    let released = 0;
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql, values) {
            queries.push(sql);
            if (sql.startsWith('SELECT')) return { rows: [{ course_description_sections: structuredClone(stored) }] };
            if (sql.startsWith('UPDATE')) stored = JSON.parse(values[1]);
            return { rows: [] };
        },
        release() { released++; }
    }));
    await Sports.changeCourseSection(guid, 'update', { id, heading: 'New age', text: 'Changed' });
    assert.deepEqual(stored, [{ id, heading: 'New age', text: 'Changed' }, original[1]]);
    await Sports.changeCourseSection(guid, 'create', { id: guid, heading: '', text: 'Added' });
    assert.equal(stored.length, 3);
    await Sports.changeCourseSection(guid, 'move', { id: guid, direction: 'up' });
    assert.deepEqual(stored.map(section => section.id), [id, guid, otherId]);
    await Sports.changeCourseSection(guid, 'destroy', { id: guid });
    assert.deepEqual(stored.map(section => section.id), [id, otherId]);
    assert.equal(await Sports.changeCourseSection(guid, 'update', { id: guid, heading: '', text: 'Gone' }), null);
    assert.equal(released, 5);
    assert.equal(queries.filter(sql => sql.endsWith('FOR UPDATE')).length, 5);
    assert.equal(queries.filter(sql => sql === 'COMMIT').length, 4);
    assert.equal(queries.at(-1), 'ROLLBACK');
    await assert.rejects(Sports.changeCourseSection(guid, 'create', original[0]), RangeError);
    assert.equal(queries.at(-1), 'ROLLBACK');
});

test('section limits, missing sports and database errors roll back and release the connection', async t => {
    let rows = [];
    let fail = false;
    let released = 0;
    const queries = [];
    t.mock.method(Pool.prototype, 'connect', async () => ({
        async query(sql) {
            queries.push(sql);
            if (sql.startsWith('SELECT')) return { rows: structuredClone(rows) };
            if (fail && sql.startsWith('UPDATE')) throw new Error('Database failed');
            return { rows: [] };
        },
        release() { released++; }
    }));
    assert.equal(await Sports.changeCourseSection(guid, 'create', original[0]), null);
    rows = [{ course_description_sections: Array.from({ length: 50 }, (_, index) => ({
        id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`, heading: '', text: 'Existing'
    })) }];
    await assert.rejects(Sports.changeCourseSection(guid, 'create', { id, heading: '', text: 'Too many' }), RangeError);
    rows = [{ course_description_sections: original }];
    fail = true;
    await assert.rejects(Sports.changeCourseSection(guid, 'destroy', { id }), /Database failed/);
    assert.equal(released, 3);
    assert.equal(queries.filter(sql => sql === 'ROLLBACK').length, 3);
});

test('section routes validate input, audit successes and report failed writes explicitly', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const change = t.mock.method(Sports, 'changeCourseSection', async () => ({ guid }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    for (const operation of ['create', 'update', 'destroy', 'move']) {
        const route = `/sports/course-sections/${operation}`;
        assert.deepEqual(adminPermissions(route), ['sports.manage']);
        const handler = admin.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
        const body = { guid, section_id: id, heading: 'Age', text: 'Changed', direction: 'up' };
        let status;
        let location;
        const res = { sendStatus(value) { status = value; }, redirect(value) { location = value; } };
        await handler({ body, profile: { guid } }, res);
        assert.match(location, /#course-defaults-/);
        const section = change.mock.calls.at(-1).arguments[2];
        assert.equal(operation === 'create' ? section.id !== id : section.id === id, true);
        if (operation === 'create') {
            assert.match(location, /admin_saved=section-created/);
            assert.ok(location.includes(`section_created=${section.id}`));
        } else assert.doesNotMatch(location, /section_created=/);
        for (const invalid of [{ guid: 'bad' }, ...(operation === 'move' ? [{ direction: 'sideways' }] : []),
            ...(['create', 'update'].includes(operation) ? [{ text: '' }, { heading: 'x'.repeat(161) }] : [])]) {
            await handler({ body: { ...body, ...invalid } }, res);
            assert.equal(status, 400);
        }
        change.mock.mockImplementation(async () => null);
        await handler({ body }, res);
        assert.equal(status, 404);
        change.mock.mockImplementation(async () => { throw new Error('Database failed'); });
        await handler({ body }, res);
        assert.equal(status, 500);
        change.mock.mockImplementation(async () => ({ guid }));
    }
    assert.equal(audit.mock.callCount(), 4);
});

test('section actions are inside each disclosure with separate forms and list-level reordering', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/sport-course-sections.ejs'), {
        sport: { guid, course_description_sections: original }
    });

    test('section deletion confirms the server result before animating and refreshing the section list', async () => {
        const script = await readFile(path.join(__dirname, '../views/partials/admin-editors.ejs'), 'utf8');
        const refresh = script.slice(script.indexOf('    async function refreshSections('), script.indexOf('    async function refreshDirectory('));
        assert.ok(refresh.indexOf('throw new Error') < refresh.indexOf('await animateDeletion(row)'));
        assert.ok(refresh.indexOf('await animateDeletion(row)') < refresh.indexOf('panel.replaceChildren'));
        assert.match(refresh, /initializeEditors\(\)/);
        assert.match(refresh, /Section removed successfully/);
        assert.match(script, /await refreshSections\(form, response, type\)/);
        assert.match(script, /entry\.form\.querySelector\('button\[type="submit"\]:not\(\[form\]\)'\)/);
    });
    const panels = [...html.matchAll(/<details[\s\S]*?<\/details>/g)].map(match => match[0]);
    assert.equal(panels.length, 3);
    for (const panel of panels.slice(1)) {
        assert.match(panel, /course-sections\/update/);
        assert.match(panel, />Save section<\/button>/);
        assert.match(panel, /data-cancel-edit>Cancel/);
        assert.match(panel, /course-sections\/destroy/);
        assert.match(panel, />Remove section<\/button>/);
        assert.match(panel, /data-cancel-edit>Cancel<\/button>\s*<button[^>]*form="remove-section-[^"]+"[^>]*>Remove section<\/button>\s*<button[^>]*>Save section<\/button>/);
        assert.doesNotMatch(panel.match(/<summary[\s\S]*?<\/summary>/)[0], /<button/);
    }
    assert.match(panels[0], /course-sections\/create/);
    assert.doesNotMatch(html, />Reorder sections<|course-sections\/move/);
    assert.match(html, /data-card-order-list="\/admin\/sports\/course-sections\/order"/);
    assert.equal((html.match(/data-card-drag /g) || []).length, 2);
    assert.equal((html.match(/data-card-move="up"/g) || []).length, 2);
    assert.equal((html.match(/data-card-move="down"/g) || []).length, 2);
    assert.match(html, /<h5 class="h6 border-top pt-4 mt-4 mb-3">Existing sections<\/h5>/);
    assert.ok(html.indexOf('>Add section</h5>') < html.indexOf('>Existing sections<'));
    assert.ok(html.indexOf('>Existing sections<') < html.indexOf('data-course-section-card='));
    assert.equal((html.match(/<form/g) || []).length, (html.match(/<\/form>/g) || []).length);
    assert.equal((html.match(/aria-label="Remove section:/g) || []).length, 2);
    assert.equal((html.match(/title="Remove section"/g) || []).length, 2);
});
