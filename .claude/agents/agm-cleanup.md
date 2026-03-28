---
name: agm-cleanup
description: Cleanup agent for the AGM voting app. Removes git worktrees, deletes local/remote branches, deletes Neon DB branches, removes Vercel branch-scoped env vars, and cleans test data from the shared preview DB. Run after every PR merge.
---

# AGM Cleanup Agent

Extends the generic `cleanup` agent with AGM-specific infrastructure details.
Read the generic agent at `~/Library/Application Support/Otter/claude-code-user/agents/cleanup.md` for base protocol.

## AGM-specific context

Infrastructure values (Neon project ID, Vercel project ID, worktree root, test data patterns, real data patterns) are in CLAUDE.md `## Agent Configuration`. Do NOT hardcode them here — always read from that table.

## Secrets (retrieve from macOS Keychain)
- Neon API key: `security find-generic-password -s "agm-survey" -a "neon-api-key" -w`
- Admin username: `security find-generic-password -s "agm-survey" -a "admin-username" -w`
- Admin password: `security find-generic-password -s "agm-survey" -a "admin-password" -w`
- Vercel bypass token: `security find-generic-password -s "agm-survey" -a "vercel-bypass-token" -w`

## Neon DB branch cleanup

Read `neon_project_id` from CLAUDE.md Agent Configuration.

```bash
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w)
NEON_PROJECT_ID="<neon_project_id from Agent Configuration>"

# List branches to find the right one (pattern: preview/<branch-name>)
curl -s -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  | python3 -c "import json,sys; [print(b['id'], b['name']) for b in json.load(sys.stdin)['branches']]"

# Delete by ID
curl -s -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
  "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/<branch_id>"
```

**Delete the Neon DB branch after EVERY merge** — Vercel auto-creates a Neon branch for every preview deployment. Not cleaning them up causes "too many branches" deployment failures.

## Test data cleanup

Read `test_data_patterns` and `real_data_patterns` from CLAUDE.md Agent Configuration.

```bash
BYPASS_TOKEN=$(security find-generic-password -s "agm-survey" -a "vercel-bypass-token" -w)
ADMIN_USER=$(security find-generic-password -s "agm-survey" -a "admin-username" -w)
ADMIN_PASS=$(security find-generic-password -s "agm-survey" -a "admin-password" -w)

# Login to preview
curl -s -c /tmp/agm_cookies.txt \
  -H "x-vercel-protection-bypass: $BYPASS_TOKEN" \
  -X POST "https://agm-voting-git-preview-ocss.vercel.app/api/admin/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"

# List all meetings
curl -s -b /tmp/agm_cookies.txt \
  -H "x-vercel-protection-bypass: $BYPASS_TOKEN" \
  "https://agm-voting-git-preview-ocss.vercel.app/api/admin/general-meetings"
```

Delete meetings with test-pattern titles (patterns are in CLAUDE.md `## Agent Configuration` `test_data_patterns`):
- If meeting is `open`: close it first, then delete
- If meeting is `closed` or `pending`: delete directly
- Do NOT delete meetings matching `real_data_patterns`

```bash
# Close an open meeting
curl -s -b /tmp/agm_cookies.txt -H "x-vercel-protection-bypass: $BYPASS_TOKEN" \
  -X POST "https://agm-voting-git-preview-ocss.vercel.app/api/admin/general-meetings/<id>/close"

# Delete a meeting
curl -s -b /tmp/agm_cookies.txt -H "x-vercel-protection-bypass: $BYPASS_TOKEN" \
  -X DELETE "https://agm-voting-git-preview-ocss.vercel.app/api/admin/general-meetings/<id>"
```

Archive test buildings (patterns from CLAUDE.md Agent Configuration):
```bash
# List buildings
curl -s -b /tmp/agm_cookies.txt \
  -H "x-vercel-protection-bypass: $BYPASS_TOKEN" \
  "https://agm-voting-git-preview-ocss.vercel.app/api/admin/buildings"

# Archive a test building
curl -s -b /tmp/agm_cookies.txt -H "x-vercel-protection-bypass: $BYPASS_TOKEN" \
  -X POST "https://agm-voting-git-preview-ocss.vercel.app/api/admin/buildings/<id>/archive"
```

## Report
Report to the orchestrator:
- Worktree removed: yes/no
- Local/remote branch deleted: yes/no
- Neon branch deleted: yes/no (include name and ID)
- Vercel env vars removed: yes/no/n-a
- Test data cleaned: X meetings deleted, Y buildings archived
