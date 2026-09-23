# ALFA Strategy 3.2 — Admin + Licenses + Central Strategy

## Render
Create a Node Web Service from the `server` folder/repository.

Build: `npm install`
Start: `npm start`

Required environment variables:
- `ADMIN_USER` — admin username
- `ADMIN_PASSWORD` — strong admin password
- `SESSION_SECRET` — long random secret (32+ chars)
- `MONGODB_URI` — MongoDB Atlas connection string
- `MONGODB_DB` — optional, defaults to `alfa_strategy`
- `REQUIRE_LICENSE` — `true` to require a valid license on `/api/calculate-signal`

Admin panel: `/admin` (change with the `ADMIN_PATH` env var, e.g. `/my-panel` - no code edit needed)

## License plans
The panel generates:
- 7 days
- 14 days
- 30 days

Keys are hashed in the database. The full key is returned only at creation time.

## Free persistence
Render Free web services have an ephemeral filesystem, so the license database must NOT rely on a local JSON file for production. This build supports MongoDB Atlas. Atlas's M0 Free cluster is free forever and is suitable for small projects; it has 512 MB storage and operational limits. See MongoDB Atlas pricing/docs before production use.

Render Free Web Services can spin down after 15 minutes without inbound HTTP/WebSocket traffic and have 750 instance hours per month. This is a hosting limitation, not an application setting.

## Security
Keep all secrets in Render environment variables. Do not commit `MONGODB_URI`, `ADMIN_PASSWORD`, or `SESSION_SECRET` to GitHub.
