# Runbook: Database Connectivity

Use this runbook when the application cannot connect to the Neon PostgreSQL database.

---

## Diagnosing DB connectivity issues

### Health check

```bash
# Full health check — returns 503 if DB is unreachable
curl https://agm-voting.vercel.app/api/health
```

Expected healthy response:
```json
{"status": "ok", "db": "connected"}
```

Degraded response (DB unreachable):
```json
{"status": "degraded", "db": "unreachable", "error": "..."}
```

### Pool diagnostics (admin auth required)

```bash
curl -H "Cookie: admin_session=..." \
  https://agm-voting.vercel.app/api/admin/debug/db-health
```

Response fields:
- `pool_type`: the pool implementation class
- `pool_size`: configured maximum persistent connections per Lambda instance
- `checked_in`: connections currently available in the pool
- `checked_out`: connections currently in use
- `overflow`: extra connections opened beyond `pool_size`

---

## Connection pool configuration

The engine is configured in `backend/app/database.py`:

```
pool_size=2       — max persistent connections per Lambda instance
max_overflow=3    — max burst connections per instance
pool_pre_ping=True — detect stale connections before use
pool_recycle=3600 — recycle connections hourly
```

**Capacity ceiling:** With `pool_size=2 + max_overflow=3 = 5` connections per Lambda instance and Neon's ~25-connection limit, the app can support up to 5 concurrent Lambda instances before approaching the limit.

---

## Common causes and resolutions

### Connection pool exhaustion

**Symptom:** `/api/health` returns 503 with "too many connections" or "connection refused".

**Resolution:**
1. Check Neon console for active connection count.
2. Wait for idle Lambda instances to expire (Vercel functions time out after 10s-60s of inactivity).
3. If persistent, consider upgrading the Neon plan for more connections.
4. As an emergency measure, restart the Vercel deployment to drain all Lambda instances.

### Stale connections after Neon idle timeout

**Symptom:** First request after a period of inactivity returns an error, then subsequent requests succeed.

**Resolution:** `pool_pre_ping=True` should handle this automatically by sending `SELECT 1` before using a pooled connection. If stale connections persist, verify `pool_pre_ping` is set in `database.py`.

### Wrong connection string

**Symptom:** All requests fail with "password authentication failed" or "database does not exist".

**Resolution:**
1. Retrieve the current `DATABASE_URL` from the Vercel dashboard (Settings → Environment Variables).
2. Verify the URL points to the correct Neon branch for this deployment (preview branches use branch-specific URLs).
3. The app strips `channel_binding=require` from the URL at startup — verify the raw URL in Vercel is correct.

### Neon compute paused (free tier)

**Symptom:** Occasional slow first request (5-10s) as Neon auto-starts the compute.

**Resolution:** This is expected behaviour on the free tier. No action needed unless requests are consistently failing. Upgrade to a paid Neon plan to disable auto-suspend if latency is unacceptable.

---

## Manual migration against a specific DB

To run migrations against a specific database (e.g. after disaster recovery):

```bash
# Retrieve the unpooled connection URL from the Lambda debug endpoint or Neon console
DB="postgresql+asyncpg://user:pass@host/db?ssl=require"

cd backend
uv run alembic -x dburl="$DB" upgrade head
```

Note: Strip `channel_binding=require` and use `ssl=require` only.

---

## Vercel branch-scoped database URLs

Each feature branch with schema migrations uses its own Neon DB branch. The `DATABASE_URL` and `DATABASE_URL_UNPOOLED` Vercel env vars are scoped to that branch.

To verify which DB a deployment is using:
1. Vercel dashboard → Project → Settings → Environment Variables
2. Filter by the branch name
3. The `DATABASE_URL` value shows the Neon branch endpoint
