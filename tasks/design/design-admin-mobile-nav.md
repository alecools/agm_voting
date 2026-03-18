# Design: Admin Mobile Navigation Drawer

## Overview

Mobile-responsive navigation for the admin area. On desktop, the existing left-sidebar remains visible. On mobile (≤640px), the sidebar is hidden and replaced by a hamburger button that opens a slide-in navigation drawer. Admin tables are wrapped in a horizontally-scrollable container so they do not break the layout on narrow screens. No backend changes.

---

## Changes

### 1. Hamburger open button

A `☰ Menu` button is always present in the DOM but only visible on mobile. It sits at the top of `<main className="admin-main">`, rendered before `<Outlet />`.

```tsx
<button
  className="admin-nav-open-btn"
  onClick={() => setIsNavOpen(true)}
  aria-label="Open navigation"
  aria-expanded={isNavOpen}
>
  ☰ Menu
</button>
```

CSS: `.admin-nav-open-btn { display: none; }` on desktop; `display: flex` inside `@media (max-width: 640px)`. Forced back to `display: none !important` inside `@media (min-width: 641px)`.

### 2. Navigation drawer panel

`AdminLayout` holds a boolean state `isNavOpen` (default `false`). The drawer is a `div.admin-nav-drawer` with a conditional `.admin-nav-drawer--open` modifier class.

```tsx
<div
  className={`admin-nav-drawer${isNavOpen ? " admin-nav-drawer--open" : ""}`}
  aria-hidden={!isNavOpen}
  data-testid="admin-nav-drawer"
>
  ...
  <NavContent onNavClick={() => setIsNavOpen(false)} />
  ...
</div>
```

CSS (inside `@media (max-width: 640px)`):
- `display: flex; flex-direction: column; position: fixed; left: 0; top: 0; height: 100%; width: 85vw; max-width: 280px; background: var(--navy); z-index: 201; overflow-y: auto; transform: translateX(-100%); transition: transform 0.25s ease;`
- `.admin-nav-drawer--open { transform: translateX(0); }`

On desktop (`@media (min-width: 641px)`), the drawer and backdrop are `display: none !important`.

### 3. Backdrop overlay

When the drawer is open, a translucent backdrop `div.admin-nav-drawer__backdrop` is conditionally rendered. Clicking it closes the drawer by setting `isNavOpen(false)`.

```tsx
{isNavOpen && (
  <div
    className="admin-nav-drawer__backdrop"
    onClick={() => setIsNavOpen(false)}
    aria-hidden="true"
  />
)}
```

CSS (inside `@media (max-width: 640px)`): `position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 200;`

### 4. Close button inside drawer

A `✕` button is rendered inside the drawer with `aria-label="Close navigation"`. It calls `setIsNavOpen(false)`.

CSS: `position: absolute; top: 12px; right: 12px;`

### 5. Nav items auto-close drawer on navigation

`NavContent` accepts an optional `onNavClick` callback. The drawer passes `onNavClick={() => setIsNavOpen(false)}` so every `NavLink` click closes the drawer. The desktop sidebar passes no callback.

**Nav items in the drawer (same as desktop sidebar):**
- Buildings → `/admin/buildings`
- General Meetings → `/admin/general-meetings`
- ← Voter portal → `/`
- Sign out (button, calls `adminLogout`)

### 6. Admin sidebar hidden on mobile

Inside `@media (max-width: 640px)`: `.admin-sidebar { display: none; }`

### 7. `.admin-table-wrapper` horizontal scroll

A new utility class wraps every admin `<table>` that may overflow on narrow screens:

```css
.admin-table-wrapper {
  overflow-x: auto;
  width: 100%;
}
```

No breakpoint restriction — the wrapper is applied globally and does nothing on desktop where the table fits.

Applied in `AGMReportView.tsx` (each per-motion results table).

### 8. Admin responsive padding

Inside `@media (max-width: 640px)`:
- `.admin-main { padding: 16px; }` (down from `32px` on desktop)
- `.admin-page-header { flex-direction: column; align-items: flex-start; gap: 12px; }` (stacks title and action button vertically)
- `.field__input, .field__select { max-width: 100%; box-sizing: border-box; }`

---

## Breakpoint

All mobile-specific styles are scoped to `@media (max-width: 640px)`. Desktop overrides that must win over mobile defaults use `@media (min-width: 641px)` with `!important`.

---

## Files changed

| File | Change |
|---|---|
| `frontend/src/pages/admin/AdminLayout.tsx` | Added `isNavOpen` state; hamburger button; drawer div with `admin-nav-drawer`/`admin-nav-drawer--open`; backdrop; close button; `NavContent` accepts `onNavClick` |
| `frontend/src/styles/index.css` | Added `.admin-nav-open-btn`, `.admin-nav-drawer`, `.admin-nav-drawer--open`, `.admin-nav-drawer__close`, `.admin-nav-drawer__backdrop` (all scoped to `@media (max-width: 640px)`); desktop override block; `.admin-table-wrapper`; admin responsive padding block |
| `frontend/src/components/admin/AGMReportView.tsx` | Wrapped each `<table className="admin-table">` in `<div className="admin-table-wrapper">` |

---

## No backend changes

This is a frontend-only layout change. No API endpoints or database schema are modified.
