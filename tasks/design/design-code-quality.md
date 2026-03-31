# Technical Design: Code Quality Improvements (US-CQM-01, US-CQM-04, US-CQM-05)

**Status:** Implemented

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

**Schema migration required: no**

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

Note: `MotionExcelUpload.tsx` was listed in an earlier audit but does not contain a raw `fetch()` call and required no change.

This bypasses the centralised error-handling and base URL logic in `apiFetch`.

### Approach

**FormData uploads** (import functions): `apiFetch` already handles `FormData` bodies by skipping the `Content-Type` header injection (the browser sets the multipart boundary automatically). Replace with `apiFetch<T>`.

**DELETE endpoints returning 204** (delete functions): `apiFetch` always calls `response.json()`, which fails on an empty 204 body. Add a new `apiFetchVoid` export to `client.ts` that shares the same logic but skips the JSON parse step. Replace delete functions with `apiFetchVoid`.

### No schema or API changes

The request/response contracts are unchanged. MSW handlers that intercept these endpoints remain valid.

**Schema migration required: no**

---

## US-CQM-05: Extract `formatLocalDateTime` to Shared Utility

### Problem

`formatLocalDateTime` (or equivalent `new Date(...).toLocaleString()` calls) is duplicated across six files:
- `frontend/src/pages/vote/VotingPage.tsx` — inline function definition
- `frontend/src/components/vote/GeneralMeetingListItem.tsx` — inline function definition
- `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` — `new Date(...).toLocaleString()`
- `frontend/src/components/admin/GeneralMeetingTable.tsx` — `new Date(...).toLocaleString()`
- `frontend/src/pages/GeneralMeetingSummaryPage.tsx` — `new Date(...).toLocaleString()`
- `frontend/src/components/admin/BuildingTable.tsx` — `new Date(...).toLocaleString()`

Note: `ConfirmationPage.tsx` and `AGMReportView.tsx` do not perform date formatting and required no change.

If the date format needs to change, all six files would otherwise need updating.

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

All six files now import `formatLocalDateTime` from their respective relative path to `utils/dateTime` and remove the local inline definitions.

### No schema or API changes

Pure frontend utility extraction. No backend or public API changes.

**Schema migration required: no**

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

## E2E Test Scenarios

These stories are pure internal refactors — no user-visible behaviour changes in any flow. No new E2E scenarios are required and no existing E2E specs need updating. The voter auth journey, voting flow, and admin report flow all continue to work identically from a browser perspective.

Existing E2E specs that exercise the affected code paths (voter auth, vote submission, admin meeting detail) remain valid as regression coverage for this refactor.

---

## Dependency Graph

All three stories are independent of each other and of any other in-flight work. They can be merged in any order.

```
US-CQM-01  ──┐
US-CQM-04  ──┤──► single branch feat-code-quality
US-CQM-05  ──┘
```
