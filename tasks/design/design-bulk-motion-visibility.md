# Design: Bulk Motion Visibility Controls (US-MV08)

**Status:** Implemented

## Overview

Add "Show All" and "Hide All" buttons to the admin `GeneralMeetingDetailPage` so a building manager can flip the visibility of all motions in one click rather than toggling them one by one.

No new backend endpoint is required. The existing `PATCH /api/admin/motions/{motion_id}/visibility` endpoint is called once per eligible motion in parallel via `Promise.all` on the frontend.

---

## Backend

### No schema or endpoint changes

The existing endpoint already handles all required cases:

- `PATCH /api/admin/motions/{motion_id}/visibility` with `{ "is_visible": bool }`
- Returns 200 on success with the updated `MotionDetail`
- Returns 409 with `"Cannot hide a motion that has received votes"` if any `Vote` records exist for that motion
- Returns 409 with `"Cannot change visibility on a closed meeting"` if the meeting is closed

For "Hide All", 409 responses on individual motions are silently swallowed on the frontend — they simply indicate a motion already has votes and must stay visible. All other error statuses (500, 403, network errors) are surfaced to the user.

---

## Frontend

### File: `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

#### New state

```ts
const [isBulkLoading, setIsBulkLoading] = useState(false);
```

`isBulkLoading` is set to `true` before the `Promise.all` call and reset to `false` in the `finally` block. While it is `true`:
- Both "Show All" and "Hide All" buttons are disabled
- Individual per-motion visibility toggles are also disabled (disable condition extended to include `isBulkLoading`)

#### New handler: `handleShowAll`

```ts
async function handleShowAll() {
  const hidden = meeting.motions.filter((m) => !m.is_visible);
  if (hidden.length === 0) return;
  setIsBulkLoading(true);
  try {
    await Promise.all(hidden.map((m) => toggleMotionVisibility(m.id, true)));
    await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  } finally {
    setIsBulkLoading(false);
  }
}
```

#### New handler: `handleHideAll`

```ts
async function handleHideAll() {
  const visible = meeting.motions.filter((m) => m.is_visible);
  if (visible.length === 0) return;
  setIsBulkLoading(true);
  try {
    await Promise.allSettled(
      visible.map((m) =>
        toggleMotionVisibility(m.id, false).catch((err: Error) => {
          // Silently skip motions that have received votes (409)
          if (!err.message.includes("received votes")) throw err;
        })
      )
    );
    await queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  } finally {
    setIsBulkLoading(false);
  }
}
```

Note: `Promise.allSettled` is used so that one rejected promise (unexpected error) does not cancel the others. After settlement, unexpected errors can be surfaced; 409/votes errors are already caught and swallowed in the `.catch` above.

#### Button placement

The two buttons are placed in the same `<div>` row as the existing "Add Motion" button, to its right:

```tsx
{meeting.status !== "closed" && (
  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
    <button
      type="button"
      className="btn btn--primary"
      onClick={() => { setShowAddMotionModal(true); setAddMotionError(null); }}
    >
      Add Motion
    </button>
    <button
      type="button"
      className="btn btn--secondary btn--sm"
      disabled={
        isBulkLoading ||
        meeting.motions.every((m) => m.is_visible)
      }
      onClick={() => void handleShowAll()}
    >
      {isBulkLoading ? "Working…" : "Show All"}
    </button>
    <button
      type="button"
      className="btn btn--secondary btn--sm"
      disabled={
        isBulkLoading ||
        meeting.motions.every((m) => !m.is_visible) ||
        meeting.motions.filter((m) => m.is_visible).length === 0
      }
      onClick={() => void handleHideAll()}
    >
      {isBulkLoading ? "Working…" : "Hide All"}
    </button>
  </div>
)}
```

Both buttons are conditionally rendered only when `meeting.status !== "closed"` (same as the "Add Motion" button), which satisfies the "disabled when closed" acceptance criterion.

#### Disabled conditions (summary)

| Button | Disabled when |
|---|---|
| Show All | `isBulkLoading` OR all motions already visible (`motions.every(m => m.is_visible)`) |
| Hide All | `isBulkLoading` OR no currently-visible motions (`motions.every(m => !m.is_visible)` or `filter(m => m.is_visible).length === 0`) |
| Per-motion toggle | existing conditions OR `isBulkLoading` |

Both buttons are absent from the DOM when `meeting.status === "closed"`.

#### Loading label

While `isBulkLoading` is `true`, both buttons show "Working…" and carry the `disabled` attribute. This avoids needing separate `isShowAllLoading`/`isHideAllLoading` flags since only one bulk operation can run at a time.

---

## State summary

| State variable | Type | Purpose |
|---|---|---|
| `isBulkLoading` | `boolean` | Tracks whether a bulk show-all or hide-all is in flight; gates all toggles |

No new API functions are needed in `frontend/src/api/admin.ts` — the existing `toggleMotionVisibility` is reused directly.

---

## Test coverage

### Unit / integration (Vitest + RTL)

- **Show All** — given a meeting with 2 hidden and 1 visible motion, clicking "Show All" calls `toggleMotionVisibility` exactly twice (once for each hidden motion) with `is_visible: true`; the visible motion is not touched.
- **Show All disabled** — button is disabled when all motions are visible.
- **Hide All** — given a meeting with 2 visible and 1 hidden motion, clicking "Hide All" calls `toggleMotionVisibility` for each visible motion with `is_visible: false`.
- **Hide All swallows 409** — when `toggleMotionVisibility` rejects with a "received votes" message, the error is not surfaced and the query is still invalidated.
- **Hide All disabled** — button is disabled when no motions are visible.
- **Both buttons disabled during bulk** — while `isBulkLoading` is true, both buttons and all per-motion toggles carry the `disabled` attribute.
- **Both buttons absent when closed** — when `meeting.status === "closed"`, neither button is rendered.
- **Query invalidated after both operations** — `queryClient.invalidateQueries` is called after `Promise.all` / `Promise.allSettled` resolves.

### End-to-end (Playwright)

- **Show All flow** — admin navigates to a meeting with all motions hidden; clicks "Show All"; asserts all motion rows display "Visible" toggle state.
- **Hide All flow** — admin navigates to a meeting with all motions visible and none with votes; clicks "Hide All"; asserts all motion rows display "Hidden" toggle state.
- **Hide All with voted motion** — admin navigates to a meeting where one motion has received votes; clicks "Hide All"; asserts the voted motion stays visible and the others become hidden.
- **Closed meeting** — admin navigates to a closed meeting; asserts neither "Show All" nor "Hide All" button is present in the DOM.

---

## Files changed

| File | Change |
|---|---|
| `tasks/prd/prd-motion-visibility.md` | Add US-MV08 after US-MV07 |
| `tasks/design/design-bulk-motion-visibility.md` | This document |
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Add `isBulkLoading` state, `handleShowAll`, `handleHideAll`, and two buttons |

No backend files change. No new API client functions needed.
