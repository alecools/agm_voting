# Runbook: Deployment Smoke Test

Use this runbook after every deployment to verify the application is healthy before
announcing the deploy or directing voters to the URL.

Estimated time: **under 5 minutes**.

---

## Prerequisites

- Access to the deployed URL (see Vercel dashboard or `VITE_API_BASE_URL` env var)
- Admin credentials (`ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars from Vercel)
- A test building already created (e.g. "E2E Test Building") with at least one lot owner email

---

## Step 1: Health check

```bash
curl -sf https://<deploy-url>/api/health
```

Expected response:

```json
{"status": "ok", "db": "connected"}
```

If you see `status: "degraded"` or an HTTP 503, stop here — the DB is unreachable.
Check Neon dashboard and Vercel environment variable `DATABASE_URL`.

---

## Step 2: Verify admin login

1. Open `https://<deploy-url>/admin` in a browser.
2. Log in with the admin credentials.
3. Confirm the building list loads without errors.

If login fails with 401, verify `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set correctly
in Vercel for the target environment.

---

## Step 3: OTP auth flow (voter path)

1. Navigate to the AGM voting URL for a known open meeting.
2. Enter a registered lot owner email address.
3. Confirm the OTP request returns successfully ("Code sent" message).
4. Retrieve the OTP via the test endpoint (only available in testing_mode) or from SMTP logs.
5. Enter the OTP — confirm you land on the lot selection screen.

If the OTP email is not delivered, check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`,
`SMTP_PASSWORD`, and `SMTP_FROM_EMAIL` env vars.

---

## Step 4: Check migration state

```bash
curl -sf https://<deploy-url>/api/health
```

If the health check passes, the migration ran successfully during the Vercel build step.
If `alembic upgrade head` failed during build, Vercel would have blocked the deploy —
so a successful health check implies the migration applied.

To verify manually, connect to the Neon DB and run:

```sql
SELECT version_num FROM alembic_version;
```

Compare the result against the head revision in `backend/alembic/versions/`.

---

## Rollback procedure

If the smoke test fails and the issue cannot be fixed with a hotfix deploy:

1. **Revert the Vercel deployment**: In the Vercel dashboard, go to the project →
   Deployments → find the previous successful deployment → Promote to Production (or Preview).

2. **Note on migrations**: Alembic migrations are **not automatically reversed** on Vercel
   rollback. If the failed deploy introduced a schema migration, you must create a compensating
   migration (a new `alembic revision` that undoes the change) and deploy it.
   Do **not** run `alembic downgrade` against a live database without first confirming the
   migration is safe to reverse.

3. **Verify rollback**: Re-run Steps 1–3 above against the reverted deployment URL.

---

## Escalation contacts

- Primary on-call: check `docs/runbooks/incident-response.md`
- Neon DB issues: Neon support portal
- Vercel issues: Vercel support portal
