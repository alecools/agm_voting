# Design: E2E Helper Pagination — Name Filter for Admin List Endpoints

## Overview

The `fix/security-reliability` branch capped `GET /api/admin/buildings` and `GET /api/admin/general-meetings` at `limit=100` by default (max 1000). The E2E global setup and helper functions work around this by passing `?limit=1000`, but this is fragile: once the shared preview DB accumulates more than 1000 test entities the workaround breaks silently.

The correct fix is to add a `?name=` query parameter to both list endpoints so callers can fetch a single item by name rather than scanning the entire list. The E2E helpers are then updated to query by name, eliminating all `?limit=1000` workarounds.

No frontend UI is changed. No new DB tables or columns are needed. This is a pure backend query + E2E helper change.

Schema migration required: **no**.

---

## Database Changes

None. The filter is applied at the query layer against existing `Building.name` and `GeneralMeeting.title` columns, both of which are `VARCHAR NOT NULL` with no new indexes required. (For typical AGM dataset sizes a sequential scan is fast enough; adding an index is a future optimisation if query plans become a concern.)

---

## Backend Changes

### 1. `GET /api/admin/buildings`

**Current signature (router):**
```python
async def list_buildings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> list[BuildingOut]:
```

**New signature (router):**
```python
async def list_buildings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    name: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[BuildingOut]:
```

The router passes `name` down to the service:
```python
buildings = await admin_service.list_buildings(db, limit=limit, offset=offset, name=name)
```

**Service — `list_buildings` (current):**
```python
async def list_buildings(db: AsyncSession, limit: int = 100, offset: int = 0) -> list[Building]:
    result = await db.execute(
        select(Building).order_by(Building.created_at).offset(offset).limit(limit)
    )
    return list(result.scalars().all())
```

**Service — `list_buildings` (new):**
```python
async def list_buildings(
    db: AsyncSession,
    limit: int = 100,
    offset: int = 0,
    name: str | None = None,
) -> list[Building]:
    q = select(Building).order_by(Building.created_at)
    if name is not None:
        q = q.where(func.lower(Building.name).contains(name.lower()))
    result = await db.execute(q.offset(offset).limit(limit))
    return list(result.scalars().all())
```

The filter uses SQLAlchemy's `ColumnElement.contains()` which translates to `LIKE '%<value>%'` (case-insensitive via `func.lower`). An exact-name search from a helper passes the full name, so it will always match exactly one record when the name is unique (as enforced by business logic).

**Request/response shape — unchanged.** The only change is the optional `name` query parameter. Response items are still `BuildingOut` objects.

---

### 2. `GET /api/admin/general-meetings`

**Current signature (router):**
```python
async def list_general_meetings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> list[GeneralMeetingListItem]:
```

**New signature (router):**
```python
async def list_general_meetings(
    limit: int = Query(default=100, le=1000),
    offset: int = Query(default=0, ge=0),
    name: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[GeneralMeetingListItem]:
```

The router passes `name` down to the service:
```python
items = await admin_service.list_general_meetings(db, limit=limit, offset=offset, name=name)
```

**Service — `list_general_meetings` (current):**
```python
async def list_general_meetings(db: AsyncSession, limit: int = 100, offset: int = 0) -> list[dict]:
    result = await db.execute(
        select(GeneralMeeting, Building.name.label("building_name"))
        .join(Building, GeneralMeeting.building_id == Building.id)
        .order_by(GeneralMeeting.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    ...
```

**Service — `list_general_meetings` (new):**
```python
async def list_general_meetings(
    db: AsyncSession,
    limit: int = 100,
    offset: int = 0,
    name: str | None = None,
) -> list[dict]:
    q = (
        select(GeneralMeeting, Building.name.label("building_name"))
        .join(Building, GeneralMeeting.building_id == Building.id)
        .order_by(GeneralMeeting.created_at.desc())
    )
    if name is not None:
        q = q.where(func.lower(GeneralMeeting.title).contains(name.lower()))
    result = await db.execute(q.offset(offset).limit(limit))
    ...
```

`func` is already imported in `admin_service.py` (`from sqlalchemy import delete, func, select`), so no new imports are needed.

**Request/response shape — unchanged.**

---

## Frontend Changes

No production frontend pages or components change. Only the E2E test helpers in `frontend/e2e/` are updated.

### Files affected

| File | Change |
|---|---|
| `frontend/e2e/workflows/helpers.ts` | `seedBuilding`, `createOpenMeeting`, `createPendingMeeting` — replace `?limit=1000` scan with `?name=<encoded>` query |
| `frontend/e2e/global-setup.ts` | Replace `?limit=1000` calls with name-filtered queries |

### Helper pseudocode — before/after

#### `seedBuilding` (helpers.ts)

Before:
```typescript
const buildingsRes = await api.get("/api/admin/buildings?limit=1000");
const buildings = await buildingsRes.json();
let building = buildings.find((b) => b.name === name);
if (!building) { /* POST */ }
```

After:
```typescript
const buildingsRes = await api.get(
  `/api/admin/buildings?name=${encodeURIComponent(name)}`
);
const buildings = await buildingsRes.json();
// name is exact — at most one result
let building = buildings.find((b) => b.name === name) ?? null;
if (!building) { /* POST */ }
```

The `find` guard after the filtered GET remains as a safety net: it handles the substring-match edge case where two buildings share a common name prefix. Because E2E building names are unique branch-scoped strings (e.g. `E2E Test Building-e2e-helper-pagination`) this will never match more than one record in practice.

#### `createOpenMeeting` / `createPendingMeeting` (helpers.ts)

Before:
```typescript
const agmsRes = await api.get("/api/admin/general-meetings?limit=1000");
const agms = await agmsRes.json();
const openAgms = agms.filter(
  (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
);
```

After:
```typescript
// Fetch only meetings whose title matches — narrows the result set to at most
// the handful of meetings created by this helper for this title.
const agmsRes = await api.get(
  `/api/admin/general-meetings?name=${encodeURIComponent(title)}`
);
const agms = await agmsRes.json();
const openAgms = agms.filter(
  (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
);
// remainder of function is unchanged
```

Note: `createOpenMeeting` and `createPendingMeeting` always close existing open/pending meetings for the building _then_ create a fresh one — they do not reuse an existing meeting. The name filter simply avoids a full-table scan while still finding the right meetings to close.

#### `global-setup.ts`

Before (two separate `?limit=1000` calls):
```typescript
// Task A
const buildingsRes = await retryGet("/api/admin/buildings?limit=1000");
...
// Task A — AGMs
const agmsRes = await retryGet("/api/admin/general-meetings?limit=1000");
...
// Task B — AGMs
const allAgmsRes = await retryGet("/api/admin/general-meetings?limit=1000");
```

After:
```typescript
// Task A — building lookup
const buildingsRes = await retryGet(
  `/api/admin/buildings?name=${encodeURIComponent(E2E_BUILDING_NAME)}`
);
...
// Task A — AGM lookup (close any open E2E AGMs for this building)
const agmsRes = await retryGet(
  `/api/admin/general-meetings?name=${encodeURIComponent(E2E_AGM_TITLE)}`
);
...
// Task B — building lookup
const adminBuildingRes = await retryGet(
  `/api/admin/buildings?name=${encodeURIComponent(E2E_ADMIN_BUILDING_NAME)}`
);
...
// Task B — AGM lookup
const allAgmsRes = await retryGet(
  `/api/admin/general-meetings?name=${encodeURIComponent(`E2E Admin Test AGM-${RUN_SUFFIX}`)}`
);
```

The `buildings` array variable is currently fetched once and shared between Task A and Task B. After the change each task fetches only its own building by name, so the shared prefetch is removed and both tasks become independent.

---

## Key Design Decisions

### Substring match vs exact match

A substring (`LIKE '%value%'`) match is chosen over exact match so the parameter is useful beyond E2E helpers — an admin could filter by a partial building name in future UI work without needing a separate `search` parameter. For the E2E use case, passing the full exact name means the substring match is effectively exact.

### `func.lower(...).contains(name.lower())` vs `ilike`

Both produce equivalent SQL on PostgreSQL. `func.lower(...).contains(value.lower())` is used because it mirrors the pattern already used in `import_buildings_from_csv` for case-insensitive building name lookups, keeping the service layer consistent.

### No new index

Building and meeting lists are small (tens to low hundreds of rows in production). A sequential scan is negligible. An index on `lower(name)` can be added if profiling shows it is needed.

### No UI exposure

The `?name=` parameter is intentionally not wired into any admin frontend page in this change. Adding it to the UI is a separate feature if ever needed.

---

## Data Flow (happy path — seedBuilding helper)

1. E2E helper calls `GET /api/admin/buildings?name=E2E+Test+Building-my-branch`.
2. FastAPI router receives `name="E2E Test Building-my-branch"`, passes it to `admin_service.list_buildings`.
3. Service builds `SELECT ... WHERE lower(name) LIKE '%e2e test building-my-branch%' ORDER BY created_at LIMIT 100`.
4. PostgreSQL returns 0 or 1 rows.
5. Router serialises the result as `list[BuildingOut]` and returns 200.
6. Helper checks `buildings.find((b) => b.name === name)`.
   - If found: uses the existing building ID.
   - If not found: POSTs to create, uses the new ID.

---

## Affected Persona Journeys

This change touches the setup infrastructure used by all E2E journeys:

- Voter journey (auth → lot selection → voting → confirmation)
- Proxy voter journey
- In-arrear lot journey
- Admin journey (login → building/meeting management → report viewing → close meeting)

None of the journey flows themselves change. The existing E2E specs for each journey must be verified to still pass after the helper changes — no new journey scenarios are added by this feature, but the existing E2E spec for each affected journey must be re-run and confirmed green (not just new scenarios added alongside).

---

## E2E Test Scenarios

These scenarios cover the new `?name=` filter behaviour. They are in addition to (not replacing) the existing per-journey E2E specs.

### Backend unit/integration tests (pytest)

**`GET /api/admin/buildings?name=`**

| Scenario | Input | Expected |
|---|---|---|
| Happy path — exact name match | `?name=Sandridge+Bay+Towers` | Returns only buildings whose name contains that string |
| Happy path — partial/substring match | `?name=sand` (case-insensitive) | Returns all buildings whose name contains "sand" |
| No match | `?name=does-not-exist-xyz` | Returns `[]` |
| name param absent | _(no name param)_ | Returns up to `limit` buildings (existing behaviour unchanged) |
| Empty string | `?name=` | Treated as no filter (returns all) — or returns all since `''` matches everything via `LIKE '%%'`; document which is chosen |
| Combined with limit/offset | `?name=test&limit=2&offset=0` | Returns at most 2 matching buildings |
| Case insensitivity | `?name=SANDRIDGE` | Matches buildings named "Sandridge Bay Towers" |

**`GET /api/admin/general-meetings?name=`**

Same matrix as buildings, applied to `GeneralMeeting.title`.

### E2E helper integration (Playwright)

| Scenario | Expected behaviour |
|---|---|
| `seedBuilding` called with a name that does not exist in DB | Issues `GET ?name=<name>`, gets `[]`, then POSTs to create; returns new ID |
| `seedBuilding` called with a name that already exists | Issues `GET ?name=<name>`, finds 1 result, returns existing ID without POST |
| `createOpenMeeting` on a building with no existing open meetings | Issues `GET ?name=<title>`, gets `[]`, skips close loop, creates meeting |
| `createOpenMeeting` on a building with an existing open meeting of the same title | Issues `GET ?name=<title>`, finds 1 open meeting, closes it, then creates fresh |
| `createPendingMeeting` — same two scenarios as above | Same pattern |
| `global-setup` runs against shared preview DB with 200+ buildings | Completes without error; no `?limit=1000` call is made |

### Regression scenarios (verify existing behaviour is preserved)

| Scenario | Expected behaviour |
|---|---|
| `GET /api/admin/buildings` with no params | Returns 100 buildings (default limit), behaviour identical to before |
| `GET /api/admin/buildings?limit=50&offset=0` | Returns up to 50 buildings, no filter applied |
| `GET /api/admin/general-meetings` with no params | Returns 100 meetings sorted by `created_at DESC` |

---

## Vertical Slice Decomposition

This feature has two independently testable slices:

| Slice | Scope | Testable independently? |
|---|---|---|
| **Slice 1 — Backend filter** | Add `name` param to router + service for buildings and meetings | Yes — pytest integration tests against the local test DB |
| **Slice 2 — E2E helper update** | Update `helpers.ts` and `global-setup.ts` to use `?name=` | Depends on Slice 1 being deployed; blocked until backend is live |
| **Slice 3 — Single-resource building endpoint** | `GET /api/admin/buildings/{building_id}` — new route, service call, frontend API function, and `BuildingDetailPage` switch from list-then-filter to direct fetch | Yes — pytest integration tests (happy path + 404) and Vitest unit tests for `BuildingDetailPage` are independent of Slices 1 and 2 |

Slice 2 cannot be merged before Slice 1 because the filter endpoint must exist for the helpers to call. Slice 3 is independent of both and can be developed and merged in any order. Both slices can be developed in parallel on separate branches but Slice 2 must be merged after Slice 1.

---

## Final Implementation Notes

The following changes were required during implementation and were shipped alongside the planned `?name=` filter work. They are documented here so the design doc reflects the actual state of the codebase.

---

### Addition 1: `GET /api/admin/buildings/{building_id}` — single-resource endpoint

**What was added:**

A new route was added to `backend/app/routers/admin.py`:

```
GET /api/admin/buildings/{building_id}
```

Returns a single `BuildingOut` when the building exists, or 404 when it does not.

**Rationale:**

`BuildingDetailPage.tsx` was previously fetching `GET /api/admin/buildings?limit=1000` and filtering the result client-side by ID. Once the list endpoint's default limit was capped at 100 (the `fix/security-reliability` change), this client-side filter silently stopped working for buildings that appeared beyond position 100 in the list. Passing `?limit=1000` was the original workaround, but that workaround was itself being removed by this feature. The correct fix was a dedicated single-resource endpoint so the page never needs to scan the list at all.

**Files changed:**

| File | Change |
|---|---|
| `backend/app/routers/admin.py` | New `get_building(building_id)` route handler |
| `backend/tests/test_admin_api.py` | `TestGetBuilding` class — happy-path and 404 integration tests |
| `frontend/src/api/admin.ts` | New `getBuilding(buildingId)` function |
| `frontend/src/pages/admin/BuildingDetailPage.tsx` | Switched from list fetch + client-side filter to `getBuilding(buildingId)` |
| `frontend/src/pages/admin/__tests__/BuildingDetailPage.test.tsx` | 10 unit tests updated to mock `GET /api/admin/buildings/:buildingId` |
| `frontend/tests/msw/handlers.ts` | MSW handler added for the single-resource endpoint |

---

### Addition 2: `building_id` filter on `GET /api/admin/general-meetings`

**What was added:**

A `building_id: uuid.UUID | None` query parameter was added to `GET /api/admin/general-meetings`. When provided, results are filtered to only meetings belonging to that building.

**Rationale:**

The E2E helpers `createOpenMeeting` and `createPendingMeeting` must close ALL open/pending meetings for a building before creating a fresh one — this prevents test interference from meetings left open by prior runs. The `?name=` filter added in the main feature was insufficient for this cleanup step: a building may have lingering open meetings from previous test runs that were created with a different title. Filtering by `?name=<current title>` would miss those meetings, leaving stale open meetings in the DB and causing later tests to fail due to a "building already has an open meeting" constraint.

The `?building_id=` filter solves this by fetching ALL meetings for the building regardless of title. The cleanup loop then closes every open/pending meeting it finds, not just those matching the current title.

**E2E helper cleanup — final query used:**

```typescript
// createOpenMeeting / createPendingMeeting — cleanup step
const agmsRes = await api.get(
  `/api/admin/general-meetings?building_id=${buildingId}&limit=100`
);
```

This replaces the earlier approach of `?name=${encodeURIComponent(title)}` described in the "Frontend Changes" section above. The `?name=` filter is still used in `seedBuilding` and in `global-setup.ts` where a title-scoped lookup is correct; it is only the cleanup step inside `createOpenMeeting`/`createPendingMeeting` that requires the building-scoped query.

**Files changed:**

| File | Change |
|---|---|
| `backend/app/routers/admin.py` | `building_id` optional param added to `list_general_meetings` |
| `backend/app/services/admin_service.py` | `building_id` filter clause added to `list_general_meetings` query |
| `backend/tests/test_admin_api.py` | 4 integration tests for `building_id` filter on the meetings endpoint |
| `frontend/e2e/workflows/helpers.ts` | `createOpenMeeting` and `createPendingMeeting` cleanup step uses `?building_id=${buildingId}&limit=100` |
