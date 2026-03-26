# Design: Fix — Back Button Blank Page on VotingPage

## Overview

Clicking the in-page "Back" button on `VotingPage`, or pressing the browser native back button while on `/vote/:meetingId/voting`, produces a blank page. This document diagnoses the exact root cause and specifies the minimal fix.

---

## Root Cause Analysis

### Route tree (from `App.tsx`)

The voter-facing route tree is:

```
/                                  → BuildingSelectPage
/vote/:meetingId/auth              → AuthPage
/vote/:meetingId/voting            → VotingPage
/vote/:meetingId/confirmation      → ConfirmationPage
```

There is **no route at `/vote/:meetingId`**. That path is unmatched by the router and React Router renders nothing, producing a blank page.

### In-page "Back" button — `VotingPage.tsx` line 424

```tsx
<button ... onClick={() => navigate(`/vote/${meetingId}`)}>
  ← Back
</button>
```

The button calls `navigate(`/vote/${meetingId}`)`. The target path — e.g. `/vote/abc-123` — has no corresponding `<Route>` in `App.tsx`. React Router finds no match and renders an empty outlet, which appears as a blank page.

### Browser native back button

The history stack when a voter reaches `/vote/:meetingId/voting` normally looks like:

```
[0] /                                   (BuildingSelectPage)
[1] /vote/:meetingId/auth               (AuthPage)
[2] /vote/:meetingId/voting             (VotingPage)   ← current
```

`AuthPage.verifyMutation.onSuccess` (line 63) calls `navigate(`/vote/${meetingId}/voting`)` — a **push** navigation, which correctly adds an entry. However, from `AuthPage` the voter arrives after `navigate(`/vote/${meetingId}/auth`)` called from `BuildingSelectPage.handleEnterVoting` — also a push. So the back button from `/voting` returns to `/vote/:meetingId/auth` (the `AuthPage`), which is a valid route. On its own, the native back button does NOT cause a blank page through the normal happy-path flow.

However, there is a secondary scenario that does produce a blank page via the native back button:

- The in-page Back button pushes `/vote/:meetingId` onto the history stack.
- The user is now on the blank `/vote/:meetingId` page and presses back — they return to `/vote/:meetingId/voting`, which is fine.
- But if the user presses the browser forward button (or lands on `/vote/:meetingId` any other way) the blank persists.

The primary defect is therefore the in-page Back button pointing to the non-existent `/vote/:meetingId` route. The native back button from a clean session does not produce a blank page on its own, but it also has a secondary problem: returning to `AuthPage` without sessionStorage state (e.g. after a hard refresh mid-session) causes `AuthPage` to render the email form, which is the correct graceful fallback — so no additional guard is needed there.

### Summary table

| Trigger | Root cause | File | Line |
|---|---|---|---|
| In-page Back button | Navigates to `/vote/:meetingId` — a route that does not exist | `VotingPage.tsx` | 424 |
| Browser back (normal flow) | Returns to `/vote/:meetingId/auth` — valid route, no issue | — | — |

---

## Database Changes

None. This is a pure frontend fix.

---

## Backend Changes

None.

---

## Frontend Changes

### `frontend/src/pages/vote/VotingPage.tsx` — line 424

**Change:** Replace `navigate(`/vote/${meetingId}`)` with `navigate(`/vote/${meetingId}/auth`)`.

Before:
```tsx
<button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}`)}>
  ← Back
</button>
```

After:
```tsx
<button type="button" className="btn btn--ghost back-btn" onClick={() => navigate(`/vote/${meetingId}/auth`)}>
  ← Back
</button>
```

This is a one-line change. The Back button now navigates to the auth page (`/vote/:meetingId/auth`), which is a valid registered route and renders `AuthPage`. `AuthPage` renders the email-entry form without requiring any sessionStorage state, so it is safe to land on at any time.

### Why not `navigate(-1)`?

`navigate(-1)` (browser-history go-back) is tempting but fragile:

- If the voter opened `/vote/:meetingId/voting` directly (e.g. bookmarked URL or mid-session hard refresh followed by re-auth), there may be no prior `/auth` entry in the history stack, and `navigate(-1)` would leave the voter on a previous unrelated page or trigger a no-op.
- It also makes the navigation target opaque in tests.

Navigating to the explicit `/vote/:meetingId/auth` path is deterministic and testable.

### Why not add a `/vote/:meetingId` route?

Adding a catch-all `/vote/:meetingId` route that redirects somewhere would mask the misdirection rather than fix it. The correct long-term answer is for the Back button to always target a defined route.

### Guard for missing sessionStorage state (secondary concern)

`AuthPage` does not read sessionStorage on mount — it starts from scratch with the email form regardless. No guard is required.

`VotingPage` reads `meeting_lots_info_<meetingId>` from sessionStorage on mount (lines 50–60) and silently falls back to empty state if absent. This means navigating forward again from `AuthPage` after a hard refresh will re-authenticate and re-populate sessionStorage normally. No additional guard is required.

---

## Key Design Decisions

1. **Target `/vote/:meetingId/auth`, not `/`** — sending the voter back to the root would lose their meeting context (the meetingId). Auth page preserves context and allows the voter to re-authenticate immediately if needed.
2. **One-line change only** — the smallest possible diff minimises regression risk. No new routes, no new components, no sessionStorage changes.
3. **No `replace` needed** — the Back button should add a history entry so the browser forward button continues to work as expected.

---

## Data Flow (Happy Path After Fix)

1. Voter on `BuildingSelectPage` (`/`) selects a meeting → `navigate(`/vote/:meetingId/auth`)`.
2. Voter authenticates on `AuthPage` → server returns lots → `navigate(`/vote/:meetingId/voting`)`.
3. Voter on `VotingPage` clicks in-page Back button → `navigate(`/vote/:meetingId/auth`)` → `AuthPage` renders (email form from scratch).
4. Voter re-authenticates or chooses a different meeting from root.

---

## Schema Migration Note

No Alembic migration required. No database changes.

---

## E2E Test Scenarios

### Happy path — in-page Back button

1. Navigate to the voter home page (`/`).
2. Select a building and an open meeting.
3. Authenticate with a valid email + OTP code.
4. Arrive at `/vote/:meetingId/voting`.
5. Click the "← Back" button.
6. Assert: URL is `/vote/:meetingId/auth`.
7. Assert: The auth page renders (email input field is visible).
8. Assert: Page is not blank (no empty `<main>` or `<body>`).

### Regression — browser Back button does not blank

1. Authenticate and land on `/vote/:meetingId/voting` (as above).
2. Use the browser's native back navigation.
3. Assert: URL is `/vote/:meetingId/auth`.
4. Assert: Auth page is visible (email input field present).

### Edge case — direct URL to `/vote/:meetingId` (pre-fix, should now 404 gracefully or redirect)

After applying the fix, the route `/vote/:meetingId` still has no match. This is acceptable because no in-app navigation targets it after the fix. A future hardening task could add a catch-all redirect, but it is out of scope for this minimal fix.

### Edge case — Back from VotingPage preserves meetingId context

1. Authenticate for meeting ID `abc-123`.
2. Click Back → land on `/vote/abc-123/auth`.
3. Assert: The auth page URL contains the correct `meetingId` (`abc-123`), not a generic `/`.

---

## Parallel Slice Decomposition

This fix is a single frontend-only change to one line in one file. It does not touch the backend, database, or any other frontend component. No slice decomposition is necessary — it is a single branch, single PR.
