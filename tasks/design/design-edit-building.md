# Technical Design: Edit Building

## Overview

This feature allows admins to update a building's `name` and/or `manager_email` via a modal dialog. The edit is a partial update: only fields that differ from the current values are sent in the request. Both fields are optional in the request body, allowing the admin to update one or both.

**Schema migration required: NO** — `name` and `manager_email` already exist on the `buildings` table.

---

## Database Changes

None. The `buildings` table already has:

| Column | Type | Constraints |
|---|---|---|
| `name` | `String` | `NOT NULL`, `UNIQUE` |
| `manager_email` | `String` | `NOT NULL` |

---

## Backend Changes

### 1. Schema: `BuildingUpdate` — `backend/app/schemas/admin.py`

```python
class BuildingUpdate(BaseModel):
    name: str | None = None
    manager_email: str | None = None

    @field_validator("name")
    @classmethod
    def name_non_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("name must not be empty")
        return v

    @field_validator("manager_email")
    @classmethod
    def email_non_empty(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("manager_email must not be empty")
        return v
```

Both fields are optional (`None` = not provided, no update). A blank string (whitespace only) is rejected with 422.

### 2. Service function: `update_building` — `backend/app/services/admin_service.py`

```python
async def update_building(
    building_id: uuid.UUID,
    data: BuildingUpdate,
    db: AsyncSession,
) -> Building:
    """Update name and/or manager_email on an existing building."""
    building = await get_building_or_404(building_id, db)
    if data.name is not None:
        building.name = data.name
    if data.manager_email is not None:
        building.manager_email = data.manager_email
    await db.commit()
    await db.refresh(building)
    return building
```

Logic:
1. Fetch `Building` by `building_id`. Raise 404 if not found.
2. Apply partial update: only set `name` and/or `manager_email` if not `None` in `data`.
3. Commit and refresh.
4. Return the updated `Building` ORM object (caller serialises with `BuildingOut.model_validate`).

### 3. Router endpoint: `PATCH /api/admin/buildings/{building_id}` — `backend/app/routers/admin.py`

```python
@router.patch("/buildings/{building_id}", response_model=BuildingOut)
async def update_building(
    building_id: uuid.UUID,
    data: BuildingUpdate,
    db: AsyncSession = Depends(get_db),
) -> BuildingOut:
    building = await admin_service.update_building(building_id, data, db)
    return BuildingOut.model_validate(building)
```

**Endpoint spec:**

| Property | Value |
|---|---|
| Method | `PATCH` |
| Path | `/api/admin/buildings/{building_id}` |
| Auth | `require_admin` (applied to entire router) |
| Request body | `BuildingUpdate` JSON |
| Success response | `200 OK` with `BuildingOut` |
| 404 | Building not found |
| 422 | Blank `name` or `manager_email` string |
| 403 | Not admin |

**Response shape (`BuildingOut`):**

```json
{
  "id": "uuid",
  "name": "string",
  "manager_email": "string",
  "is_archived": false,
  "created_at": "ISO 8601 datetime"
}
```

**Note on name uniqueness:** The `buildings.name` column has a `UNIQUE` constraint. If the admin updates `name` to a value already used by another building, the DB will raise an `IntegrityError`. This propagates as an unhandled 500 from the current implementation. The service does not pre-check for uniqueness.

---

## Frontend Changes

### 1. API function: `updateBuilding` — `frontend/src/api/admin.ts`

```typescript
export interface BuildingUpdateRequest {
  name?: string;
  manager_email?: string;
}

export async function updateBuilding(
  buildingId: string,
  data: BuildingUpdateRequest
): Promise<Building> {
  return apiFetch<Building>(`/api/admin/buildings/${buildingId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}
```

Only changed fields are included in the request body (the caller constructs the partial payload before calling).

### 2. `BuildingEditModal` — `frontend/src/pages/admin/BuildingDetailPage.tsx`

An inline modal component `BuildingEditModal` is defined in the same file as `BuildingDetailPage`.

**Props:**
```typescript
interface BuildingEditModalProps {
  building: Building;
  onSuccess: () => void;
  onCancel: () => void;
}
```

**Fields:**
- **Name** (`<input type="text">`, `required`) — pre-filled with `building.name`
- **Manager Email** (`<input type="email">`, `required`) — pre-filled with `building.manager_email`

**Validation (client-side):** Before calling the API, the handler checks whether any field has changed. If neither field differs from the current values, it sets a local error "No changes detected" and does not call the API.

**Partial payload construction:** Only fields that have changed are sent:
```typescript
const payload: { name?: string; manager_email?: string } = {};
if (name !== building.name) payload.name = name;
if (managerEmail !== building.manager_email) payload.manager_email = managerEmail;
```

**Loading state:** `saving` state variable. Save button shows "Saving…" and is `disabled` while the request is in flight. Cancel button is also `disabled` during save.

**Error handling:** An inline error is shown above the button row when the API call fails:
```tsx
{error && <p style={{ color: "red", marginBottom: 12 }}>{error}</p>}
```

**On success:** Calls `onSuccess()`. The parent invalidates `["admin", "buildings"]` and closes the modal by setting `showEditModal = false`.

**Modal overlay:** Renders as a full-viewport fixed overlay (`position: fixed; inset: 0; background: rgba(0,0,0,0.4)`) with a centered white card. `role="dialog"`, `aria-modal="true"`, `aria-label="Edit Building"`.

**Buttons:**
- **Save Changes** (`type="submit"`, `className="btn btn--primary"`, disabled while saving)
- **Cancel** (`type="button"`, `className="btn btn--ghost"`, disabled while saving)

### 3. Trigger in `BuildingDetailPage`

The modal is triggered by an "Edit Building" button in the page header action bar. The button is always visible when `building` data is loaded (regardless of archive status):

```tsx
{building && (
  <button className="btn btn--secondary" onClick={() => setShowEditModal(true)}>
    Edit Building
  </button>
)}
```

**State:**
```typescript
const [showEditModal, setShowEditModal] = useState(false);
```

**Success handler:**
```typescript
function handleEditBuildingSuccess() {
  void queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
  setShowEditModal(false);
}
```

**Rendering:**
```tsx
{showEditModal && building && (
  <BuildingEditModal
    building={building}
    onSuccess={handleEditBuildingSuccess}
    onCancel={() => setShowEditModal(false)}
  />
)}
```

---

## Key Design Decisions

### Partial update semantics
`BuildingUpdate` uses `None` as the sentinel for "not provided". The service only writes to the DB the fields present in the request body (non-None). This allows the admin to update just `name` without touching `manager_email` and vice versa.

### Client-side no-change guard
The modal performs a client-side check and shows "No changes detected" if neither field differs from the current value. This avoids a no-op API call and gives immediate feedback.

### Edit is available regardless of archive status
Archived buildings can still have their `name` and `manager_email` updated. This allows correcting data entry errors even after archiving.

### No re-auth or ownership transfer
Updating `manager_email` does not trigger any re-authentication or permission changes. It is a data field only (used for display and email delivery, not for admin access control).

---

## Files Modified

| File | Change |
|---|---|
| `backend/app/schemas/admin.py` | `BuildingUpdate` schema |
| `backend/app/services/admin_service.py` | `update_building` service function |
| `backend/app/routers/admin.py` | `PATCH /api/admin/buildings/{building_id}` endpoint |
| `frontend/src/api/admin.ts` | `BuildingUpdateRequest` interface, `updateBuilding` function |
| `frontend/src/pages/admin/BuildingDetailPage.tsx` | `BuildingEditModal` component, `showEditModal` state, trigger button, success handler |
