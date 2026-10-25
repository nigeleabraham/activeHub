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
