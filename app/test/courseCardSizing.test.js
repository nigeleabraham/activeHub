const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

test('visible class summaries resize to the tallest after loading, toggling and resizing', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/course-card-sizing.ejs'));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    let height;
    let frame;
    let toggle;
    let resize;
    let mutation;
    let visible = true;
    let tall = 160;
    const summaries = [
        { getClientRects: () => [1], getBoundingClientRect: () => ({ height: 110 }) },
        { getClientRects: () => visible ? [1] : [], getBoundingClientRect: () => ({ height: tall }) }
    ];
    const style = {
        removeProperty(name) { assert.equal(name, '--course-run-summary-height'); height = undefined; },
        setProperty(name, value) { assert.equal(name, '--course-run-summary-height'); height = value; }
    };
    vm.runInNewContext(script, {
        document: {
            documentElement: { style },
            querySelectorAll: () => summaries,
            querySelector: () => ({}),
            addEventListener(_type, listener) { toggle = listener; }
        },
        window: {
            addEventListener(_type, listener) { resize = listener; },
            setTimeout(callback) { frame = callback; }
        },
        MutationObserver: class {
            constructor(callback) { mutation = callback; }
            observe() {}
        }
    });
    frame();
    assert.equal(height, '160px');
    visible = false;
    toggle();
    frame();
    assert.equal(height, '110px');
    visible = true;
    tall = 225;
    resize();
    frame();
    assert.equal(height, '225px');
    tall = 180;
    mutation();
    frame();
    assert.equal(height, '180px');
});
