const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

for (const selector of ['.customer-navigation-group', '.admin-navigation-group']) {
    test(`${selector} dismisses on click away, another menu and Escape`, async () => {
        const html = await ejs.renderFile(path.join(__dirname, '../views/partials/navigation-behaviour.ejs'), {
            groupSelector: selector
        });
        const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
        const listeners = {};
        let focused = false;
        const groups = Array.from({ length: 2 }, () => {
            const group = {
                open: false, listeners: {},
                contains(target) { return target === group || target.group === group; },
                addEventListener(type, handler) { this.listeners[type] = handler; },
                querySelector(name) { assert.equal(name, 'summary'); return { focus() { focused = true; } }; }
            };
            return group;
        });
        vm.runInNewContext(script, { document: {
            querySelectorAll(value) { assert.equal(value, selector); return groups; },
            addEventListener(type, handler) { listeners[type] = handler; }
        } });
        const [first, second] = groups;
        first.open = true;
        listeners.click({ target: { group: first } });
        assert.equal(first.open, true, 'Clicks inside the open menu do not close it');
        listeners.click({ target: {} });
        assert.equal(first.open, false, 'Clicks outside close the menu');
        first.open = true;
        second.open = true;
        second.listeners.toggle();
        assert.equal(first.open, false, 'Opening another group closes the first');
        assert.equal(second.open, true);
        let prevented = false;
        listeners.keydown({ key: 'Escape', target: { group: second }, preventDefault() { prevented = true; } });
        assert.equal(second.open, false);
        assert.equal(focused, true, 'Escape restores focus to the summary');
        assert.equal(prevented, true);
        listeners.keydown({ key: 'Escape', target: {}, preventDefault: assert.fail });
    });
}
