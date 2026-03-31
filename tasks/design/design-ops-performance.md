# Design: Operational Readiness & Performance Improvements

**Status:** Implemented

## Overview

This design covers five improvements drawn from the `prd-review-recommendations.md` engineering review:

- **US-OPS-02** — Health check with DB connectivity
- **US-OPS-08** — Operator debug endpoints (race condition guard documentation)
- **US-PERF-01** — Fix N+1 queries in `list_lot_owners`
- **US-PERF-02** — DB connection pool configuration
- **US-OPS-01** — SLO documentation
- **US-OPS-06** — Incident runbooks

No database schema changes are required for any of these stories.

---

## US-OPS-02: Health check with DB connectivity

### Current state

`GET /api/health` is a simple static endpoint defined in `backend/app/main.py` that always returns `{"status": "ok"}`. It does not probe the database.

### Change

Replace the current health endpoint with one that:
1. Executes `SELECT 1` against the DB via the normal `get_db` dependency.
2. Returns `{"status": "ok", "db": "connected"}` on success (200).
3. Returns 503 `{"status": "degraded", "db": "unreachable", "error": "<message>"}` if the DB query fails.

Keep a lightweight liveness endpoint at `GET /api/health/live` that always returns 200 without touching the DB (for process-level liveness probes that must never fail due to DB issues).

### Endpoint signatures

```
GET /api/health
  200: {"status": "ok", "db": "connected"}
  503: {"status": "degraded", "db": "unreachable", "error": "..."}

GET /api/health/live
  200: {"status": "ok"}
```

### Implementation notes

- Both endpoints remain unauthenticated.
- The `select(1)` import comes from `sqlalchemy` (already present in the codebase).
- Wrap `db.execute(select(1))` in `asyncio.wait_for(..., timeout=2.0)` to enforce the 2-second response time SLO.
- Catch `Exception` (which includes `asyncio.TimeoutError`) to return 503 on any failure or timeout.
- The existing `/api/health` test in `test_app.py` must be updated to expect the new response shape and assert the DB field.
- Add separate test cases for DB exception path and `asyncio.TimeoutError` path.

---

## US-OPS-08: Operator debug endpoints

Three admin-only debug endpoints are added to `backend/app/routers/admin.py`. They are protected by `require_admin` (already on all routes in the router).

### Endpoints

```
GET /api/admin/debug/meeting-status/{meeting_id}
  Returns stored_status, effective_status, voting_closes_at, current_time.

GET /api/admin/debug/email-deliveries
  Returns all EmailDelivery records: id, general_meeting_id, status, total_attempts, last_error, updated_at.

GET /api/admin/debug/db-health
  Returns connection pool info from SQLAlchemy engine (pool size, overflow, checkedin, checkedout).
```

### Implementation notes

- `meeting-status` uses `get_effective_status()` (read-only, no DB write).
- `email-deliveries` queries `select(EmailDelivery)` ordered by `updated_at desc`.
- `db-health` accesses `engine.pool.status()` string (or pool attributes directly). The engine is imported from `app.database`.
- SQLAlchemy's `NullPool` (used in tests via `create_async_engine`) does not have `size()`/`checkedout()` — return `{"pool_type": "NullPool", "status": "n/a"}` when `pool` has no `size()` method.
- All three endpoints are under the existing `router = APIRouter(dependencies=[Depends(require_admin)])` so auth is automatic.

---

## US-PERF-01: Fix N+1 in `list_lot_owners`

### Current state

`admin_service.list_lot_owners()` loops over lot owners and fires two DB queries per owner: one for `LotOwnerEmail` and one for `LotProxy`. For a building with N owners this is 1 + 2N queries.

### Change

Batch all secondary queries:

```
1. SELECT * FROM lot_owners WHERE building_id = ? OFFSET ? LIMIT ?   (1 query)
2. SELECT lot_owner_id, email FROM lot_owner_emails WHERE lot_owner_id IN (...)  (1 query)
3. SELECT lot_owner_id, proxy_email FROM lot_proxies WHERE lot_owner_id IN (...)  (1 query)
4. Assemble dicts in Python — no further DB calls.
```

Total: 3 queries regardless of N (O(1)).

### Implementation notes

- Extract `owner_ids = [o.id for o in owners]`.
- If `owner_ids` is empty, skip queries 2 and 3 and return `[]`.
- Build lookup dicts: `emails_by_owner: dict[uuid, list[str]]` and `proxy_by_owner: dict[uuid, str | None]`.
- Assemble `out` list in the same loop as before — no DB calls inside the loop.
- Preserve the existing response shape exactly (no API change).
- The `_get_proxy_email` helper is **not** changed — it is still used by `get_lot_owner` and other single-owner paths.

---

## US-PERF-02: DB connection pool configuration

### Current state

`backend/app/database.py` creates the engine with no explicit pool settings, so SQLAlchemy uses defaults: `pool_size=5`, `max_overflow=10`, which can exhaust Neon's connection limit (25 connections per serverless plan) when multiple Lambda instances start.

### Change

Configure the engine for the serverless Lambda environment:

```python
engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    pool_size=settings.db_pool_size,       # default 2
    max_overflow=settings.db_max_overflow,  # default 3
    pool_timeout=settings.db_pool_timeout,  # default 10
    pool_pre_ping=True,
    pool_recycle=3600,
)
```

Pool settings are driven by `Settings` fields with environment variable overrides:

| Env var | Settings field | Default | Purpose |
|---------|---------------|---------|---------|
| `DB_POOL_SIZE` | `db_pool_size` | `2` | Max persistent connections per Lambda instance |
| `DB_MAX_OVERFLOW` | `db_max_overflow` | `3` | Burst connections beyond pool_size |
| `DB_POOL_TIMEOUT` | `db_pool_timeout` | `10` | Seconds to wait for a free connection before raising an error |

### Rationale

Neon's free/starter tier allows ~25 simultaneous connections. With 10+ Lambda cold starts each holding 5+10=15 potential connections, the pool can be exhausted rapidly. A `pool_size=2, max_overflow=3` config limits each Lambda to 5 connections max, supporting 5 concurrent Lambda instances before approaching the limit. `pool_pre_ping` prevents stale connections after Neon's 5-minute idle timeout. `pool_timeout=10` prevents requests from hanging indefinitely if all connections are checked out.

### Implementation notes

- `app/config.py` gains three new `int` fields: `db_pool_size`, `db_max_overflow`, `db_pool_timeout`.
- `app/database.py` reads these from `settings` — the engine picks up any env var overrides at startup.
- No change to the test engine (conftest uses `create_async_engine` directly with its own config).
- New unit test in `TestConfig` asserts the correct defaults.

### US-PERF-02 AC deferral note

The PRD AC states "pool_size=2, max_overflow=3, pool_timeout=10". All three values are now configurable via env vars. The additional AC item "A load test or documentation note explains the expected concurrency ceiling" is addressed in the Rationale above: 5 connections per Lambda × ~5 concurrent Lambda instances ≈ 25 connections, which matches Neon's starter-tier limit.

---

## US-OPS-01: SLO documentation

Create `docs/slo.md` defining service level objectives for the voter authentication and ballot submission flows.

---

## US-OPS-06: Incident runbooks

Create the following runbook documents under `docs/runbooks/`:
- `incident-response.md` — severity levels, escalation steps
- `app-down.md` — diagnosis, common causes, recovery
- `email-delivery-failures.md` — identify and manually retry
- `database-connectivity.md` — connection pool, recovery steps
- `disaster-recovery.md` — RTO/RPO targets, Neon PITR restore, Vercel env var re-pointing, quarterly DR drill schedule

---

## No schema changes

None of the above stories require Alembic migrations. All changes are confined to:
- `backend/app/config.py` — three new pool settings fields
- `backend/app/main.py` — health endpoint with `asyncio.wait_for` timeout
- `backend/app/database.py` — pool settings read from `settings`
- `backend/app/services/admin_service.py` — N+1 fix for `list_lot_owners`
- `backend/app/routers/admin.py` — three debug endpoints
- `backend/tests/test_app.py` (update existing + add new tests for timeout, pool config)
- `backend/tests/test_admin_debug_api.py` (new)
- `docs/slo.md` (new)
- `docs/runbooks/` (new directory + 5 files)
- `CLAUDE.md` — link to `docs/slo.md` and `docs/runbooks/`

---

## E2E Test Scenarios

No E2E changes are required for this feature. All stories are purely backend (new endpoints, internal refactoring) or documentation. There is no voter-facing or admin-facing UI change, and no new user journey is introduced.

The debug endpoints (`/api/admin/debug/*`) are admin-only and best exercised via the existing integration test suite rather than E2E. The health endpoints (`/api/health`, `/api/health/live`) are unauthenticated but have no frontend component to test in a browser.
