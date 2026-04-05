> **For any feature, bug fix, CI fix, coverage fix, or task — invoke the `/orchestrate-feature-dev` skill as the entry point.**
> The skill runs in the main session and coordinates all sub-agents (design, implement, test, cleanup) via the `Agent` tool.
> **Never edit files directly in the main repo or use general-purpose agents for code changes. All implementation must go through a worktree + `app-implement` agent.**

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

AGM Voting App — a web application for body corporates to run weighted voting during Annual General Meetings. See `tasks/prd/prd-agm-voting-app.md` for the full PRD.

**Stack:** React (Vite) frontend · FastAPI backend · PostgreSQL · SQLAlchemy + Alembic · Resend (email)

**Task folder structure:**
- `tasks/prd/` — product requirements documents (`tasks/prd/TEMPLATE.md` is the PRD template)
- `tasks/design/` — technical design docs (`tasks/design/TEMPLATE.md` is the design doc template)

---

## Codebase Structure

| Path | Contents |
|---|---|
| `backend/app/models/` | SQLAlchemy models |
| `backend/app/routers/` | FastAPI route handlers |
| `backend/app/services/` | Business logic / service layer |
| `backend/alembic/versions/` | DB migration files |
| `frontend/src/pages/` | React page components |
| `frontend/src/components/` | Shared React components |
| `frontend/src/api/` | TypeScript API client functions |
| `frontend/tests/msw/handlers.ts` | MSW mock handlers for tests |
| `tasks/design/design-system.md` | Frontend design system — read before writing any UI |

---

## Domain Knowledge

### Persona journeys

| Persona | Flow |
|---|---|
| **Voter** | auth → lot selection → voting → confirmation |
| **Proxy voter** | proxy auth → proxied lots → voting → confirmation |
| **In-arrear lot** | auth → lot with in-arrear badge → `not_eligible` motion handling → confirmation |
| **Admin** | login → building/meeting management → report viewing → close meeting |

When a change affects an existing journey, update the existing tests for that journey — do not only add new scenarios.

### Key domain test scenarios

#### Authentication (`POST /api/auth/verify`)
- Valid email + building → success with lot list
- Email not found → 401
- Proxy email → lots include `is_proxy: true`
- Closed or past-close-date meeting → `agm_status: "closed"` in response

#### Vote submission (`POST /api/agm/{id}/submit`)
- All motions answered → success
- Re-submission after already voted → 409
- Submission after meeting is closed → 403
- Proxy submits → `BallotSubmission.proxy_email` set in DB
- In-arrear lot on General Motion → `not_eligible` recorded

#### Meeting close (`POST /api/admin/agms/{id}/close`)
- Close an open meeting → success + email triggered + absent records created for non-voters
- Close an already-closed meeting → 409
- Close a meeting that does not exist → 404

#### Lot owner import (`POST /api/admin/buildings/{id}/import`)
- Valid file → success, returns upserted count
- Missing required columns → 422
- Duplicate lot numbers → 422 with details
- Extra/unknown columns → silently ignored
- Non-CSV/Excel file → 422

#### Weighted vote tallies
- All lots vote Yes → entitlement sum equals total building entitlement
- Mix of Yes/No → verify weighted sums, not lot counts
- Absent lots → counted in absent tally, not abstained

---

## Architecture & Design Decisions

Key decisions that must not be inadvertently reversed:

- **Lot owner import uses upsert** — matched by `lot_number` within building. Delete-all-then-insert would cascade-delete `AGMLotWeight` records and zero out vote tallies for existing AGMs.
- **`AGMLotWeight` is a snapshot** — entitlements are captured at AGM creation time and never updated by subsequent lot owner edits or imports.
- **Auth on closed AGMs** — `POST /api/auth/verify` returns 200 (not 403) for closed AGMs. The response includes `agm_status: str` so the frontend can route to the confirmation page instead of blocking entry.
- **Ballots are keyed on `lot_owner_id`** — `BallotSubmission` and `Vote` unique constraints use `(general_meeting_id, lot_owner_id)`, not `voter_email`. `voter_email` is retained on both tables for audit only. Auth resolves lots via `LotOwnerEmail` records, then all operations key on `lot_owner_id`.
- **Migrations run during Vercel build (`buildCommand`)** — `vercel.json`'s `buildCommand` runs `alembic upgrade head` once before the Lambda goes live. The Lambda cold start performs no DB operations. If the migration step fails, the Vercel build fails and the deploy is blocked (desirable).
- **Neon connection strings** — strip `channel_binding=require` before passing to alembic/asyncpg. Use `ssl=require` only. The build script does this transformation; `api/index.py` does it for the runtime `DATABASE_URL` used by the app.
- **Small persistent pool (pool_size=1)** — `database.py` uses a `QueuePool` with `pool_size=1, max_overflow=0`. Each Lambda instance holds exactly one warm connection. This keeps Neon compute active for the Lambda's lifetime and eliminates per-request Neon wakeup latency. `pool_pre_ping=True` handles mid-session Neon suspensions transparently. Pool settings are configurable via `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, and `DB_POOL_TIMEOUT` env vars. Vercel Fluid Compute (`maxDuration=60, memory=512` in `vercel.json`) keeps Lambda instances alive between requests.
- **DB connection retry in `get_db`** — the Neon free/launch plan auto-suspends the compute after 5 minutes of idle. When a Lambda request arrives during wake-up, the connection fails with `OperationalError`. `get_db` retries up to 3× with exponential backoff (1s, 2s) so the compute has time to become ready before a 500 is returned to the client.
- **Isolated Neon DB branch per migration branch** — every branch containing schema migrations gets its own Neon DB branch (off `demo`) to avoid migration conflicts on the shared demo DB. The `test` agent creates it before pushing; `cleanup` deletes it after merge.
- **Branch-scoped Vercel env vars** — `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are set as Vercel preview env vars scoped to the feature branch so the branch deployment migrates against its own Neon DB. Removed by `cleanup` after merge.

---

## Development Workflow

Invoke `/orchestrate-feature-dev` to coordinate all work — design → implement → test → cleanup. The skill runs in the main session and spawns `design`, `implement`, `test`, and `cleanup` sub-agents. PRDs go in `tasks/prd/`, design docs in `tasks/design/`.

### Worktree-first rule

A branch worktree must be created before any design, implementation, or test work begins. All agents work exclusively inside that worktree — never the main repo root, which may be on a different branch. See `.claude/skills/orchestrate-feature-dev/SKILL.md` (Step a) for the full protocol and commands.

---

## Implementation Ordering

Follow this order for every change. Do not skip ahead — each layer depends on the previous.

**Backend:**
1. Alembic migration (if schema changes) — run against test DB before writing any model code
2. SQLAlchemy models
3. Pydantic schemas
4. Service functions
5. Router endpoints
6. Unit tests (mocked DB)
7. Integration tests (real test DB)

**Frontend:**
1. TypeScript API client functions (`src/api/`)
2. MSW mock handlers (`frontend/tests/msw/handlers.ts`)
3. React components and pages
4. Unit tests (Vitest + RTL)
5. Integration tests

**Frontend style rule:** Read `tasks/design/design-system.md` before writing any UI. Never use `form-group`, `form-control`, inline style props for colours or spacing, or Bootstrap/Tailwind class names. After completing frontend changes, verify: `grep -r "form-group\|form-control" frontend/src/ --include="*.tsx"` must return nothing.

---

## Test Pipeline

Run all stages in order. Never skip. Never raise a PR until Branch E2E passes. Never merge until Post-merge CI passes.

| Stage | Trigger | Checks | How to monitor |
|---|---|---|---|
| **Local testing** | During development + before every push | pytest (100% cov) · Vitest (100% cov) · bandit · eslint-security | Run manually — re-run on every meaningful change for fast feedback |
| **Branch CI** | Auto on `git push` | Same as local + semgrep + Alembic migration on clean DB | `gh run list --branch <branch> --workflow ci.yml` |
| **Branch E2E** | Auto after Vercel preview deploys | Full Playwright suite against the branch's Preview deployment | `gh run list --branch <branch> --workflow e2e.yml` |
| **Post-merge CI** | Auto after PR merges to `demo` | Same as Branch CI | `gh run list --branch demo --workflow ci.yml` |
| **Demo E2E** | Orchestrator-directed after all slices merged | Full Playwright suite against Demo URL (`demo_url`) | `gh run list --branch demo --workflow e2e.yml` |

Local testing checks are fast (seconds) — use them as a tight feedback loop while developing, not just as a pre-push gate. All CI/E2E stages are automated and only need monitoring.

### Local testing — commands (run from worktree root)

```bash
cd backend && TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/ -n auto --cov=app --cov-fail-under=100 -q  # 100% coverage required
cd frontend && npm run test:coverage                               # 100% coverage required
cd backend && uv run bandit -r app/ -c pyproject.toml -ll
cd frontend && npm run lint:security
```

### Branch CI / E2E / Post-merge CI / Preview E2E — monitoring (all automated)

Poll with `gh run list --branch <branch> --workflow <workflow> --limit 1 --json status,conclusion`.
`conclusion: "success"` = pass · `"failure"` = fail · `null` = still running.

On CI failure: `gh run view --log-failed` to identify the failing step.
On E2E failure: `gh run download <run-id>` to retrieve the Playwright HTML report. Record every failure verbatim and report to orchestrator — do not fix inline.

---

## Test Data Conventions

E2E tests seed data using these naming patterns — the cleanup agent deletes them after runs:
- **Test meetings**: titles matching `WF*`, `E2E*`, `Test*`, `Delete Test*`
- **Test buildings**: names matching `E2E*`, `WF*`, `Test*`

Do NOT delete/archive real production data. Known real buildings: "The Vale", "SBT", "Sandridge Bay Towers".

---

## Example Files

Three example files live in `examples/` at the project root. Use these as test fixtures for import-related features — do not create synthetic test data when these files can be used instead.

### `examples/Owners_SBT.xlsx` — Lot owner import template

| Column | Maps to | Notes |
|--------|---------|-------|
| `S/Plan` | _(ignored)_ | |
| `Building Name` | `Building.name` | Used to identify or create the building |
| `Lot#` | `LotOwner.lot_number` | |
| `Unit#` | _(ignored)_ | |
| `UOE2` | `LotOwner.unit_entitlement` | Used for weighted voting |
| `Email` | `LotOwnerEmail.email` | Stored in the `lot_owner_emails` table; multiple lots may share an email |

147 data rows under "Sandridge Bay Towers (Building 6,7 & 8)". Multiple lots share an email (intentional). Extra columns silently ignored.

### `examples/AGM Motion test.xlsx` — AGM motion import template

| Column | Maps to |
|--------|---------|
| `Motion` | `Motion.order_index` |
| `Description` | `Motion.description` (full text shown to voters) |

2 data rows. Column names are case-insensitive. Blank rows silently skipped.

### `examples/Lot financial position.csv` — TOCS Lot Positions Report

Auto-extracted from the TOCS management system. Contains Administrative Fund and Maintenance Fund sections.
Key columns: `Lot#` -> `LotOwner.lot_number`, `Closing Balance` -> determines `financial_position` (positive = `in_arrear`, bracketed/zero = `normal`).
Multiple fund sections: worst-case across all sections (arrears in any -> `in_arrear`).
51 lots (lot numbers 1-51). Auto-detected by `import_financial_positions_from_csv` when the CSV does not start with `Lot#` on the first line.

---

## Vercel Environments

| Environment | Trigger | URL pattern |
|---|---|---|
| **Production** | Push to `master` only | `agm-voting.vercel.app` |
| **Demo** | Push to `demo` branch | `votingms-env-demo-ocss.vercel.app` |
| **Preview** | Push to any other branch | `votingms-git-<branch>-ocss.vercel.app` |

- **Never** run `vercel deploy --prod` or target production from the CLI
- The `demo` branch deploys to the **Demo** Vercel environment (for stakeholder review)
- Feature and fix branches deploy to the **Preview** Vercel environment
- **Neon DB mapping:** Demo env → `demo` Neon branch (`br-orange-sound-a76hyf9w`); Preview env (feature branches) → `preview` Neon branch (`br-bold-cherry-a7yzlzj1`)
- When setting branch-scoped env vars for feature branches, target `["preview"]`; the demo env DATABASE_URL is set at the custom environment level (`customEnvironmentIds: [env_FULKSWxHCulQ5CTDb0kyzZUfvfUE]`), not branch-scoped
- Required env vars: `DATABASE_URL`, `VITE_API_BASE_URL` (empty string on Vercel), `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SMTP_ENCRYPTION_KEY`, `ALLOWED_ORIGIN`
- SMTP settings (host, port, username, password, from_email) are now configured via the admin Settings page and stored encrypted in the database — no longer needed as env vars

> **CRITICAL:** `vercel env pull` may return a DIFFERENT Neon DB URL than what the deployed Lambda actually uses. To run a manual migration, retrieve `DATABASE_URL_UNPOOLED` directly from the Lambda (via a temporary debug endpoint), then run:
> ```bash
> DB="postgresql+asyncpg://user:pass@host/db?ssl=require"
> cd backend && uv run alembic -x dburl="$DB" upgrade head
> ```

---

## Project Infrastructure

| Constant | Value |
|---|---|
| Neon project ID | `divine-dust-41291876` |
| Vercel project ID | `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L` |
| Local test DB URL | `postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test` |
| Main repo path | `/Users/stevensun/personal/agm_survey` |
| Worktree path pattern | `/Users/stevensun/personal/agm_survey/.worktree/<branch>` |

Secrets are stored in macOS Keychain under service `agm-survey`. Account names:

| Secret | Account |
|---|---|
| Neon API key | `neon-api-key` |
| Admin username | `admin-username` |
| Admin password | `admin-password` |
| Vercel bypass token | `vercel-bypass-token` |

Retrieve with: `security find-generic-password -s "agm-survey" -a "<account>" -w`

**Operational docs:** Service level objectives are defined in [`docs/slo.md`](docs/slo.md). Incident runbooks are in [`docs/runbooks/`](docs/runbooks/).

### All branches — Vercel env var setup (required for every branch)

The Vercel `buildCommand` runs `scripts/migrate.sh` which calls `alembic upgrade head` and requires `DATABASE_URL_UNPOOLED` to be set — even on branches with no schema migrations (alembic runs as a no-op but the env var must be present). Without it the Vercel build fails immediately with `BUILD_FAILED`.

**Every branch** must have branch-scoped `DATABASE_URL` and `DATABASE_URL_UNPOOLED` Vercel env vars set before pushing:
- **No migrations**: point to the existing `demo` Neon branch connection strings (no new Neon branch needed)
- **Has migrations**: create a new Neon DB branch first (step 1 below), then use those connection strings

### Schema migration branches — Neon DB branch + Vercel env var setup

Run before `git push`. For non-migration branches, skip step 1 and use the `demo` Neon branch connection strings directly in step 2.

**1. Create Neon DB branch** (branched off `demo`):
```bash
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w)
NEON_PROJECT_ID="divine-dust-41291876"
BRANCH="<branch-name>"   # e.g. feat/my-feature

# Get the demo branch ID
DEMO_ID=$(curl -s "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer $NEON_API_KEY" \
  | python3 -c "import sys,json; bs=json.load(sys.stdin)['branches']; print(next(b['id'] for b in bs if b['name']=='demo'))")

# Create branch
RESPONSE=$(curl -s -X POST "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"branch\":{\"name\":\"demo/${BRANCH}\",\"parent_id\":\"${DEMO_ID}\"},\"endpoints\":[{\"type\":\"read_write\"}]}")

# Extract connection strings (strip channel_binding=require, use ssl=require)
DATABASE_URL=$(echo "$RESPONSE" | python3 -c "
import sys,json,re; d=json.load(sys.stdin)
uri=d['connection_uris'][0]['connection_uri']
uri=re.sub(r'channel_binding=require&?','',uri).rstrip('?&')
uri=uri.replace('postgresql://','postgresql+asyncpg://')
if 'ssl=' not in uri: uri+='?ssl=require'
print(uri)")
DATABASE_URL_UNPOOLED=$(echo "$RESPONSE" | python3 -c "
import sys,json,re; d=json.load(sys.stdin)
uri=d['connection_uris'][1]['connection_uri'] if len(d.get('connection_uris',[])) > 1 else d['connection_uris'][0]['connection_uri']
uri=re.sub(r'channel_binding=require&?','',uri).rstrip('?&')
uri=uri.replace('postgresql://','postgresql+asyncpg://')
if 'ssl=' not in uri: uri+='?ssl=require'
print(uri)")
```

**2. Set branch-scoped Vercel env vars**:
```bash
VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/stevensun/Library/Application Support/com.vercel.cli/auth.json'))['token'])")
VERCEL_PROJECT_ID="prj_qrC03F0jBalhpHV5VLK3IyCRUU6L"

for KEY in DATABASE_URL DATABASE_URL_UNPOOLED; do
  VALUE="${!KEY}"
  curl -s -X POST "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env" \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"${KEY}\",\"value\":\"${VALUE}\",\"type\":\"encrypted\",\"target\":[\"preview\"],\"gitBranch\":\"${BRANCH}\"}" \
    > /dev/null
done
```

**3. Delete Neon DB branch (cleanup — after merge)**:
```bash
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w)
NEON_PROJECT_ID="divine-dust-41291876"
BRANCH="<branch-name>"

BRANCH_ID=$(curl -s "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer $NEON_API_KEY" \
  | python3 -c "import sys,json; bs=json.load(sys.stdin)['branches']; b=next((b for b in bs if b['name']==f'demo/${BRANCH}'),None); print(b['id'] if b else '')")

[ -n "$BRANCH_ID" ] && curl -s -X DELETE \
  "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${BRANCH_ID}" \
  -H "Authorization: Bearer $NEON_API_KEY" > /dev/null
```

**4. Delete branch-scoped Vercel env vars (cleanup — after merge)**:
```bash
VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/stevensun/Library/Application Support/com.vercel.cli/auth.json'))['token'])")
VERCEL_PROJECT_ID="prj_qrC03F0jBalhpHV5VLK3IyCRUU6L"
BRANCH="<branch-name>"

# List env vars scoped to this branch and delete them
curl -s "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env?gitBranch=${BRANCH}" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  | python3 -c "import sys,json; [print(e['id']) for e in json.load(sys.stdin).get('envs',[])]" \
  | while read ID; do
      curl -s -X DELETE "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env/${ID}" \
        -H "Authorization: Bearer $VERCEL_TOKEN" > /dev/null
    done
```

---

## Agent Configuration

These fields are read by the generic agent definitions. Values here override user-level agent defaults.

| Key | Value |
|-----|-------|
| `production_branch` | `master` |
| `testing_branch` | `demo` |
| `stack` | React (Vite) · FastAPI · PostgreSQL · SQLAlchemy · Alembic |
| `backend_dir` | `backend` |
| `frontend_dir` | `frontend` |
| `test_backend` | `cd backend && TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test uv run pytest tests/ --cov=app --cov-fail-under=100 -q` |
| `test_frontend` | `cd frontend && npm run test:coverage` |
| `e2e_command` | `cd frontend && npx playwright test` |
| `worktree_root` | `/Users/stevensun/personal/agm_survey/.worktree` |
| `preview_url_pattern` | `https://votingms-git-<branch>-ocss.vercel.app` |
| `schema_migration_tool` | `alembic` |
| `container_tool` | `podman` |
| `neon_project_id` | `divine-dust-41291876` |
| `vercel_project_id` | `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L` |
| `real_data_patterns` | `"The Vale", "SBT", "Sandridge Bay Towers"` |
| `test_data_patterns` | `WF*, E2E*, Test*, Delete Test*` |
| `prd_dir` | `tasks/prd` |
| `design_dir` | `tasks/design` |
| `keychain_service` | `agm-survey` |
| `demo_url` | `https://votingms-env-demo-ocss.vercel.app` |
| `cleanup_demo_url` | `https://votingms-env-demo-ocss.vercel.app` |

---

## Commands

```bash
# Start databases (dev + test) — run from project root
podman compose -f podman-compose.yml up -d

# Backend: install deps + dev server
cd backend && uv sync --extra dev
uv run uvicorn app.main:app --reload --port 8000

# Backend: single test file (debug)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/test_models.py -v

# Backend: quick run without coverage (debug)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  .venv/bin/python -m pytest --override-ini="addopts=" -q

# DB migrations
uv run alembic upgrade head                                                                   # dev DB
uv run alembic -x dburl=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test upgrade head  # test DB
uv run alembic revision --autogenerate -m "description"                                       # generate

# Frontend: install deps + dev server
cd frontend && npm install
npm run dev
```
