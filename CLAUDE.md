# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

AGM Voting App — a web application for body corporates to run weighted voting during Annual General Meetings. See `tasks/prd-agm-voting-app.md` for the full PRD.

**Stack:** React (Vite) frontend · FastAPI backend · PostgreSQL · SQLAlchemy + Alembic · Resend (email)

---

## Architecture & Design Decisions

Key decisions that must not be inadvertently reversed:

- **Lot owner import uses upsert** — matched by `lot_number` within building. Delete-all-then-insert would cascade-delete `AGMLotWeight` records and zero out vote tallies for existing AGMs.
- **`AGMLotWeight` is a snapshot** — entitlements are captured at AGM creation time and never updated by subsequent lot owner edits or imports.
- **Auth on closed AGMs** — `POST /api/auth/verify` returns 200 (not 403) for closed AGMs. The response includes `agm_status: str` so the frontend can route to the confirmation page instead of blocking entry.
- **`voter_email` is case-sensitive** — `AGMLotWeight.voter_email` and `BallotSubmission.voter_email` must match exactly. Auth enforces this via `LotOwner.email == request.email` in SQL.
- **Alembic auto-migrates on Lambda cold start** — `api/index.py` runs `alembic upgrade head` on startup. No manual migration step is needed after deploying a branch. Do not add a second auto-migrate call.
- **Neon connection strings** — strip `channel_binding=require` before passing to alembic/asyncpg. Use `ssl=require` only. `api/index.py` does this automatically at runtime.

---

## Development Workflow

> See user-level `~/.claude/CLAUDE.md` for: PRD-before-code rule and design-first decomposition process.

### Orchestrator role

The orchestrator's only job is to **plan, coordinate, and communicate with the user**. It must not use tools directly (no bash, git, gh, file reads/edits). All tool use — code changes, test runs, git operations, CI monitoring, PR merges, file edits — must be delegated to sub-agents. The orchestrator interacts with the user to report status, ask questions, and present results from sub-agents.

**User approval is required for any merge into `master` (production).** The orchestrator may merge PRs into `preview` autonomously once CI is green.

**Agent duration tracking (required):** Every time a sub-agent completes, record its task name and duration in `memory/agent-durations.md`. Use the `duration_ms` value from the task completion notification. When the user asks for a duration summary, present the full log as a markdown table.

### Agent communication

Agents must not poll for changes from other agents. Instead:

- When an agent finishes work that another agent is waiting on (e.g. a feature agent raises a PR that a merge queue agent needs), it **completes and reports the result to the orchestrator** in its completion message.
- The **orchestrator receives the completion notification** and then **resumes the waiting agent** using the `resume` parameter, passing the new information (e.g. the PR number) in the resumed prompt.
- The waiting agent should stop after finishing its current work and wait — it should not poll `gh pr list` or sleep-loop waiting for an external event.

This keeps agents decoupled and event-driven rather than tightly coupled through shared state or polling.

### Branch workflow (required for all feature dev and bugfixes)

Every feature or bugfix must follow this process, executed by a sub-agent:

1. **Pull the latest** from the base branch before branching: `git checkout preview && git pull origin preview`, then **create a new branch** (e.g. `git checkout -b feat/my-feature`)
2. **Do all work on that branch** — multiple commits are fine and encouraged
3. **Run local tests** — `npm run test:coverage` (frontend) and `pytest --cov` (backend), both must pass at 100%
4. **Signal the orchestrator** — report local test results and send one message: "Ready for push slot — awaiting orchestrator grant." Do not push yourself.
5. **Push the branch** (only after orchestrator grants the slot) — `git push -u origin <branch>`. Vercel auto-deploys to `agm-voting-git-<branch>-ocss.vercel.app`
6. **Wait for Vercel to finish deploying**, then run the **full E2E suite to completion** — never stop early, record ALL failures:
   ```bash
   cd frontend && PLAYWRIGHT_BASE_URL=https://agm-voting-git-<branch>-ocss.vercel.app \
     VERCEL_BYPASS_TOKEN=<token> ADMIN_USERNAME=ocss_admin ADMIN_PASSWORD="ocss123!@#" \
     npx playwright test
   ```
7. **Release the push slot** — notify the orchestrator the slot is free (pass or fail)
8. **Fix all recorded failures** — while the next agent may be using the slot. Do not push during this phase
9. If fixes were needed: **re-queue** (back to step 4) for another push + test cycle
10. Once all E2E tests pass: **raise a PR** to merge into `preview`
11. **Monitor the GitHub Actions post-deploy workflow** — it runs automatically after the PR is raised. Fix any failures and re-queue if needed
12. When all tests pass including CI: **merge the PR** (orchestrator delegates merge to a sub-agent; no user approval needed)

### Orchestrator push slot queue

The shared preview environment supports only one deployment at a time to avoid test interference. **Both branch pushes and PR merges** require a push slot:

- Grant the push slot to one action at a time — FIFO by default; reprioritise by urgency or risk if needed
- **Branch push slot**: released after the agent's E2E run completes (pass or fail)
- **PR merge slot**: released after the GitHub Actions post-merge CI run completes (no E2E needed — just wait for CI green)
- An agent returning after fixing issues rejoins the **back** of the queue
- If only one agent is running, grant the slot immediately when it signals readiness

**Orchestrator merge authority:** The orchestrator may authorise PR merges, but must delegate the actual merge (and all CI monitoring) to a sub-agent. The orchestrator only interacts with the user directly — all tool use (git, gh, bash, file edits) is done by sub-agents.

**Full E2E after all slices merged:** When all PRs for a PRD implementation are merged into `preview`, run the full Playwright E2E suite once against the `preview` deployment URL to confirm end-to-end correctness.

### Parallel agents (multiple features at once)

Use **git worktrees** so each agent has its own isolated working directory:
```bash
git worktree add ../agm_survey-feat-foo feat/foo
git worktree add ../agm_survey-feat-bar feat/bar
```

**Clean up immediately after each PR is merged** (delegate to a sub-agent):

```bash
# 1. Remove the git worktree
git worktree remove ../agm_survey-feat-foo --force

# 2. Delete the local branch
git branch -d feat/foo

# 3. Delete the GitHub remote branch
git push origin --delete feat/foo
git remote prune origin

# 4. Delete the Neon DB branch (if a branch-scoped DB was created)
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w 2>/dev/null)
# List branches to find the ID:
curl -s -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/divine-dust-41291876/branches" \
  | python3 -c "import sys,json; [print(b['id'], b['name']) for b in json.load(sys.stdin)['branches']]"
# Then delete by ID:
curl -s -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/divine-dust-41291876/branches/<branch_id>"

# 5. Delete the Vercel branch-scoped env vars (DATABASE_URL and DATABASE_URL_UNPOOLED)
# Use the Vercel dashboard or the REST API (see "Isolated DB" section above for the API pattern)
```

### Isolated DB for schema-migration branches

Every feature branch that includes schema migrations MUST have its own Neon DB branch to prevent migration conflicts on the shared preview DB.

**Neon API key:** stored in the macOS keychain under service `agm-survey`, account `neon-api-key`. Retrieve with: `security find-generic-password -s "agm-survey" -a "neon-api-key" -w 2>/dev/null`

**Steps (run once when creating the feature branch):**

1. **Create a Neon branch** in the [Neon dashboard](https://console.neon.tech) — branch off `preview`. Name it after the feature.
2. **Note the pooled and unpooled connection strings** from the Neon dashboard.
3. **Set branch-scoped env vars in Vercel** using the REST API:

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

4. **Push the branch** — the Lambda auto-runs `alembic upgrade head` on first cold start.
5. **Tear down after merge** — delete the Neon branch and remove the branch-scoped Vercel env vars.

> **Note on the shared preview DB:** When a feature PR is merged to `preview`, the Lambda auto-migrates the shared preview DB on its next cold start.

### Definition of Done

A change is only complete when all of the following are true:

1. All local tests pass (`npm run test:coverage` and backend pytest with 100% coverage)
2. Branch pushed, Vercel preview deployed, full E2E suite passes against the branch preview URL
3. PR raised to `preview`, GitHub Actions post-deploy workflow passes
4. Orchestrator delegates the merge to a sub-agent; sub-agent merges the PR and waits for post-merge CI to pass
5. **Post-merge cleanup:**
   - Delete Neon feature branch (if created) and its branch-scoped Vercel env vars
   - Remove git worktree: `git worktree remove ../agm_survey-<branch> --force && git branch -d <branch>`

---

## Vercel Environments

| Environment | Trigger | URL pattern |
|---|---|---|
| **Production** | Push to `master` only | `agm-voting.vercel.app` |
| **Preview** | Push to any other branch | `agm-voting-git-<branch>-ocss.vercel.app` |

- **Never** run `vercel deploy --prod` or target production from the CLI
- All non-production deployments land in Preview and use Preview env vars
- Required env vars: `DATABASE_URL`, `VITE_API_BASE_URL` (empty string on Vercel), `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `ALLOWED_ORIGIN`

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

- **Voter journey** — authentication → lot selection → voting → confirmation. Changes to auth, lot resolution, vote submission, or UI routing must be reflected in the voter E2E spec.
- **Admin journey** — login → building/meeting management → report viewing → close meeting. Changes to admin API responses, report data, or admin UI must be reflected in admin E2E and integration tests.
- **Proxy voter journey** — authentication via proxy email → lot selection showing proxied lots → voting → confirmation. Changes to auth or vote submission must verify proxy flows are unaffected.
- **In-arrear lot journey** — authentication → lot selection with in-arrear badge → voting with not_eligible motions → confirmation. Changes to vote eligibility must verify in-arrear behaviour is preserved.

When a change affects an existing E2E scenario (new page in the voter flow, changed API response shape, renamed route), update the E2E spec — do not only add new unit tests.

### Key test scenarios by domain

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

## Example Files

Two example files live in `examples/` at the project root. Use these as test fixtures for import-related features — do not create synthetic test data when these files can be used instead.

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
