# Design: Admin User Management

PRD reference: `tasks/prd/prd-platform.md` — US-USR-01, US-USR-02, US-USR-03

**Status:** Implemented

---

## Overview

Admins need a way to manage who has access to the admin panel. Today, admin users are created exclusively via the `scripts/provision_customer.py` provisioning script (or manually via the Neon Auth management API). There is no in-app surface for listing, adding, or removing admin accounts.

This feature adds a "Users" page to the admin panel at `/admin/users` that lets any authenticated admin:

1. **List** all current admin users (email, created date).
2. **Invite** a new admin user by email — the backend creates the account in Neon Auth and immediately triggers a password-reset email so the invitee sets their own password.
3. **Remove** an admin user — with a guard that prevents removing the last remaining admin, and a UI-level guard that hides the Remove button on the current user's own row.

The role model is flat: any authenticated admin can perform all three operations.

---

## Architecture Decision: Where User Management Lives

Neon Auth is a managed Better Auth service. It exposes two surfaces relevant here:

- **The Better Auth HTTP API** (proxied by the app at `/api/auth/*`) — handles sign-in, sign-out, session management. Does not have a user-listing or user-deletion endpoint that is accessible to app sessions.
- **The Neon Auth management API** (`https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth/users`) — a REST API authenticated with a `NEON_API_KEY`. Supports `GET` (list users), `POST` (create user), and `DELETE` (delete user).

The existing auth proxy (`/api/auth/*`) is designed for browser-to-auth-service calls (sign-in, session, password reset). It is not suitable for management operations because:

- It forwards the browser session cookie, not a server-side API key.
- The Neon management API requires a `NEON_API_KEY` bearer token, which must never be exposed to the browser.

**Decision:** Add dedicated backend endpoints under `/api/admin/users` that call the Neon Auth management API server-side using `NEON_API_KEY` and `NEON_PROJECT_ID` / `NEON_BRANCH_ID` config. The frontend calls these FastAPI endpoints (which are already protected by `require_admin`), not the Neon API directly.

---

## Backend Changes

### New config settings (`backend/app/config.py`)

Three new `Settings` fields are required:

| Field | Env var | Description |
|---|---|---|
| `neon_api_key` | `NEON_API_KEY` | Bearer token for the Neon management API. Empty in local dev — user management endpoints return 503 when absent. |
| `neon_project_id` | `NEON_PROJECT_ID` | Neon project ID (e.g. `curly-lab-57416583`). Required alongside `neon_api_key`. |
| `neon_branch_id` | `NEON_BRANCH_ID` | The Neon branch ID where Neon Auth is provisioned (e.g. the `main` branch ID). Required for management API calls. |

All three default to empty string. When any of the three is empty, the user management endpoints return `503 Service Unavailable` with body `{"detail": "User management not configured"}`. This keeps local dev functional without requiring Neon credentials.

The `neon_api_key` value is a secret. It must never appear in logs or API responses. It follows the same handling pattern as `smtp_encryption_key`.

### New service module (`backend/app/services/neon_auth_service.py`)

This module owns all calls to the Neon Auth management API. It is the only place in the codebase that touches `NEON_API_KEY`.

#### Neon Auth management API — base URL and endpoints

```
Base: https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/auth
```

| Operation | Method | Path suffix |
|---|---|---|
| List users | GET | `/users` |
| Create user | POST | `/users` |
| Delete user | DELETE | `/users/{user_id}` |
| Trigger password reset | POST | (see below) |

**Password reset trigger:** After creating a new user, the service calls the Better Auth password-reset endpoint via the Neon Auth base URL (not the management API). The Neon Auth base URL is already in `settings.neon_auth_base_url`. The call:

```
POST {neon_auth_base_url}/request-password-reset
Content-Type: application/json
{"email": "...", "redirectTo": "{allowed_origin}/admin/login"}
```

This is the same endpoint the existing `auth_proxy.py` translates `forget-password` to. Calling it server-side (without a session cookie) triggers the password-reset email flow in Neon Auth.

#### Data shapes

**Neon Auth management API `GET /users` response:**
```json
{
  "users": [
    {
      "id": "user-uuid",
      "email": "admin@example.com",
      "name": "Admin User",
      "emailVerified": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**Neon Auth management API `POST /users` request:**
```json
{
  "email": "newadmin@example.com",
  "name": "",
  "password": "<randomly generated — discarded immediately after creation>"
}
```

A password is required by the management API to create the account. The service generates a cryptographically random 32-character string using `secrets.token_urlsafe(32)` and discards it immediately after the API call completes. The invitee sets their own password via the password-reset email.

**Neon Auth management API `DELETE /users/{user_id}`:** No body required. Returns 200 on success.

#### Service functions

```python
async def list_admin_users() -> list[AdminUserOut]:
    """Fetch all users from the Neon Auth management API.
    Raises NeonAuthNotConfiguredError if neon_api_key/project_id/branch_id are absent.
    Raises NeonAuthServiceError on non-200 response from Neon.
    """

async def invite_admin_user(email: str, redirect_origin: str) -> AdminUserOut:
    """Create a user in Neon Auth and trigger a password-reset email.
    Steps:
      1. POST /users to create the account with a random discarded password.
      2. POST {neon_auth_base_url}/request-password-reset to send the setup email.
    Raises NeonAuthNotConfiguredError if config is absent.
    Raises NeonAuthDuplicateUserError if the email already exists (Neon returns 409).
    Raises NeonAuthServiceError on other non-2xx responses.
    """

async def remove_admin_user(user_id: str) -> None:
    """Delete a user from Neon Auth.
    Raises NeonAuthNotConfiguredError if config is absent.
    Raises NeonAuthUserNotFoundError if the user does not exist (Neon returns 404).
    Raises NeonAuthServiceError on other non-2xx responses.
    """
```

Custom exception hierarchy (defined in `neon_auth_service.py`):
- `NeonAuthNotConfiguredError` — maps to 503
- `NeonAuthDuplicateUserError` — maps to 409
- `NeonAuthUserNotFoundError` — maps to 404
- `NeonAuthServiceError` — maps to 502 (upstream error)

#### Last-admin guard

The `remove_admin_user` function **does not** implement the last-admin guard — it only calls the Neon API. The guard lives in the router, which fetches the user list first:

```python
users = await neon_auth_service.list_admin_users()
if len(users) <= 1:
    raise HTTPException(status_code=409, detail="Cannot remove the last admin user.")
```

This is a lightweight check (one API call) and correct for the expected scale (2–10 users). It is not atomic with the delete, but the race condition (two admins simultaneously removing each other as the last admin) is acceptable at this scale and does not cause data corruption — the worst case is an empty admin user list, which is self-healing via the Neon console.

### New Pydantic schemas (`backend/app/schemas/admin.py`)

```python
class AdminUserOut(BaseModel):
    id: str
    email: str
    created_at: datetime  # parsed from Neon's "createdAt" ISO string

class AdminUserListOut(BaseModel):
    users: list[AdminUserOut]

class AdminUserInviteRequest(BaseModel):
    email: EmailStr  # Pydantic validates email format; 422 on invalid
```

### New router endpoints (`backend/app/routers/admin.py`)

All three endpoints are added to the existing `admin` router, which already has `dependencies=[Depends(require_admin)]`.

#### `GET /api/admin/users`

- Calls `neon_auth_service.list_admin_users()`
- Returns `AdminUserListOut`
- 503 if Neon Auth is not configured

#### `POST /api/admin/users/invite`

Request body: `AdminUserInviteRequest`

- Derives `redirect_origin` from `settings.allowed_origin`
- Calls `neon_auth_service.invite_admin_user(email, redirect_origin)`
- Returns `AdminUserOut` of the newly created user (201)
- 409 if email already exists
- 422 if email is not a valid email address (Pydantic validation)
- 503 if Neon Auth is not configured

Rate limiting: this endpoint sends an email. Apply the same `admin_import_limiter` pattern (or a dedicated `admin_invite_limiter`) capped at 10 calls per 10 minutes per authenticated session. This prevents abuse of the invite flow as an email-sending vector.

#### `DELETE /api/admin/users/{user_id}`

Path parameter: `user_id: str`

- `require_admin` dependency provides `current_user: BetterAuthUser` with `current_user.user_id`
- If `user_id == current_user.user_id`: return 403 `{"detail": "Cannot remove yourself."}` — this is a server-side guard in addition to the UI-level hide
- Fetches user list and checks `len(users) <= 1` → 409 `{"detail": "Cannot remove the last admin user."}`
- Calls `neon_auth_service.remove_admin_user(user_id)`
- Returns 204 No Content on success
- 404 if user not found
- 503 if Neon Auth is not configured

---

## Frontend Changes

### New API client (`frontend/src/api/users.ts`)

```typescript
export interface AdminUser {
  id: string;
  email: string;
  created_at: string;  // ISO 8601 UTC
}

export interface AdminUserListResponse {
  users: AdminUser[];
}

export async function listAdminUsers(): Promise<AdminUserListResponse>
export async function inviteAdminUser(email: string): Promise<AdminUser>
export async function removeAdminUser(userId: string): Promise<void>
```

`removeAdminUser` calls `DELETE /api/admin/users/{userId}` and returns void on 204.

### New page (`frontend/src/pages/admin/UsersPage.tsx`)

The page renders an `admin-card` with:

1. **Header row** — title "Admin Users" (`admin-card__title`) and an "Invite admin" button (`.btn--primary`).
2. **Invite form** — inline, below the header, shown only when the invite button has been clicked. Contains a single email input (`.field__input`) and a "Send invite" button (`.btn--primary`) plus a "Cancel" link (`.btn--ghost`). On submit: loading state, success message, or inline error. Form is hidden again after success.
3. **User table** — rendered inside an `.admin-table-wrapper`:
   - Columns: "Email", "Created"
   - "Email" cell: the email string, with " (you)" appended in muted style when `user.id === currentUserId`
   - "Created" cell: `new Date(user.created_at).toLocaleDateString()` in `en-AU` locale
   - "Remove" column: a `.btn--danger` button per row, hidden entirely for the current user's own row
   - Remove triggers an inline confirmation dialog (modal pattern from `design-system.md` section 8) showing the email to be removed, with "Remove" (`.btn--danger`) and "Cancel" (`.btn--ghost`) buttons
4. **Loading state** — `<p className="state-message">Loading users…</p>` while the initial fetch is in flight
5. **Error state** — `<p className="state-message state-message--error">Failed to load users.</p>` if the fetch fails
6. **Empty state** — `<p className="state-message">No admin users found.</p>` (should not occur in practice but required by frontend standards)
7. **Remove error** — inline below the table: `<p className="state-message state-message--error">{removeError}</p>` — covers both the last-admin 409 and the self-removal 403

The current user's ID is obtained from `authClient.getSession()`, which returns the Better Auth session object containing `user.id`. This is called once on mount and stored in state.

### Route registration (`frontend/src/routes/AdminRoutes.tsx`)

Add one route inside the `RequireAdminAuth` block:

```tsx
<Route path="users" element={<UsersPage />} />
```

### Sidebar nav link (`frontend/src/pages/admin/AdminLayout.tsx`)

Add a "Users" nav item to the `NavContent` component, between the existing "Settings" item and the "← Voter portal" link:

```tsx
<li className="admin-nav__item">
  <NavLink
    to="/admin/users"
    className={({ isActive }) =>
      `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
    }
    onClick={onNavClick}
  >
    Users
  </NavLink>
</li>
```

### MSW mock handlers (`frontend/tests/msw/handlers.ts`)

Add three handlers:

- `GET /api/admin/users` — returns `{ users: [{ id, email, created_at }, ...] }`
- `POST /api/admin/users/invite` — returns the newly created user object or 409
- `DELETE /api/admin/users/:userId` — returns 204 or 409 (last admin)

---

## Key Design Decisions

### Why the backend proxies the Neon management API rather than the frontend calling it directly

The Neon management API requires a `NEON_API_KEY` with broad project permissions. Exposing this key to the browser would allow any compromised admin session to perform arbitrary Neon project operations (create branches, delete the database, etc.). The FastAPI backend acts as a narrow proxy: it validates the admin session, applies the last-admin guard, and only calls the specific Neon endpoints needed for user management.

### Why password-reset email is used instead of a proper "invite" email

Neon Auth's Better Auth instance does not have a distinct "invite" email flow in the management API as of 2026-05. The practical alternative is:

1. Create the user account via `POST /users` with a random discarded password.
2. Immediately call `POST {neon_auth_base_url}/request-password-reset` so the user receives a "set your password" email.

The invitee's experience is: receive an email with a "Reset your password" link, click it, set a password, and they are in. This is slightly less polished than a true invite email (which would say "You've been invited") but is functionally equivalent and avoids storing any temporary credential.

### Why `redirect_origin` is taken from `settings.allowed_origin` rather than the request

The password-reset email must contain a link back to the correct admin login page. `settings.allowed_origin` is the canonical deployment URL (e.g. `https://vms-demo.ocss.tech`). Using the request's `Origin` header would be unreliable in the Lambda environment where Vercel rewrites headers — the same issue already solved for the auth proxy in `auth_proxy.py:_derive_origin`. For the invite flow, `settings.allowed_origin` is the right source: it is a trusted deployment-level config value.

### Why the self-removal guard exists at both UI and API levels

The UI hides the Remove button for the current user's own row. The API additionally returns 403 if `user_id == current_user.user_id`. Defence in depth: the API guard prevents the operation even if the UI is bypassed (e.g. direct API call). Both guards are cheap to implement.

---

## Data Flow — Happy Path: Invite

1. Admin navigates to `/admin/users`.
2. `GET /api/admin/users` is called; backend calls Neon management API `GET /users`, returns `AdminUserListOut`.
3. Admin clicks "Invite admin", types an email, submits.
4. `POST /api/admin/users/invite` is called with `{"email": "newuser@example.com"}`.
5. Backend calls Neon management API `POST /users` with the email and a random discarded password.
6. On success, backend calls `POST {neon_auth_base_url}/request-password-reset` to send the setup email.
7. Backend returns the new user object (201).
8. Frontend appends the new user to the table and shows "Invite sent to newuser@example.com".
9. Invitee receives a "Reset your password" email, clicks the link, sets their password.
10. Invitee can now sign in at `/admin/login`.

## Data Flow — Happy Path: Remove

1. Admin clicks "Remove" on a user row.
2. Confirmation dialog appears: "Remove user@example.com? They will lose admin access immediately."
3. Admin confirms.
4. `DELETE /api/admin/users/{user_id}` is called.
5. Backend calls `list_admin_users()` — count > 1, guard passes.
6. Backend calls Neon management API `DELETE /users/{user_id}`.
7. Backend returns 204.
8. Frontend removes the row from the table and shows "User removed."

---

## Security Considerations

- `GET /api/admin/users`, `POST /api/admin/users/invite`, and `DELETE /api/admin/users/{user_id}` all require `require_admin`. They are inside the existing admin router which applies `Depends(require_admin)` globally.
- `NEON_API_KEY` is a server-side secret. It is read from `settings.neon_api_key` and only used in `neon_auth_service.py`. It is never returned in any API response, never logged, and never sent to the frontend.
- Self-removal is blocked at both the API level (403) and the UI level (button hidden). The API guard is the authoritative one.
- Last-admin guard prevents lockout. The race condition (two admins simultaneously removing each other) is acceptable: it is self-healing via the Neon console, and the probability at 2–10 users with manual operations is negligible.
- The invite endpoint sends an email. It is rate-limited (10 calls / 10 min per session) to prevent abuse of the password-reset email flow as a spam vector.
- Email input is validated as a valid email address by Pydantic `EmailStr` before any Neon API call is made.

---

## Files to Change

| File | Change |
|---|---|
| `backend/app/config.py` | Add `neon_api_key: str = ""`, `neon_project_id: str = ""`, `neon_branch_id: str = ""` settings |
| `backend/app/services/neon_auth_service.py` | New file — `list_admin_users`, `invite_admin_user`, `remove_admin_user`; custom exception hierarchy |
| `backend/app/schemas/admin.py` | Add `AdminUserOut`, `AdminUserListOut`, `AdminUserInviteRequest` |
| `backend/app/routers/admin.py` | Add `GET /users`, `POST /users/invite`, `DELETE /users/{user_id}` endpoints |
| `backend/tests/test_admin_users.py` | New file — unit tests for user management endpoints (mocked Neon service) |
| `backend/tests/test_neon_auth_service.py` | New file — unit tests for `neon_auth_service` (mocked httpx) |
| `frontend/src/api/users.ts` | New file — `listAdminUsers`, `inviteAdminUser`, `removeAdminUser` |
| `frontend/src/pages/admin/UsersPage.tsx` | New file — Users page component |
| `frontend/src/routes/AdminRoutes.tsx` | Add `<Route path="users" element={<UsersPage />} />` |
| `frontend/src/pages/admin/AdminLayout.tsx` | Add "Users" nav item to `NavContent` |
| `frontend/tests/msw/handlers.ts` | Add mock handlers for the three user management endpoints |
| `frontend/src/pages/admin/__tests__/UsersPage.test.tsx` | New file — unit tests for UsersPage |

---

## Test Cases

### Backend unit tests (`test_admin_users.py`) — mocked `neon_auth_service`

| Test | Expected |
|---|---|
| `GET /api/admin/users` — service returns list | 200 with user list |
| `GET /api/admin/users` — service raises `NeonAuthNotConfiguredError` | 503 |
| `GET /api/admin/users` — unauthenticated | 401 |
| `POST /api/admin/users/invite` — valid email | 201 with new user |
| `POST /api/admin/users/invite` — invalid email format | 422 |
| `POST /api/admin/users/invite` — service raises `NeonAuthDuplicateUserError` | 409 |
| `POST /api/admin/users/invite` — service raises `NeonAuthNotConfiguredError` | 503 |
| `DELETE /api/admin/users/{id}` — valid, multiple users exist | 204 |
| `DELETE /api/admin/users/{id}` — user_id matches current admin | 403 |
| `DELETE /api/admin/users/{id}` — only one user in list | 409 |
| `DELETE /api/admin/users/{id}` — service raises `NeonAuthUserNotFoundError` | 404 |
| `DELETE /api/admin/users/{id}` — service raises `NeonAuthNotConfiguredError` | 503 |

### Backend unit tests (`test_neon_auth_service.py`) — mocked httpx

| Test | Expected |
|---|---|
| `list_admin_users` — Neon returns list | Returns parsed `AdminUserOut` list |
| `list_admin_users` — config missing | Raises `NeonAuthNotConfiguredError` |
| `list_admin_users` — Neon returns non-200 | Raises `NeonAuthServiceError` |
| `invite_admin_user` — Neon creates user, password-reset succeeds | Returns `AdminUserOut`; random password not in returned value |
| `invite_admin_user` — Neon returns 409 on `POST /users` | Raises `NeonAuthDuplicateUserError` |
| `invite_admin_user` — password-reset call fails | Raises `NeonAuthServiceError` (user was created but email failed) |
| `remove_admin_user` — Neon returns 200 | Returns normally |
| `remove_admin_user` — Neon returns 404 | Raises `NeonAuthUserNotFoundError` |
| `remove_admin_user` — config missing | Raises `NeonAuthNotConfiguredError` |

### Frontend unit tests (`UsersPage.test.tsx`) — MSW handlers

| Test | Expected |
|---|---|
| Initial load — renders user list | Table shows email and formatted created date |
| Initial load — shows "(you)" on current user row | Current user row has "(you)" text |
| Initial load — Remove button hidden for current user | No Remove button on own row |
| Initial load — Remove button visible for other users | Remove button present on other rows |
| Invite flow — valid email, success | "Invite sent to…" message shown; new user appears in table |
| Invite flow — invalid email | Field shows validation error before submit |
| Invite flow — 409 response | Form shows "A user with that email already exists." |
| Remove flow — confirm removes user | Row disappears; "User removed." shown |
| Remove flow — last-admin 409 | Inline error "Cannot remove the last admin user." |
| Loading state | "Loading users…" state-message shown |
| Error state | "Failed to load users." error state-message shown |
| Cancel invite | Form collapses without calling API |

---

## Schema Migration Required

No. Users are managed entirely by Neon Auth. The application's PostgreSQL database is not involved.

---

## E2E Test Scenarios

### New spec: `frontend/e2e_tests/workflows/admin-user-management.spec.ts`

#### Happy path — invite and remove

1. Sign in as the seeded E2E admin (using the existing `signInAsE2EAdmin` fixture).
2. Navigate to `/admin/users`.
3. Verify the current admin's email appears in the table with "(you)" label.
4. Verify no Remove button is visible on the current user's own row.
5. Click "Invite admin", fill in a test email (e.g. `e2e-invite-target@test.example`), submit.
6. Wait for "Invite sent to e2e-invite-target@test.example" confirmation to appear.
7. Verify the new user row appears in the table.
8. Click "Remove" on the new user's row.
9. Confirm the removal dialog.
10. Wait for "User removed." confirmation.
11. Verify the new user's row is no longer in the table.

**Teardown:** If the invited test user still exists after the spec (e.g. due to test failure before step 9), the `afterAll` block should call `DELETE /api/admin/users/{id}` via the admin API to clean up.

#### Error case — last admin cannot be removed

1. Sign in as the seeded E2E admin.
2. Navigate to `/admin/users`.
3. If there is only one user in the table, click "Remove" on any other user and confirm — otherwise this test is a no-op.
4. With only one user remaining, verify there is no Remove button at all (because it is the current user's own row).

*Note: this scenario is best validated at the unit/integration test level rather than E2E, because reaching the one-user state requires controlled teardown of other test users.*

#### Error case — duplicate invite

1. Sign in as the E2E admin.
2. Navigate to `/admin/users`.
3. Note the email of an existing user in the table.
4. Click "Invite admin" and submit the same email.
5. Verify the error message "A user with that email already exists." is shown inline.

### Multi-step sequence (required end-to-end)

1. Admin signs in at `/admin/login`.
2. Admin navigates to `/admin/users` via the sidebar.
3. Admin invites a new user (`e2e-invite-target@test.example`).
4. Invite confirmation message is shown; new user appears in table.
5. Admin removes the newly invited user.
6. Removal confirmation message is shown; user row disappears.
7. Admin navigates away (to `/admin/buildings`) — no error state persists.

This sequence validates the full invite-then-remove lifecycle and must be run as a single Playwright test.

### Existing E2E specs affected

This feature adds a sidebar nav item ("Users") to `AdminLayout`. Any E2E spec that:

- Asserts the exact sidebar nav item count, or
- Asserts the absence of a "Users" link in the sidebar

must be updated. Specifically, check `admin-33m-workflow.spec.ts` and any spec that navigates the admin sidebar — update assertions to account for the new nav item.

---

## Vertical Slice Decomposition

This feature is a single tightly-coupled slice: the backend endpoints are meaningless without the frontend page, and the frontend page cannot function without the backend. There is no benefit to splitting into parallel slices. Implement as a single branch (`admin-user-management`).

Implementation order within the slice:

1. Backend: config settings → service → schemas → router endpoints → unit tests
2. Frontend: API client → MSW handlers → UsersPage component → unit tests → route + nav link
3. E2E: new spec after Branch CI passes
