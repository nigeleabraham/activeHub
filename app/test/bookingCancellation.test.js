const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

test('booking cancellations wait for the shared fade, update counts and refresh availability', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/booking-flow-script.ejs'));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));
    const handler = script.slice(script.indexOf("    document.querySelectorAll('form[data-cancel-booking]')"),
        script.indexOf("    document.querySelectorAll('form[method="));
    for (const status of [204, 404, 200, 500]) {
        for (const lastRow of [false, true]) {
            let listener;
            let removed = false;
            let faded = false;
            let refreshed = false;
            let focused = false;
            let alerted = false;
            let busy;
            const button = { disabled: false };
            const count = {};
            const empty = { hidden: true };
            const focusTarget = { focus(options) { assert.equal(options.preventScroll, true); focused = true; } };
            const row = { remove() { assert.equal(faded, true); removed = true; } };
            const sibling = { querySelector() { return focusTarget; } };
            const details = {
                querySelectorAll() { return removed ? (lastRow ? [] : [sibling]) : (lastRow ? [row] : [row, sibling]); },
                querySelector(selector) {
                    if (selector === '[data-booking-count]') return count;
                    if (selector === '[data-bookings-table]') return { remove() {} };
                    if (selector === '[data-no-bookings]') return empty;
                    if (selector === 'summary') return focusTarget;
                    if (selector === '[data-booking-calendar]') return { dispatchEvent() { refreshed = true; } };
                    assert.fail(selector);
                }
            };
            const form = {
                action: '/admin/bookings/cancel',
                addEventListener(_event, callback) { listener = callback; },
                querySelectorAll() { return [button]; },
                getAttribute() { return busy; },
                setAttribute(_key, value) { busy = value; },
                removeAttribute() { busy = undefined; },
                closest(selector) { return selector === 'tr' ? row : details; }
            };
            vm.runInNewContext(handler, {
                document: { querySelectorAll() { return [form]; } },
                URLSearchParams, FormData: class {}, CustomEvent: class {},
                fetch: async () => ({ status }),
                animateDeletion: async target => {
                    assert.equal(target, row);
                    assert.equal(removed, false);
                    assert.equal(button.disabled, true);
                    faded = true;
                },
                console: { error() {} },
                alert() { alerted = true; }
            });
            await listener({ preventDefault() {}, submitter: button });
            const confirmed = status === 204 || status === 404;
            assert.equal(removed, confirmed);
            assert.equal(faded, confirmed);
            assert.equal(refreshed, confirmed);
            assert.equal(focused, confirmed);
            assert.equal(alerted, !confirmed);
            if (confirmed) {
                assert.equal(count.textContent, lastRow ? '0' : '1');
                assert.equal(empty.hidden, !lastRow);
            }
            assert.equal(button.disabled, false);
            assert.equal(busy, undefined);
        }
    }
});
