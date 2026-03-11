# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AGM Voting App — a web application for body corporates to run weighted voting during Annual General Meetings. See `tasks/prd-agm-voting-app.md` for the full PRD.

**Stack:** React (Vite) frontend · FastAPI backend · PostgreSQL · SQLAlchemy + Alembic · Resend (email)

---

## Development Workflow

**PRD before code — always.** For every change (new feature, bug fix, UX feedback, or refactor):

1. Update the relevant PRD in `tasks/` first — add or revise user stories, acceptance criteria, and functional requirements to reflect the change
2. Then implement the code

This applies equally to small bug fixes and large features. If feedback is received during implementation, pause, update the PRD, then continue.

### Sub-agent branch workflow (required for all feature dev and bugfixes)

> **Vercel environment note:** Every non-production deployment — whether triggered by `git push` or the CLI — lands in the Preview environment and uses Preview env vars. There is no separate "development" deployment target. The branch preview URL is `agm-voting-git-<branch>-ocss.vercel.app`.

Every feature or bugfix must follow this process, executed by a sub-agent:

1. **Pull the latest** from the base branch before branching: `git checkout preview && git pull origin preview`, then **create a new branch** (e.g. `git checkout -b feat/my-feature`)
2. **Do all work on that branch** — multiple commits are fine and encouraged
3. **Run local tests** — `npm run test:coverage` (frontend) and `pytest --cov` (backend), both must pass at 100%
4. **Signal the orchestrator** — report local test results, indicate ready to push. **Pause and wait** for the orchestrator to grant the push slot
5. **Push the branch** (only after orchestrator grants the slot) — `git push -u origin <branch>`. Vercel auto-deploys to `agm-voting-git-<branch>-ocss.vercel.app`
6. **Wait for Vercel to finish deploying**, then run the **full E2E suite to completion** — never stop early, record ALL failures:
   ```bash
   cd frontend && PLAYWRIGHT_BASE_URL=https://agm-voting-git-<branch>-ocss.vercel.app \
     VERCEL_BYPASS_TOKEN=<token> ADMIN_USERNAME=ocss_admin ADMIN_PASSWORD="ocss123!@#" \
     npx playwright test
   ```
7. **Release the push slot** — notify the orchestrator the slot is free (pass or fail)
8. **Fix all recorded failures** — work through every issue while the next agent may be using the slot. Do not push during this phase
9. If fixes were needed: **re-queue** (back to step 4) for another push + test cycle
10. Once all E2E tests pass: **raise a PR** to merge into `preview`
11. **Monitor the GitHub Actions post-deploy workflow** — it runs automatically after the PR is raised. Check for any failures
12. If the CI workflow fails: fix the issues and re-queue (back to step 4) to push and re-test
13. When all tests pass including the CI workflow: **ask the user to approve and merge the PR**

#### Orchestrator responsibilities (push slot queue)

The shared preview environment supports only one branch being pushed and tested at a time to avoid test interference. When orchestrating multiple sub-agents:

- Maintain a queue of agents waiting for the push slot
- Grant the slot to one agent at a time — FIFO by default; reprioritise by urgency or risk if needed
- Slot is released after the agent's E2E run completes (step 7) — immediately grant to the next agent in the queue
- An agent returning after fixing issues rejoins the **back** of the queue
- If only one agent is running, grant the slot immediately when it signals readiness

#### Parallel agents (multiple features at once)

Use **git worktrees** so each agent has its own isolated working directory:
```bash
git worktree add ../agm_survey-feat-foo feat/foo
git worktree add ../agm_survey-feat-bar feat/bar
# Clean up after merge:
git worktree remove ../agm_survey-feat-foo
```

#### Provisioning an isolated test database for a feature branch

When a feature includes schema migrations or needs a clean DB state, create a dedicated Neon branch:

1. **Create the branch in Neon** — branch off `preview` in the Neon dashboard. Name it after the feature.
2. **Run migrations:**
   ```bash
   uv run alembic -x "dburl=postgresql+asyncpg://<user>:<pass>@<host>/neondb?ssl=require" upgrade head
   ```
   Strip `sslmode=require` → `ssl=require` and remove `channel_binding=require` (asyncpg does not support either).
3. **Override the DB for the branch** — add a branch-scoped `DATABASE_URL` env var in the Vercel dashboard for that git branch, pointing to the feature Neon branch
4. **Tear down the Neon branch** once the feature is merged

### Definition of Done

A change is only complete when all of the following are true:

1. All local tests pass (`npm run test:coverage` and backend pytest with coverage)
2. Branch pushed, Vercel preview deployed, full E2E suite passes against the branch preview URL
3. PR raised to `preview`, GitHub Actions post-deploy workflow passes
4. User has approved and merged the PR

---

## Example Files

Two example files live in `examples/` at the project root. Use these as test fixtures for any import-related feature development and testing — do not create synthetic test data when these files can be used instead.

### `examples/Owners_SBT.xlsx` — Lot owner import template

Used for building/lot owner import (US-005, admin CSV/Excel import endpoint).

| Column | Maps to | Notes |
|--------|---------|-------|
| `S/Plan` | _(ignored)_ | Strata plan identifier — not stored |
| `Building Name` | `Building.name` | Used to identify or create the building |
| `Street No` | _(ignored)_ | Not stored |
| `Street Name` | _(ignored)_ | Not stored |
| `Lot#` | `LotOwner.lot_number` | Integer lot identifier |
| `Unit#` | _(ignored)_ | Unit number — not the entitlement |
| `UOE2` | `LotOwner.unit_entitlement` | Unit of Entitlement — used for weighted voting |
| `Email` | `LotOwner.email` | Voter email address |

- 147 data rows (lots 53–199+), all under building "Sandridge Bay Towers (Building 6,7 & 8)"
- Multiple lots share the same email — this is intentional (multi-lot owners)
- `UOE2` value is 1 per lot in this example; real files will have varying entitlement values
- Extra columns beyond those listed (including `Unit#`) should be silently ignored

### `examples/AGM Motion test.xlsx` — AGM motion import template

Used for AGM motion pre-fill at creation time (US-014, Excel motion import feature).

| Column | Maps to | Notes |
|--------|---------|-------|
| `Motion` | `Motion.order_index` | Integer display order |
| `Description` | `Motion.description` | Full motion text shown to voters |

- 2 data rows: motion 1 "do you like Motion 1?" and motion 2 "do you approve this budget?"
- Column names are case-insensitive during parsing
- Completely blank rows are silently skipped

---

## Vercel Deployment Environments

| Environment | Trigger | URL pattern |
|---|---|---|
| **Production** | Push to `master` (git only) | `agm-voting.vercel.app` |
| **Preview** | Push to any other branch (git only) | `agm-voting-git-<branch>-ocss.vercel.app` |
| **Development** | CLI only — `vercel deploy` from project root | temporary URL |

**Environment variables:** All required env vars are documented in `.env.example` at the project root. Copy it to `.env` for local development. For Vercel, add each variable in the dashboard or via `vercel env add`. Key vars:
- `DATABASE_URL` — Neon DB connection string (set by Vercel Neon integration automatically)
- `VITE_API_BASE_URL` — must be set to `""` (empty string) on Vercel so the frontend uses relative API paths; defaults to `http://localhost:8000` locally
- `SESSION_SECRET` — required for admin session cookies; use a random 32-byte hex string
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — admin login credentials
- `ALLOWED_ORIGIN` — CORS origin; set to the deployed frontend URL on Vercel

**IMPORTANT — CLI deployments go to Development only.** Never run `vercel deploy --prod` or target preview from the CLI. Production and Preview are exclusively managed by git push.

When investigating a Vercel deployment issue, always check which environment is affected before acting.

**Database migrations on Vercel:** Alembic migrations are never run automatically on deploy — they must be applied manually.

> **CRITICAL:** `vercel env pull` may return a DIFFERENT Neon database URL than what the deployed Lambda actually uses. Always retrieve the actual `DATABASE_URL_UNPOOLED` from a running Lambda (e.g. via a debug endpoint or the Vercel dashboard) before running migrations. Never assume the env pull result is correct.

The correct approach:
1. Deploy a temporary debug endpoint that returns `os.environ.get("DATABASE_URL_UNPOOLED")` from inside the Lambda
2. Use that URL to run the migration
3. Remove the debug endpoint and redeploy

```bash
# Once you have the correct unpooled URL from the Lambda:
DB="postgresql+asyncpg://user:pass@host/db?ssl=require"
cd backend && uv run alembic -x dburl="$DB" upgrade head
```

**Note:** `DATABASE_URL` env var set on the command line does NOT work with alembic — it reads `sqlalchemy.url` from `alembic.ini`. Always use `-x dburl=...`.

**Note:** Neon connection strings may include `channel_binding=require`. Strip this before passing to alembic/asyncpg — neither supports it. Use `ssl=require` only:
```bash
# Correct form for alembic:
DB="postgresql+asyncpg://user:pass@host/db?ssl=require"
# NOT: ?sslmode=require&channel_binding=require
```
`api/index.py` already strips `channel_binding=require` at runtime for the deployed Lambda.

---

## Container Management

> See user-level `~/.claude/CLAUDE.md` for general Podman rules. Project-specific note:

- The compose file for this project is `podman-compose.yml` at the project root

---

## Testing Standards

> See user-level `~/.claude/CLAUDE.md` for coverage targets, backend/frontend/Playwright testing standards and best practices. Project-specific scenarios are below.

### What to Test Per User Story

- **US-002 Building selector:** dropdown renders all buildings, selecting one shows AGM details, submitting without selection shows error
- **US-003 Auth form:** valid credentials advance to vote page, invalid credentials show error message, empty fields show validation errors
- **US-004 Voting page:** all motions render, Yes/No selection highlights correctly, submit button triggers confirmation dialog, confirmed submission locks inputs
- **US-005 CSV import:** file input accepts CSV, success shows import count, invalid file shows error
- **US-009 Confirmation screen:** shows after submission, lists all motions with recorded votes, inputs are disabled

---

### E2E Tests — AGM User Flows

Write one E2E test per major user flow:

1. **Full lot owner journey:** open app → select building → enter lot number + email → vote on all motions → submit → see confirmation screen
2. **Failed authentication:** enter wrong lot number/email → see error → correct credentials → proceed
3. **AGM closed state:** attempt to vote on a closed AGM → see "Voting has closed" message → see read-only confirmation if already submitted
4. **CSV import flow:** navigate to host page → upload valid CSV → verify success message and record count
5. **Close AGM and report:** manager closes AGM → confirm status changes → verify lot owners can no longer vote

---

### Example Scenarios by Domain

#### Lot owner authentication (`POST /auth/verify`)

- Valid lot number + matching email → success
- Valid lot number + wrong email → 401
- Lot number that does not exist → 401
- Lot number belonging to a different building → 401
- Empty lot number → 422
- Lot number as integer vs string
- Email with valid but unusual format (e.g. `user+tag@domain.co`)
- Email exceeding max length

#### Vote submission (`POST /agm/{id}/vote`)

- All motions answered → success
- Partial motions answered → define and test expected behaviour
- Re-submission after already voted → 409 (votes are immutable)
- Submission after AGM is closed → 403
- Motion ID from a different AGM → 422
- Unauthenticated request → 401

#### AGM close (`POST /agm/{id}/close`)

- Close an open AGM → success + email triggered
- Close an already-closed AGM → 409
- Close an AGM that does not exist → 404

#### CSV import (`POST /building/{id}/import`)

- Valid CSV with all required columns → success, returns count
- CSV missing `unit_entitlement` column → 422
- CSV with duplicate lot numbers → 422 with details of duplicates
- Empty CSV (headers only) → success with count 0
- CSV with extra/unknown columns → accepted, extra columns ignored
- Non-CSV file upload → 415
- Very large CSV (stress boundary)

#### Unit entitlement / weighted vote tallies

- All lots vote Yes → total entitlement equals sum of all entitlements
- No lots vote → Yes count = 0, No count = 0
- Mix of Yes/No → verify weighted sums are correct, not lot counts
- Lots with entitlement = 0 (if permitted) → confirm they do not affect tally
- Lots with very large entitlement values (integer overflow boundary)

---

## Commands

```bash
# Start databases (dev + test) — run from project root
podman compose -f podman-compose.yml up -d

# Install backend dependencies (run from backend/)
uv sync --extra dev

# Install frontend dependencies (run from frontend/)
npm install

# Run backend dev server (run from backend/)
uv run uvicorn app.main:app --reload --port 8000

# Run frontend dev server (run from frontend/)
npm run dev

# Run backend tests with coverage (run from backend/)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/ --cov=app --cov-report=term-missing --cov-fail-under=100 -v

# Run backend tests quickly without coverage (run from backend/)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  .venv/bin/python -m pytest --override-ini="addopts=" -q

# Run a single backend test file (run from backend/)
TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test \
  uv run pytest tests/test_models.py -v

# Run database migrations — dev DB (run from backend/)
uv run alembic upgrade head

# Run database migrations — test DB (run from backend/)
uv run alembic -x dburl=postgresql+asyncpg://postgres:postgres@localhost:5433/agm_test upgrade head

# Generate a new migration after model changes (run from backend/)
uv run alembic revision --autogenerate -m "description"

# Run frontend tests with coverage (run from frontend/)
npm run test:coverage

# Run Playwright e2e tests (run from frontend/, requires dev server running)
npm run e2e
```

---

## Architecture & Design Decisions

Key decisions that must not be inadvertently reversed:

- **Lot owner import uses upsert** — matched by `lot_number` within building. Delete-all-then-insert would cascade-delete `AGMLotWeight` records and zero out vote tallies for existing AGMs.

- **`AGMLotWeight` is a snapshot** — entitlements are captured at AGM creation time and never updated by subsequent lot owner edits or imports.

- **Auth on closed AGMs** — `POST /api/auth/verify` returns 200 (not 403) for closed AGMs. The response includes `agm_status: str` so the frontend can route to the confirmation page instead of blocking entry.

- **`voter_email` is case-sensitive** — `AGMLotWeight.voter_email` and `BallotSubmission.voter_email` must match exactly. Auth enforces this via `LotOwner.email == request.email` in SQL.
