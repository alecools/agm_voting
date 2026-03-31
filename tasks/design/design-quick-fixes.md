# Design: Quick Frontend Fixes

**Status:** Implemented

**Feature branch:** `feat-quick-fixes`
**Schema migration required:** No

---

## Overview

Three focused UI fixes for the admin panel:

1. **Email format validation** — the "Add Lot Owner" form accepts any text as an email; it needs a format check consistent with the one already present in `EditModal`.
2. **Buildings page header buttons not wrapping on mobile** — the controls container in `.admin-page-header` uses a hardcoded `display: flex` inline style with no `flex-wrap`, so the toggle + button group overflows on narrow viewports.
3. **Sign-out button appears dark on mobile, white on desktop** — on desktop the button inherits `color: inherit` from `.admin-sidebar`, which resolves to white because the sidebar background is `var(--color-primary)`. On mobile the sidebar is hidden; the sign-out button is inside `.admin-nav-drawer`, which is off-screen until opened. The mobile-open-button (`.admin-nav-open-btn`) is unrelated. The root cause is that the sign-out `<button>` inside the drawer inherits the same white from `.admin-nav-drawer` (also `var(--color-primary)` background), so colour is actually consistent in the drawer. The real discrepancy noted in the task is the `color: white` hardcoded literal on `.admin-nav-open-btn` vs. `color: inherit` on the sign-out button — if `color: inherit` resolves differently in a future theme, white is not guaranteed. The fix makes both sign-out buttons use an explicit `color: var(--white)` to be unambiguous.

---

## Fix 1 — Email format validation on the "Add Lot Owner" form

### Root cause

`LotOwnerForm.tsx` contains two sub-components:

- **`EditModal`** (line 24): already has a local `isValidEmail` helper (line 17–19) and calls it in `handleAddEmail` (line 184) and `handleSetProxy` (line 204). Email inputs in `EditModal` use `type="text"`.
- **`AddForm`** (line 416): the Email field (line 529–539) uses `type="text"` and performs **no format validation** — `handleSubmit` (line 458) only checks that the email string is non-empty (line 475–478). An admin can submit any non-empty string.

`BuildingsPage.tsx` (line 207–233) has the Manager Email input already typed as `type="email"` (line 228), so HTML5 browser validation applies there via the `noValidate`-absent form. However, the form does have `noValidate` on line 207, and `handleSubmit` (line 122–128) only checks for non-empty — no format check. The backend accepts any string; there is no server-side email format validation on the building create endpoint either.

### Decision: JavaScript regex validation on submit, not `type="email"`

Two options exist:

| Approach | Pros | Cons |
|---|---|---|
| `type="email"` | Zero JS, leverages browser UX | Inconsistent browser UX, suppressible with `noValidate`, does not show `field__error` in the design system style |
| Regex check on submit | Consistent error display via `field__error`, testable, works with `noValidate` | Small amount of code |

The project already uses `noValidate` on the building creation form and shows errors via `field__error`. The `isValidEmail` helper already exists in `LotOwnerForm.tsx` and is the established pattern. Regex validation on submit is the right approach for both locations.

The regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` already used in `LotOwnerForm.tsx` is sufficient for an admin-facing form. It rejects obviously malformed strings (missing `@`, missing domain, whitespace) without over-engineering RFC 5321 compliance. The same regex should be extracted into a shared utility file to avoid duplication.

Backend validation is not required as part of this change — the admin panel is authenticated and the email is used for manager contact only, not for voter authentication. Adding backend validation would be a separate hardening task.

### Files to change

#### `frontend/src/utils/validation.ts` (new file)

Extract the existing `isValidEmail` function here so it can be shared across both components:

```ts
/** Returns true if the string passes a basic email format check. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
```

#### `frontend/src/components/admin/LotOwnerForm.tsx`

- Remove the local `isValidEmail` definition (lines 17–19).
- Import `isValidEmail` from `../../utils/validation`.
- In `AddForm.handleSubmit`: after the non-empty check on `email` (currently line 475–478), add:
  ```ts
  if (!isValidEmail(email)) {
    setFormError("Please enter a valid email address.");
    return;
  }
  ```
- No change needed to `EditModal` logic (already validates); only replace local `isValidEmail` with the imported one.
- Change the email `<input>` in `AddForm` (line 536) from `type="text"` to `type="email"` — this does not conflict with `noValidate`-free forms and improves mobile keyboard UX (shows email keyboard on iOS/Android). The form does not use `noValidate`, so HTML5 will also fire visually on submit, but the JS check fires first via `e.preventDefault()` so there is no conflict.

#### `frontend/src/pages/admin/BuildingsPage.tsx`

- Import `isValidEmail` from `../../utils/validation`.
- In `handleSubmit` (line 122–128): after the non-empty check on `managerEmail`, add:
  ```ts
  if (!isValidEmail(managerEmail)) {
    setFormError("Please enter a valid email address.");
    return;
  }
  ```
- The Manager Email `<input>` (line 223) already has `type="email"`. The form already has `noValidate` (line 207), so the HTML5 validation is suppressed and the JS check is the sole validator. No change to the input element is needed.

### Error message

In both locations, the error message for invalid format is:

> "Please enter a valid email address."

This is already the established wording in `EditModal` (line 185 and line 204).

---

## Fix 2 — Buildings page header buttons wrapping on mobile

### Root cause

In `BuildingsPage.tsx` (lines 158–173), the controls container is rendered with an inline style:

```tsx
<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
  <label className="toggle-switch">...</label>
  <button ... className="btn btn--primary">+ New Building</button>
</div>
```

No `flexWrap` is set. On narrow viewports (< 640 px), the `.admin-page-header` already switches to `flex-direction: column; align-items: flex-start` (CSS lines 2172–2176), which gives the header more vertical room, but the inner controls `<div>` still has no wrap. If the toggle label and button together exceed the container width (which is 100% of `.admin-main` at 16px padding, so `calc(100vw - 32px)` on mobile), they overflow or get clipped.

The `.admin-page-header` mobile media query (CSS lines 2168–2182) does not touch the inner controls container because it is an inline-styled `<div>`, not a CSS-classed element.

### Fix

Add `flexWrap: "wrap"` to the inline style on the controls `<div>` in `BuildingsPage.tsx` line 158:

```tsx
<div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
```

This is the minimum change. On desktop the buttons fit on one line and `flexWrap` has no visual effect. On mobile, when the container width is narrower than the combined width of the toggle and button, the button wraps to the next line.

No CSS changes are needed. The inline style approach is consistent with the existing code (this container was never given a CSS class).

### Files to change

- `frontend/src/pages/admin/BuildingsPage.tsx` — line 158: add `flexWrap: "wrap"` to the inline style object.

---

## Fix 3 — Sign-out button colour inconsistency

### Root cause

In `AdminLayout.tsx`, the Sign out button appears in two places:

1. **Desktop sidebar** (lines 95–103): inside `.admin-sidebar`, which has `background: var(--color-primary)` (a dark teal/navy). The button has `style={{ ... color: "inherit" }}` so it inherits `color: rgba(255,255,255,.85)` from `.admin-nav__link`. This resolves to off-white — visually correct.

2. **Mobile drawer** (lines 134–142): inside `.admin-nav-drawer`, which also has `background: var(--color-primary)`. Same `color: "inherit"` logic. This also resolves to off-white through `.admin-nav__link` — visually correct inside the drawer.

The actual bug is subtler: the `color: "inherit"` approach relies on the ambient text colour of the surrounding container always being white. `.admin-nav__link` in CSS (line 1303–1312) sets `color: rgba(255,255,255,.85)`, which applies when the element is inside `.admin-sidebar` or `.admin-nav-drawer`. The `<button>` element uses `className="admin-nav__link"`, so it picks up that rule and the colour is correct.

However, the CSS rule `.admin-nav__link` is a class applied to `<button>` elements inside both the sidebar and the drawer. If the button is ever rendered outside those containers (e.g. during testing, or if the layout changes), `color: inherit` would pick up a dark text colour.

The more reliable fix is to stop relying on inheritance for the colour and set it explicitly. The `style` prop already overrides other properties; adding `color: "rgba(255,255,255,.85)"` (matching the CSS variable equivalent) makes the colour explicit and browser-invariant.

Additionally, verifying in the browser: on a 375 px wide screen (iPhone SE), the mobile "Menu" button is rendered by `.admin-nav-open-btn` with `color: white` (CSS line 1350). The sign-out button is inside the drawer and reads correctly when the drawer is open. The issue may have been observed because the drawer transition hides the button behind the slide-in animation at intermediate states.

### Fix

In both sign-out button occurrences in `AdminLayout.tsx`, change `color: "inherit"` to `color: "rgba(255,255,255,.85)"` in the inline style. This matches the value set by `.admin-nav__link` and makes the colour explicit regardless of container:

**Desktop sidebar** (line 98):
```tsx
style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "rgba(255,255,255,.85)" }}
```

**Mobile drawer** (line 137):
```tsx
style={{ background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0, color: "rgba(255,255,255,.85)" }}
```

No CSS file changes are needed.

### Files to change

- `frontend/src/pages/admin/AdminLayout.tsx` — lines 98 and 137: replace `color: "inherit"` with `color: "rgba(255,255,255,.85)"`.

---

## Data flow

No network requests are involved in any of these three fixes. All changes are purely client-side presentation and validation logic.

---

## Key design decisions

| Decision | Rationale |
|---|---|
| Shared `isValidEmail` utility | Eliminates duplication between `LotOwnerForm` and `BuildingsPage`; keeps the regex in one place if it ever needs updating |
| Regex validation over `type="email"` HTML5 | Consistent with existing `noValidate` pattern on `BuildingsPage`; uses the established `field__error` display; already the chosen approach in `EditModal` |
| `flexWrap: "wrap"` inline (not a CSS class) | The inner controls div has no class; adding `flexWrap` inline is the minimal, consistent change — avoids introducing a new CSS selector for a one-property fix |
| Explicit `rgba` colour for sign-out (not a CSS variable) | The value is not a named design token; it matches the value CSS already sets on `.admin-nav__link`; explicit is more reliable than `inherit` |
| No backend email validation in this PR | Backend hardening (format validation on building/lot-owner create endpoints) is a separate concern; the admin portal is authenticated so input sanitisation risk is low; scope is kept minimal |

---

## Security considerations

### Email validation
- The `isValidEmail` regex is purely advisory — it improves UX but does not prevent malicious input. The admin portal is protected by session auth; a logged-in admin submitting a malformed email to the API directly is not a meaningful threat vector.
- The regex does not guard against email header injection because emails are stored in the DB and sent via Resend (which escapes headers). No new injection surface is introduced.
- Client-side validation must never be treated as a security boundary. If the backend needs email format enforcement, that is a separate task with its own migration implications (adding a `CHECK` constraint or Pydantic `EmailStr` validator).

### No XSS risk
- All three fixes are CSS/style changes or a string comparison. No new HTML interpolation, `dangerouslySetInnerHTML`, or `eval` usage is introduced.

---

## Vertical slice decomposition

All three fixes are entirely frontend-only and do not share state or components. They can be implemented and reviewed in a single branch because each change touches different files/lines with no overlap:

| Fix | Files touched |
|---|---|
| Email validation | `frontend/src/utils/validation.ts` (new), `LotOwnerForm.tsx`, `BuildingsPage.tsx` |
| Button wrap | `BuildingsPage.tsx` (one inline style property) |
| Sign-out colour | `AdminLayout.tsx` (two inline style properties) |

They are small enough that a single branch is more practical than three separate branches.

---

## E2E Test Scenarios

The **Admin** persona journey is affected by all three fixes (admin login → building/meeting management). The existing E2E specs for that journey that must be updated (not just supplemented):

- `frontend/e2e/admin/admin-buildings.spec.ts` — update to add email validation scenarios for the New Building modal
- `frontend/e2e/admin/admin-lot-owners.spec.ts` — update to add email validation scenarios for the Add Lot Owner dialog

### Fix 1: Email validation

#### `admin-buildings.spec.ts` — new scenarios to add

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 1 | **Happy path — valid email accepted** | Open New Building modal, fill name + valid email (`manager@example.com`), submit | Modal closes, building appears in table |
| 2 | **Empty email rejected** | Open modal, fill name only, submit | `field__error` "Manager email is required." visible; modal stays open |
| 3 | **Malformed email rejected — missing @** | Open modal, fill name + `notanemail`, submit | `field__error` "Please enter a valid email address." visible; modal stays open |
| 4 | **Malformed email rejected — no domain** | Open modal, fill name + `user@`, submit | `field__error` "Please enter a valid email address." visible; modal stays open |
| 5 | **Malformed email rejected — no TLD separator** | Open modal, fill name + `user@domain`, submit | `field__error` "Please enter a valid email address." visible; modal stays open |

#### `admin-lot-owners.spec.ts` — new scenarios to add

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 6 | **Happy path — valid email accepted** | Open Add Lot Owner dialog, fill all fields with valid email, submit | Lot owner appears in table |
| 7 | **Empty email rejected** | Open dialog, leave email blank, fill other fields, submit | `field__error` "Email is required." visible; dialog stays open |
| 8 | **Malformed email rejected** | Open dialog, fill email as `bademail`, fill other fields, submit | `field__error` "Please enter a valid email address." visible; dialog stays open |

### Fix 2: Buildings page header buttons wrapping

#### `admin-buildings.spec.ts` — new scenario to add

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 9 | **Mobile viewport: controls do not overflow** | Set viewport to 375x667, navigate to `/admin/buildings` | "Show archived" toggle and "+ New Building" button are both visible without horizontal scroll; verify via `page.evaluate` that no element has a scrollWidth > clientWidth on the page header row |

Note: Playwright can set viewport via `page.setViewportSize({ width: 375, height: 667 })`. Use `page.getByRole("button", { name: "+ New Building" })` to assert `toBeVisible()` without verifying exact position.

### Fix 3: Sign-out button colour

#### New scenarios in `admin-buildings.spec.ts` or a dedicated `admin-layout.spec.ts`

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 10 | **Desktop: sign-out visible in sidebar** | Navigate to any admin page at ≥ 641 px viewport | "Sign out" button visible in sidebar; its computed color is light (white/off-white) — assert `toBeVisible()` |
| 11 | **Mobile: sign-out visible in drawer** | Set viewport to 375x667, navigate to admin page, click "Menu" button to open drawer | Drawer opens; "Sign out" button is visible; verify `toBeVisible()` |

Playwright does not easily assert `getComputedStyle` colour values, so the test should assert `toBeVisible()` and leave colour regression to a visual snapshot test if needed. The important thing is that the element is present and reachable in both states.

### Affected existing E2E journeys

The Admin persona journey (`login → building/meeting management → report viewing → close meeting`) is touched. Specifically:

- `admin-buildings.spec.ts`: the existing "create building via modal dialog" test (happy path) will continue to pass after the email validation change because it already supplies a valid email (`e2e-modal@test.com`). No modification to existing tests is needed — only additions.
- `admin-lot-owners.spec.ts`: the existing "add lot owner form submits" test supplies `lot1@e2e.com`, which is a valid email, so it continues to pass. Only additions are needed.
- No other existing E2E specs are impacted by these three fixes.
