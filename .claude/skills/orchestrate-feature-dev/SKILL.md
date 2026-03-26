---
name: orchestrate-feature-dev
description: "Orchestrate feature development for the AGM voting app. Use when starting a new feature, bug fix, or task. Coordinates design → implement → test → cleanup agents across one or more branches. Invoked as /orchestrate-feature-dev."
user-invocable: true
---

# AGM Feature Dev Orchestrator

You are orchestrating feature development for the AGM voting app. You coordinate sub-agents using the `Agent` tool. All code changes, file reads, test runs, git operations, and CI monitoring must be delegated to sub-agents — never done inline in this session.

**Sub-agent types available:** `agm-design`, `agm-implement`, `agm-test`, `agm-cleanup`

---

## Push slot queue

Only one agent may push to a remote branch at a time (prevents concurrent Vercel deployments from interfering with running E2E tests).

Rules:
- Grant FIFO; reprioritise by urgency/risk if needed
- **Branch push slot**: held from `git push` until E2E run completes (pass or fail)
- **PR merge slot**: held from merge until Vercel post-merge deployment completes
- An agent with fixes re-joins the BACK of the queue
- If only one agent is active, grant immediately

---

## Workflow for a single feature

### Step 0: Assess the task

Determine:
- Is a design phase needed? (skip for trivial frontend-only changes or if implementing an existing complete design doc)
- Does the feature require schema migrations? (flag for testing agent — Neon DB branch needed)
- Can the feature be split into parallel vertical slices?
- Is this a **styling-only change**? (CSS class changes, layout tweaks, colour/spacing adjustments with no logic change) — if yes, skip E2E entirely. Run unit + integration tests only, then push and merge directly without spawning the testing agent.

### Step a: Create branch and worktree — ALWAYS FIRST

**This step is mandatory before any design, code, or test work begins.**

Spawn a sub-agent to create a worktree from the correct base branch. The base is usually `master` for new features and `preview` for fixes/hotfixes — confirm with the user if unclear.

```bash
cd /Users/stevensun/personal/agm_survey
git fetch origin
git worktree add .claude/worktree/<slug> -b <branch-name> <base-branch>
# Example (feature from master):
git worktree add .claude/worktree/my-feature -b feat/my-feature master
# Example (fix from preview):
git worktree add .claude/worktree/my-fix -b fix/my-fix preview
```

Worktree lives at: `/Users/stevensun/personal/agm_survey/.claude/worktree/<slug>`

**All subsequent agents — design, implement, test — must work exclusively inside this worktree.** The main repo root (`/Users/stevensun/personal/agm_survey`) may be on a completely different branch. Reading files from the wrong location produces an incorrect design and broken code.

### Step b: Spawn the design agent

Use `subagent_type: "agm-design"`. Provide:
- The task description
- The worktree path (e.g. `/Users/stevensun/personal/agm_survey/.claude/worktree/<slug>`)
- The PRD file path **inside the worktree** (if implementing an existing PRD)
- Explicit instruction: **read all source files from the worktree path, not the main repo root**

Wait for the design agent to report "Design complete" before proceeding.

### Step c: Spawn the implementation agent

Use `subagent_type: "agm-implement"`. Provide:
- The worktree path
- The design doc path
- The PRD path
- Any context from the design agent's report

Wait for the implementation agent to report "Ready for push slot".

### Step d: Grant the push slot

Check if any other agent holds the push slot. If free, grant it. Otherwise, queue this branch.

### Step e: Spawn the testing agent

Use `subagent_type: "agm-test"`. Provide:
- The worktree path
- The branch name
- The preview URL (pattern: `https://agm-voting-git-<branch>-ocss.vercel.app`)
- Whether schema migrations are involved (Neon DB branch needed)

The testing agent will push, create the PR, run E2E, and release the slot.

### Step f: After E2E results

**If all E2E pass:**
- Acquire the push slot (merge counts as a push slot operation)
- Spawn a sub-agent to merge the PR: `gh pr merge <number> --merge --delete-branch`
- Release the push slot after the Vercel post-merge deployment completes (~2 min)

**If E2E fail:**
- Resume the implementation agent with the failure details
- The implementation agent fixes and commits, then signals "Ready for push slot" again
- The fixed branch re-joins the BACK of the push slot queue
- Spawn the testing agent again once the slot is available

### Step g: Spawn the cleanup agent

Immediately after merge, spawn `subagent_type: "agm-cleanup"`. Provide:
- Branch name
- Worktree path
- Whether a Neon DB branch was created
- Whether Vercel env vars were set

Do NOT bundle cleanup into the merge agent — it gets skipped. Always a separate agent.

### Step h: Full preview E2E (multi-branch only)

After ALL branches for a PRD are merged to `preview`, spawn the testing agent to run the full E2E suite against `https://agm-voting-git-preview-ocss.vercel.app`.

After the preview E2E run, spawn the cleanup agent in test-data-only mode to clean up test meetings and buildings.

---

## Workflow for parallel branches (backend + frontend split)

When a feature can be split:
1. **Agent 1** — backend branch (`feat/X-backend`): design → implement → signal ready
2. **Agent 2** — frontend branch (`feat/X-frontend`): design (MSW mocks) → implement → signal ready
3. **Agent 3** — merge/test branch (`feat/X`): created after both signal ready; merges both branches, runs full local tests, signals ready for push slot
4. Run testing agent on `feat/X`; cleanup all three branches after merge

---

## Reporting to the user

Keep the user informed of:
- Which agents are running and what they're doing
- Push slot status (who holds it, queue length)
- E2E results (pass/fail counts)
- When a PR is ready to merge
- Any failures that need attention

**Merges to `preview`**: autonomous (no user approval needed) once E2E passes.
**Merges to `master`**: always require explicit user approval before proceeding.
