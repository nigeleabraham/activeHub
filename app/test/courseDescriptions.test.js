const test = require('node:test');
const assert = require('node:assert/strict');
const { sections, descriptionConfig, resolveDescription } = require('../courseDescriptions');
const ejs = require('ejs');
const path = require('node:path');
const id = '123e4567-e89b-42d3-a456-426614174000';
const extraId = '123e4567-e89b-42d3-a456-426614174001';

test('description sections inherit live defaults, override independently and append after defaults', () => {
    const defaults = [{ id, heading: 'Age', text: 'Default age' }, { id: extraId, heading: 'Refunds', text: 'Default refunds' }];
    const config = descriptionConfig(id, { [id]: { heading: 'My age', text: 'Unique age' } },
        [{ id: '123e4567-e89b-42d3-a456-426614174002', heading: 'Extra', text: 'More information' }], [id, extraId]);
    assert.deepEqual(resolveDescription(config, defaults).map(s => s.text), ['Unique age', 'Default refunds', 'More information']);
    defaults[1].text = 'Changed refund policy';
    assert.deepEqual(resolveDescription(config, defaults).map(s => s.text), ['Unique age', 'Changed refund policy', 'More information']);
    assert.throws(() => descriptionConfig(id, {}, [], [extraId]), /assigned sport/);
    assert.throws(() => sections([{ id, heading: '', text: '' }]), /Invalid/);
    assert.throws(() => sections([{ id, heading: '', text: 'x' }, { id, heading: '', text: 'y' }]), /Invalid/);
    assert.throws(() => sections([{ id: 'invalid', heading: '', text: 'x' }]), /Invalid/);
});

test('course description display escapes section headings and formats section bodies safely', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/course-description.ejs'), {
        course: { description: 'Original hidden', description_sport_guid: id,
            resolved_sections: [{ heading: '<script>heading</script>', text: '<bold>Important</bold><email>a@example.com</email>' }] }
    });
    assert.doesNotMatch(html, /Original hidden|<script>/);
    assert.match(html, /&lt;script&gt;heading&lt;\/script&gt;/);
    assert.match(html, /<strong>Important<\/strong>/);
    assert.match(html, /href="mailto:a%40example.com"/);
    assert.doesNotMatch(html, /<details/);
});

test('customer descriptions collapse both unique text and inherited sections without empty disclosures', async () => {
    const filename = path.join(__dirname, '../views/partials/course-description.ejs');
    for (const course of [
        { description: 'Unique description' },
        { description_sport_guid: id, resolved_sections: [{ heading: 'Age', text: 'Inherited description' }] }
    ]) {
        const html = await ejs.renderFile(filename, { course, collapsible: true });
        assert.match(html, /<details class="mb-3" data-course-description>/);
        assert.match(html, /<summary>Course description<\/summary>/);
        assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
        assert.match(html, /<\/details>/);
    }
    const empty = await ejs.renderFile(filename, { course: { description: '', resolved_sections: [] }, collapsible: true });
    assert.doesNotMatch(empty, /<details|<summary/);
});
