const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { orderedItems } = require('../courseDescriptions');
const Sports = require('../models/Sports');
const Courses = require('../models/Courses');
const AuditLog = require('../models/AuditLog');
const router = require('../routes/front');
const vm = require('node:vm');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const guid = '123e4567-e89b-42d3-a456-426614174000';
const second = '123e4567-e89b-42d3-a456-426614174001';
const third = '123e4567-e89b-42d3-a456-426614174002';

test('drag preview contains only the picked heading and cleans up on cancellation and drop', async () => {
    const source = await readFile(path.join(__dirname, '../views/partials/card-order-behaviour.ejs'), 'utf8');
    const listeners = {};
    const classes = new Set();
    const row = {
        dataset: { orderId: guid },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        querySelector() { return { textContent: 'Only this heading' }; },
        getBoundingClientRect() { return { width: 900 }; }
    };
    const handle = { closest() { return row; } };
    let preview;
    let image;
    const document = {
        addEventListener(name, callback) { listeners[name] = callback; },
        createElement() {
            return { style: {}, setAttribute() {}, remove() { this.removed = true; } };
        },
        body: { append(node) { preview = node; } },
        querySelectorAll() { return []; }
    };
    vm.runInNewContext(source, { document, saving: false });
    for (const endEvent of ['dragend', 'drop']) {
        listeners.dragstart({
            target: { closest() { return handle; } },
            dataTransfer: {
                setData(type, value) { assert.equal(value, guid); },
                setDragImage(node) { image = node; }
            }
        });
        assert.equal(image, preview);
        assert.notEqual(image, row);
        assert.equal(preview.textContent, 'Only this heading');
        assert.equal(preview.style.width, '480px');
        assert.equal(classes.has('card-being-dragged'), true);
        listeners[endEvent]({ target: { closest() { return null; } } });
        assert.equal(preview.removed, true);
        assert.equal(classes.has('card-being-dragged'), false);
    }
});

test('complete card ordering preserves objects and rejects missing, duplicate and foreign IDs', () => {
    const items = [{ id: guid, text: 'First' }, { id: second, text: 'Second' }];
    assert.deepEqual(orderedItems(items, [second, guid]), [items[1], items[0]]);
    for (const order of [null, {}, [guid], [guid, guid], [guid, third], [guid, second, third]]) {
        assert.throws(() => orderedItems(items, order), RangeError);
    }
    assert.deepEqual(orderedItems([], []), []);
});

test('section and FAQ drag ordering persist all IDs under locks and reject stale lists without writes', async t => {
    for (const type of ['sections', 'faqs']) {
        const writes = [];
        const sqls = [];
        const items = [{ id: guid, guid, heading: 'First', text: 'First text' },
            { id: second, guid: second, heading: 'Second', text: 'Second text' }];
        const connect = t.mock.method(Pool.prototype, 'connect', async () => ({
            async query(sql, params) {
                sqls.push(sql);
                if (sql.startsWith('SELECT') && sql.includes('FROM sports')) {
                    return { rows: [{ guid, course_description_sections: structuredClone(items) }] };
                }
                if (sql.startsWith('SELECT')) return { rows: structuredClone(items) };
                if (sql.startsWith('UPDATE')) writes.push(params);
                return { rows: [] };
            },
            release() {}
        }));
        const reorder = order => type === 'sections'
            ? Sports.changeCourseSection(guid, 'order', { order }) : Courses.reorderFaqs(guid, order);
        await reorder([second, guid]);
        if (type === 'sections') assert.deepEqual(JSON.parse(writes[0][1]).map(item => item.id), [second, guid]);
        else assert.deepEqual(writes, [[second, 0], [guid, 1]]);
        assert.ok(sqls.some(sql => sql.endsWith('FOR UPDATE')));
        const count = writes.length;
        await assert.rejects(reorder([guid, third]), RangeError);
        assert.equal(writes.length, count);
        assert.equal(sqls.at(-1), 'ROLLBACK');
        connect.mock.restore();
    }
});

test('card order routes confirm exact saved order and explicitly report invalid, stale and failed writes', async t => {
    const admin = router.stack.find(layer => layer.handle.stack).handle;
    const section = t.mock.method(Sports, 'changeCourseSection', async () => ({ guid }));
    const faq = t.mock.method(Courses, 'reorderFaqs', async () => ({ guid }));
    const audit = t.mock.method(AuditLog, 'record', async () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    for (const [path, mock] of [['/sports/course-sections/order', section], ['/courses/faqs/order', faq]]) {
        const handler = admin.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
        let status;
        let data;
        const res = { status(value) { status = value; return this; }, json(value) { data = value; } };
        const body = { sport_guid: guid, order: JSON.stringify([second, guid]) };
        await handler({ body, profile: { guid } }, res);
        assert.deepEqual(data, { saved: true, order: [second, guid] });
        for (const invalid of [{ order: '{' }, { order: '{}' }, { order: JSON.stringify([guid, guid]) },
            { order: JSON.stringify(['bad']) }, { sport_guid: 'bad' }]) {
            await handler({ body: { ...body, ...invalid } }, res);
            assert.equal(status, 400);
        }
        assert.equal(mock.mock.callCount(), 1);
        for (const [result, expected] of [[null, 404], [new RangeError('List changed'), 409], [new Error('Offline'), 500]]) {
            mock.mock.mockImplementation(async () => { if (result instanceof Error) throw result; return result; });
            await handler({ body, profile: { guid } }, res);
            assert.equal(status, expected);
            assert.equal(typeof data.error, 'string');
            assert.equal(data.saved, undefined);
        }
    }
    assert.equal(audit.mock.callCount(), 2);
});
