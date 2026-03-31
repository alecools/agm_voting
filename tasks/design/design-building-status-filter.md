# Technical Design: Building Filter and Status Filter on General Meetings List Page

**Status:** Implemented

## Overview

The Admin General Meetings list page (`GeneralMeetingListPage`) provides two filter controls — a building dropdown and a status dropdown — that narrow the displayed meetings table. Filter state is persisted in URL search parameters so that the selected filters survive page refresh and can be shared via URL. Filtering is purely client-side: the full meetings list is fetched once and filtered in the browser.

**Schema migration required: NO.**
**New backend endpoints required: NO.** The existing `listGeneralMeetings` and `listBuildings` API calls are unchanged.

---

## Component: `GeneralMeetingListPage`

**File:** `frontend/src/pages/admin/GeneralMeetingListPage.tsx`

---

## URL Search Parameters

| Param | Values | Default (absent) |
|---|---|---|
| `building` | Building UUID (`string`) | Empty string — all buildings shown |
| `status` | `"open"`, `"pending"`, `"closed"` | Empty string — all statuses shown |

Parameters are read and written via React Router's `useSearchParams`. When a filter is set to its "show all" value (empty string), the parameter is deleted from the URL rather than set to `""`.

```typescript
const [searchParams, setSearchParams] = useSearchParams();
const selectedBuildingId = searchParams.get("building") ?? "";
const selectedStatus     = searchParams.get("status")   ?? "";
```

---

## Filter Controls

### Building dropdown

- Label: "Building" (`htmlFor="building-filter"`)
- `id="building-filter"`, `className="field__select"`
- First option: `<option value="">All buildings</option>`
- Remaining options: one per building from `listBuildings` query, keyed by `b.id`, displaying `b.name`
- Controlled by `selectedBuildingId`

On change:
```typescript
function handleBuildingChange(e: React.ChangeEvent<HTMLSelectElement>) {
  const value = e.target.value;
  const next = new URLSearchParams(searchParams);
  if (value) {
    next.set("building", value);
  } else {
    next.delete("building");
  }
  setSearchParams(next);
}
```

### Status dropdown

- Label: "Status" (`htmlFor="status-filter"`)
- `id="status-filter"`, `className="field__select"`
- Options: `All statuses` (value `""`), `Open` (`"open"`), `Pending` (`"pending"`), `Closed` (`"closed"`)
- Controlled by `selectedStatus`

On change:
```typescript
function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
  const value = e.target.value;
  const next = new URLSearchParams(searchParams);
  if (value) {
    next.set("status", value);
  } else {
    next.delete("status");
  }
  setSearchParams(next);
}
```

---

## Client-Side Filtering Logic

Both filters are applied as successive `.filter()` calls on the full meetings array fetched from the API:

```typescript
const filteredMeetings = meetings
  .filter((m) => !selectedBuildingId || m.building_id === selectedBuildingId)
  .filter((m) => !selectedStatus     || m.status      === selectedStatus);
```

- An empty (falsy) filter value passes all items through (short-circuit on `!selectedBuildingId`).
- Both filters are independent and composable — selecting both a building and a status shows only meetings matching both criteria.
- The `GeneralMeetingTable` component receives `filteredMeetings` (not the raw `meetings` array).

---

## Data Queries

Two React Query queries run in parallel on mount:

| Query key | API function | Purpose |
|---|---|---|
| `["admin", "general-meetings"]` | `listGeneralMeetings()` | Full meetings list (no server-side filtering) |
| `["admin", "buildings"]` | `listBuildings()` | Populates building dropdown options |

The meetings query result defaults to `[]` while loading, so `filteredMeetings` is also `[]` until data arrives. The `GeneralMeetingTable` component handles its own loading state.

---

## Pagination Reset on Filter Change

The `BuildingTable` component (used on the Buildings list page, not the meetings list) resets to page 1 when its `buildings` prop changes length:

```typescript
useEffect(() => {
  setPage(1);
}, [buildings.length]);
```

On the General Meetings list page, `GeneralMeetingTable` receives `filteredMeetings` directly. Any change to a filter immediately produces a new filtered array, which is passed as a new prop — any pagination inside `GeneralMeetingTable` that depends on the prop array will naturally re-evaluate. The page reset trigger is the change in the `meetings` prop itself (either length or identity), so selecting a new filter resets the table to the first page.

---

## Layout

The two filter controls are rendered side by side in the card header, using inline flexbox:

```tsx
<div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
  <div style={{ maxWidth: 280 }}>   {/* Building dropdown */}  </div>
  <div style={{ maxWidth: 180 }}>   {/* Status dropdown */}    </div>
</div>
```

The "Create General Meeting" button is in the page header (`admin-page-header`), separate from the filter row.

---

## Status Values

The `status` field on `GeneralMeetingListItem` reflects the computed effective status of the meeting:

| Value | Meaning |
|---|---|
| `"open"` | Meeting is active and accepting votes |
| `"pending"` | Meeting exists but voting has not started yet |
| `"closed"` | Meeting has been closed (manually or by close date) |

These values match the `GeneralMeetingStatus` type defined in `frontend/src/types`.

---

## Files Modified

| File | Change |
|---|---|
| `frontend/src/pages/admin/GeneralMeetingListPage.tsx` | Building + status filter dropdowns; `useSearchParams`-backed filter state; client-side filtering of `filteredMeetings` |
| `frontend/src/components/admin/BuildingTable.tsx` | `useEffect` resets page to 1 when `buildings.length` changes (page reset on filter change, used on Buildings page) |
