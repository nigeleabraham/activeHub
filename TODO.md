# ActiveHub todo

- [x] Finish search page.
  - Improve booking search page formatting.
  - Explain date bounding more clearly: To defaults to From plus the configured
    maximum days and can only be shortened, never before From.
  - Make it clearer that both From and To dates are mandatory.

- [x] Improve the settings admin page.
  - Improve the overall UI and organization.
  - Group weather auto-approval with the related refund and credit settings.
  - Reconsider putting every setting inside a dropdown/expander.

- [ ] Design separate course administration.
  - Rework the Courses tab so content is grouped first by sport and then by
    course.
  - Move FAQs out of the top of the page and place them in the relevant sport
    or course section.
  - [x] Add an administrator workflow for finding and reviewing course bookings,
    including gymnastics courses and individual attendees.
  - [x] Let administrators select a course and class/run to see everyone booked,
    including account holders and children.
  - [x] Produce a printable attendee register for each class/run and session.
  - [x] Let administrators cancel individual course bookings, updating availability
    and preserving cancellation and audit history.
  - [x] Define cancellation and account-credit rules for course places.
  - Bank refunds use the existing refundable-credit request workflow; direct
    course-place bank refunds are not implemented.
  - Support refunding eligible gymnastics and other course purchases while
    preserving payment, credit and audit history.
  - Keep course-booking administration distinct from court-booking management.
