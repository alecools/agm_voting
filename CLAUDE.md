> **ORCHESTRATOR MODE — READ FIRST**
>
> This session is an **orchestrator**. You must NEVER call tools (Read, Grep, Glob, Bash, Edit, Write, Agent, etc.) directly.
> Every task — file reads, code changes, test runs, git operations, CI checks — must be delegated to a sub-agent.
>
> Workflow for any feature or fix:
> 1. Spawn `agm-design` agent → updates PRD + writes design doc in `tasks/design/`
> 2. Spawn `agm-implement` agent (in a worktree) → implements code, runs tests at 100% coverage, commits
> 3. Grant push slot → spawn `agm-test` agent → pushes branch, waits for Vercel, runs full E2E suite
> 4. After E2E passes → spawn sub-agent to raise PR and merge into `preview`
> 5. Spawn `agm-cleanup` agent → removes worktree, Neon branch, Vercel env vars
>
> Agent definitions live in `.claude/agents/`. Read `agm-orchestrate.md` for the full coordination protocol.
>
> **Violating this rule (e.g. reading a file "just to check") is the most common failure mode. Do not do it.**

---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

AGM Voting App — a web application for body corporates to run weighted voting during Annual General Meetings. See `tasks/prd/prd-agm-voting-app.md` for the full PRD.

**Task folder structure:**
- `tasks/prd/` — product requirements documents
- `tasks/design/` — technical design docs (one per feature, written by design agents before implementation)

**Stack:** React (Vite) frontend · FastAPI backend · PostgreSQL · SQLAlchemy + Alembic · Resend (email)

---

## Architecture & Design Decisions

Key decisions that must not be inadvertently reversed:

- **Lot owner import uses upsert** — matched by `lot_number` within building. Delete-all-then-insert would cascade-delete `AGMLotWeight` records and zero out vote tallies for existing AGMs.
- **`AGMLotWeight` is a snapshot** — entitlements are captured at AGM creation time and never updated by subsequent lot owner edits or imports.
- **Auth on closed AGMs** — `POST /api/auth/verify` returns 200 (not 403) for closed AGMs. The response includes `agm_status: str` so the frontend can route to the confirmation page instead of blocking entry.
- **`voter_email` is case-sensitive** — `AGMLotWeight.voter_email` and `BallotSubmission.voter_email` must match exactly. Auth enforces this via `LotOwner.email == request.email` in SQL.
- **Migrations run during Vercel build (`buildCommand`)** — `vercel.json`'s `buildCommand` runs `alembic upgrade head` once before the Lambda goes live. The Lambda cold start performs no DB operations. If the migration step fails, the Vercel build fails and the deploy is blocked (desirable).
- **Neon connection strings** — strip `channel_binding=require` before passing to alembic/asyncpg. Use `ssl=require` only. The build script does this transformation; `api/index.py` does it for the runtime `DATABASE_URL` used by the app.

---

## Development Workflow

> See user-level `~/.claude/CLAUDE.md` for: PRD-before-code rule and design-first decomposition process.

Workflow is managed by the project's custom agents in `.claude/agents/`. The orchestrator spawns agents based on the task:

| Agent | File | Trigger / When to spawn |
|---|---|---|
| `agm-orchestrate` | `.claude/agents/agm-orchestrate.md` | User requests a new feature, bug fix, or any multi-step work — this is the entry point; coordinates all other agents and the push slot queue |
| `agm-design` | `.claude/agents/agm-design.md` | First step of every feature: update or create the PRD, write the technical design doc in `tasks/design/`, sketch E2E scenarios — never writes implementation code |
| `agm-implement` | `.claude/agents/agm-implement.md` | After design doc is written: implement backend + frontend changes in a worktree, run unit and integration tests at 100% coverage, commit, then signal "Ready for push slot" |
| `agm-test` | `.claude/agents/agm-test.md` | After implementation is committed and the push slot is granted: push the branch, wait for Vercel deployment, run the full Playwright E2E suite once to completion, report all results, release the slot |
| `agm-cleanup` | `.claude/agents/agm-cleanup.md` | After a PR merges to `preview`: remove git worktree, delete local and remote branch, delete Neon DB branch (if created), remove Vercel branch-scoped env vars, clean test data from preview DB |

For full workflow details, see `.claude/agents/agm-orchestrate.md`.

### Task folder structure

| Folder | Contents |
|---|---|
| `tasks/prd/` | Product requirements documents (`prd-*.md`) |
| `tasks/design/` | Technical design docs (`design-<feature>.md`) — one per feature, written by the design agent before implementation begins |

**Design agents must write their output to `tasks/design/design-<feature>.md`** before reporting back to the orchestrator. Implementation agents must read this file before writing any code. Both files (PRD update + design doc) must be committed and included in the PR.

### Definition of Done

1. All local tests pass at 100% coverage (backend pytest + frontend vitest)
2. Branch pushed, Vercel deployed, full E2E passes against the branch preview URL
3. PR raised and merged into `preview`
4. Post-merge cleanup complete (Neon branch, Vercel env vars, worktree, local + remote git branch)

---

### Isolated DB for schema-migration branches

Every branch with schema migrations MUST have its own Neon DB branch to avoid migration conflicts on the shared preview DB.

**Neon API key:** `security find-generic-password -s "agm-survey" -a "neon-api-key" -w`

**Setup (once, when creating the branch):**

1. Create a Neon branch off `preview` (named after the feature) via the Neon dashboard
2. Note the pooled + unpooled connection strings
3. Set branch-scoped Vercel env vars:

   ```bash
   PROJECT_ID=$(cat .vercel/project.json | python3 -c "import sys,json; print(json.load(sys.stdin)['projectId'])")

   python3 - <<'EOF'
   import urllib.request, json, os
   token = os.environ["VERCEL_TOKEN"]
   project_id = os.environ["PROJECT_ID"]
   branch = "feat/my-feature"
   pooled_url   = "postgresql://...?sslmode=require&channel_binding=require"
   unpooled_url = "postgresql://...?sslmode=require&channel_binding=require"
   for key, value in [("DATABASE_URL", pooled_url), ("DATABASE_URL_UNPOOLED", unpooled_url)]:
       body = json.dumps({"key": key, "value": value, "type": "encrypted",
                          "target": ["preview"], "gitBranch": branch}).encode()
       req = urllib.request.Request(
           f"https://api.vercel.com/v10/projects/{project_id}/env", data=body,
           headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
           method="POST")
       print(f"{key}: {urllib.request.urlopen(req).status}")
   EOF
   ```

4. Push the branch — Vercel build runs `alembic upgrade head` against the branch-scoped Neon DB before the Lambda goes live
5. After merge: delete the Neon branch and remove branch-scoped Vercel env vars (delegate to the `agm-cleanup` agent)

> When a PR merges to `preview`, the Vercel build runs `alembic upgrade head` against the shared preview DB as part of the build step.

---

## Vercel Environments

| Environment | Trigger | URL pattern |
|---|---|---|
| **Production** | Push to `master` only | `agm-voting.vercel.app` |
| **Preview** | Push to any other branch | `agm-voting-git-<branch>-ocss.vercel.app` |

- **Never** run `vercel deploy --prod` or target production from the CLI
- All non-production deployments land in Preview and use Preview env vars
- Required env vars: `DATABASE_URL`, `VITE_API_BASE_URL` (empty string on Vercel), `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `ALLOWED_ORIGIN`

> **CRITICAL:** `vercel env pull` may return a DIFFERENT Neon DB URL than what the deployed Lambda actually uses. To run a manual migration, retrieve `DATABASE_URL_UNPOOLED` directly from the Lambda (via a temporary debug endpoint), then run:
> ```bash
> DB="postgresql+asyncpg://user:pass@host/db?ssl=require"
> cd backend && uv run alembic -x dburl="$DB" upgrade head
> ```

---

## Testing Standards

> See user-level `~/.claude/CLAUDE.md` for coverage targets, backend/frontend/Playwright standards. Project-specific requirements are below.

### Scope review before writing tests

Before writing tests for any new requirement, identify which existing persona journeys are affected and update those tests:

- **Voter journey** — authentication -> lot selection -> voting -> confirmation. Changes to auth, lot resolution, vote submission, or UI routing must be reflected in the voter E2E spec.
- **Admin journey** — login -> building/meeting management -> report viewing -> close meeting. Changes to admin API responses, report data, or admin UI must be reflected in admin E2E and integration tests.
- **Proxy voter journey** — authentication via proxy email -> lot selection showing proxied lots -> voting -> confirmation. Changes to auth or vote submission must verify proxy flows are unaffected.
- **In-arrear lot journey** — authentication -> lot selection with in-arrear badge -> voting with not_eligible motions -> confirmation. Changes to vote eligibility must verify in-arrear behaviour is preserved.

When a change affects an existing E2E scenario (new page in the voter flow, changed API response shape, renamed route), update the E2E spec — do not only add new unit tests.

### Key test scenarios by domain

#### Authentication (`POST /api/auth/verify`)
- Valid email + building -> success with lot list
- Email not found -> 401
- Proxy email -> lots include `is_proxy: true`
- Closed or past-close-date meeting -> `agm_status: "closed"` in response

#### Vote submission (`POST /api/agm/{id}/submit`)
- All motions answered -> success
- Re-submission after already voted -> 409
- Submission after meeting is closed -> 403
- Proxy submits -> `BallotSubmission.proxy_email` set in DB
- In-arrear lot on General Motion -> `not_eligible` recorded

#### Meeting close (`POST /api/admin/agms/{id}/close`)
- Close an open meeting -> success + email triggered + absent records created for non-voters
- Close an already-closed meeting -> 409
- Close a meeting that does not exist -> 404

#### Lot owner import (`POST /api/admin/buildings/{id}/import`)
- Valid file -> success, returns upserted count
- Missing required columns -> 422
- Duplicate lot numbers -> 422 with details
- Extra/unknown columns -> silently ignored
- Non-CSV/Excel file -> 422

#### Weighted vote tallies
- All lots vote Yes -> entitlement sum equals total building entitlement
- Mix of Yes/No -> verify weighted sums, not lot counts
- Absent lots -> counted in absent tally, not abstained

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
| `Email` | `LotOwner.email` | |

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

## Commands

```bash
# Start databases (dev + test) — run from project root
podman compose -f podman-compose.yml up -d

# Backend: install deps
cd backend && uv sync --extra dev

# Backend: dev server
uv run uvicorn app.main:app --reload --port 8000

# Backend: tests with coverage (100% required)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/ --cov=app --cov-report=term-missing --cov-fail-under=100 -v

# Backend: quick test run (no coverage)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  .venv/bin/python -m pytest --override-ini="addopts=" -q

# Backend: single file
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/test_models.py -v

# DB migrations — dev
uv run alembic upgrade head

# DB migrations — test DB
uv run alembic -x dburl=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test upgrade head

# Generate migration
uv run alembic revision --autogenerate -m "description"

# Frontend: install deps
cd frontend && npm install

# Frontend: dev server
npm run dev

# Frontend: tests with coverage (100% required)
npm run test:coverage

# Frontend: E2E tests (requires dev server or PLAYWRIGHT_BASE_URL set)
npm run e2e
```
