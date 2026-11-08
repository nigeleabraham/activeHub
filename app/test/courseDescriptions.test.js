const test = require('node:test');
const assert = require('node:assert/strict');
const { sections, descriptionConfig, resolveDescription, combineSections, courseDescriptionText, hasCustomDescription } = require('../courseDescriptions');
const ejs = require('ejs');
const path = require('node:path');
const id = '123e4567-e89b-42d3-a456-426614174000';
const extraId = '123e4567-e89b-42d3-a456-426614174001';

test('single descriptions combine legacy headings, overrides and extras without losing text', () => {
    const defaults = [{ id, heading: 'Age', text: 'Default' }, { id: extraId, heading: '', text: 'Terms' }];
    assert.equal(combineSections(defaults), '<bold>Age</bold>\nDefault\n\nTerms');
    const inherited = { description_sport_guid: id };
    assert.equal(hasCustomDescription(inherited), false);
    assert.equal(courseDescriptionText(inherited, defaults), combineSections(defaults));
    const customized = { ...inherited, description_overrides: { [id]: { heading: 'Custom age', text: 'Custom' } },
        description_sections: [{ id: extraId, heading: 'Extra', text: 'More' }] };
    assert.equal(hasCustomDescription(customized), true);
    assert.equal(courseDescriptionText(customized, defaults), '<bold>Custom age</bold>\nCustom\n\nTerms\n\n<bold>Extra</bold>\nMore');
    assert.equal(courseDescriptionText({ description: 'Own', description_sections: [{ heading: '', text: 'Extra' }] }),
        'Own\n\nExtra');
});

test('one-block descriptions can retain the maximum legacy default and additional section content', () => {
    const defaults = Array.from({ length: 50 }, (_, index) => ({
        id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
        heading: 'h'.repeat(160), text: 'x'.repeat(10000)
    }));
    const text = courseDescriptionText({ description_sport_guid: id, description_sections: defaults }, defaults);
    assert.ok(text.length > 1000000);
    assert.equal(sections([{ id, heading: '', text }])[0].text, text);
    assert.throws(() => sections([{ id, heading: '', text: 'x'.repeat(1020001) }]), /Invalid/);
});

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
