# Technical Design: Tenant Branding Configuration

## Overview

Add a `tenant_config` table that stores a single row of per-deployment branding settings:
`app_name`, `logo_url`, `primary_colour`, and `support_email`. Admins edit these values on a
new `/admin/settings` page. A public `GET /api/config` endpoint serves the config to the
frontend, which applies branding on app mount via a `BrandingContext` that sets the document
title, injects a CSS custom property for the primary colour, and conditionally renders the logo
or app name in the voter shell and admin sidebar.

User stories covered: US-CFG-01, US-CFG-02, US-CFG-03.

---

## Schema Migration Note

**This feature requires an Alembic migration.** A new `tenant_config` table is created and a
seed row is inserted. An isolated Neon DB branch must be created for the implementation branch
before pushing, and branch-scoped Vercel env vars (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`)
must be set to point to that branch.

---

## Database Changes

### New table: `tenant_config`

| Column           | Type                        | Constraints                                 | Default        |
|------------------|-----------------------------|---------------------------------------------|----------------|
| `id`             | `INTEGER`                   | PRIMARY KEY, `CHECK (id = 1)`               | `1`            |
| `app_name`       | `VARCHAR`                   | NOT NULL                                    | `'AGM Voting'` |
| `logo_url`       | `VARCHAR`                   | NOT NULL                                    | `''`           |
| `primary_colour` | `VARCHAR`                   | NOT NULL                                    | `'#005f73'`    |
| `support_email`  | `VARCHAR`                   | NOT NULL                                    | `''`           |
| `updated_at`     | `TIMESTAMP WITH TIME ZONE`  | NOT NULL, server_default=now(), onupdate    | `now()`        |

**Single-row enforcement:** The `id` column is a plain `INTEGER` primary key with a
`CHECK (id = 1)` constraint (named `ck_tenant_config_single_row`). Any `INSERT` with `id != 1`
is rejected at the DB level. The service layer always reads and writes `WHERE id = 1` and never
exposes the ID field via the API.

**No `TimestampMixin`:** The mixin adds both `created_at` and `updated_at`. Since `created_at`
is not meaningful for a configuration singleton, `updated_at` is declared directly on the model.

**Empty string as "not set":** `logo_url` and `support_email` use `""` as the absent sentinel
rather than NULL. This keeps response shapes uniform and removes nullable handling on the frontend.

**No length constraints on VARCHAR columns:** Consistent with the rest of the codebase (e.g.
`Building.name`, `Building.manager_email` use `String` without an explicit length).

### Alembic migration

New migration file. `down_revision` points to `0e7439a74cb6` (current head: `add_is_visible_to_motions`).

Upgrade steps:
1. `op.create_table('tenant_config', ...)` with all columns and the `CHECK (id = 1)` constraint.
2. Seed insert (idempotent):
   ```sql
   INSERT INTO tenant_config (id, app_name, logo_url, primary_colour, support_email)
   SELECT 1, 'AGM Voting', '', '#005f73', ''
   WHERE NOT EXISTS (SELECT 1 FROM tenant_config WHERE id = 1);
   ```

Downgrade steps:
1. `op.drop_table('tenant_config')`

---

## Backend Changes

### New model: `backend/app/models/tenant_config.py`

```python
class TenantConfig(Base):
    __tablename__ = "tenant_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    app_name: Mapped[str] = mapped_column(String, nullable=False, default="AGM Voting")
    logo_url: Mapped[str] = mapped_column(String, nullable=False, default="")
    primary_colour: Mapped[str] = mapped_column(String, nullable=False, default="#005f73")
    support_email: Mapped[str] = mapped_column(String, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        CheckConstraint("id = 1", name="ck_tenant_config_single_row"),
    )
```

Add `TenantConfig` to `backend/app/models/__init__.py` and the `__all__` list.

### New Pydantic schemas: `backend/app/schemas/config.py`

```python
class TenantConfigOut(BaseModel):
    app_name: str
    logo_url: str
    primary_colour: str
    support_email: str
    model_config = ConfigDict(from_attributes=True)

class TenantConfigUpdate(BaseModel):
    app_name: str
    logo_url: str = ""
    primary_colour: str = "#005f73"
    support_email: str = ""
```

Validation rules in `TenantConfigUpdate`:
- `app_name`: `@field_validator` — strip whitespace, reject empty string (422).
- `primary_colour`: `@field_validator` — validate against `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`;
  reject if non-empty and not matching (422). Empty string is accepted (means "use default CSS").
- `logo_url` and `support_email`: no format validation — empty string is valid.

### New service: `backend/app/services/config_service.py`

Two async functions:

```python
async def get_config(db: AsyncSession) -> TenantConfig:
    """Fetch row id=1. If missing (should not happen after migration), insert defaults and return."""

async def update_config(data: TenantConfigUpdate, db: AsyncSession) -> TenantConfig:
    """UPDATE tenant_config SET ... WHERE id = 1. Returns updated row."""
```

`update_config` uses a plain `UPDATE ... WHERE id = 1` rather than an upsert because the seed
migration guarantees the row always exists. If the row is absent it raises HTTP 500 (corrupt
deployment state).

### New API endpoints

Endpoints are added to the **existing routers** to stay consistent with the codebase pattern
(one router file per domain area, not one router per endpoint). The config endpoints are small
enough to live in the existing files.

#### `backend/app/routers/public.py` — new route

```
GET /api/config
```
- No authentication required.
- Calls `config_service.get_config(db)`.
- Returns `TenantConfigOut`.
- No server-side caching — the frontend uses a 5-minute stale time via React Query.

#### `backend/app/routers/admin.py` — two new routes

```
GET /api/admin/config
PUT /api/admin/config
```
Both inherit `dependencies=[Depends(require_admin)]` from the router declaration.

- `GET /api/admin/config` — calls `config_service.get_config(db)`, returns `TenantConfigOut`.
- `PUT /api/admin/config` — accepts `TenantConfigUpdate` body, calls
  `config_service.update_config(data, db)`, returns updated `TenantConfigOut`.
  Returns 422 on validation failure (empty `app_name`, invalid hex colour).

No changes to `main.py` are needed — the existing router registrations already cover these.

---

## Frontend Changes

### New API client: `frontend/src/api/config.ts`

A new file is preferred over appending to `public.ts` or `admin.ts` because the config type
(`TenantConfig`) is shared between the public and admin calls, and co-locating both in one
file avoids a circular import or a separate types file.

```typescript
export interface TenantConfig {
  app_name: string;
  logo_url: string;
  primary_colour: string;
  support_email: string;
}

export interface TenantConfigUpdateRequest {
  app_name: string;
  logo_url: string;
  primary_colour: string;
  support_email: string;
}

export async function getPublicConfig(): Promise<TenantConfig> {
  return apiFetch<TenantConfig>("/api/config");
}

export async function getAdminConfig(): Promise<TenantConfig> {
  return apiFetch<TenantConfig>("/api/admin/config");
}

export async function updateAdminConfig(data: TenantConfigUpdateRequest): Promise<TenantConfig> {
  return apiFetch<TenantConfig>("/api/admin/config", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}
```

### New React context: `frontend/src/context/BrandingContext.tsx`

```typescript
export interface BrandingConfig {
  app_name: string;
  logo_url: string;
  primary_colour: string;
  support_email: string;
}

const DEFAULTS: BrandingConfig = {
  app_name: "AGM Voting",
  logo_url: "",
  primary_colour: "#005f73",
  support_email: "",
};

export const BrandingContext = React.createContext<BrandingConfig>(DEFAULTS);

export function BrandingProvider({ children }: { children: React.ReactNode }) { ... }

export function useBranding(): BrandingConfig {
  return React.useContext(BrandingContext);
}
```

`BrandingProvider` implementation details:
- Uses `useQuery({ queryKey: ["public-config"], queryFn: getPublicConfig, staleTime: 5 * 60 * 1000 })` from React Query. This is valid because `BrandingProvider` is placed **inside** `QueryClientProvider` in `main.tsx` (see routing changes below).
- While `isLoading` is true, the context value is `DEFAULTS` — the app renders with compile-time defaults with no blank screen or layout shift.
- On query success, calls:
  - `document.title = data.app_name`
  - `document.documentElement.style.setProperty("--color-primary", data.primary_colour)` (only if `data.primary_colour` is non-empty)
- Provides the resolved `data` (or `DEFAULTS` if loading/error) via `BrandingContext.Provider`.
- On query error, silently falls back to `DEFAULTS`.

**Why React Query, not a plain `useEffect` + `fetch`:** React Query is already a dependency and
provides deduplication, stale-time caching, and automatic refetch after a `queryClient.invalidateQueries`
call from the Settings page save handler. Using React Query keeps the pattern consistent with
the rest of the app.

### Modified file: `frontend/src/main.tsx`

`BrandingProvider` is added inside `QueryClientProvider` and wraps the `RouterProvider` (or
`App` element depending on the current mount structure). Order:

```tsx
<QueryClientProvider client={queryClient}>
  <BrandingProvider>
    <App />
  </BrandingProvider>
</QueryClientProvider>
```

### Modified component: `frontend/src/components/vote/VoterShell.tsx`

- Import `useBranding`.
- Replace the hard-coded `<picture>` element in the header with:
  - If `logo_url` is non-empty: `<img src={logo_url} alt={app_name} className="app-header__logo" />`
  - If empty: `<span className="app-header__app-name">{app_name}</span>`

### Modified component: `frontend/src/pages/admin/AdminLayout.tsx`

- Import `useBranding`.
- Apply the same logo/app-name conditional to **both** the desktop sidebar `admin-sidebar__header`
  block and the mobile `admin-nav-drawer` header block (both currently contain identical hard-coded
  `<picture>` elements).
- Use `app_name` as `aria-label` / `alt` text on the logo image.

### Modified page: `frontend/src/pages/vote/AuthPage.tsx`

- Import `useBranding`.
- After the `<AuthForm>` component, conditionally render:
  ```tsx
  {support_email && (
    <p className="support-contact">
      Need help? Contact <a href={`mailto:${support_email}`}>{support_email}</a>
    </p>
  )}
  ```

### Modified page: `frontend/src/pages/vote/ConfirmationPage.tsx`

- Import `useBranding`.
- After the main card's `submit-section` div, conditionally render the same
  `support-contact` paragraph as in `AuthPage`.

### New page: `frontend/src/pages/admin/SettingsPage.tsx`

Route: `/admin/settings`.

Structure:
```
<div class="admin-page-header">
  <h1>Settings</h1>
</div>
<div class="card">
  <form class="admin-form">
    [App name field]
    [Logo URL field]
    [Primary colour field]
    [Support email field]
    [Save button]
    [Success/error messages]
  </form>
</div>
```

Field details:

| Field           | Input type | Required | Validation                            |
|-----------------|------------|----------|---------------------------------------|
| App name        | `text`     | Yes      | Non-empty (client + server 422)       |
| Logo URL        | `text`     | No       | Cleared = empty string sent to server |
| Primary colour  | `text`     | No       | Pattern `#[0-9a-fA-F]{3,6}` client-side; server validates same rule |
| Support email   | `email`    | No       | Browser `type="email"` validation; cleared = empty string |

Behaviour:
1. On mount: `useQuery({ queryKey: ["admin-config"], queryFn: getAdminConfig })` populates the form.
2. Save button: `useMutation` calling `updateAdminConfig(formValues)`.
3. While mutating: button disabled, label "Saving…".
4. On success:
   - Show inline `<p class="form-success">Settings saved.</p>` for 3 seconds.
   - Call `queryClient.invalidateQueries({ queryKey: ["public-config"] })` to trigger a
     `BrandingProvider` refetch so colour and title update immediately in the current session.
5. On error: parse the 422 `detail` array and show field-level inline errors below each
   affected field using the existing `field-error` CSS class.

### Modified file: `frontend/src/routes/AdminRoutes.tsx`

Inside the `RequireAdminAuth / AdminLayout` route group, add:

```tsx
import SettingsPage from "../pages/admin/SettingsPage";
// ...
<Route path="settings" element={<SettingsPage />} />
```

### Modified file: `frontend/src/pages/admin/AdminLayout.tsx` — nav link

In the `NavContent` component, add after the "General Meetings" `NavLink`:

```tsx
<li className="admin-nav__item">
  <NavLink
    to="/admin/settings"
    className={({ isActive }) =>
      `admin-nav__link${isActive ? " admin-nav__link--active" : ""}`
    }
    onClick={onNavClick}
  >
    Settings
  </NavLink>
</li>
```

### New CSS utility class in `frontend/src/styles/index.css`

```css
.support-contact {
  margin-top: 16px;
  font-size: 0.875rem;
  color: var(--text-secondary);
  text-align: center;
}
```

No changes to existing primary-colour usage — the CSS custom property `--color-primary` is
already used throughout the stylesheet; updating it via `setProperty` at runtime is sufficient.

---

## Key Design Decisions

### Single-row enforcement via CHECK constraint, not sequence or trigger

Three approaches were considered:

1. `CHECK (id = 1)` — chosen. DB-enforced, zero application logic, trivially reversible.
   The service layer never needs to ask "which row?".
2. Partial unique index on an `is_singleton BOOLEAN` column — more complex with no benefit.
3. Application-level guard raising 409 on a second insert — not DB-enforced; bypassable via
   a direct DB write.

### Endpoints added to existing routers, not a new `config.py` router

The codebase has one router per domain (`public.py`, `admin.py`, `auth.py`, `voting.py`).
Adding two routes to `public.py` and two routes to `admin.py` keeps the pattern consistent
and avoids a new file with four one-liner functions. A separate `config.py` router would only
be justified if the config domain grew to many endpoints.

### React context over sessionStorage for branding state

Branding config is global read-only state with a lifetime of one page load. A React context
populated via React Query on mount is idiomatic for this pattern. sessionStorage would require
explicit cache invalidation after the admin saves changes, and would not propagate updates to
the currently open tab without a `storage` event listener.

### `queryClient.invalidateQueries` on save triggers live update

After the admin saves settings, invalidating `["public-config"]` causes `BrandingProvider`'s
query to refetch. The new colour and title are applied to the current browser session without
requiring a page reload. This is only possible because `BrandingProvider` uses React Query
rather than a plain `useEffect` fetch.

### Empty string as "not set", not NULL

Avoids nullable columns (simpler SQLAlchemy mapping), avoids `null` checks in TypeScript, and
keeps the JSON response shape uniform. The frontend checks `logo_url !== ""` and
`support_email !== ""` to decide what to render.

### No server-side caching

The config is a single row queried on every `GET /api/config` call. The table changes at most
a few times per deployment lifecycle. The frontend's 5-minute `staleTime` provides sufficient
client-side caching for high-frequency voter traffic. Adding a server-side cache would
complicate tests and is not warranted.

### `PUT` not `PATCH` for the update endpoint

The Settings form always sends all four fields. `PUT` accurately represents full replacement
semantics. `PATCH` would require the service to merge partial updates, adding complexity with
no user-visible benefit.

---

## Data Flow: Happy Path

### Voter loads the app — branding applied

1. `main.tsx` renders `<QueryClientProvider><BrandingProvider><App/></BrandingProvider></QueryClientProvider>`.
2. `BrandingProvider` mounts; React Query calls `GET /api/config`.
3. FastAPI `public.py` calls `config_service.get_config(db)`, reads `tenant_config WHERE id=1`,
   returns `TenantConfigOut`.
4. Provider receives the result, sets `document.title = app_name` and injects `--color-primary`
   into `:root`.
5. `VoterShell` reads `useBranding()` and renders the logo image (if `logo_url` non-empty) or
   app name text.
6. `AuthPage` reads `support_email`; if non-empty renders the "Need help?" mailto link.

### Admin updates settings

1. Admin navigates to `/admin/settings`.
2. React Query calls `GET /api/admin/config`; form populates with current values.
3. Admin edits primary colour to `#2a9d8f`, clicks "Save settings".
4. `useMutation` calls `PUT /api/admin/config` with all four fields.
5. FastAPI validates `TenantConfigUpdate`, `config_service.update_config` executes
   `UPDATE tenant_config SET primary_colour='#2a9d8f', updated_at=now() WHERE id=1`.
6. Returns updated `TenantConfigOut` (200).
7. `onSuccess`: `queryClient.invalidateQueries({ queryKey: ["public-config"] })` triggers
   `BrandingProvider`'s query to refetch.
8. `BrandingProvider` re-fetches `GET /api/config`, receives `primary_colour="#2a9d8f"`.
9. Calls `document.documentElement.style.setProperty("--color-primary", "#2a9d8f")`.
10. All elements using `var(--color-primary)` visually update immediately in the current session.
11. "Settings saved." inline message displays for 3 seconds.

---

## E2E Test Scenarios

### Setup / teardown

Each test seeds a known state by calling `PUT /api/admin/config` directly (via API with admin
credentials) and resets to defaults in an `afterEach` hook.

---

### Scenario 1 — Happy path: admin saves all four fields

1. Log in as admin, navigate to `/admin/settings`.
2. Clear "App name", type "Test Corp AGM".
3. Set "Logo URL" to `https://example.com/logo.png`.
4. Set "Primary colour" to `#ff6600`.
5. Set "Support email" to `help@testcorp.com`.
6. Click "Save settings".
7. Assert: button shows "Saving…" while in flight.
8. Assert: "Settings saved." message appears after response.
9. Reload the page; assert all four fields display the saved values.

### Scenario 2 — Branding applied to voter shell (no logo)

1. Seed: `app_name="Corp Vote"`, `primary_colour="#ff0000"`, `logo_url=""`, `support_email=""`.
2. Navigate to `/` (voter home).
3. Assert: `<title>` is "Corp Vote".
4. Assert: voter shell header renders the text "Corp Vote" (no `<img>` tag).
5. Assert: computed value of `--color-primary` on `:root` is `#ff0000`.

### Scenario 3 — Logo rendered when logo_url is set

1. Seed: `logo_url="https://example.com/logo.png"`.
2. Navigate to `/`.
3. Assert: voter shell header contains `<img src="https://example.com/logo.png">`.
4. Assert: no app-name text span in the header.
5. Navigate to `/admin/buildings`; assert admin sidebar also contains the same `<img>`.

### Scenario 4 — Support email shown on auth page

1. Seed: `support_email="support@agm.com"`.
2. Navigate to a valid meeting's auth URL `/vote/{meetingId}/auth`.
3. Assert: page contains text "Need help?" and a link with href `mailto:support@agm.com`.

### Scenario 5 — Support email hidden when empty

1. Seed: `support_email=""`.
2. Navigate to `/vote/{meetingId}/auth`.
3. Assert: no "Need help?" text and no mailto link present.

### Scenario 6 — Support email shown on confirmation page

1. Seed: `support_email="support@agm.com"`.
2. Navigate to `/vote/{meetingId}/confirmation` (after submitting a ballot).
3. Assert: confirmation page contains the mailto link for `support@agm.com`.

### Scenario 7 — Validation error: empty app name

1. Navigate to `/admin/settings`.
2. Clear "App name" entirely.
3. Click "Save settings".
4. Assert: error message shown near the App name field.
5. Assert: page does not navigate away.

### Scenario 8 — Validation error: invalid hex colour

1. Navigate to `/admin/settings`.
2. Set "Primary colour" text to `notacolour`.
3. Click "Save settings".
4. Assert: inline error shown near the Primary colour field.
5. Assert: no success message shown.

### Scenario 9 — Colour change reflected immediately without reload

1. Log in as admin, navigate to `/admin/settings`.
2. Set "Primary colour" to `#123456`, click "Save settings".
3. Assert: after "Settings saved." appears, `--color-primary` on `:root` is `#123456` in
   the current tab (no page reload required).

### Scenario 10 — Public config accessible without auth, admin config requires auth

1. Without admin cookies, call `GET /api/config`; assert 200 with all four fields.
2. Without admin cookies, call `GET /api/admin/config`; assert 401.
3. Without admin cookies, call `PUT /api/admin/config`; assert 401.

### Scenario 11 — Settings nav link visible in admin sidebar

1. Log in as admin.
2. Assert: admin sidebar contains a "Settings" nav link.
3. Click it; assert URL is `/admin/settings` and the Settings page heading is visible.

---

## Vertical Slice Decomposition

Per the task brief, no vertical slice decomposition is required — backend and frontend are
tightly coupled for this small feature. The feature is implemented as a single branch.

Recommended implementation order within the branch:
1. Alembic migration + `TenantConfig` model (prerequisite for all other steps).
2. Pydantic schemas in `config.py`.
3. `config_service.py` service functions.
4. Backend endpoint additions to `public.py` and `admin.py`.
5. Backend unit + integration tests (to 100% coverage).
6. Frontend `api/config.ts` client.
7. Frontend `BrandingContext.tsx` + `main.tsx` provider mount.
8. Frontend `SettingsPage.tsx` + routing + nav link.
9. Frontend modifications to `VoterShell`, `AdminLayout`, `AuthPage`, `ConfirmationPage`.
10. Frontend unit + integration tests (to 100% coverage).
11. E2E Playwright tests covering the scenarios above.
