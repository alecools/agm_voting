# Technical Design: Code Quality Improvements (US-CQM-01, US-CQM-04, US-CQM-05)

## Overview

Three independent refactors that improve maintainability without any schema changes or public API changes.

---

## US-CQM-01: Extract Auth Lot-Lookup Helper

### Problem

`verify_auth()` and `restore_session()` in `backend/app/routers/auth.py` contain identical ~60-line blocks that:
- Query `LotOwnerEmail` for direct owners
- Query `LotProxy` for proxy lots
- Merge into `all_lot_owner_ids`
- Fetch `LotOwner` records
- Fetch visible `Motion` records
- Compute per-lot `already_submitted` and `voted_motion_ids`
- Compute `unvoted_visible_count`

Any bug fix or feature addition (e.g. adding a new field to `LotInfo`) requires duplicate changes.

### Approach

Extract a private async helper `_resolve_voter_state(db, voter_email, general_meeting_id, building_id) -> dict`.

Returns:
```python
{
    "lots": list[LotInfo],
    "visible_motions": list[Motion],
    "unvoted_visible_count": int,
}
```

Both `verify_auth` and `restore_session` call this helper. The `verify_auth` endpoint additionally checks `if not lots` and raises 401 (the session-restore path doesn't need this check since the session already proves email ownership was verified at OTP time).

### No schema or API changes

Public response shapes (`AuthVerifyResponse`) are unchanged. No migration required.

---

## US-CQM-04: Replace Raw `fetch()` with `apiFetch` in admin.ts

### Problem

Seven functions in `frontend/src/api/admin.ts` call `fetch()` directly instead of the shared `apiFetch` client:
- `importBuildings` — FormData upload
- `importLotOwners` — FormData upload
- `importProxyNominations` — FormData upload
- `importFinancialPositions` — FormData upload
- `deleteGeneralMeeting` — DELETE, 204 no-body
- `deleteBuilding` — DELETE, 204 no-body
- `deleteMotion` — DELETE, 204 no-body

This bypasses the centralised error-handling and base URL logic in `apiFetch`.

### Approach

**FormData uploads** (import functions): `apiFetch` already handles `FormData` bodies by skipping the `Content-Type` header injection (the browser sets the multipart boundary automatically). Replace with `apiFetch<T>`.

**DELETE endpoints returning 204** (delete functions): `apiFetch` always calls `response.json()`, which fails on an empty 204 body. Add a new `apiFetchVoid` export to `client.ts` that shares the same logic but skips the JSON parse step. Replace delete functions with `apiFetchVoid`.

### No schema or API changes

The request/response contracts are unchanged. MSW handlers that intercept these endpoints remain valid.

---

## US-CQM-05: Extract `formatLocalDateTime` to Shared Utility

### Problem

`formatLocalDateTime` is defined identically in two files:
- `frontend/src/pages/vote/VotingPage.tsx` (line 21)
- `frontend/src/components/vote/GeneralMeetingListItem.tsx` (line 3)

If the date format needs to change, both files must be updated.

### Approach

Create `frontend/src/utils/dateTime.ts` with:

```typescript
export function formatLocalDateTime(
  isoString: string | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!isoString) return "";
  const fmt = options ?? { dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat(undefined, fmt).format(new Date(isoString));
}
```

Key improvements over the inline versions:
- Handles `null`/`undefined` input by returning `""` (satisfies US-CQM-05 acceptance criteria)
- Accepts optional `Intl.DateTimeFormatOptions` for flexibility
- Single source of truth

Both `VotingPage.tsx` and `GeneralMeetingListItem.tsx` import from `../../utils/dateTime` and remove their local definitions.

### No schema or API changes

Pure frontend utility extraction. No backend or public API changes.

---

## Testing Strategy

### Backend (US-CQM-01)
- All existing `verify_auth` and `restore_session` tests in `test_phase2_api.py` continue to pass — the refactor is purely internal.
- Add a unit test for `_resolve_voter_state` directly to verify the helper returns the expected shape.

### Frontend (US-CQM-04)
- Existing component tests for `BuildingCSVUpload`, `LotOwnerCSVUpload`, `FinancialPositionUpload`, `ProxyNominationsUpload`, and `MotionManagementTable` (which calls `deleteMotion`) use MSW and remain valid — the mock handlers intercept at the network level regardless of whether `apiFetch` or raw `fetch` is used.
- Add a unit test for `apiFetchVoid` in `client.ts` covering: success (204), and error (non-2xx).

### Frontend (US-CQM-05)
- Create `frontend/src/utils/__tests__/dateTime.test.ts` covering: valid UTC ISO string, `null` input, `undefined` input, custom format options.
- Existing `GeneralMeetingListItem` tests continue to pass (no change to rendering logic).
- Existing `VotingPage` tests continue to pass (no change to rendering logic).

---

## Dependency Graph

All three stories are independent of each other and of any other in-flight work. They can be merged in any order.

```
US-CQM-01  ──┐
US-CQM-04  ──┤──► single branch feat-code-quality
US-CQM-05  ──┘
```
