# Design: Branding, UI, and Multi-Tenancy

## Overview

A singleton `tenant_config` table stores per-deployment branding: `app_name`, `logo_url`, `favicon_url`, `primary_colour`, `support_email`. The admin Settings page allows editing these and uploading a logo image (stored in Vercel Blob). `BrandingContext` applies branding on app mount by setting the document title, injecting `--color-primary` CSS variable, and updating the favicon. The layout is full-width with consistent typography and touch-friendly drag-and-drop for motion reordering.

---

## Data Model

### `tenant_config` table

Singleton row (`id = 1`, enforced by `CHECK (id = 1)`):

| Column | Type | Default |
|---|---|---|
| `id` | INTEGER PK | `1` |
| `app_name` | VARCHAR NOT NULL | `'AGM Voting'` |
| `logo_url` | VARCHAR NOT NULL | `''` |
| `primary_colour` | VARCHAR NOT NULL | `'#005f73'` |
| `support_email` | VARCHAR NOT NULL | `''` |
| `updated_at` | TIMESTAMPTZ | `now()` |

Empty string is the "not set" sentinel for optional fields (no nullable columns). `logo_url` is updated by the logo upload flow.

---

## API Endpoints

### Public config

`GET /api/config` (no auth) — returns `TenantConfigOut` (`app_name`, `logo_url`, `primary_colour`, `support_email`). Served from a 60-second in-process module-level cache (see `design-infrastructure.md`). Cache invalidated on every `update_config` call.

### Admin config

`GET /api/admin/config` — returns same `TenantConfigOut`.

`PUT /api/admin/config` — accepts `TenantConfigUpdate`. Validation: `app_name` non-empty, `primary_colour` must match `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$` if non-empty. Returns updated `TenantConfigOut`.

### Logo upload

`POST /api/admin/config/logo` — multipart file upload (max 5 MB; accepted types: PNG, JPEG, WebP, GIF, SVG). Uploads to Vercel Blob via REST API using `BLOB_READ_WRITE_TOKEN` env var. Returns `{ "url": "<blob-cdn-url>" }`. The frontend then saves this URL via `PUT /api/admin/config`. The endpoint does NOT directly update `tenant_config`.

Error codes: 400 (missing file or >5 MB), 415 (unsupported type), 500 (Blob token not configured), 502 (upstream upload failed).

---

## Frontend Components

### `BrandingContext.tsx` (`frontend/src/context/BrandingContext.tsx`)

React context populated via React Query (`queryKey: ["public-config"]`, `staleTime: 5 minutes`). While loading, provides `DEFAULTS` values (compile-time defaults, no layout shift). On query success:
- `document.title = data.app_name`
- `document.documentElement.style.setProperty("--color-primary", data.primary_colour)` (if non-empty)
- `document.querySelector("link[rel='icon']").href = data.logo_url || "/favicon.ico"`

`BrandingProvider` wraps the app inside `QueryClientProvider` in `main.tsx`. `useBranding()` hook returns the current branding config.

### `VoterShell.tsx` (`frontend/src/components/vote/VoterShell.tsx`)

Header renders:
- If `logo_url` non-empty: `<img src={logo_url} alt={app_name} className="app-header__logo" />`
- Otherwise: `<span className="app-header__app-name">{app_name}</span>`

### `AdminLayout.tsx` (`frontend/src/pages/admin/AdminLayout.tsx`)

Same logo/app-name conditional applied to both desktop sidebar header and mobile drawer header. `app_name` used as `aria-label` / `alt` text on logo image. "Settings" nav link added to the nav list.

### `AuthPage.tsx` / `ConfirmationPage.tsx`

`support_email` (if non-empty) renders: `"Need help? Contact <a href="mailto:{support_email}">{support_email}</a>"` in a `.support-contact` paragraph.

### `SettingsPage.tsx` (`frontend/src/pages/admin/SettingsPage.tsx`)

Route: `/admin/settings`. Cards:

**Tenant Branding:**
- App name (required text input)
- Logo URL (text input) + "Upload logo image" file input (triggers `POST /api/admin/config/logo` on change; populates URL field with result)
- Primary colour (text input with hex validation pattern)
- Support email (email input, optional)
- Save button → `PUT /api/admin/config`; on success `queryClient.invalidateQueries({ queryKey: ["public-config"] })` for live update in current tab

**Mail Server:** (see `design-email-smtp.md`)

### Logo upload in `SettingsPage`

`handleLogoFileChange`:
1. `isUploading = true`
2. Call `uploadLogo(file)` → `POST /api/admin/config/logo`
3. On success: set `logoUrl` state to returned URL
4. On error: show `uploadError` below the file input

File input uses `<input type="file">` (no `field__input` class — file inputs have native browser chrome).

---

## Layout and Typography

### Full-width layout

The main content area uses `max-width: 100%` with consistent horizontal padding (`--space-4`). Admin pages use `.admin-page` / `.admin-page-header` / `.card` layout classes. No Bootstrap/Tailwind — custom CSS variables only.

### Typography

- Headings: `--font-size-xl`, `--font-size-lg`, etc.
- Body: `--font-size-base` (16px)
- Muted text: `var(--text-muted)` colour
- No `form-group` or `form-control` class names (legacy Bootstrap classes are prohibited)

### CSS custom properties

`--color-primary` is injected at runtime by `BrandingContext`. All elements using the primary colour reference this variable. Changing primary colour in Settings updates the entire UI immediately without a page reload.

---

## Drag-and-Drop (Motion Reordering)

Motion reordering in `MotionManagementTable` uses `@dnd-kit/core` + `@dnd-kit/sortable`:

- Drag handle (⠿ icon via `useSortable`) in the first column of each row
- `DndContext` + `SortableContext` wraps the `<tbody>`; each row is a `SortableRow`
- Touch events supported natively by dnd-kit (no additional touch library needed)
- Optimistic update on `onDragEnd`: immediately reorders the local list, then calls `PUT /api/admin/general-meetings/{id}/motions/reorder`; reverts on error
- Move buttons (top/up/down/bottom) serve as keyboard/accessibility fallback

`react-beautiful-dnd` is explicitly excluded: deprecated, React 18 incompatible.

---

## Key Behaviours

- **Cache coherency**: admin saves branding → `invalidateQueries(["public-config"])` → `BrandingContext` refetches → CSS variable and title update in the current tab within one query cycle
- **Fallback branding**: while config is loading, `DEFAULTS` (`app_name: "AGM Voting"`, `primary_colour: "#005f73"`) prevent blank-page flash
- **Empty logo_url**: favicon fallback to `/favicon.ico` (silent 404 = browser default icon); app name text shown in header
- **Static logo assets removed**: `frontend/public/logo.png` and `frontend/public/logo.webp` deleted; favicon link in `index.html` points to `/favicon.ico`
- **Two-step logo upload**: upload endpoint returns URL; URL saved via `PUT /api/admin/config` (keeps config endpoint simple)

---

## Security Considerations

- `BLOB_READ_WRITE_TOKEN` is server-side only (not exposed to frontend)
- `PUT /api/admin/config` and `POST /api/admin/config/logo` require admin auth
- `GET /api/config` is unauthenticated but returns only non-sensitive branding data
- Hex colour validated server-side to prevent CSS injection via `--color-primary`
- Logo URL is admin-supplied — no sanitisation of the URL itself, but it is only rendered in admin-controlled contexts

---

## Files

| File | Role |
|---|---|
| `backend/app/models/tenant_config.py` | `TenantConfig` singleton model |
| `backend/app/services/config_service.py` | `get_config` (with TTL cache), `update_config`; logo upload via `blob_service` |
| `backend/app/services/blob_service.py` | `upload_to_blob` (Vercel Blob REST API) |
| `backend/app/schemas/config.py` | `TenantConfigOut`, `TenantConfigUpdate`, `LogoUploadOut` |
| `backend/app/routers/public.py` | `GET /api/config` |
| `backend/app/routers/admin.py` | `GET/PUT /api/admin/config`; `POST /api/admin/config/logo` |
| `backend/alembic/versions/` | Migration: create `tenant_config` table + seed row |
| `frontend/src/context/BrandingContext.tsx` | React context; applies CSS var, title, favicon |
| `frontend/src/main.tsx` | `<BrandingProvider>` wraps `<App>` inside `<QueryClientProvider>` |
| `frontend/src/pages/admin/SettingsPage.tsx` | Branding + SMTP settings |
| `frontend/src/components/vote/VoterShell.tsx` | Logo/app-name rendering |
| `frontend/src/pages/admin/AdminLayout.tsx` | Sidebar/drawer logo + Settings nav link |
| `frontend/src/api/config.ts` | `getPublicConfig`, `getAdminConfig`, `updateAdminConfig`, `uploadLogo` |
| `frontend/src/styles/index.css` | `.support-contact`, `motion-type-badge--multi-choice`, CSS vars |
| `frontend/index.html` | Favicon link changed to `/favicon.ico` |

---

## Schema Migration Required

Yes — `tenant_config` table (with seed row inserted by migration).
