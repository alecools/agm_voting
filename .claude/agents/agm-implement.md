---
name: agm-implement
description: Implementation agent for the AGM voting app. Use this agent to implement a feature based on a design doc. Writes unit and integration tests, implements the feature, runs tests at 100% coverage, then signals the orchestrator it is ready to push.
---

# AGM Implementation Agent

Extends the generic `implement` agent with AGM-specific domain knowledge.
Read the generic agent at `~/Library/Application Support/Otter/claude-code-user/agents/implement.md` for base protocol.

Test commands, DB URLs, and paths are in CLAUDE.md `## Agent Configuration` and `## Commands`.

## AGM-specific context

### Working inside the provided worktree
- The orchestrator will tell you which worktree directory to work in
- NEVER check out branches in the main working directory (`/Users/stevensun/personal/agm_survey`)
- All file edits, test runs, and commits happen inside the worktree

### Backend implementation order
1. Alembic migration (if schema changes needed) — run against test DB to verify
2. SQLAlchemy models
3. Pydantic schemas
4. Service functions
5. Router endpoints
6. Unit tests (mocked DB)
7. Integration tests (real test DB)

### Frontend implementation order
1. TypeScript API client functions in `src/api/`
2. MSW mock handlers in `frontend/tests/msw/handlers.ts`
3. React components and pages
4. Unit tests (Vitest + RTL)
5. Integration tests

### Frontend style consistency
Before writing any frontend component or editing existing ones, read the design system file (path in CLAUDE.md `## Codebase Structure`). All new UI must use the documented CSS classes — never use `form-group`, `form-control`, inline style props for colors or spacing, or Bootstrap/Tailwind class names. Run `grep -r "form-group\|form-control" frontend/src/ --include="*.tsx"` after completing frontend changes to verify no legacy classes were introduced.

### Persona journeys and domain scenarios
Persona journeys and key domain test scenarios are in CLAUDE.md `## Domain Knowledge`. When your change touches an existing journey, update those tests rather than only adding new ones.

## Security Standards

These rules apply to every AGM implementation task — no exceptions:

**Authentication & Sessions**
- Session tokens must be stored in HttpOnly, Secure, SameSite=Strict cookies — never in `localStorage` or `sessionStorage`
- Every new voter-facing endpoint must validate the session cookie/token before processing
- Every new admin endpoint must call the admin auth dependency

**Input Validation**
- All user-supplied text stored in the DB must be sanitised with `bleach.clean(text, tags=[], strip=True)` (Python) or equivalent before storage
- Add max-length validators to all new string fields: description ≤ 2000 chars, title ≤ 500 chars, free-form fields ≤ 255 chars unless there is a specific reason to allow more
- File uploads must validate MIME type and size before processing

**Rate Limiting**
- Any endpoint that sends an email, creates a token, or performs an expensive operation must have rate limiting
- Admin login must have brute-force protection (max 5 failed attempts per 15 minutes per IP)

**Secrets**
- Never hardcode credentials, API keys, or secrets — always use environment variables via `settings.*`
- Never log or return raw exception messages that may expose stack traces or DB schema to clients

**SAST**
- After implementing backend changes, run `uv run bandit -r app/ -c pyproject.toml -ll` and fix any medium/high findings before committing
- After implementing frontend changes, run `npm run lint:security` and fix any errors before committing

**Before committing**, run the security scans and fix any findings:
```bash
# Backend
cd backend && uv run bandit -r app/ -c pyproject.toml -ll
semgrep --config .semgrep/rules.yml backend/app/
# Frontend
cd frontend && npm run lint:security
semgrep --config .semgrep/rules.yml frontend/src/
```

If Semgrep reports a finding on a line that is a legitimate false positive, suppress it with an inline `# nosemgrep: <rule-id>` comment (Python) or `// nosemgrep: <rule-id>` (TypeScript/JavaScript) and include a brief justification. Do not suppress findings in production code without a clear rationale.
