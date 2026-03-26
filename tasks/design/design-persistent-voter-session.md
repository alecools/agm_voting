# Design: Persistent Voter Session

## Overview

Voters currently must complete the full OTP flow on every visit to the app, even if they authenticated minutes earlier and simply closed a browser tab. This design adds return-visit session persistence so that a voter who has already authenticated can skip the OTP step for up to 24 hours (or until the meeting closes, whichever comes first).

### Key finding from codebase investigation

A full stateful session system already exists and is already wired up:

- `backend/app/models/session_record.py` — `SessionRecord` table with `session_token`, `voter_email`, `building_id`, `general_meeting_id`, `expires_at`
- `backend/app/services/auth_service.py` — `create_session()` (called by `POST /api/auth/verify`) and `get_session()` (used by all voting endpoints)
- `POST /api/auth/verify` already creates a `SessionRecord` and sets a `meeting_session` HttpOnly cookie
- All voting endpoints (`GET /motions`, `POST /submit`, etc.) already accept the session via cookie OR `Authorization: Bearer <token>` header

The gap is entirely on the **frontend**: there is no `localStorage` persistence, no return-visit detection, and no endpoint to validate a stored token and restore session state without re-running the OTP flow.

The work required is therefore:
1. **Backend:** one new endpoint `POST /api/auth/session` that accepts a stored token and returns the same `AuthVerifyResponse` shape as `POST /api/auth/verify`
2. **Frontend:** store the session token in `localStorage` after OTP verification; on page load check for a stored token, call the new endpoint, and skip OTP if valid

---

## Chosen approach: stateful server-side session (no schema change)

### Stateless JWT vs stateful server-side session

| Concern | Stateless JWT | Stateful server-side (chosen) |
|---|---|---|
| DB migration required | No | No — `session_records` table already exists |
| Immediate invalidation on meeting close | Requires additional DB check or short expiry | Natural: `get_session()` already checks expiry; adding AGM status check is one line |
| Token revocation (logout, abuse) | Requires a denylist (DB anyway) | Delete the row |
| Complexity | Requires HMAC/JWT library, signing logic | `secrets.token_urlsafe(32)` already used |
| Already implemented | No | Yes — the entire session infrastructure is live |

The stateful approach requires zero schema changes and zero new libraries. The JWT approach would add complexity without a meaningful security improvement given this threat model (voting app, not banking). The stateful model is chosen.

---

## Database changes

None. The `session_records` table already exists with all required columns:

```
session_records
  id               UUID PK
  session_token    VARCHAR UNIQUE NOT NULL
  voter_email      VARCHAR NOT NULL
  building_id      UUID FK buildings.id ON DELETE CASCADE
  general_meeting_id UUID FK general_meetings.id ON DELETE CASCADE
  created_at       TIMESTAMPTZ server default now()
  expires_at       TIMESTAMPTZ NOT NULL
```

**Schema migration required: NO.**

---

## Backend changes

### 1. New endpoint: `POST /api/auth/session`

**Location:** `backend/app/routers/auth.py`

**Purpose:** Accepts a previously-issued session token (from `localStorage`), validates it, and returns the same `AuthVerifyResponse` shape as `POST /api/auth/verify`. This allows the frontend to restore a session without OTP.

**Request schema (new Pydantic model `SessionRestoreRequest`):**

```python
class SessionRestoreRequest(BaseModel):
    session_token: str
    general_meeting_id: uuid.UUID
```

**Response schema:** reuses existing `AuthVerifyResponse` (unchanged).

**Logic:**

1. Look up `SessionRecord` by `session_token` AND `general_meeting_id` where `expires_at > now()`; return 401 if not found
2. Load the `GeneralMeeting`; if `get_effective_status(meeting) == "closed"` return 401 with `{"detail": "Session expired — meeting is closed"}`
3. Using `session.voter_email` and `meeting.building_id`, run exactly the same lot-lookup, submission-check, and `unvoted_visible_count` logic as `POST /api/auth/verify` steps 4–10
4. Re-set the `meeting_session` cookie (same as `verify`)
5. Return `AuthVerifyResponse`

The 401 on closed meeting (step 2) is intentional: returning 401 forces the frontend to show the auth screen, which will then route the voter to the confirmation page via the `agm_status: "closed"` response from OTP verification. This avoids exposing a separate "closed" code path on the session endpoint.

**Error responses:**

| Case | Status | Detail |
|---|---|---|
| Token not found / expired | 401 | "Session expired or invalid" |
| AGM is closed | 401 | "Session expired — meeting is closed" |
| AGM not found | 404 | "General Meeting not found" |

**No rate limiting** on this endpoint — it is token-authenticated, not email-based.

### 2. New schema model: `SessionRestoreRequest`

**Location:** `backend/app/schemas/auth.py`

Add:

```python
class SessionRestoreRequest(BaseModel):
    session_token: str
    general_meeting_id: uuid.UUID

    @field_validator("session_token")
    @classmethod
    def token_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("session_token must not be empty")
        return v
```

### 3. No changes to `auth_service.py`

`get_session()` already does the right lookup (token + meeting_id + expiry check). The new endpoint calls `get_session()` directly to find the session, then runs the lot-lookup logic inline (same as `verify_auth`).

### 4. Meeting close invalidation

No additional work. When an admin closes a meeting, the new `POST /api/auth/session` endpoint rejects tokens for that meeting because step 2 checks `get_effective_status(meeting) == "closed"`. The `session_records` rows are **not** deleted on close — the check is purely runtime. This is correct: the voter's session token remains in `localStorage` but becomes invalid immediately when the meeting closes, because every call to `POST /api/auth/session` re-checks AGM status.

---

## Frontend changes

### Overview of changes

| File | Change |
|---|---|
| `frontend/src/api/voter.ts` | Add `restoreSession()` function and `SessionRestoreRequest` / response types |
| `frontend/src/pages/vote/AuthPage.tsx` | On mount, attempt session restore; on successful OTP verify, store token in `localStorage` |
| `frontend/src/pages/vote/VotingPage.tsx` | No changes required — already reads session state from sessionStorage and cookies |

### `frontend/src/api/voter.ts` additions

New types:

```typescript
export interface SessionRestoreRequest {
  session_token: string;
  general_meeting_id: string;
}

// Response shape is identical to AuthVerifyResponse — reuse existing type
```

New function:

```typescript
export function restoreSession(req: SessionRestoreRequest): Promise<AuthVerifyResponse> {
  return apiFetch<AuthVerifyResponse>("/api/auth/session", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
```

### `frontend/src/pages/vote/AuthPage.tsx` changes

**localStorage key:** `agm_session_<meetingId>` — stores the raw `session_token` string.

#### On mount (return-visit detection)

Add a `useEffect` that runs once when the component mounts (dependency: `[meetingId]`):

```
1. If no meetingId, do nothing.
2. Read localStorage key `agm_session_<meetingId>`.
3. If no token found, do nothing (show normal auth form).
4. Call restoreSession({ session_token: token, general_meeting_id: meetingId }).
5. On success (same as verifyMutation.onSuccess):
   - Write sessionStorage keys (same 5 keys as OTP verify success)
   - Navigate based on agm_status / lot state
6. On error (401 or any failure):
   - Remove the stale token from localStorage: localStorage.removeItem(`agm_session_${meetingId}`)
   - Do nothing else — the normal auth form is already rendered
```

While the restore attempt is in flight, show a loading indicator ("Resuming your session…") to prevent a flash of the auth form followed by an immediate redirect.

#### On successful OTP verify (`verifyMutation.onSuccess`)

After writing sessionStorage keys and before navigating, add:

```typescript
// Persist session token for return-visit restoration (24h or until meeting closes)
if (data.session_token) {
  localStorage.setItem(`agm_session_${meetingId}`, data.session_token);
}
```

This requires `AuthVerifyResponse` to include `session_token: string` — see the response shape change below.

#### On session expiry / meeting close

The `localStorage` entry is cleaned up in the `restoreSession` error handler. No additional cleanup is needed: the token becomes invalid server-side immediately, and the next visit triggers a 401 which removes the stale token.

### Response shape change: add `session_token` to `AuthVerifyResponse`

Both `POST /api/auth/verify` and `POST /api/auth/session` must return the session token so the frontend can store it.

**Backend `AuthVerifyResponse` schema addition:**

```python
class AuthVerifyResponse(BaseModel):
    lots: list[LotInfo]
    voter_email: str
    agm_status: str
    building_name: str
    meeting_title: str
    unvoted_visible_count: int = 0
    session_token: str  # NEW: raw token for localStorage persistence
```

**Why return the token explicitly rather than reading the cookie?** The `meeting_session` cookie is `HttpOnly`, so JavaScript cannot read it. The token must be returned in the response body for the frontend to store it in `localStorage`.

**Frontend `AuthVerifyResponse` type addition:**

```typescript
export interface AuthVerifyResponse {
  lots: LotInfo[];
  voter_email: string;
  agm_status: string;
  building_name: string;
  meeting_title: string;
  unvoted_visible_count: number;
  session_token: string;  // NEW
}
```

### sessionStorage keys (unchanged)

The existing sessionStorage keys are written by both OTP verify success and session restore success using the same logic:

| Key | Value |
|---|---|
| `meeting_lots_<meetingId>` | `JSON.stringify(pendingLotIds)` |
| `meeting_lots_info_<meetingId>` | `JSON.stringify(data.lots)` |
| `meeting_lot_info_<meetingId>` | `JSON.stringify(pendingLots)` |
| `meeting_building_name_<meetingId>` | `data.building_name` |
| `meeting_title_<meetingId>` | `data.meeting_title` |

These are `sessionStorage` (tab-scoped, cleared on tab close), while the token is `localStorage` (persistent across tab closures).

### Routing changes

None. The existing routes in `App.tsx` are unchanged. The return-visit logic lives entirely inside `AuthPage`.

---

## Key design decisions

### Why return `session_token` in the response body?

`HttpOnly` cookies are not readable by JavaScript. The token must appear in the JSON body for `localStorage` persistence. The cookie is retained as well because the voting endpoints read it on every API call — the cookie drives the actual session authentication on the backend; `localStorage` drives the return-visit UX on the frontend.

### Why localStorage rather than sessionStorage for the token?

`sessionStorage` is scoped to a single browser tab and is cleared when the tab is closed. The feature goal is to skip OTP when a voter closes the tab and returns later. `localStorage` persists until explicitly cleared or until the browser's storage is cleared, which is the correct behaviour.

### Why not extend session expiry on restore?

Extending the `expires_at` on each restore would require a DB write on every session validation call. The current design avoids that. A 24-hour window is sufficient for the AGM use case (meetings rarely run longer than a day). If session extension becomes a requirement it can be added to `create_session` / `get_session` without a schema change.

### Why 401 (not a separate status) for closed-meeting sessions?

Returning 401 on a closed-meeting token causes the frontend to fall through to the normal OTP auth flow. `POST /api/auth/verify` already returns `agm_status: "closed"` which the frontend uses to route to the confirmation screen. Reusing this path avoids a separate "closed" state machine branch in `AuthPage`.

---

## Data flow: return visit (happy path)

1. Voter opens `/vote/<meetingId>/auth` in a new tab or session.
2. `AuthPage` mounts; `useEffect` reads `localStorage.getItem("agm_session_<meetingId>")`.
3. Token found → frontend shows "Resuming your session…" and calls `POST /api/auth/session` with `{ session_token, general_meeting_id }`.
4. Backend looks up `SessionRecord` by token + meeting_id; expiry check passes; AGM status is open.
5. Backend runs lot-lookup + submission-check + unvoted_visible_count (same as verify). Returns `AuthVerifyResponse` including new `session_token` field and sets `meeting_session` cookie.
6. Frontend receives 200; writes sessionStorage keys; navigates to `/vote/<meetingId>/voting` (or confirmation if all submitted).
7. Voting page loads normally — it reads from sessionStorage and the HttpOnly cookie is set for all subsequent API calls.

## Data flow: return visit after token expiry or meeting close

1. Voter opens `/vote/<meetingId>/auth`.
2. `AuthPage` mounts; reads `localStorage` token.
3. Token found → calls `POST /api/auth/session`.
4. Backend returns 401 (expired token, or meeting is closed).
5. Frontend removes stale token from `localStorage`; stops loading indicator.
6. Normal OTP auth form renders.
7. Voter completes OTP. If meeting is closed, `agm_status: "closed"` routes to confirmation page.

---

## E2E Test Scenarios

### Happy path

**SESS-E2E-01: Return visit within session window**
- Voter authenticates via OTP → `localStorage` contains `agm_session_<meetingId>` token
- Voter closes tab, opens new tab, navigates to `/vote/<meetingId>/auth`
- OTP form is never shown; voter is taken directly to the voting page
- Session cookie is set; voter can submit ballot normally

**SESS-E2E-02: Session restore for closed-AGM voter (already submitted)**
- Voter authenticates, submits ballot, `localStorage` token written
- Admin closes meeting
- Voter returns to `/vote/<meetingId>/auth`
- `POST /api/auth/session` returns 401 → stale token removed → OTP form shown
- Voter enters OTP → `agm_status: "closed"` → navigated to confirmation page

**SESS-E2E-03: First-time visit — no token in localStorage**
- Voter navigates to `/vote/<meetingId>/auth` with no existing session
- OTP form renders immediately (no loading state shown)
- After OTP verification, `localStorage` contains the new token

### Error / edge cases

**SESS-E2E-04: Expired session token (24h passed)**
- Seed a `SessionRecord` row with `expires_at` in the past; write its token to `localStorage`
- Voter navigates to auth page
- `POST /api/auth/session` returns 401
- `localStorage` key is cleared
- OTP form renders

**SESS-E2E-05: Token for wrong AGM in localStorage**
- `localStorage` contains a token for AGM-A; voter navigates to AGM-B
- Key lookup for `agm_session_<agmB-id>` returns null → OTP form renders immediately
- Token for AGM-A is untouched in `localStorage`

**SESS-E2E-06: Meeting closed mid-session (token valid but meeting closed)**
- Voter authenticates → `localStorage` token written
- Admin closes meeting (via admin API)
- Voter opens new tab to `/vote/<meetingId>/auth`
- `POST /api/auth/session` returns 401 (meeting closed)
- `localStorage` token is cleared
- Voter sees OTP form; completes OTP → routed to confirmation page

**SESS-E2E-07: Corrupted / tampered token in localStorage**
- Manually set `localStorage["agm_session_<id>"]` to a random string
- Voter navigates to auth page
- `POST /api/auth/session` returns 401
- Token is cleared; OTP form renders

### State-based scenarios

**SESS-E2E-08: Voter submits ballot, closes tab, returns — already-submitted state preserved**
- Voter authenticates, submits ballot for all lots
- Voter closes tab
- Voter opens new tab → session restore succeeds
- `already_submitted` flags on all lots are true → routed to confirmation page (not voting page)

**SESS-E2E-09: Multi-lot voter — partial submission then return**
- Voter with 3 lots submits for 2 lots, closes tab
- Voter returns; session restore succeeds
- Navigated to voting page; 2 lots show "Already submitted", 1 lot is selectable

**SESS-E2E-10: Session restore during pending meeting status**
- `agm_status: "pending"` returned from `POST /api/auth/session`
- Voter is navigated to home page with pending message (same as OTP verify path)

---

## Vertical slice decomposition

This feature touches both backend and frontend but has a clear dependency: the frontend cannot be implemented until the new endpoint exists and `session_token` appears in `AuthVerifyResponse`. There is only one slice.

**Slice 1 (single branch):**
- Backend: new `POST /api/auth/session` endpoint + `session_token` field in `AuthVerifyResponse`
- Frontend: `localStorage` persistence + return-visit detection in `AuthPage`
- Tests: unit (backend service logic, frontend component), integration (endpoint with real DB), E2E (scenarios above)

No further decomposition is warranted.
