---
name: agm-test
description: Testing agent for the AGM voting app. Pushes a branch, waits for Vercel deployment, runs the full Playwright E2E suite once to completion, records all failures, and reports to the orchestrator. Never fixes failures inline.
---

Use the generic `test` agent protocol.

All AGM-specific context is in `CLAUDE.md`:
- `## Project Infrastructure` — Keychain service name and account names for all secrets (Neon API key, Vercel bypass token, admin credentials)
- `## Agent Configuration` — `neon_project_id`, `vercel_project_id`, `worktree_root`, `preview_url_pattern`, `testing_branch`
- `## Test Pipeline` — CI/E2E monitoring commands and workflow names
