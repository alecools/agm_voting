# Design: Infrastructure, Performance, and Testing Strategy

## Overview

This document covers the deployment infrastructure, database connection management, query performance optimisations, bundle optimisation, dependency versions, and testing strategy. The app runs on Vercel (FastAPI Lambda + React Vite frontend) with Neon PostgreSQL. Alembic migrations run as a Vercel build step (not on Lambda cold start). The frontend uses `exceljs` (replacing the CVE-affected `xlsx`/SheetJS package).

---

## Deployment Infrastructure

### Vercel environments

| Environment | Trigger | URL |
|---|---|---|
| Production | Push to `master` | `agm-voting.vercel.app` |
| Demo | Push to `demo` branch | `vms-demo.ocss.tech` |
| Preview | Push to any other branch | `votingms-git-<branch>-ocss.vercel.app` |

### Alembic migrations as build step

`scripts/migrate.sh` is called from `vercel.json` `buildCommand` (after `npx vite build`). It normalises `DATABASE_URL_UNPOOLED` for asyncpg (strips `channel_binding=require`, replaces `sslmode=require` with `ssl=require`) and runs `python -m alembic -x dburl="$DB" upgrade head`.

Migration runs once per deploy (before Lambda goes live). If migration fails, the Vercel build fails and the deploy is blocked. Lambda cold starts no longer run migrations — this eliminates multi-instance migration lock contention and reduces cold-start time from 30–120s to ~2s.

E2E global setup timeouts tightened after removing migration from cold start: warmup attempts 5 (was 20), sleep 3s (was 6s), per-request timeout 8s (was 15s).

### Neon-Vercel integration

The Neon-Vercel integration automatically provisions a `preview/<branch-name>` Neon branch for every push to a non-demo branch. It injects `DATABASE_URL` and `DATABASE_URL_UNPOOLED` into the Vercel build and Lambda environment, so no manual DB setup is required for feature branches.

After merge, the `preview/<branch>` Neon branch must be deleted to avoid orphaned compute.

---

## Database Connection Pool

**Settings (`backend/app/database.py`):**

| Parameter | Value | Notes |
|---|---|---|
| `pool_size` | 20 (configurable via `DB_POOL_SIZE`) | Supports up to 30 concurrent DB ops under Fluid Compute |
| `max_overflow` | 10 (configurable via `DB_MAX_OVERFLOW`) | |
| `pool_timeout` | 30s (configurable via `DB_POOL_TIMEOUT`) | |
| `pool_pre_ping` | True | Handles mid-session Neon suspensions |
| `statement_cache_size` | 100 | Safe with direct `DATABASE_URL_UNPOOLED` (no PgBouncer) |

Uses `DATABASE_URL_UNPOOLED` (direct Neon connection) so asyncpg prepared statement caching works correctly. `pool_pre_ping=True` transparently handles the Neon free/launch plan auto-suspend.

`get_db` retries up to 3× with exponential backoff (1s, 2s) on `OperationalError` to absorb Neon wake-up time.

---

## Backend Query Performance

### `_resolve_voter_state` (auth.py)

The hot path called on every `POST /api/auth/verify` and `POST /api/auth/session`. Queries 1+2 (direct lot owner IDs and proxy lot owner IDs) are fired in parallel via `asyncio.gather` using separate `AsyncSessionLocal` sessions (sharing a session across concurrent coroutines is unsafe in SQLAlchemy async):

```python
direct_ids, proxy_ids = await asyncio.gather(
    _load_direct_lot_owner_ids(voter_email, building_id),
    _load_proxy_lot_owner_ids(voter_email, building_id),
)
```

Wall-clock round-trips: 5 sequential → 1 gather(2) + 3 sequential.

Helper functions (`_load_direct_lot_owner_ids`, `_load_proxy_lot_owner_ids`) are defined in `auth_service.py` and shared with `voting.py` for `list_motions`.

### `list_motions` (voting.py)

Session object already carries `building_id`; the meeting existence query is eliminated. Direct + proxy lot ID queries use the same shared helpers and `asyncio.gather`. Wall-clock round-trips: 4 sequential → 1 gather(2) + 2 sequential.

### `get_general_meeting_detail` tally (admin_service.py)

For **open meetings** (live computation path): replaced full `Vote` object load with a lightweight projection `(motion_id, choice, lot_owner_id, motion_option_id)` — ~60% reduction in bytes transferred. Standard-motion tally computed in the DB via `GROUP BY (motion_id, choice)` joined with `agm_lot_weights` for entitlement sums, eliminating O(V) Python iteration per motion.

For **closed meetings**: snapshot columns on `MotionOption` (`for_voter_count`, `for_entitlement_sum`, etc.) are the primary tally source (no vote table re-read).

### Session restore (auth.py)

`POST /api/auth/session` now calls `extend_session(db, session_record)` (UPDATE existing row's `expires_at`) instead of `create_session(...)` (INSERT new row). This eliminates session row proliferation and keeps each voter's session table footprint to exactly one row.

### `tenant_config` cache (config_service.py)

`get_config()` serves from a module-level TTL cache (60 seconds). The cached `TenantConfig` ORM object is expunged from the session before caching (prevents `DetachedInstanceError`). Cache invalidated on every `update_config()` call. Under concurrent load, the worst case is two Lambda instances each fetching the config once per 60s — effectively 0 DB round-trips for all subsequent requests.

---

## Bundle Optimisation

### `exceljs` replaces `xlsx` (SheetJS)

`xlsx@0.18.5` had two HIGH-severity CVEs (prototype pollution, ReDoS). It is replaced by `exceljs@4.4.0` (MIT, no known CVEs) in `parseMotionsExcel.ts`.

The dynamic `import("exceljs")` pattern is preserved so the bundle is only loaded when an admin triggers the motion import UI (voter-flow bundle unaffected).

CSV files are handled by a separate naive branch (split lines by `\n`, split cells by `,`) since ExcelJS has no CSV reader. This eliminates the need for a separate CSV library.

ExcelJS `worksheet.getRow(n).values` is 1-indexed (index 0 is always undefined); the adapter slices off index 0 to maintain the 0-based row structure expected by the downstream parsing logic.

### Vite build configuration

`vite.config.ts` uses manual chunk splitting to separate vendor bundles. The exceljs dynamic import is NOT listed in the manual chunks (it is loaded only via dynamic imports, keeping the main bundle lean).

---

## Dependency Versions

Current major versions in use:

| Package | Version | Notes |
|---|---|---|
| React | 19 | Concurrent features; `use` hook available |
| React Router | 7 | `createBrowserRouter`; data router API |
| TypeScript | 6 | `noUncheckedIndexedAccess`; strict mode |
| Vite | 8 | ESM-first; Rollup 4 |
| FastAPI | latest stable | async SQLAlchemy 2.x |
| SQLAlchemy | 2.x | async sessions; mapped columns |
| Alembic | latest stable | |
| exceljs | 4.4.0 | Replaces xlsx |

Upgrade notes are tracked in the unmerged design docs (`design-react-19-upgrade.md`, etc. — see the task files in `tasks/design/`).

---

## Testing Strategy

### Coverage requirements

100% line coverage is required for every change. No level (unit, integration, E2E) is optional.

### Local testing

```bash
# Backend (run from repo root or worktree root)
cd backend && TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/ -n auto --cov=app --cov-fail-under=100 -q

# Frontend
cd frontend && npm run test:coverage

# Security scanners
cd backend && uv run bandit -r app/ -c pyproject.toml -ll
cd frontend && npm run lint:security
```

### E2E test infrastructure

E2E tests run against the branch's Vercel Preview deployment. OTP codes are retrieved via `GET /api/test/latest-otp` (gated by `TESTING_MODE=true` env var). Real emails are suppressed via `EMAIL_OVERRIDE=tocstesting@gmail.com`.

`global-setup.ts` uses name-filtered API queries (`?name=<entity-name>`) instead of `?limit=1000` full-list scans to find E2E seed data.

E2E specs seed their own data in `beforeAll` and never depend on pre-existing DB state. Test data naming patterns: buildings `E2E*`/`WF*`/`Test*`, meetings `E2E*`/`WF*`/`Test*`.

After every E2E run (or merge cleanup), delete `email_deliveries` rows with `status='pending'` linked to test meetings — left-behind rows cause real email retry attempts on subsequent deployments.

### CI pipeline

| Stage | Trigger | Checks |
|---|---|---|
| Branch CI | `git push` | pytest (100% cov) + Vitest (100% cov) + bandit + eslint-security + semgrep + Alembic migration on clean DB |
| Branch E2E | After Vercel preview deploys | Full Playwright suite against preview deployment |
| Post-merge CI | After PR merges to `demo` | Same as Branch CI |
| Demo E2E | Orchestrator-directed after all slices merged | Full Playwright suite against Demo URL |

### Business workflow E2E specs

End-to-end specs cover the following persona journeys:
- **Voter journey**: OTP auth → lot selection → voting → confirmation
- **Proxy voter journey**: proxy auth → proxied lots → voting → confirmation
- **In-arrear lot**: auth → lot with in-arrear badge → not_eligible motion handling → confirmation
- **Admin journey**: login → building/meeting management → report viewing → close meeting
- **Multi-choice motion**: voter selects options → confirmation shows option names; admin sees tally
- **Phased voting**: voter submits partial ballot → admin reveals motion → voter re-enters → completes

---

## Files

| File | Role |
|---|---|
| `scripts/migrate.sh` | Build-step migration script |
| `vercel.json` | `buildCommand` runs frontend build + migration script |
| `api/index.py` | Lambda entry; `_auto_open_and_close_meetings()` on cold start (migrations removed) |
| `backend/app/database.py` | SQLAlchemy async engine with pool settings |
| `backend/app/routers/auth.py` | `asyncio.gather` for parallel lot ID resolution; `extend_session` instead of `create_session` |
| `backend/app/services/auth_service.py` | `_load_direct_lot_owner_ids`, `_load_proxy_lot_owner_ids`, `extend_session` |
| `backend/app/routers/voting.py` | Shared lot ID helpers; `session.building_id` eliminates meeting query |
| `backend/app/services/admin_service.py` | SQL GROUP BY tally for open meetings; snapshot tally for closed meetings |
| `backend/app/services/config_service.py` | Module-level TTL cache for `tenant_config` |
| `frontend/src/utils/parseMotionsExcel.ts` | exceljs + naive CSV branch |
| `frontend/package.json` | `exceljs` added; `xlsx` removed |
| `frontend/playwright.config.ts` | E2E timeouts tightened; `workers: 2` |
| `frontend/e2e/global-setup.ts` | Name-filtered lookups; tightened warmup timeouts |

---

## Schema Migration Required

No additional schema changes for infrastructure/performance improvements. All are code-only.
