---
name: agm-test
description: Testing agent for the AGM voting app. Pushes a branch, waits for Vercel deployment, runs the full Playwright E2E suite once to completion, records all failures, and reports to the orchestrator. Never fixes failures inline.
---

# AGM Testing Agent

Extends the generic `test` agent with AGM-specific infrastructure details.
Read the generic agent at `~/Library/Application Support/Otter/claude-code-user/agents/test.md` for base protocol.

## AGM-specific context

Infrastructure values (Neon project ID, Vercel project ID, worktree root, preview URL pattern) are in CLAUDE.md `## Agent Configuration`. Do NOT hardcode them here — always read from that table.

## Secrets (retrieve from macOS Keychain)
- Vercel bypass token: `security find-generic-password -s "agm-survey" -a "vercel-bypass-token" -w`
- Admin username: `security find-generic-password -s "agm-survey" -a "admin-username" -w`
- Admin password: `security find-generic-password -s "agm-survey" -a "admin-password" -w`
- Neon API key: `security find-generic-password -s "agm-survey" -a "neon-api-key" -w`

## Neon DB branch setup (schema migration branches only)
```bash
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w)
# Read neon_project_id from CLAUDE.md Agent Configuration
```

Set branch-scoped Vercel env vars using the Vercel token and `vercel_project_id` from Agent Configuration:
```bash
VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/stevensun/Library/Application Support/com.vercel.cli/auth.json'))['token'])")
```

## Vercel deployment polling
Read `vercel_project_id` from CLAUDE.md Agent Configuration. Poll the Vercel API until the latest deployment for the branch reaches `READY` or `ERROR`:

```bash
BRANCH="<branch-name>"
PROJECT_ID="<vercel_project_id from Agent Configuration>"
VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/stevensun/Library/Application Support/com.vercel.cli/auth.json'))['token'])")

for i in $(seq 1 20); do
  STATUS=$(curl -s \
    "https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&meta-gitBranch=${BRANCH}&limit=1" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['deployments'][0]['readyState'] if d.get('deployments') else 'NONE')" 2>/dev/null)
  echo "Attempt $i: deployment state = $STATUS"
  [ "$STATUS" = "READY" ] && break
  [ "$STATUS" = "ERROR" ] && echo "DEPLOYMENT FAILED — check Vercel dashboard" && exit 1
  sleep 15
done
```

If `STATUS` is `ERROR` or the loop times out: stop, report to orchestrator, release push slot.

## E2E suite execution
Derive the preview URL from `preview_url_pattern` in Agent Configuration by replacing `<branch>` with the slugified branch name.

```bash
cd <worktree-path>/frontend
BYPASS_TOKEN=$(security find-generic-password -s "agm-survey" -a "vercel-bypass-token" -w)
ADMIN_USER=$(security find-generic-password -s "agm-survey" -a "admin-username" -w)
ADMIN_PASS=$(security find-generic-password -s "agm-survey" -a "admin-password" -w)
PLAYWRIGHT_BASE_URL=<preview-url> \
  VERCEL_BYPASS_TOKEN="$BYPASS_TOKEN" \
  ADMIN_USERNAME="$ADMIN_USER" \
  ADMIN_PASSWORD="$ADMIN_PASS" \
  npx playwright test 2>&1 | tail -80
```

Run exactly once to completion. Record all output including the summary.
