# ActiveHub app - Docker

Copy `.env.example` to `.env` and set a local database password, then start the app:

```sh
cp .env.example .env
docker compose up -d
```

And open http://localhost:3000 in your browser.

## Seed data

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

**Admin > Settings > Weather credit slot auto-approval** enables the optional slot-approval feature (off by default). When approving a Weather request, administrators can also approve its exact start/end time across **all facilities**. Existing pending Weather requests for that slot are credited in the same transaction; later eligible Weather requests are credited on submission, not before a resident requests them. Weather credits are always refundable and inherit the slot's approving administrator. Other requests always require individual review. Ownership, paid-booking, past-booking and rolling-period rules still apply.

The Credit requests page lists all approved slots whose booking end falls within the existing Credit request period; there is no separate day setting. Automatic decisions are labelled in history. Disabling the switch pauses saved slots without deleting them or reversing credit. Re-enabling affects new submissions; requests submitted while disabled remain pending until reviewed. Slot approvals and submissions are serialized to avoid missing concurrent requests or granting credit twice.

Administrators configure the rolling period in **Admin > Settings > Credit request period** (1–365 whole days, default 30). Only past bookings ending within that period appear on Credits and refunds and qualify for new credit requests. This is a rolling number of 24-hour days, not calendar months. Changing the period does not remove existing requests from the administrator's review list or hide the resident's credit balances.

**My profile** (`/profile`) contains name and email editing. **Credits and refunds** (`/credits-and-refunds`) contains balances, requests and past bookings, with separate home-page links. Older credit-request form URLs remain supported and redirect back to Credits and refunds.

Residents may request credit on an eligible paid past booking only when the court could not be used because of **Weather** (tracked as `weather`) or **Other** court problems (tracked as `discretionary`). Only Other requests show a description box, which requires up to 500 characters. Weather requests have no description. Neither reason requires a confirmation tick box. Administrators see the type and description in both pending requests and decision history. Existing inclement-weather requests migrate to `weather`. Administrator-issued credits are unchanged by this choice of request reasons.

Each new credit records its source booking reference, original amount, remaining amount and whether an administrator allows a bank refund. Weather request credits are always refundable, including automatically approved requests. Other request credits are non-refundable by default, but administrators can allow a bank refund when approving them. Only Weather requests offer slot auto-approval. Administrators still choose refundability when directly adding credit or cancelling with credit; the default is non-refundable.

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
