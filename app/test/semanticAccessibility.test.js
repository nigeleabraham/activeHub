const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const views = path.join(__dirname, '../views');
const read = file => fs.readFileSync(path.join(views, file), 'utf8');

test('feedback uses native outputs without redundant status roles', () => {
    for (const file of fs.readdirSync(views, { recursive: true }).filter(file => file.endsWith('.ejs'))) {
        assert.doesNotMatch(read(file), /role="status"|setAttribute\('role', 'status'\)/, file);
    }
    const styles = read('partials/accessibility-styles.ejs');
    assert.match(styles, /output \{ display: block; margin-bottom: 1rem; \}/);
    assert.match(styles, /output\[hidden\] \{ display: none; \}/);
    assert.match(styles, /output\.output-inline \{ display: inline; margin-bottom: 0; \}/);
    assert.match(read('partials/sport-faq-form.ejs'), /<output[^>]*data-faq-feedback[^>]*aria-live="polite" hidden><\/output>/);
    assert.match(read('partials/booking-messages.ejs'), /<output[^>]*data-booking-toast>/);
    assert.doesNotMatch(read('partials/booking-messages.ejs').split('<% } else if (created) { %>')[1], /<div|<p\b/);
});

test('control groups, cookie region and opening-hours rows use native semantics', () => {
    for (const file of ['partials/booking-flow.ejs', 'resident-bookings.ejs']) {
        assert.match(read(file), /<fieldset[^>]*data-calendar-slots[^>]*aria-label="Booking times"><\/fieldset>/);
        assert.doesNotMatch(read(file), /role="group"/);
    }
    assert.match(read('partials/card-order-controls.ejs'), /<fieldset[^>]*>\s*<legend class="sr-only">Order:/);
    assert.match(read('partials/cookie-banner.ejs'), /<section id="cookie-banner"[^>]*aria-label=/);
    assert.match(read('resident-facilities.ejs'), /<th scope="row"/);
    assert.match(read('partials/course-form.ejs'), /<label[^>]*for="<%= cardId %>-override-mode"/);
    assert.match(read('partials/course-form.ejs'), /<input id="<%= cardId %>-override-mode"/);
});

test('remote icon styles are integrity checked and delete labels include the visible name', () => {
    assert.match(read('facilities.ejs'), /font-awesome\.min\.css"\s+integrity="sha384-[^"]+" crossorigin="anonymous"/);
    assert.match(read('sports.ejs'), /aria-label="Delete sport: <%= sport.name %>">Delete sport<\/button>/);
    assert.match(read('resident-checkout.ejs'), /id="card-cvc"[^>]*type="password"[^>]*autocomplete="off"/);
    assert.match(read('resident-profile.ejs'), /id="emergency-contact-telephone"[^>]*autocomplete="off"/);
});
