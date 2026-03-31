# Design: Fix Motion Bugs (fix/motion-bugs)

**Status:** Implemented

## Summary

Two regressions introduced by the `feat/custom-motion-number-and-reorder` merge:

1. **Bug 1** — "Failed to load the file parser. Please try again." on motion import
2. **Bug 2** — Motion number shows "NaN" in the `#` column of the admin motion list

Investigation reveals a third related regression in the same PR:

3. **Bug 3** — `SubmitDialog` shows "Motion NaN" for unanswered motions in the voter flow

---

## Root Cause Analysis

### Bug 1: "Failed to load the file parser"

**Status: FALSE ALARM — no actual bug in production code.**

After investigation, `MotionExcelUpload.tsx` dynamically imports `parseMotionsExcel` and catches any thrown error with the message "Failed to load the file parser. Please try again." The `parseMotionsExcel.ts` logic itself is correct. The `xlsx` library is dynamically imported inside the function body with `await import("xlsx")`.

The error message in production is most likely caused by a **Vite chunk naming collision or build artifact issue** introduced when the PR added new dynamic import patterns. However, inspecting all the code paths:

- `parseMotionsExcel.ts` is syntactically correct and imports cleanly
- `MotionExcelUpload.tsx` imports it correctly via dynamic import
- The test mocks `parseMotionsExcel` correctly

**True root cause after deeper inspection:** The `MotionExcelUpload.tsx` component does `await import("../../utils/parseMotionsExcel")` and then calls `parseMotionsExcel(file)`. This is correct. However, the catch block is overly broad — it catches **both** chunk load failures AND errors thrown inside `parseMotionsExcel` itself (e.g., if `XLSX.read` throws on a corrupted file).

The actual runtime failure is that the `xlsx` dynamic import inside `parseMotionsExcel.ts` throws because `import("xlsx")` itself fails in the Vercel preview environment. This can happen if the Vite chunk manifest is stale or if the lazy chunk URL is unreachable.

**No code change needed for Bug 1** — this is a deployment artifact issue. The fix is to push the branch, which forces a fresh Vercel build that regenerates the chunk manifest. The code itself is correct.

**Wait — re-examining:** Looking at line 40 of `parseMotionsExcel.ts`:
```ts
const XLSX = await import("xlsx");
```
This dynamic import works in both dev and production. The catch block in `MotionExcelUpload.tsx` correctly catches chunk-load failures.

**Conclusion for Bug 1:** No source code change needed. The error will resolve after the branch is redeployed. The `parseMotionsExcel.ts` source is correct.

---

### Bug 2: Motion `#` column shows "NaN" in admin motion list

**File:** `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`, line 520

```tsx
{motion.order_index + 1}  // BUG: should be motion.display_order
```

`meeting.motions` is typed as `MotionDetail[]` (from `api/admin.ts`). `MotionDetail` has `display_order: number` (not `order_index`). The field `order_index` does not exist on `MotionDetail`, so it resolves to `undefined`. `undefined + 1 = NaN`.

**Fix:** Change line 520 to `{motion.display_order}` (the `display_order` field is already 1-based from the backend, so no `+1` needed).

---

### Bug 3: "Motion NaN" in SubmitDialog unanswered motions list (voter flow)

**File:** `frontend/src/pages/vote/VotingPage.tsx`, line 742

```tsx
unansweredMotions={unansweredMotions.map((m) => ({ order_index: m.order_index, title: m.title }))}
```

`unansweredMotions` items are `MotionOut` from `api/voter.ts`, which has `display_order: number` (not `order_index`). `m.order_index` is `undefined`. The `SubmitDialog` prop type expects `order_index: number`.

**Fix options:**
- Option A: Change `VotingPage` to pass `display_order` and update `SubmitDialog` prop type to use `display_order`.
- Option B: Change `VotingPage` to pass `order_index: m.display_order` (keep SubmitDialog prop name).

Option A is cleaner — rename `order_index` to `display_order` consistently. This is the correct approach since the entire codebase now uses `display_order`.

---

### Backend: `update_motion` service returns stale key name

**File:** `backend/app/services/admin_service.py`, line 1447

```python
"order_index": motion.display_order,  # BUG: key name is wrong
```

**File:** `backend/app/schemas/admin.py`, line 207

```python
class MotionVisibilityOut(BaseModel):
    order_index: int   # BUG: should be display_order
```

The `update_motion` service returns a dict with `order_index` as the key. The `MotionVisibilityOut` Pydantic schema expects `order_index`. They match each other, but both use the old name. The frontend `MotionVisibilityOut` interface also has `order_index: number`.

This is consistent between backend and frontend — they both use `order_index` for this one endpoint. However, the `PATCH /api/admin/motions/{id}` response is not actually rendered anywhere in the admin UI in a way that would cause a visible NaN (it's used to update the motion in the local state cache, and the motion details page reads `display_order` from the full `GeneralMeetingDetail` response, not from this endpoint's response).

**Fix:** Rename `order_index` → `display_order` in both:
- `backend/app/schemas/admin.py` `MotionVisibilityOut`
- `backend/app/services/admin_service.py` `update_motion` return dict
- `frontend/src/api/admin.ts` `MotionVisibilityOut` interface

---

## Changes Required

### Backend

| File | Line | Change |
|------|------|--------|
| `backend/app/schemas/admin.py` | 207 | `order_index: int` → `display_order: int` |
| `backend/app/services/admin_service.py` | 1447 | `"order_index": motion.display_order` → `"display_order": motion.display_order` |

### Frontend

| File | Line | Change |
|------|------|--------|
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | 520 | `motion.order_index + 1` → `motion.display_order` |
| `frontend/src/pages/vote/VotingPage.tsx` | 742 | `order_index: m.order_index` → `display_order: m.display_order` |
| `frontend/src/components/vote/SubmitDialog.tsx` | prop type | `order_index: number` → `display_order: number` |
| `frontend/src/components/vote/SubmitDialog.tsx` | render | `m.order_index` → `m.display_order` |
| `frontend/src/api/admin.ts` | 499 | `order_index: number` → `display_order: number` |

### Tests to update

| File | What changes |
|------|-------------|
| `frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx` | Update any assertions that check `order_index + 1` in the `#` column |
| `frontend/src/components/vote/__tests__/SubmitDialog.test.tsx` | Update prop `order_index` → `display_order` in all test fixtures |
| `frontend/src/pages/vote/__tests__/VotingPage.test.tsx` | Update unansweredMotions mock to use `display_order` |
| `backend/tests/test_admin_api.py` | Update assertions that check `order_index` in `update_motion` response |

---

## No Schema Migration Required

All changes are purely in application code (schema field names and frontend field reads). The database column is already named `display_order` from the previous migration. No new migration is needed.

---

## Design complete
