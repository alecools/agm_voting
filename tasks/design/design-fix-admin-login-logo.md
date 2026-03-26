# Design: Fix Admin Login Page to Use Tenant Branding Logo

## Overview

The admin login page (`/admin/login`) displayed a hardcoded `<img src="/logo.png">` and `<picture>` element pointing to `/logo.webp` and `/logo.png`. After the tenant branding feature was added (see `design-tenant-branding.md`), every other page in the app (admin sidebar, voter shell header) reads the logo URL from `BrandingContext` via `useBranding()`. The login page was missed during that integration.

**Result:** When a tenant uploads a custom logo via the Settings page, the admin login page continues to show the old static `/logo.png` instead of the configured logo.

This is a purely frontend fix — no backend or database changes required.

---

## Root Cause

`frontend/src/pages/admin/LoginPage.tsx` imports no branding context and unconditionally renders:

```tsx
<picture>
  <source srcSet="/logo.webp" type="image/webp" />
  <img src="/logo.png" alt="Logo" />
</picture>
```

`useBranding()` was never wired into this component.

---

## Database Changes

None.

---

## Backend Changes

None.

---

## Frontend Changes

### `frontend/src/pages/admin/LoginPage.tsx`

- Import `useBranding` from `BrandingContext`.
- Call `const { logo_url } = useBranding()` inside the component.
- Replace the hardcoded `<picture>` element with a conditional render:
  - When `logo_url` is a non-empty string: render `<img src={logo_url} alt="Logo" className="login-card__logo" />`.
  - When `logo_url` is empty or not set: render nothing (no broken image).
- Remove the hardcoded `/logo.png` and `/logo.webp` references from this file.

---

## Key Design Decisions

- **No fallback to static files** — if no logo URL is configured, the login card renders without an image rather than falling back to `/logo.png`. This is consistent with the behaviour of the voter shell header and admin sidebar.
- **Same source as all other pages** — `useBranding()` / `BrandingContext` is the single source of truth for the logo URL across the app. Wiring the login page to the same source ensures all pages are consistent when branding is updated.

---

## Data Flow

1. App loads. `BrandingContext` fetches `GET /api/config` and stores `logo_url` in context.
2. User navigates to `/admin/login`.
3. `LoginPage` calls `useBranding()`, reads `logo_url`.
4. If `logo_url` is a non-empty string, renders `<img src={logo_url}>`. Otherwise renders no image.

---

## Schema Migration Note

**Schema migration needed: NO.**

---

## E2E Test Scenarios

### Affected journey: Admin login

The existing admin login E2E spec (`frontend/e2e/admin/admin-login.spec.ts`) must be updated:

#### Happy path
- **SC-LL-01**: Admin navigates to `/admin/login` with a configured logo URL. The login card shows `<img>` with the configured URL.

#### Edge cases
- **SC-LL-02**: Admin navigates to `/admin/login` with no logo URL configured (empty string). No broken image is shown; the login card renders without an `<img>` element.
