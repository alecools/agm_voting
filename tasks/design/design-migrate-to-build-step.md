# Design: Move Alembic Migrations to Vercel Build Step

## Goal

Move `alembic upgrade head` from Lambda cold start (`api/index.py`) to a Vercel pre-deploy build step. This eliminates multi-instance cold-start collision errors during E2E testing and makes Lambda cold starts significantly faster.

## Current Setup

- `api/index.py` calls `alembic upgrade head` on every Lambda cold start via the Python Alembic API
- This causes concurrent migration lock contention when `--workers=2` spins up multiple Lambda instances simultaneously
- Forces `--workers=1` in E2E runs, doubling test time
- Lambda cold start takes 30–120s on new deployments due to migration time
- `global-setup.ts` has a 20-attempt × 6s warmup loop (up to 2 min) to absorb cold-start migration time

## Design

### 1. `scripts/migrate.sh` (new file)

```bash
#!/bin/bash
set -euo pipefail

# Normalise DATABASE_URL_UNPOOLED for asyncpg / alembic
DB=$(python3 - <<'PYEOF'
import os
u = os.environ["DATABASE_URL_UNPOOLED"]
u = u.replace("postgres://", "postgresql+asyncpg://", 1) \
     .replace("postgresql://", "postgresql+asyncpg://", 1) \
     .replace("sslmode=require", "ssl=require") \
     .replace("&channel_binding=require", "") \
     .replace("channel_binding=require&", "") \
     .replace("channel_binding=require", "")
print(u)
PYEOF
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/backend"
python -m alembic -x dburl="$DB" upgrade head
```

Key decisions:
- Use `BASH_SOURCE` to resolve repo root — the Vercel `buildCommand` starts with `cd frontend`, so the script cannot assume `backend/` is a relative path from the working directory
- Use `python -m alembic` (not `uv run alembic`) — Vercel already installs Python deps from `requirements.txt` at build time; `uv` is not available in the Vercel build environment
- Use `DATABASE_URL_UNPOOLED` — alembic requires a direct connection; the pooled URL (PgBouncer) does not support DDL
- Strip `channel_binding=require` — same transformation already done in `api/index.py` at runtime
- `set -euo pipefail` — build fails if migration fails, blocking the deploy (desired)

### 2. `vercel.json` — updated `buildCommand`

The `buildCommand` runs from `frontend/` after `cd frontend`, so call the script with `../scripts/migrate.sh`:

```json
{
  "buildCommand": "cd frontend && npm install && npx vite build && cp -r dist ../api/static && bash ../scripts/migrate.sh"
}
```

### 3. `api/index.py` — remove migration block

Delete the entire migration block (lines 46–68). Keep the `_db_url` assignment used by the auto-open/auto-close block below it.

### 4. `frontend/e2e/global-setup.ts` — simplify warmup

| Setting | Before | After |
|---|---|---|
| Warmup attempts | 20 | 5 |
| Warmup sleep | 6 000 ms | 3 000 ms |
| Per-request timeout | 15 000 ms | 8 000 ms |
| Warning message | "after 20 attempts" | "after 5 attempts" |
| `retryGet` maxAttempts | 12 | 5 |
| `retryGet` sleep | 5 000 ms | 3 000 ms |
| `setDefaultNavigationTimeout` | 180 000 ms | 60 000 ms |
| API request context timeout | 90 000 ms | 30 000 ms |

### 5. `frontend/playwright.config.ts` — tighten timeouts

| Setting | Before | After |
|---|---|---|
| `timeout` (deployed) | 120 000 ms | 60 000 ms |
| `expect.timeout` (deployed) | 15 000 ms | 10 000 ms |
| `workers` (deployed) | 1 (CLI override) | 2 (from config) |

The `--workers=1` CLI flag is removed from CLAUDE.md E2E run commands.

## Prerequisite: Vercel env var fallback

Vercel resolves env vars with branch-scoped vars taking priority over environment-level vars. This means:

| Branch type | `DATABASE_URL_UNPOOLED` resolved | Migration result |
|---|---|---|
| Schema-migration branch | Branch-scoped → own Neon branch | Runs new migrations on isolated DB |
| Non-schema branch | Fallback → shared preview DB | No-op (already at head) |

Schema-migration branches already have a branch-scoped `DATABASE_URL_UNPOOLED` set — no change needed for them. The only prerequisite is adding a **non-branch-scoped Preview env var** as a fallback so non-schema branches can also run `alembic upgrade head` (harmlessly, as a no-op) during their build step.

Action required (Vercel dashboard): Settings → Environment Variables → add `DATABASE_URL_UNPOOLED` for Preview environment **without** a git branch filter, pointing to the shared preview Neon DB's unpooled connection string.

## Risks

| Risk | Mitigation |
|---|---|
| `DATABASE_URL_UNPOOLED` not set at build time | `set -euo pipefail` + Python `KeyError` → build fails with clear error |
| Branch without Neon branch-scoped DB | Falls back to global Preview `DATABASE_URL_UNPOOLED` → runs no-op migration against shared preview DB (safe) |
| Concurrent branch builds | Alembic advisory lock serialises concurrent migrations safely |
| `uv` not available | Use `python -m alembic` instead — no uv needed |

## Slice

Single slice — one branch, one PR. No parallel agents needed.

Files changed:
- `scripts/migrate.sh` (new)
- `vercel.json`
- `api/index.py`
- `frontend/e2e/global-setup.ts`
- `frontend/playwright.config.ts`
- `CLAUDE.md` (remove `--workers=1` from E2E command)
