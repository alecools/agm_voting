# Design: Multi-Tenant Platform — Deployment-per-Tenant + Neon Auth

PRD reference: `tasks/prd/prd-multi-tenant.md`

**Status:** Draft

---

## Overview

This document covers the technical design for two related changes:

1. **Deployment-per-tenant model** — how multiple customers are served by separate deployments of the same codebase, and how new customers are provisioned via `scripts/provision_customer.py`.
2. **Admin auth migration to Neon Auth (Better Auth)** — replacing the legacy `ADMIN_USERNAME` / `ADMIN_PASSWORD` session-cookie auth with per-user email + password accounts managed by Neon Auth's Organization plugin.

These two changes are coupled: the provisioning script sets up both the Neon project and the Neon Auth instance for each new deployment.

---

## Architecture Overview

### Deployment-per-tenant diagram

```
Platform Operator
       |
       v
scripts/provision_customer.py
       |
       +---> Neon API --> [Neon Project: customer-a]
       |                        |
       |                   DB migrations (alembic)
       |                   Neon Auth provisioned
       |
       +---> Vercel API --> [Vercel Project: customer-a]
                                |
                           env vars injected:
                           DATABASE_URL, SESSION_SECRET, etc.


Runtime:

Voter/Admin browser
       |
       v
[Vercel Project: customer-a]       [Vercel Project: customer-b]
  Lambda + FastAPI app                Lambda + FastAPI app
       |                                      |
[Neon Project: customer-a]         [Neon Project: customer-b]
  Single PostgreSQL cluster           Single PostgreSQL cluster
  (completely separate)               (completely separate)
```

### Why this was chosen over schema-per-tenant

Schema-per-tenant within a single Neon project would require:
- A `search_path` middleware that sets the PostgreSQL schema on every DB connection for every request
- Alembic managing two migration trees (public schema and tenant schema)
- A `public.organisations` routing table
- A `public.meeting_routing` table so voter routes can resolve the correct tenant schema
- Custom session encoding of `org_id` to enforce per-org access control on every endpoint

This is a substantial amount of in-app infrastructure with a non-trivial security surface (missing a `search_path` guard on any one endpoint is a data leakage bug). The deployment-per-tenant model eliminates all of this: each deployment is a standard single-tenant app. The only new complexity is the provisioning script.

---

## Provisioning Script Design

**Path:** `scripts/provision_customer.py`

### Inputs

| Flag | Type | Description |
|---|---|---|
| `--name` | string | Customer display name (e.g. "Acme Strata Management") |
| `--slug` | string | URL-safe slug (lowercase alphanumeric + hyphens, 3-63 chars); used as Neon project name and Vercel project name |
| `--admin-email` | email | Email address for the initial admin user |
| `--plan` | enum | `free`, `standard`, or `enterprise`; determines Neon plan selection |
| `--domain` | string (optional) | Custom domain to configure on the Vercel project |

### Required environment variables for the script

| Var | Source |
|---|---|
| `NEON_API_KEY` | macOS Keychain (`agm-survey` / `neon-api-key`) or env |
| `VERCEL_API_TOKEN` | macOS Keychain (`agm-survey` / `vercel-bypass-token`) or env |

### Steps (in order)

1. **Validate inputs** — slug matches `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`, email is valid format, plan is one of the enum values. Exit with error if any check fails.

2. **Create Neon project** — `POST https://console.neon.tech/api/v2/projects` with `name: "{slug}"`. Extract `project.id`, `connection_uri` (unpooled), and the default branch connection string. If a project named `{slug}` already exists, skip and reuse.

3. **Sanitise connection string** — strip `channel_binding=require`, use `ssl=require` only (same logic as `api/index.py`).

4. **Run Alembic migrations** — execute `alembic -x dburl="{sanitised_connection_uri}" upgrade head` from the `backend/` directory. Exit non-zero if this fails.

5. **Provision Neon Auth** — call the Neon Auth provisioning API on the new Neon project to enable Better Auth. Configure the Organization plugin. Capture `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` for the next step.

6. **Create Vercel project** — `POST https://api.vercel.com/v9/projects` with `name: "{slug}"`, framework `"vite"`, and the git repository details. If a project named `{slug}` already exists, skip and reuse.

7. **Set Vercel env vars** — for the new project, set:
   - `DATABASE_URL` (Neon connection string with PgBouncer if on pooled plan, else unpooled)
   - `DATABASE_URL_UNPOOLED` (direct Neon connection)
   - `SESSION_SECRET` (randomly generated 32-byte hex string)
   - `SMTP_ENCRYPTION_KEY` (randomly generated 32-byte hex string)
   - `ALLOWED_ORIGIN` (the Vercel project URL or custom domain)
   - `VITE_API_BASE_URL` (empty string — resolved at Vercel edge)
   - `NEON_AUTH_BASE_URL`
   - `NEON_AUTH_COOKIE_SECRET`
   If any env var already exists, skip (idempotency).

8. **Create initial admin user** — call the Neon Auth API to create the first organisation and invite the `--admin-email` address as owner. Print the invite link to stdout so the operator can forward it to the customer.

9. **Configure custom domain** (optional) — if `--domain` is provided, call `POST https://api.vercel.com/v9/projects/{project_id}/domains` with the domain. Print DNS configuration instructions.

10. **Print summary** — print Neon project ID, Vercel project URL, and a confirmation that the deployment will be live on the next push.

### Idempotency

Every step checks whether the resource already exists before creating it:
- Neon: list projects, find by name
- Vercel: list projects, find by name
- Vercel env vars: list env vars for project, skip vars already present

Re-running for the same slug produces the same result without duplicating resources.

### Error handling

- Steps 1-4 are run sequentially. If the Alembic migration fails, the script exits non-zero and prints the migration error. The Neon project is left in place (idempotent re-run will skip project creation and retry the migration).
- Steps 5-9 are best-effort: partial failures are reported but the script continues so the operator can see what succeeded and what to retry manually.

---

## Admin Auth Migration Design

### What is replaced

| Current | Replacement |
|---|---|
| `backend/app/routers/admin_auth.py` (190 lines) | Better Auth JWT validation middleware |
| `backend/app/config.py` `admin_username` + `admin_password` settings | Removed; Better Auth manages the user table |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars | Removed; `NEON_AUTH_BASE_URL` + `NEON_AUTH_COOKIE_SECRET` added |
| `AdminLoginPage.tsx` — custom username/password form | Better Auth client SDK sign-in form |
| `RequireAdminAuth.tsx` — session cookie check | Better Auth session hook |
| `GET /api/admin/auth/me` — cookie introspection | Better Auth session endpoint |

### What is retained

| Component | Reason |
|---|---|
| `backend/app/models/admin_login_attempt.py` | Better Auth does not provide IP-based rate limiting; custom `AdminLoginAttempt` table and middleware are kept |
| `get_client_ip()` helper | Still needed for IP extraction from X-Forwarded-For |
| IP-based rate limiting logic (5 failures / 15 min / 429) | Security requirement independent of Better Auth |
| `admin_username` field on `BallotSubmission` | Audit trail; populated from Better Auth session `user.email` |

### JWT validation in FastAPI

Better Auth issues a JWT on successful sign-in. The `require_admin` dependency changes from a session cookie lookup to a JWT validation:

```python
# New require_admin dependency (pseudocode)
async def require_admin(request: Request) -> BetterAuthUser:
    token = request.cookies.get("better-auth.session_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = jwt.decode(token, settings.neon_auth_cookie_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Authentication required")
    return BetterAuthUser(email=payload["email"], user_id=payload["sub"])
```

The actual JWT algorithm and claim names depend on the Better Auth version; the implementation agent must consult the Better Auth documentation for the exact claim keys.

### Admin login flow (new)

```
AdminLoginPage (Better Auth SDK sign-in)
    |
    v
POST /api/auth/sign-in/email (Better Auth endpoint, mounted at /api/auth)
    |
    v
Rate-limit check via AdminLoginAttempt middleware
    |-- Too many failures --> 429
    |
    v
Better Auth validates email + password against its user table
    |-- Invalid --> 401 (AdminLoginAttempt.failed_count incremented)
    |-- Valid   --> JWT cookie set, AdminLoginAttempt record cleared
    |
    v
Frontend: RequireAdminAuth reads Better Auth session, renders admin UI
```

### Audit trail: admin_username field

`BallotSubmission.admin_username` records which admin submitted a ballot on behalf of a voter during in-person vote entry. Currently populated from `request.session["admin_username"]` (the ADMIN_USERNAME env var value).

After the migration, populate it from the Better Auth JWT claim `user.email`:

```python
# In admin vote entry service
admin_user = require_admin(request)  # returns BetterAuthUser
submission.admin_username = admin_user.email
```

This preserves the audit trail with a more meaningful identifier (email vs. shared username string).

### Frontend changes

| File | Change |
|---|---|
| `frontend/src/pages/admin/AdminLoginPage.tsx` | Replace custom form with Better Auth client `signIn.email()` call |
| `frontend/src/components/admin/RequireAdminAuth.tsx` | Replace session cookie check with Better Auth `useSession()` hook |
| `frontend/src/api/` — any function calling `/api/admin/auth/login` or `/api/admin/auth/me` | Remove; replaced by Better Auth SDK calls |

The Better Auth client SDK is `@neondatabase/neon-js/auth` (or the standalone `better-auth/client` package — the implementation agent must verify the correct package name against the Neon Auth Beta documentation at the time of implementation).

### New required env vars (per deployment)

| Var | Description |
|---|---|
| `NEON_AUTH_BASE_URL` | Base URL of the Neon Auth instance for this deployment's Neon project |
| `NEON_AUTH_COOKIE_SECRET` | Secret used to sign Better Auth session cookies / JWTs |

### Removed env vars

| Var | Reason |
|---|---|
| `ADMIN_USERNAME` | Replaced by Better Auth user email |
| `ADMIN_PASSWORD` | Replaced by Better Auth user table with hashed passwords |

---

## Neon Auth Setup per Deployment

Neon Auth is provisioned once per Neon project (i.e. once per customer deployment) during the provisioning script run. The following steps are performed by the script:

1. **Enable Neon Auth** on the Neon project via the Neon API (`POST /api/v2/projects/{project_id}/auth`).
2. **Configure Organization plugin** — 1 organisation per deployment represents the customer's company. The initial organisation is created with the customer name from `--name`.
3. **Create initial admin user** — the `--admin-email` address is invited as organisation owner. Better Auth sends the invite email; the customer sets their password on first login.
4. **Capture env vars** — `NEON_AUTH_BASE_URL` and `NEON_AUTH_COOKIE_SECRET` are returned by the provisioning API and injected into the Vercel project env vars (step 7 of the provisioning script).

### Neon Auth Better Auth integration points

| Better Auth plugin | Purpose |
|---|---|
| Email + password | Primary auth method for admin users |
| Organization plugin | Manages the 1:1 org-per-deployment, invite flow, roles (owner/admin/member) |

No OAuth or SSO plugins are enabled in this version.

---

## Test Migration Plan

The auth layer change requires significant test rewrites. The table below maps current test files to their replacement strategy.

### Backend tests

| Current test file | Lines | Change required |
|---|---|---|
| `tests/test_admin_auth.py` | ~812 lines | Full rewrite — mock Better Auth JWT validation instead of session cookie; rewrite login, logout, me, rate-limit, and hash-password scenarios around JWT mocking |
| `tests/test_admin.py` (sections using `require_admin`) | Partial | Replace session cookie injection in test fixtures with JWT token injection |

**JWT mocking approach for backend tests:**

Override the `require_admin` dependency in test fixtures to return a `BetterAuthUser` with a test email. Do not attempt to construct real Better Auth JWTs in tests — inject the dependency directly:

```python
# In conftest.py
async def override_require_admin():
    return BetterAuthUser(email="test-admin@example.com", user_id="test-user-id")

app.dependency_overrides[require_admin] = override_require_admin
```

### Frontend tests

| Current test file | Lines | Change required |
|---|---|---|
| `frontend/src/pages/admin/__tests__/AdminLoginPage.test.tsx` | ~154 lines | Rewrite — mock Better Auth client `signIn.email()` instead of the `/api/admin/auth/login` MSW handler |
| `frontend/src/components/admin/__tests__/RequireAdminAuth.test.tsx` | Partial | Replace session cookie mock with Better Auth `useSession()` mock |
| `frontend/tests/msw/handlers.ts` — `/api/admin/auth/login` handler | Remove | No longer needed; Better Auth SDK calls are mocked at the SDK level |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Neon Auth and Organization plugin are in Beta — API may change | Pin the Neon Auth SDK version. Document the version used. Monitor the Neon Auth changelog. Accept that an API break may require a patch before the next customer provisioning. |
| Better Auth is email-first; current ADMIN_USERNAME is a plain string | The initial admin user must be registered as an email address (e.g. `admin@customer.com`). The provisioning script enforces this. Operators who previously used a non-email username must create a new admin account during migration. |
| Session cutover for existing single-tenant deployments | Existing sessions (Starlette session cookies) will be invalidated when the auth layer is swapped. Admins will be redirected to the new Better Auth login page on their next request. This is acceptable — no data is lost. |
| JWT secret rotation | `NEON_AUTH_COOKIE_SECRET` is set during provisioning and stored in Vercel env vars. Rotation requires re-deploying all instances (one per customer). Document the rotation procedure in `docs/runbooks/`. |
| Rate-limit bypass if Better Auth handles login before the middleware | The custom rate-limit middleware must wrap the Better Auth sign-in endpoint, not just the old `/api/admin/auth/login` path. Mount the middleware at the FastAPI app level to intercept all requests to `/api/auth/sign-in/email`. |

---

## Files to Change

| File | Change |
|---|---|
| `scripts/provision_customer.py` | New file — provisioning CLI script |
| `backend/app/routers/admin_auth.py` | Remove entirely; replaced by Better Auth JWT middleware |
| `backend/app/config.py` | Remove `admin_username` and `admin_password` settings; add `neon_auth_base_url` and `neon_auth_cookie_secret` |
| `backend/app/main.py` | Mount Better Auth endpoint at `/api/auth`; swap session middleware for JWT middleware; keep `AdminLoginAttempt` rate-limit middleware |
| `backend/app/dependencies.py` (or equivalent) | Rewrite `require_admin` dependency to validate Better Auth JWT |
| `frontend/src/pages/admin/AdminLoginPage.tsx` | Replace custom form with Better Auth client sign-in |
| `frontend/src/components/admin/RequireAdminAuth.tsx` | Replace session cookie check with Better Auth `useSession()` hook |
| `frontend/src/api/` — admin auth functions | Remove login/logout/me API client functions; replaced by Better Auth SDK |
| `frontend/tests/msw/handlers.ts` | Remove `/api/admin/auth/login` handler |
| `frontend/package.json` | Add Better Auth client SDK dependency |
| `backend/pyproject.toml` | Add Better Auth server-side dependency (if applicable) |
| `vercel.json` | No change to buildCommand; env var list in docs updated |
| `tasks/prd/prd-multi-tenant.md` | Already updated (this branch) |

---

## Schema Migration Required

No — this change does not modify the PostgreSQL schema. The `admin_login_attempt` table is retained unchanged. Better Auth manages its own user table inside the Neon Auth service (not in the application's database).

---

## E2E Test Scenarios

### Happy path

1. Platform operator runs `scripts/provision_customer.py --slug acme-strata --name "Acme Strata" --admin-email admin@acme-strata.com --plan standard`
2. Script completes without error; prints invite link
3. Admin opens invite link, sets password
4. Admin logs in at `/admin/login` with email + password
5. Admin is redirected to the admin dashboard; all existing admin features are accessible
6. Admin creates a building, imports lot owners, creates an AGM — all operations succeed
7. Admin logs out; session is cleared; `/admin/login` is shown on next visit

### Error/edge cases

- Login with invalid email → 401; `AdminLoginAttempt` failure count incremented
- Login with valid email + wrong password → 401; failure count incremented
- 5 consecutive failures from the same IP → 429 returned on the 6th attempt
- After 15-minute window expires → failure count resets; login succeeds again
- Expired invite link → error message shown; operator must re-send invite
- Already-used invite link → error message shown
- Provisioning script run twice for the same slug → second run is a no-op; no duplicate resources created

### State-based scenarios

- Admin session active → `RequireAdminAuth` renders children; admin can navigate freely
- Admin session missing (cookie absent) → `RequireAdminAuth` redirects to `/admin/login`
- Admin session expired (JWT exp claim past) → `require_admin` dependency returns 401; frontend redirects to login
- Admin submits in-person vote → `BallotSubmission.admin_username` is set to the admin's email address

### Multi-step sequence

1. Provision new customer (CLI)
2. Admin accepts invite, sets password
3. Admin logs in → dashboard loads
4. Admin creates building → creates AGM → adds motions
5. Voter authenticates via OTP → votes
6. Admin closes meeting → results visible
7. Admin logs out → session cleared

This sequence must have an E2E test that covers steps 3-7 against a fresh provisioned deployment. The implementation agent must write this as a Playwright test in `frontend/tests/e2e/admin-auth-neon.spec.ts`.

### Existing E2E specs affected

The Neon Auth swap affects the **Admin persona journey** end-to-end. The following existing E2E specs must be updated to use the new Better Auth sign-in flow rather than the legacy username/password form:

- Any spec that calls `AdminLoginPage` with a username field must be updated to use the email field
- Any spec that seeds admin auth state via direct session manipulation must be updated to use Better Auth token injection
- `frontend/tests/e2e/admin-*.spec.ts` — all admin journey specs are affected

---

## Vertical Slice Decomposition

This feature can be split into two independently deployable slices:

**Slice 1: Provisioning script** (`scripts/provision_customer.py`)
- No app code changes
- Testable by running the script against a test Neon + Vercel account
- Does not block Slice 2

**Slice 2: Neon Auth admin login swap**
- Backend: replace `admin_auth.py`, update `require_admin` dependency, add JWT middleware
- Frontend: swap `AdminLoginPage`, `RequireAdminAuth`, remove MSW handler
- Tests: full rewrite of auth test suite
- Depends on Slice 1 only for the provisioning env vars; can be developed against a manually provisioned Neon Auth instance

Slices can proceed in parallel if two developers are available. Slice 2 is the higher-risk slice due to the Beta status of Neon Auth.
