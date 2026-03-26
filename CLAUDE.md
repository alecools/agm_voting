> **For any feature, bug fix, or task — invoke the `/orchestrate-feature-dev` skill as the entry point.**
> The skill runs in the main session and coordinates all sub-agents (design, implement, test, cleanup) via the `Agent` tool.
> See `.claude/skills/orchestrate-feature-dev/SKILL.md` for the full protocol.

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
- **Ballots are keyed on `lot_owner_id`** — `BallotSubmission` and `Vote` unique constraints use `(general_meeting_id, lot_owner_id)`, not `voter_email`. `voter_email` is retained on both tables for audit only. Auth resolves lots via `LotOwnerEmail` records, then all operations key on `lot_owner_id`.
- **Migrations run during Vercel build (`buildCommand`)** — `vercel.json`'s `buildCommand` runs `alembic upgrade head` once before the Lambda goes live. The Lambda cold start performs no DB operations. If the migration step fails, the Vercel build fails and the deploy is blocked (desirable).
- **Neon connection strings** — strip `channel_binding=require` before passing to alembic/asyncpg. Use `ssl=require` only. The build script does this transformation; `api/index.py` does it for the runtime `DATABASE_URL` used by the app.
- **Isolated Neon DB branch per migration branch** — every branch containing schema migrations gets its own Neon DB branch (off `preview`) to avoid migration conflicts on the shared preview DB. The `agm-test` agent creates it before pushing; `agm-cleanup` deletes it after merge.
- **Branch-scoped Vercel env vars** — `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are set as Vercel preview env vars scoped to the feature branch so the branch deployment migrates against its own Neon DB. Removed by `agm-cleanup` after merge.

---

## Project Infrastructure

| Constant | Value |
|---|---|
| Neon project ID | `divine-dust-41291876` |
| Vercel project ID | `prj_qrC03F0jBalhpHV5VLK3IyCRUU6L` |
| Local test DB URL | `postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test` |
| Main repo path | `/Users/stevensun/personal/agm_survey` |
| Worktree path pattern | `/Users/stevensun/personal/agm_survey/.worktree/<branch>` |

Secrets (bypass token, admin credentials, API keys) are stored in macOS Keychain under the service name `agm-survey`.

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

## Test Data Conventions

E2E tests seed data using these naming patterns — the cleanup agent deletes them after runs:
- **Test meetings**: titles matching `WF*`, `E2E*`, `Test*`, `Delete Test*`
- **Test buildings**: names matching `E2E*`, `WF*`, `Test*`

Do NOT delete/archive real production data. Known real buildings: "The Vale", "SBT", "Sandridge Bay Towers".

---

## Development Workflow

Invoke `/orchestrate-feature-dev` to coordinate all work — design → implement → test → cleanup. The skill runs in the main session and spawns `agm-design`, `agm-implement`, `agm-test`, and `agm-cleanup` sub-agents. PRDs go in `tasks/prd/`, design docs in `tasks/design/`.

### Worktree-first rule

A branch worktree must be created before any design, implementation, or test work begins. All agents work exclusively inside that worktree — never the main repo root, which may be on a different branch. See `.claude/skills/orchestrate-feature-dev/SKILL.md` (Step a) for the full protocol and commands.

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
