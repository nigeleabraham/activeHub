# ActiveHub app - Docker

For current priorities, unfinished work and where to resume, see [the project to-do list](TODO.md).

Copy `.env.example` to `.env` and set a local database password, then start the app:

```sh
cp .env.example .env
docker compose up -d
```

And open http://localhost:3000 in your browser.

## Responsive layout

On the Courses page, **Choose a class** is a collapsed disclosure for each course. Expanding it reveals its class cards; returning from the basket restores its open state and scroll position. Facility cards show a course count and course-title links to the corresponding heading on the Courses page, rather than descriptions, FAQs, class runs or purchase controls. A course-heading anchor automatically opens that course's class disclosure and scrolls to its heading, both on arrival and when the anchor changes.

The basket's **Pay / checkout** action opens the existing Payment page used for court bookings, with course places and attendees in its order summary. Class selection also offers **Checkout** (or **Add to basket and checkout** when the basket already contains items), which adds the selected place before opening Payment for the whole basket. Both flows share the card form and account-credit confirmation layout; course payments retain their own basket revision checks and enrolment transaction. Declined course payments remain on the Payment page, while stale or invalid baskets return to basket review.

Customer page banners place a labelled Basket button with a basket icon and the signed-in customer's item count on the right, including zero for an empty basket. The count refreshes on every page request. Pages without a title banner retain basket access in their header.

Customer and admin pages share a desktop container that expands from 1200px viewports to a maximum of 1600px, with comfortable side margins and aligned header/navigation/content edges. Smaller-screen Bootstrap layouts are unchanged. Course class cards use one column on mobile, two from 992px and three from 1200px. Description and FAQ text is limited to 75 characters per line, and desktop form controls to 48rem, so extra space benefits grids, tables and calendars without excessively stretching text or inputs.

## Admin editing

Admin forms use inline editors, with one editor open at a time. Saved values remain visible in the surrounding cards or setting summaries. Add/edit forms, sport booking months, settings (including logo uploads), and editable credit-review forms share the same workflow.

The Facilities directory has a collapsible **Add facility** card above the directory, matching Add sport. Its form is grouped into Facility details, Activities and Booking arrangements. Coordinates are under Advanced location settings. Booking-method radio buttons show only the relevant controls. Create facility closes the form and shows an add-success banner in the guidance slot; after four seconds it fades and restores the guidance without collapsing space or scrolling to the new card. Cancel uses the same unsaved-change protection as editing.

Add and Edit use the same shared facility form, including field grouping, booking-method radios and optional advanced location settings. Editing preselects the saved values and uses **Save changes**; the separate Delete button remains on each existing directory card.

Course rows keep **Edit** and **Delete** together on the same action row. Editing opens a separate panel below the row, with the course name retained in the accessible button label and unsaved-change prompt.

Course management separates shared course details (name, description and sports) from facility runs. Each course can have multiple runs at multiple facilities, including several runs at the same facility. Each run has its own label, full-course price, maximum spaces and individual session start/end timestamps. Editing the main course updates inherited details everywhere without replacing its runs. Removing a facility deletes only its runs, not the main course. Seed export/import includes runs, sessions, sport assignments and FAQs.

Admin and customer course listings order courses by the youngest age or school year stated in their titles (pre-school, reception, then numbered school years). Titles without an age group follow alphabetically. Runs are ordered Sunday to Saturday, then by UK start time, with facility/name tie-breakers. The earliest scheduled session determines each run's day and time; drafts without sessions use their day/time label, with unlabelled drafts last.

Course descriptions support `<bold>text</bold>` for bold, `<ul>text</ul>` for underline (not a list), and `<bullet>text</bullet>` for each bullet point. These render in the admin course directory and customer Courses and Facilities pages. Tags can be nested; only exact paired tags are interpreted, other HTML is escaped, and line breaks are preserved. FAQ formatting remains unchanged: its `<bold>` tag uses coloured text instead of bold weight.

Both course descriptions and FAQ answers also support `<email>name@example.com</email>` for a clickable email address that opens the user's email application. Email tags must contain only an email address, without nested tags or email subject/body parameters. Invalid or unpaired email tags are displayed as text.

Sports can define ordered default course-description sections in each sport's dedicated **Course defaults** panel on the Sports page, using **Edit course defaults** and **Save course defaults**, separately from sport-name editing. Each section has an optional heading and formatted text, with add, remove and move controls. Courses can select one assigned sport as their source, inherit each section live or override its heading/text independently, and append their own ordered sections. Unique legacy descriptions remain saved and display when no sport source is selected. Changing a default updates inherited sections but not overrides. Removing a default section removes it (and its override) from the course display; appended course sections remain. Section IDs persist through heading edits/reordering and seed export/import.

Customer course and facility session tables show only sessions that have not started yet. Admin listings and editors retain the complete schedule, including past sessions. Full-course session counts and prorated prices always use the complete saved schedule; hiding past dates does not delete them.

The **Course leader** role is created with `courses.manage`, allowing its active users to add, amend and delete any course. Administrators can additionally create, edit and delete sport course FAQs on the Courses page. FAQs belong to a sport, not an individual course or facility, and appear under every matching course on customer-facing facility listings. FAQ actions remain Administrator-only even for course managers. FAQ answers support custom tags on both customer Courses and Facilities pages: `<bold>text</bold>` uses dark blue (#003e90) at normal weight, `<ul>text</ul>` underlines text (it does not create a list), and `<bullet>text</bullet>` creates a bullet point. Formatting may be nested inside bullet items. Only exact, paired custom tags are interpreted; attributes, other HTML, and the previous Markdown markers remain plain text. Line breaks are preserved.

Customers can open Courses from the home page at `/courses`. Each main course appears once, with its shared title and description above its facility runs. On customer Courses and Facilities pages, descriptions start collapsed under “Course description”; expanding them shows unique text or resolved sport-default sections. Class choices are visible under “Choose a class”, with the class count alongside. Compact cards show the regular weekday/time where consistent, run label, location, session length, current price and spaces remaining. Customers choose “Who is attending?” and use the prominent “Add to basket” button showing the price. Sold-out classes show “Sold out” instead of purchase controls. Full-course prices and session tables are collapsed under “Dates and price details”. Sport FAQs appear once per sport outside and above the course cards, as initially collapsed disclosures. Their contents are hidden from screen readers until expanded; sports without FAQs or available courses have no FAQ card. Session lengths are calculated from the displayed schedule on both customer Courses and Facilities pages.

Customers can create and edit multiple children's profiles in **My profile > My children**, then choose themselves or a saved child on each run and select **Add to basket**. The children list displays three columns on wide screens (1200px+), two from 768px, and one on smaller screens, with aligned Edit/Archive actions in each column. Each attendee can have one place per run. The database-backed basket persists per signed-in customer, supports multiple runs/attendees and removal, and offers checkout or a return link to the originating course/facility page. A basket is not a reservation. Checkout revalidates publication, future sessions, prorated prices, attendee ownership, spaces and unexpired account credit. Credit is used first, followed by the same simulated card payment as court bookings; no real money is taken or card details stored. Payment atomically creates enrolments, consumes credit and clears the basket. Concurrent purchases cannot oversell, repeated payment submissions cannot create duplicate orders, and stale quotes must be reviewed again. Confirmations remain accessible through **Basket > Your confirmed course orders**, including snapshots of attendee names and purchased schedules. Archiving a child does not erase existing enrolments. Course orders and baskets are transactional data and are not included in seed exports.

Child profiles contain a name, optional date of birth, address, parental and emergency contact details, the same health questions/conditions as adult profiles, membership number and sport interests. They have no personal email/telephone or login/roles/credit balance: the adult account owns the child and funds bookings. Address, parental contacts (parent name/email/telephone), and emergency contacts each inherit live from the adult profile by default, or use independent child-specific overrides. Inherited values are resolved rather than copied; switching back to inheritance clears the stored override group on save. Health, membership and interests never inherit. Existing `profile_family_members` rows are extended in place, preserving IDs and basket/enrolment references. Children are owner-scoped and soft-archived, with historical enrolment snapshots retained. Creation/editing audit events exclude child names, contact and health values. Child lists and attendee selectors sort by date of birth, youngest first, then alphabetically for ties; children without dates appear last. Future and invalid birth dates are rejected. Adam's test children Nine through Twenty Three use placeholder birthdays of 1 January 2009 through 2023 respectively.

Administrators generate weekly sessions from inclusive dates, weekday and same-day start/end times (up to two years), then edit individual sessions as `YYYY-MM-DD HH:mm HH:mm` lines. They can also enter individual sessions directly. All input/display times are Europe/London; timestamps are stored with time zones, so weekly wall times remain consistent across GMT/BST changes. Nonexistent spring-clock-change times are rejected. Runs require a non-negative price (up to GBP 999999.99), 1–99999 maximum spaces and 1–366 non-overlapping sessions. Saving the session list replaces that run's schedule transactionally.

Current run price = full price in pence × remaining sessions ÷ total sessions, rounded once to the nearest penny. A session stops counting at its start instant, including a session already in progress. Price and visibility are calculated on each request, with no scheduled data deletion. Citizen Courses and Facilities pages list only completed-setup runs with future sessions; administration retains drafts and ended runs. Existing facility assignments migrate once to draft runs, preserving course details and previous dates for reference; supply price, capacity and sessions before they appear to customers. The old facility/date fields remain for migration compatibility, but no longer govern course publication or pricing. Spaces remaining equal configured capacity minus confirmed enrolments. Runs with enrolments cannot be deleted, and their capacity cannot be reduced below the enrolled count. Course cancellations/refunds are not yet supported; court-booking cancellation and refund flows are unchanged.

Course creation, updates and deletion update the affected list and directory count in place without a page reload. A single local live status names the course and completed action. Added and updated rows briefly highlight (without animation when reduced motion is preferred); buttons show Adding, Saving or Deleting while pending and duplicate actions are blocked. Failed actions retain entered values and show an explicit error.

After adding a course, the same facility's Add course form stays open with cleared fields and focus on Course name, ready for another entry. Update and delete keep focus near the affected row. The local confirmation is brought into view only when needed, without focusing the message. Non-enhanced submissions retain redirect-based confirmations.

Add-course confirmations appear in reserved space beside the Add course control above the form, not beside the submit button below Description. Adding does not automatically scroll to the notification.
These add confirmations stay visible for four seconds and fade over half a second without collapsing the reserved space. Each add restarts the timer. Updates use a green row highlight without a visible banner. Successful deletions highlight the row light red and fade it out before removal. Edit/delete completion is announced to screen readers; errors remain visible. Reduced-motion preferences disable the animations.
Sports deletions use the same light-red highlight and fade-out after server confirmation, without reloading the page. The directory count updates, keyboard focus moves to a nearby delete button (or the sport-name field when empty), and errors remain visible. Reduced-motion preferences skip the animation.
Booking cancellations (including cancel-and-credit) use that same red highlight and 800ms fade before removing the booking row. Counts, empty states and calendar availability update in place, with keyboard focus moved to a nearby cancellation button or the Bookings heading. Reduced-motion preferences skip the fade; unsuccessful cancellations retain the row.
Removing an unbooked slot from the selected-slots list also uses the red fade, then updates the selection count and calendar. Selection controls pause during the animation to prevent submitting the slot being removed; focus moves to the next Remove button or the court selector when the list is empty.
Profiles use the same feedback patterns: add confirmations fade back to guidance in a reserved slot, edit confirmations appear beside the saved profile's name without collapsing space, and confirmed deletions highlight red and fade out in place. Counts and keyboard focus update without reloading. Self-deletion and last-administrator protections remain enforced, and rejected deletions leave the profile visible with an error.
Deleting a profile atomically deactivates it, deletes bookings starting in the future (releasing their court reservations), cancels pending booking-credit and bank-refund requests, and voids all remaining credit. Past/in-progress bookings, completed decisions, payment history and the archived profile remain for historical reporting; deleted profiles cannot sign in, appear in profile pickers or receive new bookings or credits. Deletion does not issue a payment refund or restore booking credit. Archived email addresses remain reserved.

Both forms use the full card width. On desktop, Name and Postcode share a row, activities use three or four columns, and opening hours and the booking limit share a row. Address and Description remain full width; controls stack into a single column on mobile.

Changed forms show **Unsaved changes**. Opening another editor, cancelling, following a link, or submitting a different action offers **Save and continue**, **Discard changes**, and **Keep editing**. Saving must succeed before continuing; validation, permission, network and server errors leave the entered values in place with an explicit error. Save and continue still runs the form's normal validation and financial-action confirmation. Cancel/discard resets the form, including dependent controls.
Unsaved forms also show a dark left-hand border, including bordered Sports editors.

Closing or refreshing the tab uses the browser's native unsaved-change warning. There is no autosave or page-wide Save all. Existing booking-calendar transaction controls keep their specialised behaviour; the shared editor guard protects unsaved configuration when those actions are triggered. JavaScript is required for the single-editor workflow; the original server-rendered forms remain available without it.

The unsaved-changes dialog orders actions as **Keep editing**, **Discard changes**, **Save and continue** on desktop. On mobile they stack as **Save and continue**, **Keep editing**, **Discard changes**. Keyboard order follows the displayed order; initial focus and Escape both use **Keep editing**.

Facilities must have at least one activity selected when creating or editing them. Browser and server validation enforce this; when no sports are defined, create a sport before saving a facility.

Successful inline admin saves show a green **Changes saved successfully.** status banner after reloading, including Save and continue to another admin editor or page. The confirmation is consumed so refreshing does not repeat it.
Facility-edit confirmations name the updated facility and appear alongside its card title in a reserved feedback slot. They fade after four seconds without collapsing the slot or moving the page.
Sport-edit confirmations name the updated sport and appear alongside its name in a reserved feedback slot. They fade after four seconds without collapsing the slot or moving the page.
The **Opening hours templates** section uses a collapsible **Add template** card with the existing weekly schedule and daylight controls. Successful creation shows a fading banner in the reserved guidance slot, then restores the guidance without moving the page.
Template Edit and Delete buttons share their own row beneath the template details at every screen size.
Template cards match Facilities title and summary typography, with daylight badges below the schedule. Expanded editors use an unseparated form and full-size Save changes/Cancel controls.

Admin booking tools are split into **Bookings** (`/admin/bookings`) for calendars, making bookings and managing existing bookings, and **Court configuration** (`/admin/court-configuration`) for courts, shared resources and each site's sport booking months. Both remain administrator-only. Existing configuration POST endpoints are retained, but success and error redirects return to Court configuration; booking actions still return to Bookings.
Admin navigation sits at the top of every admin page, above the page heading. A full-width white masthead with black text includes the configured site logo (or site title if no logo is set), an admin-home link and account controls. A black bar beneath it contains four dropdown groups: Home Pages, Facilities management, Bookings management and System Admin. The current group and page are highlighted; dropdowns support keyboard activation, Escape and outside-click dismissal. All four groups stay in a single horizontal row at widths of 992px and above, and switch together to a vertical stack below that width, without mixed rows. Unsaved-change protection still applies to navigation links, including the logo.
Template-update confirmations name the template alongside its title, then fade after four seconds in a reserved slot without moving the card or page.
Successful template deletions highlight the card light red and fade it out before removal, matching Sports. Counts and keyboard focus update without reloading; errors stay visible and reduced-motion preferences skip the animation.
On Sports, guidance about managing sports and assigning them to facilities occupies the add-success banner location when that banner is absent. The add-success banner stays visible for four seconds, fades over half a second, then restores the guidance. Both share a reserved grid slot so the transition does not collapse space or move the page.

The facility's maximum upcoming bookings per resident applies only when the profile's active role is **Resident**. All other active roles are exempt from this limit, including when using the self-service booking page. Other booking rules still apply.

Customer **My profile** and existing child profiles use the same shared inline editor workflow as admin pages: each section has its own Edit/Save changes/Cancel controls, and only one editor is open at a time. Editing replaces the displayed values inside the card instead of expanding a disclosure underneath. The card returns to its natural compact size after saving or cancelling, and opening an editor preserves scroll position without scrolling to the focused field. Saves stay in place, highlight changed values with a fading background rather than a visible confirmation banner, and update only that section, preserving unrelated values (including unanswered legacy health questions). Leaving or switching editors with unsaved changes offers Save and continue, Discard changes, or Keep editing. Related health answers and contact-inheritance groups are saved together. Creating a child still submits one complete record; without JavaScript, the original full-profile forms remain available.

### Multiple roles per profile

The customer home page has one Administration entry point for active roles with management permissions. The admin dashboard and navigation show only allowed areas. All existing permissions gate their matching server-side pages and actions: facilities, courses, sports, opening hours, bookings/court configuration, profiles, roles and audit. Booking managers can search profiles to book on their behalf, but cannot administer profiles without `profiles.manage`. Settings, credit reviews and refunds (including cancel-and-credit) remain Administrator-only. Cross-area course actions require `courses.manage`, even from the Facilities page. Course management applies to courses at every facility.

Every profile is permanently assigned Resident. Profile administration shows Resident checked and disabled, with checkboxes for additional roles. Creation and updates enforce Resident on the server even when it is not submitted; existing profiles gain Resident without losing previous assignments. Assignments are stored in `profile_roles`; `profiles.role` remains a fallback role for sessions and legacy seed imports. New profiles start with Resident as this fallback; login independently selects the highest-privilege assigned role. Updates preserve the fallback when still assigned, otherwise use Resident. Seed exports include role assignments.

Anyone with multiple available roles can use **Active role** in the navigation, including on admin pages. An Administrator assignment automatically makes every existing and future role available for switching, without copying those assignments onto the profile. Other users can switch only to explicitly assigned roles. Every active role inherits Resident's base permissions plus its own configured additions, never additions from other assigned roles. Resident cannot be renamed or deleted, but its base permissions can be edited. Booking limits still follow the active role. Role selection is profile-bound and checked against current database assignments on every request; a selection that is no longer available resets the session to the profile's stored default role. Each login selects Administrator if assigned, otherwise the assigned role with the most permissions beyond Resident's baseline (alphabetical tie-break). Manual switching lasts until the next login or until that selection becomes unavailable. Audit records use the active role at the time of the action.

Resident cannot be removed from a profile. The last active profile assigned Administrator cannot lose that assignment or be deleted, including through concurrent edits. Role member counts include every assignment, and assigned roles cannot be deleted.

## Seed data

### Camden Active course import

Run `node scripts/importCamdenCourses.js` for a read-only preview of advertised gymnastics courses from the official Camden Active website; pass `--apply` to add missing courses and draft facility runs. The import uses factual titles, prices, venues and session dates with original descriptions, not copied website prose. Existing records and subsequent edits are preserved using source-URL markers in settings. Source pages that expose no session details are reported and omitted at run level. Court-hire listings are not imported as taught courses.

Imported runs remain drafts because published pages do not provide maximum capacity or past session dates. The full-course price uses the advertised per-session price times the original session count, not the reduced remaining-session total. Confirm capacity and restore the complete original schedule before publishing; no missing dates or capacities are invented. Source URLs, original counts and advertised prices are retained in import markers for reference.

The database is populated from `app/seed/data.json`, a snapshot of the reference data: sports, opening hours, facilities, bookable courts and options, roles and their responsibilities, profiles, site settings and the site logo. Bookings and the audit log are not included.

The app seeds the database when its container starts. Seeding runs once per database and is then recorded, so later restarts never overwrite edits made in the admin pages.

To add any rows that are missing from an already-seeded database (existing rows are left alone):

```sh
docker compose exec activeHub-app npm run seed -- --force
```

To refresh the snapshot from the current database, export it and copy it back to the repository:

```sh
docker compose exec activeHub-app npm run seed:export
docker cp activeHubApp:/usr/src/app/seed/data.json app/seed/data.json
```

## Daylight opening-hours overrides

Facility coordinates are optional in the add/edit forms. Supply `latitude, longitude` in decimal degrees (for example `51.5074, -0.1278`) for an exact location, or leave blank to resolve the UK postcode through postcodes.io when saving. Only the postcode is sent to that service. The resulting coordinates are stored for maps, distance sorting and dawn/dusk calculations; availability does not depend on a live lookup. Failed or invalid lookups prevent saving with an explicit error and retain the form entries. Existing coordinates take precedence; clear the field to resolve a changed postcode. Postcode locations are approximate.

Under **Admin > Bookings > [site] > Sport booking months**, each sport has January–December checkboxes, all enabled by default. The setting applies to every court for that sport at that site only; other sports and other sites are unaffected. Restrictions recur yearly using Europe/London booking dates, so Tennis and Netball sharing physical resources can have different seasons. Empty selection blocks all new bookings for that sport at that site. Availability hides disallowed slots and checkout/admin creation enforce the rules again transactionally, including every month touched by an interval. Changing months does not cancel existing bookings and is allowed even when courts have upcoming bookings. Month changes are audited.

New courts inherit their sport's booking months at that site. Existing per-court settings are migrated once by taking the union of their allowed months for each site/sport: a month enabled for any court remains enabled for the sport. Sports with no courts default to all months. Restarts preserve subsequent sport-level changes.

Submitting an old court-month form from a previously opened page redirects to the current controls with an explicit instruction to review and save the sport's months. It does not silently apply the old court selection to the whole sport.

When loading or navigating the booking calendar, the selected court is preserved even if its sport is unavailable for the displayed month. The calendar shows an unavailable message rather than automatically switching courts. Users can choose another court or date themselves.

Citizen-facing facility cards include **Book online**: in-app venues open the booking form with that facility selected; external venues retain their external booking link.

Opening-hours templates have separate **Dawn** and **Dusk** switches, both off by default. Dawn means sunrise and dusk means civil dusk (the sun 6 degrees below the horizon), calculated locally with SunCalc using each facility's latitude/longitude and booking date, displayed in Europe/London time.

Effective opening is the later of the weekly opening time and sunrise. Effective closing is the earlier of the weekly closing time and civil dusk plus 20 minutes. Opening rounds up to whole minutes. When civil dusk plus 20 minutes is earlier than the template closing time, closing rounds down to the hour to reflect the last possible booking (for example, 17:34 becomes 17:00). Earlier template closing times are unchanged. Closed weekdays remain closed; if the limits leave no opening interval, that date is closed. These limits apply consistently to availability, facility hours and server-side booking validation, including administrator bookings. Invalid coordinates or unavailable solar events produce an explicit error rather than silently removing the limits. Facilities without templates retain their existing unrestricted behaviour.

## Booking credit and bank refunds

Payment IDs (`payment_reference`) are shown with resident credits and eligible bookings, administrator refund results, credit requests and bank-refund reviews. Credits and cancellation snapshots retain the source payment ID even after the booking is deleted. Existing credits are backfilled from surviving bookings or refund snapshots; unavailable historical IDs are labelled "Not recorded" rather than generated.

The Settings **Site title** section also contains **Organisation name**, defaulting to `Peck'em`. Resident credit guidance uses this name and the configured Credit request period, independently of the site title.

Automatically approved Weather requests show a brief success confirmation after submission, with no permanent automatic-approval label on the resident's credit. Administrator history retains the automatic decision record. Bank refunds still require a separate request and review.

Past bookings on Credits and refunds include only bookings that have not already been credited, within the configured Credit request period. Pending and declined requests remain visible; credited bookings are excluded regardless of whether their credit is still available, spent or expired.

**Admin > Settings > Credit lifetime** controls the lifetime of future credits in whole 24-hour days (1–36500, default 365). Each credit stores its issue time and fixed expiry, so changing the setting never changes existing credits. On the first upgrade, existing credits receive 365 days from upgrade time, regardless of their original issue date; this backfill is not repeated on restart.

Resident credit queries return only unspent, unexpired credits, with their expiry date and remaining days (rounded up). Available totals and checkout pricing exclude expired money, and checkout enforces expiry again transactionally while still spending oldest eligible credits first. Historical ledger rows and allocations are retained for audit; the cached profile ledger total includes expired balances, but displayed/spendable totals are calculated from unexpired ledger entries. No new bank-refund request may be made after expiry. A request submitted before expiry stays reviewable, even after expiry, and appears separately to the resident as a pending bank refund rather than available credit.

**Admin > Settings > Weather credit slot auto-approval** enables the optional slot-approval feature (off by default). When approving a Weather request, administrators can also approve its exact start/end time across **all facilities**. Existing pending Weather requests for that slot are credited in the same transaction; later eligible Weather requests are credited on submission, not before a resident requests them. The card-paid portion of Weather credits is refundable; reissued credits retain their original refund eligibility. Automatic credits inherit the slot's approving administrator. Other requests always require individual review. Ownership, paid-booking, past-booking and rolling-period rules still apply.

The Credit requests page lists all approved slots whose booking end falls within the existing Credit request period; there is no separate day setting. Automatic decisions are labelled in history. Disabling the switch pauses saved slots without deleting them or reversing credit. Re-enabling affects new submissions; requests submitted while disabled remain pending until reviewed. Slot approvals and submissions are serialized to avoid missing concurrent requests or granting credit twice.

Administrators configure the rolling period in **Admin > Settings > Credit request period** (1–365 whole days, default 30). Only past bookings ending within that period qualify for new credit requests. Uncredited bookings with pending requests also remain visible on Credits and refunds after the period ends, until a decision is made; they can still be approved. This is a rolling number of 24-hour days, not calendar months. Changing the period does not remove existing requests from the administrator's review list or hide pending resident requests or credit balances.

**My profile** (`/profile`) contains name and contact editing, including email, optional telephone number, emergency contact name and emergency contact telephone number. Telephone fields accept up to 40 characters (digits, spaces, +, -, parentheses and full stops); emergency contact names accept up to 120 characters. My address provides optional manual address lines 1 and 2 (160 characters each), town/city and county (120 each), and postcode (20). No address lookup or external address sharing is used. My health requires answers to the medical-concern and long-term activity-limitation questions when saving. Answering Yes to a medical concern reveals condition checkboxes (Asthma, Epilepsy, Allergy requiring EpiPen, Other); at least one is required. Other requires an explanation of up to 1,000 characters. Saving No clears previously saved conditions and Other details. The activity-limitation question is independent and always shown. Existing profiles remain unanswered until saved. These details are stored on the signed-in profile and are not exposed by profile search or general profile listings; health answers are not copied into audit messages or sent to external services. Self-service updates cannot change roles or credit. **Credits and refunds** (`/credits-and-refunds`) contains balances, requests and past bookings, with separate home-page links. Older credit-request form URLs remain supported and redirect back to Credits and refunds.

**My membership** accepts an optional free-text membership number (up to 120 characters), saved on the signed-in profile and excluded from general profile listings, searches and audit details. Blank values clear the number. Its label is "[scheme name] membership number"; administrators configure the scheme name under **Settings > Membership scheme** (required, up to 60 characters, default "GLL Better Card"). Renaming the scheme does not alter stored numbers.

**My interests** lists the current system sports alphabetically as optional checkboxes. The full-width card uses three columns at large widths (992px+), two at medium widths (768px+), and one on smaller screens. Selections are saved with the signed-in profile using **Save changes**; clearing every checkbox removes all interests. Sport renames retain selections, and deleted sports are omitted.

Residents may request credit on an eligible paid past booking only when the court could not be used because of **Weather** (tracked as `weather`) or **Other** court problems (tracked as `discretionary`). Only Other requests show a description box, which requires up to 500 characters. Weather requests have no description. Neither reason requires a confirmation tick box. Administrators see the type and description in both pending requests and decision history. Discretionary requests offer **Approve (refundable)**, **Approve (non-refundable)** and **Decline** actions, with a required reason for declines. Non-refundable approval makes the entire award non-refundable, overriding any refundable credit originally used. Refundable approval preserves original credit eligibility and makes only the card-paid portion newly refundable. Existing inclement-weather requests migrate to `weather`. Administrator-issued credits are unchanged by this choice of request reasons.

Each new credit records its source booking reference, original amount, remaining amount and bank-refund eligibility. Credit spending snapshots each source credit's refund eligibility. When a booking is credited again, original refundable credit stays refundable unless a discretionary request is explicitly approved as non-refundable; original non-refundable credit always stays non-refundable. Weather awards (including automatic approvals) make only the card-paid portion newly refundable. Direct administrator credits default the card-paid portion to non-refundable, with an explicit checkbox to allow a bank refund; these direct awards preserve original credit eligibility. Mixed awards are split into separate refundable and non-refundable ledger entries, with the combined balance equal to the booking payment.

Bookings management, credit-request review and refund search display the original card/refundable-credit/non-refundable-credit funding breakdown. Legacy spending allocations are backfilled from their source credit records; amounts without traceable funding are visibly flagged and treated as non-refundable, never as card payments. Existing issued credits and completed bank refunds are not retrospectively rewritten. External refunds remain limited to the card-paid portion.

Credits and refunds shows the total and individual credits. Checkout spends credits oldest first, including credit with a pending bank-refund request. A pending request always covers only the remaining amount; spending it in full closes the request automatically.

Administrators review requests in **Admin > Credit refunds**. Accepting deducts the remaining amount immediately and records the exact amount to transfer. The actual bank transfer happens outside ActiveHub; no bank details are collected here. Declining leaves the credit available for bookings. Each credit can have one bank-refund request.

Declining either a booking credit request or a bank-refund request requires a comment of 1 to 500 characters. The comment is saved with the decision, included in the audit trail and shown to the requestor on Credits and refunds and in administrator decision history. Older declines without comments are labelled accordingly.

On first startup after this change, existing balances migrate as non-refundable credits. Historical booking credit records supply booking references where available. Since older spending was not itemized, remaining balances are allocated to the newest historical credits (equivalent to spending the oldest first). Any balance that cannot be matched to a surviving booking record is explicitly labelled as an opening balance. The migration preserves totals and only runs once. Credit history and refund requests are operational data and are not included in reference-data exports.

Profile credit balances are also excluded from reference-data imports and exports so a fresh database cannot acquire balances without their ledger entries.

Run the standard tests with `cd app && npm test`. To run the PostgreSQL credit integration tests as well, supply `CREDIT_TEST_DATABASE_URL` pointing to a **fresh, disposable database whose name ends in `_test`**:

```sh
cd app
CREDIT_TEST_DATABASE_URL=postgres://localhost/activehub_credit_test npm test
```

## Refunda refund-testing account

Create the optional dummy resident and test bookings explicitly (never run automatically):

```sh
docker compose exec activeHub-app npm run seed:refunda
```

Sign in as **Refunda** (`refunda@example.test`) using the simulated login. Initial data includes:

- £45 total booking credit: £20 refundable and ready to request, £10 non-refundable, and £15 refundable with a bank-refund request pending review.
- Two paid past bookings eligible for new weather-credit requests.
- A third paid past booking with a weather-credit request already pending.
- A paid upcoming booking to test cancellation and crediting.

All seven bookings use the dedicated **Refunda Test Centre**, with references `AH-REFUNDA-01` through `AH-REFUNDA-07`. Dates are relative to setup time; weather-credit eligibility lasts one month. Payments are dummy data, not real charges. Re-running the command preserves existing data and test progress; it does not reset balances or recreate requests.
