const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

test('completed bank refunds fade before removal, update the queue and preserve focus and position', async () => {
    const script = await ejs.renderFile(path.join(__dirname, '../views/partials/refund-queue-behaviour.ejs'));
    for (const scenario of ['next', 'previous', 'last', 'unconfirmed', 'login', 'failed']) {
        let listener;
        let removed = false;
        let animated = false;
        let tableRemoved = false;
        let focused = '';
        let busy = false;
        let scroll = 500;
        const banner = { hidden: true };
        const empty = { hidden: true };
        const error = { hidden: true, textContent: '' };
        const classes = new Map();
        const count = { classList: { toggle(name, value) { classes.set(name, value); } } };
        const currentButton = { disabled: false };
        const siblingButton = {
            disabled: false,
            focus(options) { assert.equal(this.disabled, false); assert.equal(options.preventScroll, true); focused = 'sibling'; }
        };
        const heading = { focus(options) { assert.equal(options.preventScroll, true); focused = 'heading'; } };
        const row = {
            getBoundingClientRect() { return { top: banner.hidden ? 250 : 310 }; },
            remove() { assert.equal(animated, true); removed = true; }
        };
        const sibling = { querySelector: () => siblingButton };
        const rows = () => {
            if (scenario === 'last') return removed ? [] : [row];
            if (removed) return [sibling];
            return scenario === 'previous' ? [sibling, row] : [row, sibling];
        };
        const form = {
            action: '/admin/credit-refunds/decide',
            addEventListener(_event, fn) { listener = fn; },
            querySelector: () => error, closest: () => row,
            setAttribute() { busy = true; }, removeAttribute() { busy = false; }
        };
        const document = {
            querySelectorAll(selector) {
                if (selector === '[data-refund-decision]') return [form];
                if (selector === '[data-refund-decision] button') return [currentButton, siblingButton];
                if (selector === '[data-refund-row]') return rows();
                assert.fail(selector);
            },
            querySelector(selector) {
                if (selector === '[data-refund-success]') return banner;
                if (selector === '[data-refund-count]') return count;
                if (selector === '[data-no-refunds]') return empty;
                if (selector === '[data-refund-table]') return { remove() { tableRemoved = true; } };
                assert.fail(selector);
            },
            getElementById: () => heading
        };
        const window = {
            get scrollY() { return scroll; }, scrollX: 0,
            scrollBy(_x, y) { scroll += y; },
            scrollTo(_x, y) { scroll = y; }
        };
        vm.runInNewContext(script, {
            document, window, URL, URLSearchParams, FormData: class {},
            location: { origin: 'http://localhost', href: 'http://localhost/admin/credit-refunds' },
            fetch: async (_url, options) => {
                assert.equal(options.method, 'POST');
                assert.equal(currentButton.disabled, true);
                if (scenario === 'failed') throw new Error('network failure');
                return {
                    ok: true,
                    url: scenario === 'login' ? 'http://localhost/login'
                        : `http://localhost/admin/credit-refunds?${scenario === 'unconfirmed' ? 'error=1' : 'decision=approved'}`
                };
            },
            animateDeletion: async target => {
                assert.equal(target, row);
                assert.equal(banner.hidden, false);
                assert.equal(removed, false);
                animated = true;
            },
            console: { error() {} }
        });
        await listener({ preventDefault() {}, submitter: currentButton });
        const confirmed = ['next', 'previous', 'last'].includes(scenario);
        assert.equal(removed, confirmed, scenario);
        assert.equal(animated, confirmed, scenario);
        assert.equal(error.hidden, confirmed, scenario);
        assert.equal(currentButton.disabled, false);
        assert.equal(busy, false);
        if (confirmed) {
            assert.equal(focused, scenario === 'last' ? 'heading' : 'sibling');
            assert.equal(scroll, 560);
            assert.equal(count.textContent, scenario === 'last' ? '0 awaiting action' : '1 awaiting action');
            assert.equal(tableRemoved, scenario === 'last');
            assert.equal(empty.hidden, scenario !== 'last');
            assert.equal(classes.get('badge-warning'), scenario !== 'last');
        } else {
            assert.match(error.textContent, /check bank refund history/i);
            assert.equal(banner.hidden, true);
            assert.equal(scroll, 500);
        }
    }
});

test('cancelled confirmation never submits or removes a refund', async () => {
    const script = await ejs.renderFile(path.join(__dirname, '../views/partials/refund-queue-behaviour.ejs'));
    let listener;
    vm.runInNewContext(script, {
        document: { querySelectorAll: () => [{ addEventListener(_event, fn) { listener = fn; } }] },
        fetch: assert.fail
    });
    await listener({ defaultPrevented: true, preventDefault: assert.fail });
});
