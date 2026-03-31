# Design: Sortable Columns for Buildings, Lot Owners, and Meetings Tables

**Status:** Implemented

## Overview

This feature adds sortable column headers to three admin tables:

- **Buildings table** (`BuildingsPage` / `BuildingTable`) — columns: Name, Created At
- **Lot owners table** (`BuildingDetailPage` / `LotOwnerTable`) — columns: Lot Number, Unit Entitlement, Financial Position
- **Meetings table** (`GeneralMeetingListPage` / `GeneralMeetingTable`) — columns: Title, Status, Created At

Clicking a column header cycles through: unsorted → ascending → descending → ascending (no return to unsorted after the first click, since the table always needs a deterministic order). The active sort column shows a directional indicator; other columns show a neutral indicator.

---

## Decision: Server-side vs Client-side Sorting

### Buildings and Meetings — server-side

Both tables are paginated server-side. `BuildingsPage` fetches one page from `GET /api/admin/buildings` with `limit`/`offset`. `GeneralMeetingListPage` fetches from `GET /api/admin/general-meetings` with `limit`/`offset`. Sorting in the browser would only sort the current page, not the full dataset. Therefore sort parameters must be passed to the backend alongside `limit`/`offset`.

### Lot owners — client-side

`BuildingDetailPage` calls `listLotOwners(buildingId)` which returns all lot owners for the building in one request (no pagination parameters exposed to the UI; the API default limit is 100 but the component renders all rows with in-component pagination in `LotOwnerTable`). The full dataset is already in memory, so client-side sort is correct and avoids a new backend parameter. If building sizes grow beyond 100 lots, a migration to server-side sort can be done separately.

---

## Database Changes

None. This feature requires no schema changes and no Alembic migration.

---

## Backend Changes

### `GET /api/admin/buildings`

Add two optional query parameters:

| Param | Type | Allowed values | Default |
|---|---|---|---|
| `sort_by` | `str \| None` | `"name"`, `"created_at"` | `None` (falls back to `"created_at"`) |
| `sort_dir` | `str \| None` | `"asc"`, `"desc"` | `"desc"` |

Validation: if `sort_by` is provided and is not in the allowlist `{"name", "created_at"}`, raise `HTTP 422` with detail `"Invalid sort_by value"`. If `sort_dir` is provided and not in `{"asc", "desc"}`, raise `HTTP 422` with detail `"Invalid sort_dir value"`.

**Router** (`backend/app/routers/admin.py`):

```python
@router.get("/buildings", response_model=list[BuildingOut])
async def list_buildings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    name: str | None = Query(default=None),
    is_archived: bool | None = Query(default=None),
    sort_by: str | None = Query(default=None),
    sort_dir: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[BuildingOut]:
    ...
```

**Service** (`backend/app/services/admin_service.py`):

Modify `list_buildings` signature:

```python
async def list_buildings(
    db: AsyncSession,
    limit: int = 100,
    offset: int = 0,
    name: str | None = None,
    is_archived: bool | None = None,
    sort_by: str | None = None,
    sort_dir: str | None = None,
) -> list[Building]:
```

Replace the hard-coded `.order_by(Building.created_at.desc())` with a dynamic clause:

```python
_BUILDINGS_SORT_COLUMNS = {
    "name": Building.name,
    "created_at": Building.created_at,
}
_VALID_SORT_DIRS = {"asc", "desc"}

def _buildings_order_clause(sort_by: str | None, sort_dir: str | None):
    col = _BUILDINGS_SORT_COLUMNS.get(sort_by or "created_at", Building.created_at)
    if (sort_dir or "desc") == "asc":
        return col.asc()
    return col.desc()
```

The allowlist validation (raising HTTP 422) lives in the router, not the service, following existing patterns.

### `GET /api/admin/general-meetings`

Add two optional query parameters:

| Param | Type | Allowed values | Default |
|---|---|---|---|
| `sort_by` | `str \| None` | `"title"`, `"created_at"` | `None` (falls back to `"created_at"`) |
| `sort_dir` | `str \| None` | `"asc"`, `"desc"` | `"desc"` |

`"status"` is intentionally excluded from sortable columns on the backend. The effective status is computed in Python (`get_effective_status`), not a raw DB column, so ordering by it in SQL would be meaningless. The Status column header in the UI will remain non-sortable (no click handler, no sort indicator).

Validation: same pattern as buildings — 422 for unrecognised `sort_by` or `sort_dir` values.

**Router** addition:

```python
sort_by: str | None = Query(default=None),
sort_dir: str | None = Query(default=None),
```

**Service** — modify `list_general_meetings`:

```python
_MEETINGS_SORT_COLUMNS = {
    "title": GeneralMeeting.title,
    "created_at": GeneralMeeting.created_at,
}

def _meetings_order_clause(sort_by: str | None, sort_dir: str | None):
    col = _MEETINGS_SORT_COLUMNS.get(sort_by or "created_at", GeneralMeeting.created_at)
    if (sort_dir or "desc") == "asc":
        return col.asc()
    return col.desc()
```

Replace `.order_by(GeneralMeeting.created_at.desc())` with `.order_by(_meetings_order_clause(sort_by, sort_dir))`.

### `GET /api/admin/buildings/{building_id}/lot-owners`

No changes. Client-side sort.

---

## Frontend Changes

### Shared type

Add a shared sort-state type in `frontend/src/types.ts` (or a new `frontend/src/utils/sort.ts`):

```typescript
export type SortDir = "asc" | "desc";

export interface SortState<T extends string> {
  column: T;
  dir: SortDir;
}
```

### Shared component: `SortableColumnHeader`

Create `frontend/src/components/admin/SortableColumnHeader.tsx`.

Props:

```typescript
interface SortableColumnHeaderProps {
  label: string;
  column: string;
  currentSort: { column: string; dir: SortDir } | null;
  onSort: (column: string) => void;
}
```

Renders a `<th>` with:
- `aria-sort` attribute: `"ascending"` | `"descending"` | `"none"` depending on whether this column is the active sort column and direction. Non-sortable columns (plain `<th>`) omit `aria-sort`.
- A `<button>` inside the `<th>` with the column label and a sort indicator icon.
- Sort indicators:
  - Inactive column: `⇅` (bidirectional, `color: var(--text-muted)`, `opacity: 0.5`)
  - Active ascending: `▲` (`color: var(--text-primary)`)
  - Active descending: `▼` (`color: var(--text-primary)`)
- The button uses `className="admin-table__sort-btn"` (new CSS class, see below).
- `onClick` calls `onSort(column)`.

**New CSS class** to add to `frontend/src/styles/index.css`:

```css
.admin-table__sort-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: inherit;
  font-weight: inherit;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-transform: inherit;
  letter-spacing: inherit;
  white-space: nowrap;
}
.admin-table__sort-btn:hover {
  color: var(--text-primary);
}
.admin-table__sort-btn .sort-indicator {
  font-size: 0.65rem;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0.5;
}
.admin-table__sort-btn .sort-indicator--active {
  color: var(--text-primary);
  opacity: 1;
}
```

The `<th>` itself must not have additional `cursor: pointer` styling — the button inside handles the interaction target.

### Sort state lifecycle (buildings and meetings)

Sort state is stored in URL search params, following the existing pattern for `page`, `building`, and `status` filters. This ensures the sort is preserved on page refresh and back navigation.

URL param names: `sort_by` and `sort_dir`.

Default values (omitted from URL when default): `sort_by=created_at`, `sort_dir=desc`.

When sort changes:
1. Reset `page` to 1 (delete the `page` param).
2. Set `sort_by` and `sort_dir` (omit from URL if they match defaults).
3. Use `setSearchParams(next, { replace: true })` to avoid polluting browser history.

### `BuildingsPage.tsx` changes

1. Read `sort_by` and `sort_dir` from `searchParams` (default `created_at` / `desc`).
2. Pass `sort_by` and `sort_dir` to `listBuildings(...)` call.
3. Include `sortBy` and `sortDir` in `queryKey`:
   ```typescript
   queryKey: ["admin", "buildings", "list", safePage, showArchived, sortBy, sortDir],
   ```
4. Same keys in the prefetch `queryKey`.
5. Add `handleSortChange(column: string)` handler: toggles direction if same column, defaults to `asc` for a new column.
6. Pass `sortBy`, `sortDir`, and `handleSortChange` as props to `BuildingTable`.

### `BuildingTable.tsx` changes

1. Add props `sortBy: string`, `sortDir: SortDir`, `onSort: (col: string) => void`.
2. Replace static `<th>Name</th>` and `<th>Created At</th>` with `<SortableColumnHeader>`.
3. `<th>Manager Email</th>` and `<th>Status</th>` remain plain (non-sortable).
4. Remove internal `useEffect(() => setPage(1), [buildings.length])` — page reset on sort is now handled in `BuildingsPage` via URL params. The component-internal page state remains for rendering only.

### `GeneralMeetingListPage.tsx` changes

1. Read `sort_by` and `sort_dir` from `searchParams` (default `created_at` / `desc`).
2. Pass to `listGeneralMeetings(...)`.
3. Include in `queryKey`:
   ```typescript
   queryKey: ["admin", "general-meetings", "list", safePage, selectedBuildingId, selectedStatus, sortBy, sortDir],
   ```
4. Same keys in the prefetch `queryKey`.
5. Add `handleSortChange(column: string)` handler.
6. Pass `sortBy`, `sortDir`, `onSort` as props to `GeneralMeetingTable`.

### `GeneralMeetingTable.tsx` changes

1. Add props `sortBy: string`, `sortDir: SortDir`, `onSort: (col: string) => void`.
2. Replace `<th>Title</th>` and `<th>Meeting At</th>` with `<SortableColumnHeader>` for `title` and `created_at`. Note: the visible column is "Meeting At" but the underlying sort maps to `created_at` on the backend (creation date of the meeting record). Rename the column header visually to "Created At" for clarity, since `meeting_at` is a scheduled date not directly sortable server-side without adding it to the allowlist. Alternatively, add `meeting_at` to the backend allowlist as a sortable column — see Key Design Decisions below.
3. `<th>Building</th>` and `<th>Status</th>` and `<th>Voting Closes At</th>` remain plain.
4. Remove the internal `useEffect(() => setPage(1), [meetings.length])`.

### `LotOwnerTable.tsx` changes (client-side sort)

1. Add local sort state: `const [sortState, setSortState] = useState<{ column: LotOwnerSortColumn; dir: SortDir }>({ column: "lot_number", dir: "asc" })`.
2. `LotOwnerSortColumn` is `"lot_number" | "unit_entitlement" | "financial_position"`.
3. Derive `sorted` from `lotOwners` using a `useMemo` with a stable comparator:
   - `lot_number`: string natural sort (`localeCompare` with `numeric: true`)
   - `unit_entitlement`: numeric ascending/descending
   - `financial_position`: sort order `normal` < `in_arrear` (ascending) — i.e. in-arrear lots sort last ascending, first descending
4. Replace static `<th>Lot Number</th>`, `<th>Unit Entitlement</th>`, `<th>Financial Position</th>` with `<SortableColumnHeader>`.
5. `<th>Email</th>`, `<th>Proxy</th>`, `<th>Actions</th>` remain plain.
6. The sort state is component-local (not URL params) because the lot owners table does not have a URL of its own — it is embedded in `BuildingDetailPage`.

### `frontend/src/api/admin.ts` changes

Extend `ListBuildingsParams`:

```typescript
export interface ListBuildingsParams {
  limit?: number;
  offset?: number;
  name?: string;
  is_archived?: boolean;
  sort_by?: string;
  sort_dir?: string;
}
```

Update `listBuildings` to append `sort_by` and `sort_dir` when present.

Extend `ListGeneralMeetingsParams`:

```typescript
export interface ListGeneralMeetingsParams {
  limit?: number;
  offset?: number;
  name?: string;
  building_id?: string;
  status?: string;
  sort_by?: string;
  sort_dir?: string;
}
```

Update `listGeneralMeetings` to append `sort_by` and `sort_dir` when present.

---

## ARIA Requirements

Every sortable `<th>` must have an `aria-sort` attribute:

| State | `aria-sort` value |
|---|---|
| This column is the active sort, ascending | `"ascending"` |
| This column is the active sort, descending | `"descending"` |
| Any other sortable column | `"none"` |

Non-sortable `<th>` elements must not have `aria-sort`.

The sort button inside `<th>` must have `type="button"` to prevent accidental form submission. It should not receive a separate `aria-label` — the column label text is sufficient context because `<th>` provides the heading role.

---

## Security Considerations

**Sort parameter allowlist validation on the backend** prevents column injection. If a caller passes `sort_by=password` or `sort_by='; DROP TABLE buildings; --`, the router rejects the request with HTTP 422 before the service is called. The allowlists are defined as Python sets and the comparison is exact-match (no substring or pattern matching).

The `sort_dir` parameter is similarly constrained to `{"asc", "desc"}`. SQLAlchemy's `.asc()` / `.desc()` methods are used to construct the `ORDER BY` clause rather than raw string interpolation, eliminating any SQL injection risk even if validation were bypassed.

No privilege escalation risk: the endpoints are already behind `require_admin`. Sort parameters do not affect which rows are returned, only their order.

---

## Key Design Decisions

### Why `meeting_at` is not in the initial meetings sort allowlist

`meeting_at` is a scheduled future date, and `created_at` is when the record was created. Both could be useful sort keys. However, adding `meeting_at` requires adding it to `_MEETINGS_SORT_COLUMNS` and the frontend UI. To keep scope tight, the initial implementation exposes `title` and `created_at`. `meeting_at` can be added as a follow-up. The UI column labelled "Meeting At" in `GeneralMeetingTable` maps to the `meeting_at` field for display only; it will not have a sort header in this release.

### Why status is not a sortable column for meetings

`get_effective_status` is a computed field in Python that examines `voting_closes_at` relative to `now()`. It is not a raw database column. Ordering by it in SQL would require either materialising it as a generated column (schema change) or fetching all rows and sorting in Python (defeats pagination). Both options are out of scope for this feature.

### Why lot owner sort is client-side

The lot owner list is always fetched in full (no server-side pagination in the UI). Client-side sort avoids a backend round-trip on every column click and keeps the implementation simple. The existing in-component pagination in `LotOwnerTable` still operates on the sorted slice.

### Toggling sort direction

When clicking the currently-active column: toggle `asc` → `desc` → `asc`. When clicking a different column: always default to `asc` for text columns (`name`, `title`, `lot_number`, `financial_position`) and `desc` for date columns (`created_at`). This follows common UX convention (text A-Z ascending by default; newest-first for dates).

### Sort state in URL params vs component state

Buildings and meetings: URL params. This preserves sort state across page refresh and browser back/forward, matching the existing pattern for `page`, `building`, and `status`.

Lot owners: component-local state. The lot owner table is embedded in a detail page with no dedicated sort URL, and the full dataset is in memory.

---

## Data Flow — Happy Path (Buildings, server-side)

1. Admin lands on `/admin/buildings`. No `sort_by`/`sort_dir` in URL — defaults apply (`created_at desc`).
2. `BuildingsPage` reads `sort_by = "created_at"`, `sort_dir = "desc"` from defaults.
3. React Query issues `GET /api/admin/buildings?limit=20&offset=0&sort_by=created_at&sort_dir=desc`.
4. Router validates params, calls `admin_service.list_buildings(..., sort_by="created_at", sort_dir="desc")`.
5. Service applies `.order_by(Building.created_at.desc())` and returns the first 20 records.
6. `BuildingTable` renders with `<SortableColumnHeader column="created_at">` showing `▼`.
7. Admin clicks "Name" column header.
8. `handleSortChange("name")` runs: new column → default `asc`. Calls `setSearchParams` → URL becomes `/admin/buildings?sort_by=name&sort_dir=asc` (page param removed).
9. React Query key changes → refetch: `GET /api/admin/buildings?limit=20&offset=0&sort_by=name&sort_dir=asc`.
10. Service applies `.order_by(Building.name.asc())`.
11. Table re-renders with "Name" `<th aria-sort="ascending">` showing `▲`.
12. Admin clicks "Name" again → `sort_dir` toggles to `desc` → URL: `?sort_by=name&sort_dir=desc` → refetch → `▼`.

---

## Vertical Slice Decomposition

This feature can be decomposed into three independently testable slices:

| Slice | Branch | Dependencies |
|---|---|---|
| **Slice A**: Buildings server-side sort | `feat/sortable-buildings` | None |
| **Slice B**: Meetings server-side sort | `feat/sortable-meetings` | Requires `SortableColumnHeader` from Slice A (shared component) |
| **Slice C**: Lot owners client-side sort | `feat/sortable-lot-owners` | Requires `SortableColumnHeader` from Slice A |

In practice: implement `SortableColumnHeader` and its CSS in Slice A. Slice B and Slice C can then import it. If parallel implementation is desired, the component can be stubbed in Slices B and C and replaced once Slice A merges.

Dependency graph:

```
Slice A (buildings + SortableColumnHeader)
    |
    +--- Slice B (meetings)
    |
    +--- Slice C (lot owners)
```

Slices B and C can run in parallel after Slice A merges, or all three can be combined into a single branch for simplicity.

---

## Affected Persona Journeys

This feature modifies the **Admin** journey: `login → building/meeting management → report viewing → close meeting`.

The following existing E2E specs must be updated — not just supplemented with new tests:

- `/Users/stevensun/personal/agm_survey/.worktree/feat-sortable-tables/frontend/e2e/admin/admin-buildings.spec.ts` — update the "displays building table with data" test to assert the default `Created At` column header shows the `▼` indicator; add sort interaction tests.
- `/Users/stevensun/personal/agm_survey/.worktree/feat-sortable-tables/frontend/e2e/admin/admin-general-meetings.spec.ts` — update the table header assertions; add sort interaction tests.
- `/Users/stevensun/personal/agm_survey/.worktree/feat-sortable-tables/frontend/e2e/admin/admin-lot-owners.spec.ts` — update to assert lot owner table column headers are sortable; add sort interaction tests.

---

## E2E Test Scenarios

All E2E tests seed their own data via API calls and clean up via the test data naming conventions (`E2E*` / `Test*` prefixes).

### Buildings table (server-side)

**Happy path — default sort**
- Navigate to `/admin/buildings`.
- Assert "Created At" column header has `aria-sort="descending"` and shows `▼`.
- Assert "Name" column header has `aria-sort="none"` and shows `⇅`.

**Happy path — sort by Name ascending**
- Click "Name" column header.
- Assert URL contains `sort_by=name&sort_dir=asc`.
- Assert "Name" column header has `aria-sort="ascending"` and shows `▲`.
- Assert the table rows are in alphabetical order (first row name <= second row name).

**Happy path — toggle Name to descending**
- With `sort_by=name&sort_dir=asc` active, click "Name" again.
- Assert URL contains `sort_by=name&sort_dir=desc`.
- Assert `aria-sort="descending"`, shows `▼`.
- Assert rows are in reverse alphabetical order.

**Happy path — sort by Created At ascending**
- Click "Created At" column header (from default desc state).
- Assert URL contains `sort_by=created_at&sort_dir=asc`.
- Assert rows are oldest-first.

**State — sort resets page to 1**
- Navigate to `/admin/buildings?page=2`.
- Click "Name" column header.
- Assert URL does NOT contain `page=` (page reset to 1).

**State — sort preserved on page refresh**
- Navigate to `/admin/buildings?sort_by=name&sort_dir=asc`.
- Reload the page.
- Assert "Name" column header still shows `aria-sort="ascending"`.

**Edge — invalid sort_by in URL**
- Navigate to `/admin/buildings?sort_by=INVALID`.
- Backend returns 422; frontend shows the error state message "Failed to load buildings." (the existing error path).

### Meetings table (server-side)

**Happy path — default sort**
- Navigate to `/admin/general-meetings`.
- Assert "Created At" column header has `aria-sort="descending"`.
- Assert "Title" column header has `aria-sort="none"`.
- Assert "Status" column header does NOT have `aria-sort` attribute.
- Assert "Building" column header does NOT have `aria-sort` attribute.

**Happy path — sort by Title ascending**
- Click "Title" column header.
- Assert URL contains `sort_by=title&sort_dir=asc`.
- Assert `aria-sort="ascending"` on "Title" header.
- Assert rows appear in alphabetical order by title (seed at least two meetings with known titles).

**Happy path — toggle Title to descending**
- Click "Title" again.
- Assert `aria-sort="descending"`, rows in reverse order.

**State — sort resets page to 1**
- Navigate to page 2, click "Title".
- Assert URL does not contain `page=`.

**State — sort preserved when building filter changes**
- Set `sort_by=title&sort_dir=asc`, then change the building filter dropdown.
- Assert `sort_by=title&sort_dir=asc` remains in URL (page resets, sort does not).

### Lot owners table (client-side)

**Happy path — default sort**
- Navigate to a building detail page with multiple lot owners.
- Assert "Lot Number" column header has `aria-sort="ascending"` (default).
- Assert lot numbers are displayed in ascending natural numeric order.

**Happy path — sort by Unit Entitlement ascending**
- Click "Unit Entitlement" column header.
- Assert `aria-sort="ascending"` on "Unit Entitlement" header.
- Assert rows ordered by entitlement low-to-high.

**Happy path — sort by Unit Entitlement descending**
- Click "Unit Entitlement" again.
- Assert `aria-sort="descending"`.
- Assert rows ordered high-to-low.

**Happy path — sort by Financial Position**
- Seed a building with at least one `in_arrear` and one `normal` lot.
- Click "Financial Position" ascending.
- Assert `normal` lots appear before `in_arrear` lots.
- Click again for descending.
- Assert `in_arrear` lots appear first.

**State — sort persists within session (component state)**
- Sort by Unit Entitlement.
- Open and cancel the lot owner edit form.
- Assert sort is still by Unit Entitlement (component state not reset by form open/close).

**Edge — single lot owner**
- Navigate to a building with exactly one lot owner.
- Assert all three sort column headers are visible and clickable without error.
- Clicking any sort header does not cause an error or blank table.

**Edge — no lot owners**
- Navigate to a building with no lot owners.
- Assert the empty state message is shown.
- Assert sort headers are still rendered (no crash).

---

## Schema Migration Note

**Schema migration required: No**

This feature adds query parameters to existing endpoints and introduces client-side sort logic only. No new tables, columns, or enum values are created. No Alembic migration is needed.
