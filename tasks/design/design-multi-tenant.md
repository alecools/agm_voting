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
   - `NEON_AUTH_BASE_URL` (the `base_url` field from the enable-auth API response)
   - `VITE_NEON_AUTH_BASE_URL` (same value — required by Vite build for the frontend auth client)
   - `NEON_AUTH_COOKIE_SECRET` (independently generated via `openssl rand -base64 32`; NOT the `secret_server_key` from the API response)
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

### Implementation Notes

The following gaps were researched and resolved before implementation. The implementation agent must follow these findings exactly rather than re-researching.

---

#### Gap 1 — Package names and versions (resolved)

**Frontend npm packages (pinned):**

| Package | Version | Purpose |
|---|---|---|
| `better-auth` | `^1.6.9` | Core Better Auth library (server + client bundled) |
| `better-auth/react` | (ships with `better-auth`) | React `useSession()` hook and auth client factory |
| `better-auth/client` | (ships with `better-auth`) | Vanilla JS client — used as the base for `createAuthClient()` |

**Do NOT use `@neondatabase/auth`.** That package is a Next.js-specific wrapper (`createNeonAuth`) that depends on Next.js server APIs and is incompatible with the Vite + FastAPI stack used here.

The correct import pattern for this Vite app:

```typescript
// Create auth client (e.g. frontend/src/lib/auth-client.ts)
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_NEON_AUTH_BASE_URL,
});
```

**Backend Python packages (pinned):**

There is no Better Auth Python SDK. Server-side session validation is done via an HTTP call to the Neon Auth service (see Gap 2). The only Python dependency needed is:

| Package | Version | Purpose |
|---|---|---|
| `httpx` | `>=0.27` | Async HTTP client for calling `GET {NEON_AUTH_BASE_URL}/api/auth/get-session` |

`PyJWT` (`>=2.9`) may be added if the `session_data` cookie cache JWT strategy is used for performance, but it is not required for the primary session validation path.

---

#### Gap 2 — Session token format and validation approach (resolved — critical correction)

**The `better-auth.session_token` cookie is NOT a JWT.** It is an opaque database token that is HMAC-signed with the Better Auth secret before being stored in the cookie. Calling `jwt.decode()` on it will fail.

**The correct server-side validation approach is an HTTP introspection call:**

```python
# backend/app/dependencies.py
import httpx
from dataclasses import dataclass
from fastapi import HTTPException, Request
from app.config import settings

@dataclass
class BetterAuthUser:
    email: str
    user_id: str

async def require_admin(request: Request) -> BetterAuthUser:
    """Validate a Better Auth session by calling the Neon Auth get-session endpoint.

    Better Auth session tokens are opaque HMAC-signed cookies, not JWTs.
    The only way to validate them from a separate backend is to forward the
    cookie to the Better Auth service and receive the session payload back.
    """
    session_token = request.cookies.get("better-auth.session_token")
    if not session_token:
        raise HTTPException(status_code=401, detail="Authentication required")

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f"{settings.neon_auth_base_url}/api/auth/get-session",
                headers={"cookie": f"better-auth.session_token={session_token}"},
                timeout=5.0,
            )
        except httpx.RequestError:
            raise HTTPException(status_code=503, detail="Auth service unavailable")

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Authentication required")

    data = resp.json()
    if not data or not data.get("user"):
        raise HTTPException(status_code=401, detail="Authentication required")

    user = data["user"]
    return BetterAuthUser(
        email=user["email"],
        user_id=user["id"],
    )
```

**Response shape of `GET /api/auth/get-session`:**

```json
{
  "session": {
    "id": "session-uuid",
    "token": "opaque-token-string",
    "userId": "user-uuid",
    "expiresAt": "2025-05-30T00:00:00.000Z",
    "ipAddress": "1.2.3.4",
    "userAgent": "Mozilla/5.0 ..."
  },
  "user": {
    "id": "user-uuid",
    "email": "admin@example.com",
    "name": "Admin User",
    "emailVerified": true,
    "image": null,
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

A `null` body or a non-200 status means the session is invalid or expired.

**Performance note:** This adds a network round-trip on every admin request. If this proves too slow in practice, enable the `session_data` cookie cache with `strategy: "jwt"` on the Better Auth server instance (Neon Auth supports this). With cookie cache enabled, the `better-auth.session_data` cookie contains a HS256-signed JWT with `{"userId": "...", "expiresAt": "..."}` claims that can be decoded locally with PyJWT — but this optimisation is out of scope for the initial implementation.

**If cookie cache with JWT strategy is enabled later**, the `session_data` JWT payload contains:

| Claim | Type | Description |
|---|---|---|
| `userId` | string | Better Auth user UUID |
| `expiresAt` | ISO timestamp | Session expiry |
| (no `email` claim) | — | Email is NOT in the cached JWT; requires separate lookup |

The `session_data` JWT uses **HS256** signed with `settings.neon_auth_cookie_secret`. It does not contain an `email` claim — only `userId`. Using it for `require_admin` would require a separate DB lookup for email.

**Conclusion:** Use the HTTP introspection approach (above) for initial implementation. Do not attempt to decode `better-auth.session_token` as a JWT.

---

#### Gap 3 — Rate-limit middleware (resolved)

The `AdminLoginRateLimitMiddleware` wraps `POST /api/auth/sign-in/email` (the Better Auth sign-in endpoint) using the existing `AdminLoginAttempt` table and DB logic.

**Important:** Better Auth does not call back to notify of success or failure — the middleware must inspect the response status code from the next handler to decide whether to record a failure. A non-2xx response from the sign-in endpoint is treated as a credential failure.

```python
# To be added to backend/app/main.py

class AdminLoginRateLimitMiddleware(BaseHTTPMiddleware):
    """Rate-limit POST /api/auth/sign-in/email using the AdminLoginAttempt table.

    Mirrors the logic in admin_auth.py:admin_login but as a middleware so it
    wraps the Better Auth handler transparently:
    - Pre-request: check if the IP has >= 5 failures within the 15-minute window → 429
    - Post-response: if Better Auth returns non-2xx, record a failure; if 2xx, clear failures

    Path: /api/auth/sign-in/email only. All other requests pass through unchanged.
    """

    _TARGET_PATH = "/api/auth/sign-in/email"
    _MAX_FAILURES = 5
    _WINDOW_SECONDS = 900  # 15 minutes

    async def dispatch(self, request: Request, call_next):
        if request.method != "POST" or request.url.path != self._TARGET_PATH:
            return await call_next(request)

        from datetime import UTC, datetime, timedelta
        from sqlalchemy import delete as sql_delete, select
        from app.database import AsyncSessionLocal
        from app.models.admin_login_attempt import AdminLoginAttempt
        from app.routers.admin_auth import get_client_ip  # retained helper

        ip = get_client_ip(request)
        now = datetime.now(UTC)
        window_start = now - timedelta(seconds=self._WINDOW_SECONDS)

        async with AsyncSessionLocal() as db:
            attempt_result = await db.execute(
                select(AdminLoginAttempt)
                .where(AdminLoginAttempt.ip_address == ip)
                .with_for_update()
            )
            attempt_record = attempt_result.scalar_one_or_none()

            # Expire stale window
            if attempt_record is not None:
                if attempt_record.first_attempt_at.replace(tzinfo=UTC) < window_start:
                    await db.execute(
                        sql_delete(AdminLoginAttempt)
                        .where(AdminLoginAttempt.id == attempt_record.id)
                    )
                    await db.flush()
                    attempt_record = None

            if (
                attempt_record is not None
                and attempt_record.failed_count >= self._MAX_FAILURES
            ):
                await db.commit()
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Too many failed login attempts. Try again in 15 minutes."},
                )

            await db.commit()  # release FOR UPDATE lock before calling next

        # Call Better Auth handler
        response = await call_next(request)

        async with AsyncSessionLocal() as db:
            attempt_result = await db.execute(
                select(AdminLoginAttempt)
                .where(AdminLoginAttempt.ip_address == ip)
                .with_for_update()
            )
            attempt_record = attempt_result.scalar_one_or_none()

            if response.status_code >= 400:
                # Record failure
                if attempt_record is None:
                    db.add(AdminLoginAttempt(
                        ip_address=ip,
                        failed_count=1,
                        first_attempt_at=now,
                        last_attempt_at=now,
                    ))
                else:
                    attempt_record.failed_count += 1
                    attempt_record.last_attempt_at = now
            else:
                # Successful login — clear failure record
                if attempt_record is not None:
                    await db.execute(
                        sql_delete(AdminLoginAttempt)
                        .where(AdminLoginAttempt.id == attempt_record.id)
                    )

            await db.commit()

        return response
```

**Insertion point in `main.py`:** Register `AdminLoginRateLimitMiddleware` **after** `CSRFMiddleware` (i.e., it runs before `CSRFMiddleware` in Starlette's reversed middleware order, which is the correct order — rate-limit before CSRF). The full middleware registration order (top = outermost, bottom = innermost):

```python
app.add_middleware(CORSMiddleware, ...)           # 1. outermost
app.add_middleware(SessionMiddleware, ...)         # 2. (retained — voter OTP flow still uses it)
app.add_middleware(SecurityHeadersMiddleware)      # 3.
app.add_middleware(RequestIDMiddleware)            # 4.
app.add_middleware(CSRFMiddleware)                 # 5.
app.add_middleware(AdminLoginRateLimitMiddleware)  # 6. innermost — intercepts /api/auth/sign-in/email
```

Note: `SessionMiddleware` is retained because the voter OTP auth flow (`/api/auth/verify`) still uses Starlette sessions. Only admin auth is being migrated away from sessions.

**CSRF exemption:** Add `/api/auth/sign-in/email` to `CSRFMiddleware._EXEMPT_PATHS` so the Better Auth SDK call (which does not send `X-Requested-With`) is not blocked. Update:

```python
_EXEMPT_PATHS = {
    "/api/admin/auth/login",       # retained during migration period
    "/api/admin/auth/logout",      # retained during migration period
    "/api/admin/auth/hash-password",
    "/api/auth/sign-in/email",     # new — Better Auth sign-in
    "/api/auth/sign-out",          # new — Better Auth sign-out
}
```

---

#### Gap 4 — E2E test seeding strategy (resolved)

E2E tests must sign in as a real admin through the full Better Auth flow. There are two options:

**Recommended approach: seed via Neon Auth Management API**

Before running E2E tests, a `beforeAll` fixture calls the Neon Auth management API to create a test admin user:

```bash
POST https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth/users
Authorization: Bearer $NEON_API_KEY
Content-Type: application/json

{
  "email": "e2e-admin@test.example",
  "password": "E2eTestPassword!1",
  "name": "E2E Test Admin"
}
```

This creates the user in the Neon Auth user table. The test then calls `POST /api/auth/sign-in/email` directly (via the Better Auth client or raw fetch) to get a session cookie, then uses that cookie for all subsequent admin requests in the E2E spec.

The Playwright `beforeAll` fixture pseudocode:

```typescript
// frontend/e2e_tests/fixtures/admin-auth.ts
import { NEON_AUTH_BASE_URL } from "../config";

export async function seedE2EAdmin(neonApiKey: string, projectId: string, branchId: string) {
  // 1. Create the user via Neon Auth management API
  await fetch(
    `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/auth/users`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${neonApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "e2e-admin@test.example",
        password: "E2eTestPassword!1",
        name: "E2E Test Admin",
      }),
    }
  );
}

export async function signInAsE2EAdmin(page: Page): Promise<void> {
  // 2. Navigate to admin login and sign in with Better Auth form
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill("e2e-admin@test.example");
  await page.getByLabel("Password").fill("E2eTestPassword!1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/admin");
}
```

**Cleanup:** After each E2E run, delete the test user via:
```
DELETE https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth/users/{user_id}
```

**Alternative (simpler for local dev):** Call `POST {NEON_AUTH_BASE_URL}/api/auth/sign-up/email` directly to register a test user on the running Neon Auth instance. This does not require the Neon API key and works for both local dev and preview deployments. The cleanup step calls `POST {NEON_AUTH_BASE_URL}/api/auth/delete-user` with an admin session.

**Note:** The Neon Auth management API `POST .../auth/users` request schema is documented as `email`, `password`, `name` but the full schema is not confirmed from public documentation as of 2025-04-30. The implementation agent must test this against a real Neon Auth instance before writing the final fixture. If the management API does not support direct user creation with a known password, use the `signUp.email` alternative (second approach above).

**Do NOT bypass Better Auth by injecting test session cookies.** The E2E tests must exercise the real sign-in endpoint so the rate-limit middleware and auth flow are tested end-to-end.

---

#### Gap 5 — Neon Auth provisioning API contract (resolved)

**Enable Neon Auth on a project branch:**

```
POST https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth
Authorization: Bearer $NEON_API_KEY
Content-Type: application/json

{
  "auth_provider": "better_auth",
  "database_name": "neondb"   // optional — defaults to the project's default database
}
```

**Response (201 Created):**

```json
{
  "auth_provider": "better_auth",
  "auth_provider_project_id": "cab6949a-10e3-4d25-a879-512beed281e3",
  "pub_client_key": "pk_live_...",
  "secret_server_key": "sk_live_...",
  "jwks_url": "https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth/.well-known/jwks.json",
  "schema_name": "neon_auth",
  "table_name": "users_sync",
  "base_url": "https://ep-example.neonauth.us-east-1.aws.neon.tech/neondb/auth"
}
```

**Critical: `pub_client_key` and `secret_server_key` are returned only once.** Store them immediately.

**Env var mapping:**

| Response field | Environment variable | Usage |
|---|---|---|
| `base_url` | `NEON_AUTH_BASE_URL` | Used in `createAuthClient({ baseURL: ... })` on frontend and in `require_admin`'s introspection URL on backend |
| (operator-generated) | `NEON_AUTH_COOKIE_SECRET` | A separate secret generated by the operator (`openssl rand -base64 32`); used for session cookie signing in the Better Auth server instance. This is NOT the `secret_server_key` from the response. |
| `pub_client_key` | `NEON_AUTH_PUB_CLIENT_KEY` | Passed to `createAuthClient` if using Better Auth's server-side features directly; may not be needed in the HTTP-introspection approach |
| `secret_server_key` | `NEON_AUTH_SECRET_SERVER_KEY` | Not used by this app (which uses HTTP introspection, not the Better Auth Node.js SDK on the server) |

**Note on `NEON_AUTH_COOKIE_SECRET`:** Neon Auth documentation describes this as a separately generated secret (minimum 32 characters) for signing the `better-auth.session_data` cookie cache. It is NOT derived from `secret_server_key`. Generate with `openssl rand -base64 32` and store in Vercel env vars.

**Retrieve existing auth config (for idempotency):**

```
GET https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth
Authorization: Bearer $NEON_API_KEY
```

Returns the current auth config. If auth is already enabled, the provisioning script should skip the POST and reuse the existing `base_url`.

**Other management endpoints (same base path `…/auth/`):**

| Path suffix | Methods | Purpose |
|---|---|---|
| `/users` | POST, DELETE, PUT | Create / delete / update user roles |
| `/domains` | GET, POST, DELETE | Manage allowed redirect domains |
| `/email_and_password` | GET, PATCH | Configure email+password auth settings |
| `/email_provider` | GET, PATCH | Email delivery settings (from-address, SMTP) |
| `/plugins` | GET, PATCH | Enable/disable plugins (e.g. Organization) |

**User creation endpoint (for provisioning the initial admin):**

```
POST https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth/users
Authorization: Bearer $NEON_API_KEY
Content-Type: application/json

{
  "email": "admin@customer.com",
  "password": "...",
  "name": "Customer Admin"
}
```

The exact request schema is not fully confirmed from public documentation as of 2025-04-30. The implementation agent should test against the interactive API reference at `https://api-docs.neon.tech/reference/getting-started` before finalising the provisioning script.

---

### What is replaced

| Current | Replacement |
|---|---|
| `backend/app/routers/admin_auth.py` (190 lines) | Replaced by `require_admin` dependency using Better Auth HTTP session introspection; `get_client_ip()` helper moved to `dependencies.py` |
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

### Session validation in FastAPI

Better Auth sessions are **not JWTs**. The `better-auth.session_token` cookie holds an opaque HMAC-signed token that is only validatable by the Better Auth service. The `require_admin` dependency must call the Neon Auth HTTP API to validate it:

See the concrete implementation in "Gap 2 — Session token format and validation approach" under Implementation Notes above.

The key points are:
- Call `GET {NEON_AUTH_BASE_URL}/api/auth/get-session` with the session cookie forwarded
- A 200 response with a non-null `user` object means the session is valid
- Extract `user["email"]` and `user["id"]` to construct `BetterAuthUser`
- Do NOT attempt to decode `better-auth.session_token` with `jwt.decode()` — it will fail

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
    |-- Valid   --> opaque session cookie (better-auth.session_token) set, AdminLoginAttempt record cleared
    |
    v
Frontend: RequireAdminAuth reads Better Auth session, renders admin UI
```

### Audit trail: admin_username field

`BallotSubmission.admin_username` records which admin submitted a ballot on behalf of a voter during in-person vote entry. Currently populated from `request.session["admin_username"]` (the ADMIN_USERNAME env var value).

After the migration, populate it from the Better Auth session `user.email` (returned by the `require_admin` dependency's introspection call):

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

The Better Auth client SDK is `better-auth` v1.6.9. Use `createAuthClient` from `better-auth/react` for React hooks (`useSession()`) and `better-auth/client` for the base client factory. Do NOT use `@neondatabase/auth` — that is a Next.js-specific wrapper incompatible with the Vite stack.

### New required env vars (per deployment)

| Var | Description |
|---|---|
| `NEON_AUTH_BASE_URL` | Base URL of the Neon Auth instance (`base_url` from the enable-auth API response). Used by the FastAPI backend in `require_admin` to call the get-session endpoint. |
| `VITE_NEON_AUTH_BASE_URL` | Same value as `NEON_AUTH_BASE_URL`, exposed to the Vite frontend build. Used in `createAuthClient({ baseURL: ... })`. Set as a separate Vercel env var with the `VITE_` prefix so Vite inlines it at build time. |
| `NEON_AUTH_COOKIE_SECRET` | A randomly generated secret (≥32 chars, `openssl rand -base64 32`) used by Better Auth for session cookie signing. This is NOT the `secret_server_key` from the Neon API response — it is independently generated per deployment. |

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
| `backend/pyproject.toml` | Add `httpx>=0.27` for async HTTP calls to the Neon Auth get-session endpoint |
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
