# Runbook: Application Down

Use this runbook when the AGM Voting App is returning errors or is completely unreachable.

---

## Step 0: Check Vercel function logs FIRST

**Before checking Neon metrics or CI/E2E failure messages, read the raw Lambda logs.** Infrastructure symptoms (ETIMEDOUT, Lambda timeout, slow cold starts) frequently mask application-level bugs that are only visible in the function log stream.

In the Vercel dashboard: Deployments → current deployment → Functions tab → select any recent failing invocation → expand the log.

**Key startup events to look for (emitted in the first ~1s of a cold start):**

| Log event | Meaning | Action |
|---|---|---|
| `startup_email_requeue count=N` (N > 0) | Stale pending emails are being retried on cold start — this is **normal** but a large count (> 5) indicates test data was not cleaned up | Delete stale records via the SQL in `email-delivery-failures.md` |
| `email_delivery_attempt status=failed error="…Authentication…"` | SMTP credentials are wrong — emails fail permanently | Fix SMTP credentials in Admin → Settings → Mail server |
| `migration_head_check_failed` | Alembic cannot find the migration folder | Check `DATABASE_URL` / `DATABASE_URL_UNPOOLED` env vars |

**Rule:** If the Lambda is slow or timing out, the answer is almost always in the first 2 seconds of the function log, not the Neon compute dashboard.

---

## Step 1: Determine failure type

```bash
# Process-level liveness (does not touch DB)
curl https://vms-demo.ocss.tech/api/health/live

# Full health check (includes DB connectivity)
curl https://vms-demo.ocss.tech/api/health
```

| Result | Diagnosis |
|--------|-----------|
| `/api/health/live` returns 200, `/api/health` returns 503 | DB is unreachable — see `database-connectivity.md` |
| `/api/health/live` returns 5xx or times out | Lambda process itself is failing |
| Both return 200 but users report errors | Specific endpoint is broken — check Vercel function logs |

---

## Step 2: Check Vercel deployment status

1. Log in to `https://vercel.com/ocss/internal-vms`.
2. Navigate to Deployments and check the most recent deployment status.
3. Click the deployment → Functions tab → check recent invocations for errors.
4. Common causes:
   - **Build failure** — Alembic migration failed during build. Check the build logs for migration errors.
   - **Runtime crash** — Unhandled exception in a Lambda handler. Check function logs.
   - **Environment variable missing** — `DATABASE_URL`, `SESSION_SECRET`, etc. Check Settings → Environment Variables.

---

## Step 3: Check Neon DB status

1. Log in to `https://console.neon.tech/app/projects/curly-lab-57416583`.
2. Check the dashboard for:
   - High connection count (> 20 active connections suggests pool exhaustion)
   - Recent errors in the query log
   - Compute status (should be "Active" or "Idle")

---

## Step 4: Recovery actions

### Rollback a broken deployment

1. In Vercel Deployments, find the last known-good deployment.
2. Click `...` → **Promote to Production**.
3. Verify `GET /api/health` returns 200 after promotion.
4. **Important:** If the broken deployment included a schema migration, the rollback will run against a newer DB schema. Assess whether the old code is compatible with the new schema before promoting.

### Force a new deployment

```bash
# Trigger a fresh deploy from the current branch
git commit --allow-empty -m "chore: trigger redeploy"
git push origin <branch>
```

### Restart the connection pool

The Lambda is stateless — there is no persistent pool to restart. If connections are exhausted, new Lambda invocations will open fresh connections. Check `GET /api/admin/debug/db-health` (admin auth required) for current pool state.

---

## Common causes and resolutions

| Cause | Symptom | Resolution |
|-------|---------|------------|
| DB migration failed on deploy | Build log shows `alembic upgrade head` error | Fix migration, push a new commit |
| Missing env var | 500 errors mentioning `NoneType` or config | Add the missing env var in Vercel Settings |
| Connection pool exhaustion | `/api/health` returns 503 with "connection refused" or timeout | Check Neon connection count; wait for idle connections to expire or scale Neon compute |
| Bad code deploy | 500s on specific endpoints immediately after deploy | Roll back to previous deployment |
| Neon compute paused (free tier) | First request is very slow or times out | Neon auto-starts on first connection; no action needed unless it fails repeatedly |
