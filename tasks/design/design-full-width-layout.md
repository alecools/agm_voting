# Design: Full-Width Desktop Layout and Collapsible Mobile Lot Sidebar

## Overview

Two layout improvements to the voter voting page:

1. **Full-width desktop layout** — the `.voter-content` wrapper is widened from the previous narrow constraint to `max-width: 1280px`, giving the two-column voting layout room to breathe on wide screens.
2. **Collapsible mobile lot sidebar** — on mobile (≤640px), the sidebar column is hidden and replaced by a slide-in drawer. A `☰ Your Lots` open button appears above the motions column. On desktop the drawer is hidden and the sidebar column is always visible.

No backend changes. No new API endpoints.

---

## Changes

### 1. `.voter-content` max-width widened

**Before:** `max-width: 660px` (narrow, prevented the two-column layout from using available screen space on desktop)

**After:**
```css
.voter-content {
  flex: 1;
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 36px 24px 80px;
}

@media (max-width: 640px) {
  .voter-content {
    padding: 20px 16px 60px;
  }
}
```

The padding reduces on mobile to preserve horizontal space.

### 2. Two-column voting layout

The `.voting-layout` wrapper is used whenever `showSidebar` is true (multi-lot voters with more than one lot). Single-lot voters see a plain full-width motions column.

```css
.voting-layout {
  display: flex;
  gap: 24px;
  align-items: flex-start;
}
.voting-layout__sidebar {
  width: 280px;
  flex-shrink: 0;
}
.voting-layout__main {
  flex: 1;
  min-width: 0;
}
```

On mobile (`@media (max-width: 640px)`), `.voting-layout__sidebar { display: none; }` hides the sidebar column. The main column expands to full width automatically.

On desktop (`@media (min-width: 641px)`), the drawer elements are `display: none !important`.

### 3. Mobile sidebar drawer

`VotingPage` adds a boolean state `isDrawerOpen` (default `false`). The drawer is only rendered when `showSidebar` is true (multi-lot voters).

**Open button** — sits above the motions column, hidden on desktop:
```tsx
<button
  type="button"
  className="sidebar-drawer-open-btn"
  onClick={() => setIsDrawerOpen(true)}
  aria-label="Open lot selector"
>
  ☰ Your Lots
</button>
```

**Drawer panel** — slide-in from the left:
```tsx
<div
  className={`sidebar-drawer${isDrawerOpen ? " sidebar-drawer--open" : ""}`}
  aria-hidden={!isDrawerOpen}
>
  <button
    type="button"
    className="sidebar-drawer__close"
    aria-label="Close lot selector"
    onClick={() => setIsDrawerOpen(false)}
  >✕</button>
  {lotListContent}
</div>
```

**Backdrop** — conditionally rendered when open:
```tsx
{isDrawerOpen && (
  <div
    className="sidebar-drawer__backdrop"
    onClick={() => setIsDrawerOpen(false)}
    aria-hidden="true"
  />
)}
```

CSS (mobile, inside `@media (max-width: 640px)`):
```css
.sidebar-drawer {
  display: block;
  position: fixed;
  top: 0; left: 0;
  height: 100%; width: 85vw; max-width: 320px;
  background: var(--white);
  z-index: 201;
  overflow-y: auto;
  padding: 48px 16px 24px;
  transform: translateX(-100%);
  transition: transform 0.25s ease;
}
.sidebar-drawer--open { transform: translateX(0); }
.sidebar-drawer__backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 200;
}
```

On desktop, `.sidebar-drawer`, `.sidebar-drawer__backdrop`, and `.sidebar-drawer-open-btn` are all `display: none !important`.

### 4. Sidebar content

The lot list content (`lotListContent`) is shared between the desktop sidebar column and the mobile drawer. It contains:
- "Your Lots" heading and subtitle (lot count or "all submitted")
- Lot shortcut buttons (Select All, Deselect All, Select Proxy Lots, Select Owned Lots)
- Scrollable `<ul>` of lot checkboxes — each item shows lot number, proxy badge, in-arrear badge, already-submitted badge
- No-selection error message (shown when Submit is clicked with nothing selected)
- "View Submission" button when all lots are already submitted

### 5. Single-lot proxy inline strip

Single-lot voters who are voting via proxy do not see a sidebar or drawer. They see a compact `.lot-selection--inline` strip above the motions:

```tsx
<div className="lot-selection lot-selection--inline">
  <h2 className="lot-selection__title">Your Lots</h2>
  <ul ...>
    <li>
      <span>Lot {lot.lot_number}</span>
      <span className="lot-selection__badge lot-selection__badge--proxy">via Proxy</span>
    </li>
  </ul>
</div>
```

Single-lot non-proxy voters see no lot panel at all.

---

## Breakpoint summary

| Breakpoint | Sidebar column | Drawer open button | Drawer panel |
|---|---|---|---|
| ≥641px (desktop) | Visible (280px fixed) | Hidden (`display: none !important`) | Hidden (`display: none !important`) |
| ≤640px (mobile) | Hidden (`display: none`) | Visible | Slide-in panel |

---

## Files changed

| File | Change |
|---|---|
| `frontend/src/pages/vote/VotingPage.tsx` | Added `isDrawerOpen` state; `mobileDrawer` JSX (backdrop + drawer panel with close button); `sidebar-drawer-open-btn` button above motions; `sidebarContent` desktop column (`voting-layout__sidebar`); `showSidebar` flag; `lotListContent` shared variable; single-lot-proxy inline strip |
| `frontend/src/styles/index.css` | Updated `.voter-content` max-width to 1280px and padding; added `.voter-content` mobile padding block; added `.voting-layout`, `.voting-layout__sidebar`, `.voting-layout__main`; added `.sidebar-drawer`, `.sidebar-drawer--open`, `.sidebar-drawer__close`, `.sidebar-drawer__backdrop`, `.sidebar-drawer-open-btn` (mobile block); desktop override block for drawer elements |

---

## No backend changes

All changes are frontend layout and CSS only.
