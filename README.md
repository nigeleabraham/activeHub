# Multi Containers App

This is a repo for new users getting started with Docker.

Copy `.env.example` to `.env` and set a local database password, then start the app:

```sh
cp .env.example .env
docker compose up -d
```

And open http://localhost:3000 in your browser.

## Camden facility import

The app imports or updates Camden facilities each time its container starts. Imported entries are matched by source URL, so startup imports do not create duplicates. If the source site is unavailable, the app still starts and the importer error is logged.

To preview source data without database writes:

```sh
docker compose exec activeHub-app npm run import:camden -- --dry-run
```

Import or update the facilities with complete address and location data:

```sh
docker compose exec activeHub-app npm run import:camden
```

The importer skips incomplete records and is safe to rerun; it matches imported facilities by source URL.