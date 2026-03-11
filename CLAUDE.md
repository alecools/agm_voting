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

Every feature or bugfix must follow this process, executed by a sub-agent:

1. **Create a new branch** from the current base (e.g. `git checkout -b feat/my-feature`)
2. **Do all work on that branch** — multiple commits are fine and encouraged
3. **Run local tests** — `npm run test:coverage` (frontend) and `pytest --cov` (backend), both must pass at 100%
4. **Signal the orchestrator** — report local test results and indicate readiness to deploy. Then **pause and wait** for the orchestrator to grant a deployment slot
5. **Deploy to Vercel development** (only after orchestrator grants the slot) — `vercel deploy` from project root (never `--prod`). This produces a temporary development URL
6. **Run the full E2E suite** against the deployed URL:
   ```bash
   cd frontend && PLAYWRIGHT_BASE_URL=<dev-url> VERCEL_BYPASS_TOKEN=<token> ADMIN_USERNAME=ocss_admin ADMIN_PASSWORD="ocss123!@#" npx playwright test
   ```
7. **Fix any failures**, then notify the orchestrator that the deployment slot is free
8. **Push the branch** — `git push -u origin <branch>` — once all tests pass

#### Orchestrator responsibilities (deployment queue)

The Vercel development environment is shared — only one agent may deploy and run E2E tests at a time. When acting as orchestrator over multiple sub-agents:

- Maintain a mental queue of agents waiting for the deployment slot
- Grant the slot to one agent at a time (FIFO by default; use judgement to reprioritise if one feature is more urgent or less risky)
- When the active agent reports its slot is free, immediately grant it to the next agent in the queue
- If only one agent is running, grant the slot as soon as it signals readiness — no delay

#### Parallel agents (multiple features at once)

When multiple sub-agents work in parallel:

- Use **git worktrees** so each agent has its own working directory:
  ```bash
  git worktree add ../agm_survey-feat-foo feat/foo
  git worktree add ../agm_survey-feat-bar feat/bar
  ```
- Each agent deploys independently to Vercel development (`vercel deploy`) — each gets its own temporary URL
- If agents need persistent isolated databases (e.g. for migration testing), create a separate Neon branch per feature and set `DATABASE_URL` when deploying:
  ```bash
  DATABASE_URL="..." vercel deploy
  # or add a temporary env override in the Vercel dashboard for that deployment
  ```
- Clean up worktrees after the branch is merged: `git worktree remove ../agm_survey-feat-foo`

#### Provisioning an isolated test database for a feature branch

When a feature includes schema migrations or needs a clean DB state, create a dedicated Neon branch:

1. **Create the branch in Neon** — in the Neon dashboard, branch off `preview` (not `main`) so it starts with the current preview schema. Name it after the feature (e.g. `feat/my-feature`).

2. **Run migrations on the new branch:**
   ```bash
   uv run alembic -x "dburl=postgresql+asyncpg://<user>:<pass>@<host>/neondb?ssl=require" upgrade head
   ```
   Strip `sslmode=require` → `ssl=require` and remove `channel_binding=require` if present (asyncpg does not support either).

3. **Deploy with the feature DB** — pass the branch DB URL as an env override so only this Vercel dev deployment uses it:
   ```bash
   # From the feature worktree directory:
   vercel deploy --env DATABASE_URL="postgresql://<user>:<pass>@<pooler-host>/neondb?sslmode=require&channel_binding=require" \
                 --env DATABASE_URL_UNPOOLED="postgresql://<user>:<pass>@<direct-host>/neondb?sslmode=require&channel_binding=require"
   ```
   `api/index.py` will sanitise the URL at runtime (strips `sslmode` → `ssl`, strips `channel_binding`).

4. **Run the full E2E suite** against the dev URL as normal.

5. **Tear down the Neon branch** once the feature is merged — delete it in the Neon dashboard to avoid accumulating stale branches.

### Definition of Done

A change is only complete when all of the following are true:

1. All local tests pass (`npm run test:coverage` and backend pytest with coverage)
2. Deployed to the **development** Vercel environment only — run `vercel deploy` from project root (never `--prod`)
3. All required environment variables are present in the target Vercel environment — run `vercel env ls --scope ocss` and compare against `.env.example`. Add any missing vars before testing
4. Any deployment issues (missing migrations, env vars, runtime errors) are fixed
5. The full test suite is run against the deployed development instance to confirm parity

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

**Always use Podman** — never Docker — for all container and compose operations in this project.

```bash
# Start services
podman compose up -d

# Stop services
podman compose down

# View logs
podman compose logs -f

# Run a one-off command inside a container
podman compose exec <service> <command>
```

- Use `podman compose` (not `docker compose` or `docker-compose`)
- Use `podman` (not `docker`) for any direct container commands
- The compose file is `podman-compose.yml` at the project root

---

## Testing Standards

### Coverage Target

**100% line coverage is required** — every line of code, both backend and frontend, must be exercised by at least one test. Coverage reports must be generated on every test run and a build/CI check should fail if coverage drops below 100%.

- Backend: `pytest-cov` with `--cov-fail-under=100`
- Frontend: Vitest with `coverage.thresholds` set to 100 for lines, functions, branches, and statements

The only acceptable exclusions are lines explicitly marked with `# pragma: no cover` (backend) or `/* istanbul ignore */` (frontend), and these must have a comment justifying the exclusion.

---

### Backend Testing (pytest)

Every API endpoint must have thorough tests. Apply the following techniques for all backend test suites.

#### Input Partition Testing

Divide inputs into equivalence classes and test at least one value from each class. For every endpoint parameter, identify:

- Valid inputs (normal case)
- Invalid type (e.g. string where integer expected)
- Missing required fields
- Null / empty values
- Unexpected extra fields

#### Boundary Value Analysis

Test at the edges of valid ranges, not just the middle:

- Min valid value, max valid value
- One below min, one above max
- Zero and negative numbers where relevant
- Empty string vs single character vs max-length string

#### State-Based Testing

Many endpoints behave differently depending on entity state. Test each state transition explicitly:

- AGM status: `open` → `closed` (test that actions valid in one state are rejected in the other)
- Lot owner: authenticated session vs unauthenticated vs already-voted
- Vote: before submission vs after submission (immutable)

#### Error and Edge Cases

- Duplicate records (e.g. same lot number in same building)
- Foreign key violations (e.g. AGM ID that does not exist)
- Concurrent requests (e.g. two submissions for the same lot at the same time)
- Empty collections (e.g. AGM with zero motions, building with zero lot owners)

#### Test Structure

Each API test file should be organised with clearly labelled sections:

```python
# --- Happy path ---
# --- Input validation ---
# --- Boundary values ---
# --- State / precondition errors ---
# --- Edge cases ---
```

Tests that exercise DB state must use isolated transactions or a dedicated test database — never the development database.

---

### Frontend Testing (Vitest + React Testing Library)

All React components and utility functions must be covered by unit and integration tests using Vitest and React Testing Library (RTL).

#### Unit Tests (per component)

- Render the component with required props and assert the output contains expected elements
- Test every conditional render branch (e.g. loading state, error state, empty state, populated state)
- Test all user interactions: clicks, form input, form submission, keyboard events
- Assert that the correct callbacks are called with the correct arguments
- Test components in isolation using mocked API calls (use `msw` — Mock Service Worker — to intercept fetch/axios requests)

#### Integration Tests

- Test complete user flows across multiple components wired together (e.g. building select → lot auth → vote page)
- Use RTL's `userEvent` (not `fireEvent`) to simulate realistic user interactions
- Assert on visible UI outcomes, not internal component state

#### What to Test Per User Story

- **US-002 Building selector:** dropdown renders all buildings, selecting one shows AGM details, submitting without selection shows error
- **US-003 Auth form:** valid credentials advance to vote page, invalid credentials show error message, empty fields show validation errors
- **US-004 Voting page:** all motions render, Yes/No selection highlights correctly, submit button triggers confirmation dialog, confirmed submission locks inputs
- **US-005 CSV import:** file input accepts CSV, success shows import count, invalid file shows error
- **US-009 Confirmation screen:** shows after submission, lists all motions with recorded votes, inputs are disabled

---

### End-to-End / Browser Testing (Playwright)

Playwright automates a real browser (Chromium by default) and must be used to verify complete user journeys from browser open to final state. Tests run headlessly and should be part of CI.

#### Setup

Playwright runs against the Vite dev server (or a test server). Configure `baseURL` in `playwright.config.ts` to point to the local dev server.

#### What to Cover with E2E Tests

Write one E2E test per major user flow:

1. **Full lot owner journey:** open app → select building → enter lot number + email → vote on all motions → submit → see confirmation screen
2. **Failed authentication:** enter wrong lot number/email → see error → correct credentials → proceed
3. **AGM closed state:** attempt to vote on a closed AGM → see "Voting has closed" message → see read-only confirmation if already submitted
4. **CSV import flow:** navigate to host page → upload valid CSV → verify success message and record count
5. **Close AGM and report:** manager closes AGM → confirm status changes → verify lot owners can no longer vote

#### Playwright Best Practices

- Use `page.getByRole()` and `page.getByLabel()` locators (not CSS selectors or `data-testid`) wherever possible — this tests accessibility as a side effect
- Add `data-testid` attributes only when no semantic locator is available
- Each test must be fully independent — seed the database to a known state before each test using API calls or a test fixture helper
- Assert on visible UI state after each action, not just at the end of the flow
- Use Playwright's `expect(page).toHaveURL()` and `expect(locator).toBeVisible()` assertions rather than arbitrary waits

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
