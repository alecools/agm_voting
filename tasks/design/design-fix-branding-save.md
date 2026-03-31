# Design: Fix Tenant Branding Settings Save

**Status:** Implemented

## Problem

After saving settings on `/admin/settings`, the branding in the admin sidebar
(app name, logo, primary colour) does not update until the user reloads the page.
The user experience is "nothing happens" because:

1. `BrandingProvider` fetches config once on mount via a plain `useEffect` and
   stores it in local React state — it does NOT use React Query.
2. `SettingsPage.handleSubmit` calls
   `queryClient.invalidateQueries({ queryKey: ["public-config"] })` after a
   successful PUT — but because `BrandingProvider` never registered a
   `["public-config"]` query in React Query's cache, this invalidation is a
   silent no-op.
3. Consequence: `config.app_name`, `config.logo_url`, and the CSS
   `--color-primary` variable in the running page remain stale after save.

There is also a test-coverage gap:
- `SettingsPage.tsx` line 50 (`setTimeout` callback body) is not covered
  to 100% branch, and no per-file threshold is enforced for it.
- There is no E2E test for the settings save flow.

## Root Cause

`BrandingProvider` owns the public config state independently of React Query.
`SettingsPage` incorrectly assumes the branding is managed through React Query.

## Fix

### Option A — Convert `BrandingProvider` to React Query (chosen)

Replace the `useEffect`/`useState` pattern in `BrandingProvider` with
`useQuery({ queryKey: ["public-config"], queryFn: getPublicConfig })`.
This registers the key in the shared `QueryClient` so that
`queryClient.invalidateQueries({ queryKey: ["public-config"] })` in
`SettingsPage` triggers an actual re-fetch, updating sidebar branding in real
time.

Advantages:
- `SettingsPage` code is already correct — no changes needed there.
- Loading/error fallback remains identical.
- React Query handles deduplication and stale-while-revalidate automatically.

Disadvantages:
- `BrandingProvider` must be rendered inside `QueryClientProvider`, which it
  already is (see `main.tsx`).

### Option B — Callback prop / Context setter (rejected)

Pass a `reloadConfig` callback from `BrandingProvider` down to `SettingsPage`
via context. More prop-drilling, non-standard pattern for this codebase.

## Changes Required

### Frontend

| File | Change |
|---|---|
| `frontend/src/context/BrandingContext.tsx` | Replace `useEffect`/`useState` with `useQuery({ queryKey: ["public-config"], queryFn: getPublicConfig })`. Preserve `DEFAULT_CONFIG` fallback on error/loading. Apply CSS variable + document title on successful data. |
| `frontend/src/context/__tests__/BrandingContext.test.tsx` | Update tests to match new React Query implementation. Wrap in `QueryClientProvider`. Remove `useEffect` timing assumptions. |
| `frontend/vite.config.ts` | Add per-file 100% threshold for `src/pages/admin/SettingsPage.tsx`. |

### Backend
No backend changes.

### E2E
Add `frontend/e2e/admin/admin-settings.spec.ts` covering:
1. Settings page loads with current values
2. Updating app name and saving shows "Settings saved."
3. Sidebar reflects new app name after save (branding re-fetched)
4. Saving with empty app name shows validation error

## Schema Changes
None.

## Test plan

### Unit/integration (Vitest)
- `BrandingContext.test.tsx`: loading state, loaded state, error state (uses
  default), CSS variable applied, document.title set.
- `SettingsPage.test.tsx`: existing tests all pass; add test asserting that
  after save, `queryClient.invalidateQueries` causes a re-fetch of
  `["public-config"]`.

### E2E (Playwright)
- `admin-settings.spec.ts`: full save flow against deployed preview URL.

## Acceptance Criteria
1. After clicking Save on the Settings page, the app name in the admin sidebar
   updates immediately (without page reload).
2. The CSS `--color-primary` variable updates immediately after save.
3. All 835+ existing Vitest tests continue to pass.
4. 100% branch/line/function/statement coverage on `SettingsPage.tsx` and
   `BrandingContext.tsx`.
5. E2E test for settings save passes on the preview deployment.
