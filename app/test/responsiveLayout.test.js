const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shared desktop containers widen consistently while preserving readable content and mobile breakpoints', () => {
    const styles = fs.readFileSync(path.join(__dirname, '../views/partials/accessibility-styles.ejs'), 'utf8');
    assert.match(styles, /@media \(min-width: 1200px\)\s*\{\s*\.container\s*\{\s*width: calc\(100% - 4rem\);\s*max-width: 1600px;/);
    assert.match(styles, /main \.form-control,\s*main \.custom-select\s*\{\s*max-width: 48rem;/);
    assert.match(styles, /\.readable-content,\s*main dd\s*\{\s*max-width: 75ch;/);
    const courses = fs.readFileSync(path.join(__dirname, '../views/resident-courses.ejs'), 'utf8');
    assert.match(courses, /col-12 col-lg-6 col-xl-4/);
});

test('customer course titles match FAQs while inner disclosures are smaller and FAQ cards are white', () => {
    const courses = fs.readFileSync(path.join(__dirname, '../views/resident-courses.ejs'), 'utf8');
    assert.match(courses, /<h3 class="h5 mb-3"/);
    assert.match(courses, /<summary class="h5 mb-0"><%= group.name %> FAQs/);
    assert.match(courses, /\.sport-faqs \{[^}]*background: #fff;[^}]*border: 1px solid #b1b4b6;/);
    assert.match(courses, /\[data-course-description\] > summary,\s*\[data-course-runs\] > summary \{ font-size: 1rem;/);
    assert.match(courses, /<summary class="h6">Choose a class/);
});
