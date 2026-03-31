#!/usr/bin/env bash
# cleanup-feature-branch.sh — idempotent cleanup of Neon DB branch and Vercel env vars
# for a feature branch after it has been merged (RR3-22).
#
# Usage: ./scripts/cleanup-feature-branch.sh <branch-name>
#
# Idempotent: running twice on the same branch produces no errors.
# On any step failure, the script exits non-zero and prints which resource was not cleaned.

set -euo pipefail

BRANCH="${1:-}"
if [[ -z "$BRANCH" ]]; then
  echo "ERROR: branch name is required" >&2
  echo "Usage: $0 <branch-name>" >&2
  exit 1
fi

NEON_PROJECT_ID="divine-dust-41291876"
VERCEL_PROJECT_ID="prj_qrC03F0jBalhpHV5VLK3IyCRUU6L"

# ---------------------------------------------------------------------------
# Retrieve secrets
# ---------------------------------------------------------------------------
NEON_API_KEY=$(security find-generic-password -s "agm-survey" -a "neon-api-key" -w 2>/dev/null || echo "")
VERCEL_TOKEN=$(python3 -c "import json; print(json.load(open('/Users/stevensun/Library/Application Support/com.vercel.cli/auth.json'))['token'])" 2>/dev/null || echo "")

if [[ -z "$NEON_API_KEY" ]]; then
  echo "ERROR: could not retrieve neon-api-key from keychain" >&2
  exit 1
fi
if [[ -z "$VERCEL_TOKEN" ]]; then
  echo "ERROR: could not retrieve Vercel token" >&2
  exit 1
fi

ERRORS=0

# ---------------------------------------------------------------------------
# Step 1: Delete Neon DB branch (existence check — idempotent)
# ---------------------------------------------------------------------------
echo "==> Checking for Neon DB branch: preview/${BRANCH}"
BRANCH_ID=$(curl -s "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer $NEON_API_KEY" \
  | python3 -c "
import sys,json
bs=json.load(sys.stdin).get('branches',[])
b=next((b for b in bs if b['name']==f'preview/${BRANCH}'),None)
print(b['id'] if b else '')
" 2>/dev/null || echo "")

if [[ -z "$BRANCH_ID" ]]; then
  echo "  Neon DB branch 'preview/${BRANCH}' not found — skipping (already deleted or never created)"
else
  echo "  Deleting Neon DB branch: $BRANCH_ID"
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${BRANCH_ID}" \
    -H "Authorization: Bearer $NEON_API_KEY")
  if [[ "$HTTP_STATUS" == "2"* ]]; then
    echo "  Neon DB branch deleted successfully"
  else
    echo "ERROR: Failed to delete Neon DB branch (HTTP $HTTP_STATUS)" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Step 2: Delete branch-scoped Vercel env vars (existence check — idempotent)
# ---------------------------------------------------------------------------
echo "==> Checking for Vercel env vars scoped to branch: ${BRANCH}"
ENV_IDS=$(curl -s "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env?gitBranch=${BRANCH}" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  | python3 -c "import sys,json; [print(e['id']) for e in json.load(sys.stdin).get('envs',[])]" \
  2>/dev/null || echo "")

if [[ -z "$ENV_IDS" ]]; then
  echo "  No Vercel env vars found for branch '${BRANCH}' — skipping (already deleted or never created)"
else
  while IFS= read -r ENV_ID; do
    [[ -z "$ENV_ID" ]] && continue
    echo "  Deleting Vercel env var: $ENV_ID"
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env/${ENV_ID}" \
      -H "Authorization: Bearer $VERCEL_TOKEN")
    if [[ "$HTTP_STATUS" == "2"* ]]; then
      echo "  Deleted env var $ENV_ID"
    else
      echo "ERROR: Failed to delete Vercel env var $ENV_ID (HTTP $HTTP_STATUS)" >&2
      ERRORS=$((ERRORS + 1))
    fi
  done <<< "$ENV_IDS"
fi

# ---------------------------------------------------------------------------
# Final verification
# ---------------------------------------------------------------------------
echo "==> Verifying cleanup..."

REMAINING_BRANCH=$(curl -s "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
  -H "Authorization: Bearer $NEON_API_KEY" \
  | python3 -c "
import sys,json
bs=json.load(sys.stdin).get('branches',[])
b=next((b for b in bs if b['name']==f'preview/${BRANCH}'),None)
print(b['id'] if b else '')
" 2>/dev/null || echo "")

if [[ -n "$REMAINING_BRANCH" ]]; then
  echo "ERROR: Neon DB branch 'preview/${BRANCH}' still exists after cleanup" >&2
  ERRORS=$((ERRORS + 1))
fi

REMAINING_ENVS=$(curl -s "https://api.vercel.com/v10/projects/${VERCEL_PROJECT_ID}/env?gitBranch=${BRANCH}" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('envs',[])))" \
  2>/dev/null || echo "0")

if [[ "$REMAINING_ENVS" != "0" ]]; then
  echo "ERROR: $REMAINING_ENVS Vercel env var(s) for branch '${BRANCH}' still exist after cleanup" >&2
  ERRORS=$((ERRORS + 1))
fi

if [[ $ERRORS -eq 0 ]]; then
  echo "==> Cleanup complete for branch: ${BRANCH}"
  exit 0
else
  echo "==> Cleanup finished with $ERRORS error(s) for branch: ${BRANCH}" >&2
  exit 1
fi
