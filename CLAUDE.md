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

### Task folder structure

| Folder | Contents |
|---|---|
| `tasks/prd/` | Product requirements documents (`prd-*.md`) |
| `tasks/design/` | Technical design docs (`design-<feature>.md`) — one per feature, written by the design agent before implementation begins |

**Design agents must write their output to `tasks/design/design-<feature>.md`** before reporting back to the orchestrator. Implementation agents must read this file before writing any code. Both files (PRD update + design doc) must be committed and included in the PR.

### Orchestrator role

The orchestrator's only job is to **plan, coordinate, and communicate with the user**. It must not use tools directly (no bash, git, gh, file reads/edits). All tool use — code changes, test runs, git operations, PR merges, file edits — must be delegated to sub-agents.

- **User approval is required for any merge into `master` (production).** The orchestrator may merge PRs into `preview` autonomously once E2E passes.
- **Agent duration tracking (required):** Record every sub-agent's task name and duration in `memory/agent-durations.md` using the `duration_ms` from the task completion notification.
- **Agent communication:** Agents must not poll for other agents. When an agent finishes work another agent is waiting on, it completes and reports to the orchestrator. The orchestrator then resumes the waiting agent via the `resume` parameter with the new information.

---

### Worktrees — MANDATORY FOR ALL AGENTS

Every agent MUST create a git worktree before doing any work. Never check out a branch in the main working directory — it corrupts state for concurrent agents.

```bash
cd /Users/stevensun/personal/agm_survey
git checkout preview && git pull origin preview
git checkout -b feat/my-feature
git worktree add /Users/stevensun/personal/agm_survey-feat-my-feature feat/my-feature
# do ALL work inside the worktree
```

The main directory (`/Users/stevensun/personal/agm_survey`) is reserved for orchestrator-level operations only.

---

### Single-agent branch workflow

Use this for features that touch only one side (backend only or frontend only), or small full-stack changes.

1. Create branch + worktree (see Worktrees section above)
2. Implement all changes; multiple commits are fine
3. Run local tests — `npm run test:coverage` (frontend) and `pytest --cov` (backend), both at 100%
4. Signal orchestrator: "Ready for push slot — awaiting orchestrator grant." **Do not push yourself.**
5. After slot is granted: `git push -u origin <branch>` — Vercel auto-deploys to `agm-voting-git-<branch>-ocss.vercel.app`
6. Wait for Vercel to deploy, then run the **full E2E suite to completion** — never stop early, record ALL failures:
   ```bash
   cd frontend && PLAYWRIGHT_BASE_URL=https://agm-voting-git-<branch>-ocss.vercel.app \
     VERCEL_BYPASS_TOKEN=<token> ADMIN_USERNAME=ocss_admin ADMIN_PASSWORD="ocss123!@#" \
     npx playwright test
   ```
   > **Run exactly once. Never re-run or self-fix.** If tests fail, record every failure and report to the orchestrator. Do not decide a failure is "flaky" or "infrastructure noise" — the orchestrator decides.
7. Release the push slot — report results to orchestrator (pass or fail)
8. Fix any recorded failures (slot is now free; another agent may hold it)
9. If fixes needed: re-queue (back to step 4, rejoins the **back** of the queue)
10. Once all E2E pass: raise a PR to `preview`
11. Merge the PR (orchestrator delegates to a sub-agent; no user approval needed for `preview`)
12. **Post-merge cleanup — REQUIRED, do not skip:**
    - Remove the git worktree: `git worktree remove /Users/stevensun/personal/agm_survey-<branch> --force`
    - Delete the local branch: `git branch -d <branch>`
    - Delete the remote branch: `git push origin --delete <branch> && git remote prune origin`
    - **Delete the Neon DB branch** (if one was created for this feature) — see Post-merge cleanup section for the API commands
    - **Delete the Vercel branch-scoped env vars** (`DATABASE_URL` + `DATABASE_URL_UNPOOLED`) if set for this branch

---

### Parallel-agent branch workflow (backend + frontend split)

Use this when a feature touches both `backend/` and `frontend/` with independent changes.

**Agent 1 — Backend** (`feat/X-backend` branch + worktree):
- Implement backend changes (schema, routes, tests) + run `pytest --cov` at 100%
- Signal orchestrator: "Backend ready." Do NOT push.

**Agent 2 — Frontend** (`feat/X-frontend` branch + worktree):
- Implement frontend changes using MSW mocks + run `npm run test:coverage` at 100%
- Signal orchestrator: "Frontend ready." Do NOT push.

**Agent 3 — Merge/test/push** (spawned after both signal ready):
1. Create combined branch + worktree: `git checkout -b feat/X && git worktree add .../agm_survey-feat-X feat/X`
2. Merge both branches: `git merge feat/X-backend && git merge feat/X-frontend`
3. Run the **full local test suite** — `pytest --cov` + `npm run test:coverage` — both at 100%
4. Fix any integration issues (API contract mismatches, merge conflicts); commit if needed
5. Signal orchestrator: "Ready for push slot — awaiting orchestrator grant."
6. After slot is granted: push, run full E2E, release slot
7. Raise PR → merge
8. **Post-merge cleanup — REQUIRED, do not skip:** remove worktrees + local/remote branches for all three branches (`feat/X-backend`, `feat/X-frontend`, `feat/X`). Delete Neon DB branch and Vercel branch-scoped env vars if created. See Post-merge cleanup section for commands.

---

### Push slot queue

One slot governs all actions that trigger a Vercel deployment. **Both pushes and PR merges require the slot.**

- Grant FIFO; reprioritise by urgency or risk if needed
- **Branch push**: hold from `git push` until E2E run completes (pass or fail)
- **PR merge**: hold from merge until Vercel post-merge deployment completes (no E2E needed)
- Agent with fixes rejoins the **back** of the queue
- If only one agent is running, grant immediately

**After all slices are merged to `preview`:** run the full E2E suite once against the `preview` URL to confirm end-to-end correctness.

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
5. After merge: delete the Neon branch and remove branch-scoped Vercel env vars

> When a PR merges to `preview`, the Vercel build runs `alembic upgrade head` against the shared preview DB as part of the build step.

---

### Post-merge cleanup

Run immediately after each PR merges (delegate to a sub-agent):

```bash
# Remove worktree + local branch
git worktree remove /Users/stevensun/personal/agm_survey-<branch> --force
git branch -d <branch>

# Delete remote branch
git push origin --delete <branch>
git remote prune origin

# Delete Neon DB branch (if created) — list then delete by ID
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w 2>/dev/null)
curl -s -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/divine-dust-41291876/branches" \
  | python3 -c "import sys,json; [print(b['id'], b['name']) for b in json.load(sys.stdin)['branches']]"
curl -s -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/divine-dust-41291876/branches/<branch_id>"

# Delete Vercel branch-scoped env vars (DATABASE_URL + DATABASE_URL_UNPOOLED)
# Use the Vercel dashboard or REST API
```

---

### Definition of Done

1. All local tests pass at 100% coverage (backend pytest + frontend vitest)
2. Branch pushed, Vercel deployed, full E2E passes against the branch preview URL
3. PR raised and merged into `preview`
4. Post-merge cleanup complete (Neon branch, Vercel env vars, worktree, local + remote git branch)

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
