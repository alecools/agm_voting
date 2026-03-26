# Design: Stable Motion Number (auto-populated from display_order)

## Summary

Two behaviour changes to motion numbering:

1. **Auto-populate on create** — when `motion_number` is omitted (`None`) from an add-motion request, the service sets `motion_number` to `str(new_display_order)` (the position being assigned). Previously it stored `None`.

2. **Stable across reorder** — `reorder_motions` only updates `display_order`; it must never touch `motion_number`. This is already the case in the implementation; a regression test is added to lock the behaviour.

## Why

Motion numbers identify motions in formal minutes. An admin who relies on the auto-assigned number "3" should not find that it silently changed to "2" after reordering. The numbers are now fixed at creation time.

## Files that need to change

### Backend

| File | Change |
|---|---|
| `backend/app/services/admin_service.py` | `add_motion_to_meeting`: when `data.motion_number is None`, set `motion_number = str(next_index)` instead of `None`. |
| `backend/tests/test_admin_api.py` | Rename `test_add_motion_without_motion_number_is_null` → `test_add_motion_without_motion_number_auto_assigns_display_order`; update assertion to expect `str(display_order)`. Update `test_add_motion_whitespace_motion_number_stored_as_null` (still None). Update `test_add_motion_duplicate_motion_number_null_allowed` (now auto-assigns distinct numbers so they won't clash). Add `test_add_motion_explicit_motion_number_overrides_auto`. Add `test_reorder_does_not_change_motion_numbers`. |

### Frontend

| File | Change |
|---|---|
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Update the motion number input placeholder to "Auto (e.g. 3)" to communicate the auto-assign behaviour. No logic change needed — the field already sends `null` when blank. |
| `frontend/tests/msw/handlers.ts` | The MSW add-motion handler already mirrors `motion_number` from the request body (returns `body?.motion_number ?? null`). Since the backend now auto-assigns when omitted, the mock should return `"3"` (the mocked display_order) when `motion_number` is not provided. |
| `frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx` | The test "submitting the form with valid data calls the API and closes the form" does not check `motion_number` in the response — no change needed. Other tests that explicitly set `motion_number` in the payload are unaffected. |

## No schema migration needed

The `motion_number` column already exists and is nullable. The change is purely in service-layer logic.

## Boundary cases

- `motion_number` omitted → auto-assign `str(display_order)`, e.g. `"0"` for first motion
- `motion_number` is empty string `""` → treat as whitespace → store as `None` (existing behaviour)
- `motion_number` is whitespace only `"   "` → store as `None` (existing behaviour)
- `motion_number` explicitly provided, e.g. `"SR-1"` → use that value (override)
- Duplicate auto-assigned number is impossible in practice because `display_order` increments monotonically per meeting; however, if an admin adds two motions very quickly it could still trigger a 409 on `uq_motions_general_meeting_motion_number` — existing 409 handling covers this
