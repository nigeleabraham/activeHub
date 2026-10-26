# ActiveHub work in progress

Last updated: 26 October 2026.

## Where we left off

We were improving the customer course purchase journey and preparing support
for parents managing several children's records.

The current implementation has a persistent course basket, attendee selection,
account-credit use, simulated card checkout and confirmed course enrolments.
Parents can now create, edit and archive multiple child profiles under My
children. Each child has independent health, membership and interests, plus
live inherited address/parental/emergency contacts with separate overrides.

Recent UI changes made class choices and purchase buttons visible, kept course
descriptions and date/price details collapsible, and widened desktop layouts.
These changes were deployed to the local Docker app at http://localhost:3000.

Use `git status` to check for any local changes before continuing work.

## Suggested next focus

Review the new child profile workflow and the basket with several children.
Child profiles now have an optional date of birth and sort youngest first.
Consider age eligibility rules next.

## Basket and checkout

- [ ] Review and refine the basket layout and purchase journey.
- [x] Show the basket item count while browsing, alongside the basket icon in the banner.
- [ ] Verify booking the same class for several different children.
- [ ] Make each basket item's course, class, attendee, dates and price clear.
      Course/class, attendee and price are displayed; session dates need review.
- [ ] Verify adding/removing items, returning to browsing and payment confirmation.
      Initial automated and browser checks exist; extend coverage as the journey evolves.
- [ ] Replace simulated payments with a real payment provider when ready.

Already implemented:

- Database-backed basket per signed-in customer, supporting multiple places.
- Add/remove items and return to the originating course/facility page.
- Restoration of expanded sections and scroll position on return.
- Attendee selection for the customer or saved family members.
- Prorated pricing and account credit applied before simulated card payment.
- Atomic enrolment/credit updates, availability checks and overselling prevention.
- Duplicate-payment protection and saved order confirmations.
- Spaces remaining based on confirmed enrolments.

Card payments are simulated: no real money is taken. Course cancellations and
refunds are not yet supported.

## Children's records

- [x] Let a parent create and manage several children under their account.
- [x] Provide a dedicated children's list in My profile.
- [x] Add a child-record creation form.
- [x] Add editing for existing children's records.
- [x] Use shared section-by-section Edit/Save/Cancel controls for adult and existing child profiles, with inline feedback and unsaved-change protection.
- [x] Show children in a bordered, responsive three/two/one-column list with aligned actions and the shared archive fade animation.
- [x] Match adult profile fields, with parental rather than personal contact details.
- [x] Inherit live address, parental contacts and emergency contacts with independent overrides.
- [x] Add optional child date of birth and youngest-first ordering in lists and attendee selectors.
- [ ] Decide course age eligibility rules.
- [x] Ensure parents can access and edit only their own children's records.
- [x] Allow archiving a child without losing historical course enrolments.
- [x] Use saved children in course attendee selectors.
- [x] Preserve duplicate-enrolment prevention for the same child and run.
- [x] Automated tests for multiple children, editing, inheritance, archiving and checkout.
- [ ] Review end-to-end usability with a real multiple-child family.

Existing family-member IDs were preserved when extending their records; old
basket and enrolment references continue to work. Children have no login
accounts or separate credit balances.

## Relevant implementation

- [Course basket and enrolment model](app/models/CourseOrders.js)
- [Basket and family-member routes](app/routes/courseBasket.js)
- [Child profile model](app/models/Children.js)
- [Child profile routes](app/routes/children.js)
- [Child editor](app/views/resident-child.ejs)
- [Customer profile](app/views/resident-profile.ejs)
- [Customer course page](app/views/resident-courses.ejs)
- [Class details and purchase controls](app/views/partials/course-run-details.ejs)
- [Basket page](app/views/resident-basket.ejs)
- [Basket tests](app/test/courseBasket.test.js)
- [PostgreSQL integration tests](app/test/credits.integration.test.js)

## Resuming work

Read this file and inspect the current working tree before making changes.
Keep this list updated as work is completed or priorities change.
