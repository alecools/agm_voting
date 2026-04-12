# Design: Voter Sign-out

PRD reference: `tasks/prd/prd-voting-flow.md` — US-SO-01

**Status:** Implemented

---

## Overview

The voting page currently has a "← Back" button that calls `navigate('/vote/<meetingId>/auth')`. It does not invalidate the server-side session; the `agm_session` HttpOnly cookie and the corresponding `SessionRecord` row remain active. This means a voter who hands off a shared device leaves their session fully exploitable.

This change renames the button to "Sign out", hooks it up to the existing `POST /api/auth/logout` endpoint (with a server-side session deletion added), clears client-side state, and navigates the user to the home page (`/`).

The backend logout endpoint already exists and already clears the cookie. The only backend change needed is to also delete the `SessionRecord` from the database so that re-presenting the same signed cookie value cannot restore the session. The frontend `logout()` API function already exists in `voter.ts`. The MSW handler and the API unit test already exist. The remaining work is wiring up the VotingPage button and adding the sessionStorage + React Query cleanup.

---

## Technical Design

### Database changes

No schema changes. The `session_records` table is unchanged.

### Backend changes

#### `POST /api/auth/logout` — add session deletion (modified)

File: `backend/app/routers/auth.py`

Current implementation:

```python
@router.post("/auth/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(key="agm_session", path="/api")
    return {"ok": True}
```

Modified implementation — delete the `SessionRecord` row if one exists for the presented cookie:

```python
@router.post("/auth/logout")
async def logout(
    response: Response,
    agm_session: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if agm_session:
        try:
            raw_token = _unsign_token(agm_session)
            await db.execute(
                delete(SessionRecord).where(
                    SessionRecord.session_token == raw_token
                )
            )
            await db.commit()
        except HTTPException:
            pass  # Expired/invalid signature — no DB row to delete; still clear cookie
    response.delete_cookie(key="agm_session", path="/api")
    return {"ok": True}
```

Key design decisions:
- The `HTTPException` from `_unsign_token` (401) is caught and swallowed. Logout must be idempotent: an expired or tampered token is not an error; the cookie is still cleared.
- No `Depends(get_db)` injection was previously needed; it is added now to execute the DELETE. The dependency is only resolved if the function body actually needs the DB, which it does when a cookie is present.
- A missing or absent cookie results in no DB operation; the cookie clear still fires.

#### Imports added to `auth.py`

```python
from sqlalchemy import delete, select  # `delete` already imported — no change needed
```

`delete` is already imported (line 12 of the current `auth.py`). `Cookie` is already imported (line 13). `Depends` is already imported. `get_db` is already imported. No new imports required.

### Frontend changes

#### `VotingPage.tsx` — rename button, wire logout, clear state

File: `frontend/src/pages/vote/VotingPage.tsx`

Changes:

1. Import `logout` and `useQueryClient` (already imported):
   - `logout` is already available in `../../api/voter` — add it to the import list.
   - `useQueryClient` is already imported.

2. Add a `handleSignOut` callback that:
   a. Calls `logout()` (fire-and-forget with error swallowed — sign-out must never block).
   b. Removes all `sessionStorage` keys scoped to `meetingId`.
   c. Calls `queryClient.clear()` to flush all cached voter data.
   d. Calls `navigate("/")` to return to the home page.

3. Replace the "← Back" button (lines 632-634 of the current file):

```tsx
// Before
<button type="button" className="btn btn--ghost back-btn"
  onClick={() => navigate(`/vote/${meetingId}/auth`)}>
  ← Back
</button>

// After
<button type="button" className="btn btn--ghost back-btn"
  onClick={handleSignOut}>
  Sign out
</button>
```

The meeting-not-found error state (lines 616-628) retains its existing "← Back" button verbatim — it navigates to `/vote/${meetingId}/auth` and does not trigger sign-out. This is intentional: the voter has not yet successfully authenticated when they see the not-found error (the meeting URL is invalid), so there is no session to invalidate.

#### `handleSignOut` implementation detail

```tsx
const handleSignOut = useCallback(() => {
  // Best-effort server logout — never block navigation on failure
  logout().catch(() => {});
  // Clear all meeting-scoped sessionStorage keys
  if (meetingId) {
    sessionStorage.removeItem(`meeting_lots_${meetingId}`);
    sessionStorage.removeItem(`meeting_lots_info_${meetingId}`);
    sessionStorage.removeItem(`meeting_lot_info_${meetingId}`);
    sessionStorage.removeItem(`meeting_building_name_${meetingId}`);
    sessionStorage.removeItem(`meeting_title_${meetingId}`);
    sessionStorage.removeItem(`meeting_mc_selections_${meetingId}`);
  }
  queryClient.clear();
  navigate("/");
}, [meetingId, queryClient, navigate]);
```

`logout()` is called with `.catch(() => {})` so a network failure does not prevent navigation. The local cleanup (sessionStorage + React Query) happens synchronously before the navigate call, ensuring state is always cleared regardless of the network result.

`queryClient.clear()` evicts all cached queries. This is a broader reset than `invalidateQueries` and is appropriate here because the new user's session will produce completely different data; stale cache entries from the previous voter would be misleading.

#### No changes to `frontend/src/api/voter.ts`

The `logout()` function already exists (lines 222-226). No changes required.

#### No changes to `frontend/tests/msw/handlers.ts`

The MSW handler for `POST /api/auth/logout` already exists (line 1322). No changes required.

---

## Security Considerations

**Server-side session invalidation:** The existing logout endpoint only cleared the cookie. If a malicious actor had exfiltrated the signed cookie value (e.g. via network sniffing on HTTP, or by reading from developer tools before logout), they could re-present it after logout and restore the session. Deleting the `SessionRecord` row closes this window — re-presenting an old token returns 401 from `get_session` because the DB row is gone.

**No new endpoints, inputs, or secrets.** The endpoint already existed. No new auth requirements. No rate-limiting concern: logout is not a resource-creating operation and cannot be exploited to enumerate data.

**CSRF exemption note:** `POST /api/auth/logout` is already in `CSRFMiddleware._EXEMPT_PATHS` (line 104 of `main.py`). No change needed.

---

## Files to Change

| File | Change |
|---|---|
| `backend/app/routers/auth.py` | Add `Cookie` + `get_db` params to `logout`; delete `SessionRecord` row before clearing cookie |
| `frontend/src/pages/vote/VotingPage.tsx` | Import `logout`; add `handleSignOut` callback; rename "← Back" → "Sign out" on the main button; wire `onClick={handleSignOut}` |
| `backend/tests/test_phase2_api.py` | Add tests: logout with valid session cookie deletes the `SessionRecord` row; subsequent restore_session returns 401 |
| `frontend/src/pages/vote/__tests__/VotingPage.test.tsx` | Update existing "renders back button" and "back button navigates" tests to use new label "Sign out"; add test: sign-out clears sessionStorage + navigates to "/" |
| `e2e_tests/voter/back-button-navigation.spec.ts` | Update `BB.1` and `BB.2` scenarios to reflect that the in-page button is now labelled "Sign out" and navigates to `/` instead of `/auth` |

---

## Data Flow — Happy Path

1. Voter is on `VotingPage` at `/vote/<meetingId>/voting`.
2. Voter clicks "Sign out".
3. `handleSignOut` fires synchronously:
   a. Calls `logout()` (async, not awaited) → fires `POST /api/auth/logout` to the backend.
   b. Removes all `meeting_*` sessionStorage keys for `meetingId`.
   c. Calls `queryClient.clear()`.
   d. Calls `navigate("/")`.
4. Browser navigates to `/` immediately (no await on the network call).
5. Backend processes `POST /api/auth/logout`:
   a. Reads `agm_session` cookie from the request.
   b. Calls `_unsign_token` to extract the raw token.
   c. Executes `DELETE FROM session_records WHERE session_token = <raw_token>`.
   d. Commits the transaction.
   e. Calls `response.delete_cookie(key="agm_session", path="/api")`.
   f. Returns `{"ok": True}`.
6. Browser receives the `Set-Cookie: agm_session=; Max-Age=0` header and clears the cookie.
7. Any subsequent call to `POST /api/auth/session` with the old cookie returns 401 (row deleted + cookie cleared).

---

## Key Design Decisions

**Why navigate to `/` and not `/vote/<meetingId>/auth`?**

The original "Back" button navigated to `/auth` because it was intended for a voter who had second thoughts and wanted to re-authenticate as a different identity. "Sign out" has a different intent: the voter is done and wants to exit entirely. Navigating to `/` (the building selection page) is the natural exit point for the voter journey. If a new voter wants to vote for the same meeting, they navigate from `/` as normal.

**Why not await `logout()` before navigating?**

The network call can fail (server unavailable, connectivity issue). Blocking navigation on the network call would mean a voter on a flaky connection could never sign out. Local state is always cleared; server-side invalidation is best-effort. This matches the admin logout pattern in `AdminLayout.tsx`, which also does not await the logout API call before navigating.

**Why keep the meeting-not-found "← Back" button unchanged?**

When the meeting-not-found error renders, the voter has not been through OTP auth (the meeting URL is invalid). There is no session cookie and no sessionStorage data to clear. Reusing the same sign-out handler would fire a pointless API call and navigate to `/` instead of `/auth`, which breaks the user's ability to correct the meeting URL.

**Why `queryClient.clear()` and not `queryClient.invalidateQueries()`?**

`invalidateQueries` marks data as stale and refetches on next use — it does not evict the in-memory cache. On a shared device, after logout, if the new user's auth resolves before the background refetch completes, they could briefly see the previous voter's lot list. `clear()` evicts everything immediately, eliminating this race.

**Why delete the `SessionRecord` row entirely instead of expiring it?**

Setting `expires_at = now()` is functionally equivalent but leaves a tombstone row that the background cleanup task would need to handle. Deleting immediately is simpler and consistent with how admin logout works (it uses Starlette's `session.clear()` which destroys the session entirely).

---

## Schema Migration Required

No. No schema changes are required.

---

## E2E Test Scenarios

### Happy path

**SO-E2E-01: Sign out clears session and lands on home page**

Steps:
1. Seed building, lot owner, meeting.
2. Authenticate voter — land on `/vote/<id>/voting`.
3. Click "Sign out".
4. Assert URL is `/` (building selection page).
5. Navigate to `/vote/<id>/auth` (same meeting).
6. Assert the OTP form is shown (session restore returns 401 — cookie cleared and DB row deleted).

### Error/edge cases

**SO-E2E-02: Sign out succeeds even when backend is unavailable**

This scenario cannot be tested directly against a live backend (would require mocking network failure). Covered in unit tests: `handleSignOut` is called with a mocked `logout()` that rejects; assert sessionStorage is cleared and `navigate("/")` is called regardless.

**SO-E2E-03: Multi-step sequence — authenticate, vote partially, sign out, re-authenticate**

Steps:
1. Seed building, 2-lot voter, meeting with 1 motion.
2. Authenticate — land on `/vote/<id>/voting`.
3. Do NOT submit votes.
4. Click "Sign out" — lands on `/`.
5. Navigate to `/vote/<id>/auth`.
6. Assert OTP form is shown (not auto-redirected to voting — old session is invalidated).
7. Re-authenticate with the same email.
8. Assert routed back to `/vote/<id>/voting` with motions shown (fresh session, no prior votes).

This multi-step scenario verifies: sign-out invalidates the server session (step 6 shows OTP form), and the voter can re-authenticate cleanly (step 8).

### Existing E2E specs affected

The following existing specs reference the "← Back" button on `VotingPage` and must be updated:

| Spec file | Scenario | Update needed |
|---|---|---|
| `e2e_tests/voter/back-button-navigation.spec.ts` | `BB.1`: clicks `getByRole("button", { name: "← Back" })` | Update selector to `"Sign out"`; assert URL is `/` not `/auth` |
| `e2e_tests/voter/back-button-navigation.spec.ts` | `BB.2`: browser native back — no button click | No update needed (browser back button, not in-page button) |

The **Voter** persona journey (auth → lot selection → voting → confirmation) is touched by this change at the voting step. The `e2e_tests/workflows/voting-scenarios.spec.ts` and `e2e_tests/workflows/edge-cases.spec.ts` files should be reviewed to confirm they do not click the "← Back" button; if any do, those selectors must be updated.

---

## Vertical Slice Decomposition

This feature is small enough to be a single slice. Backend and frontend changes are tightly coupled (the frontend's `handleSignOut` depends on the backend deleting the `SessionRecord` to provide the security guarantee). No parallel decomposition is warranted.
