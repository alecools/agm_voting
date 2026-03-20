# Technical Design: Delete Building

## Overview

This feature allows admins to permanently delete a building and all its associated data. Deletion is only permitted when the building is archived. The operation cascades through the entire building hierarchy via SQLAlchemy relationships and PostgreSQL `ON DELETE CASCADE` constraints.

**Schema migration required: NO** — all cascade relationships already exist on the relevant tables.

---

## Database Changes

None. The existing cascade structure handles deletion:

### Cascade tree on `Building` delete

```
Building
├── LotOwner (CASCADE)
│   ├── LotOwnerEmail (CASCADE)
│   ├── LotProxy (CASCADE)
│   ├── GeneralMeetingLotWeight (CASCADE)
│   └── BallotSubmission (CASCADE)
├── GeneralMeeting (CASCADE)
│   ├── Motion (CASCADE)
│   │   └── Vote (CASCADE)
│   ├── GeneralMeetingLotWeight (CASCADE)
│   ├── Vote (CASCADE)
│   ├── BallotSubmission (CASCADE)
│   ├── SessionRecord (CASCADE)
│   └── EmailDelivery (CASCADE)
└── SessionRecord (CASCADE)
```

Both SQLAlchemy ORM `cascade="all, delete-orphan"` relationships and PostgreSQL `ondelete="CASCADE"` FK constraints are in place. A single `await db.delete(building)` triggers the full cascade.

---

## Backend Changes

### 1. Service function: `delete_building` — `backend/app/services/admin_service.py`

```python
async def delete_building(building_id: uuid.UUID, db: AsyncSession) -> None:
    """Permanently delete an archived building and all its cascade data."""
    building = await get_building_or_404(building_id, db)
    if not building.is_archived:
        raise HTTPException(
            status_code=409,
            detail="Only archived buildings can be deleted",
        )
    await db.delete(building)
    await db.commit()
```

Logic:
1. Fetch `Building` by `building_id`. Raise 404 if not found (via `get_building_or_404`).
2. Check `building.is_archived`. If `False`, raise 409 "Only archived buildings can be deleted".
3. `await db.delete(building)` → `await db.commit()`. SQLAlchemy cascades delete to all child relationships.
4. Return `None` (caller returns 204).

### 2. Router endpoint: `DELETE /api/admin/buildings/{building_id}` — `backend/app/routers/admin.py`

```python
@router.delete("/buildings/{building_id}", status_code=204)
async def delete_building(
    building_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    await admin_service.delete_building(building_id, db)
```

**Endpoint spec:**

| Property | Value |
|---|---|
| Method | `DELETE` |
| Path | `/api/admin/buildings/{building_id}` |
| Auth | `require_admin` (applied to entire router) |
| Request body | None |
| Success response | `204 No Content` |
| 404 | Building not found |
| 409 | Building is not archived |
| 403 | Not admin |

---

## Frontend Changes

### 1. API function: `deleteBuilding` — `frontend/src/api/admin.ts`

```typescript
export async function deleteBuilding(buildingId: string): Promise<void> {
  const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
  const res = await fetch(`${BASE_URL}/api/admin/buildings/${buildingId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}
```

Note: uses raw `fetch` (not `apiFetch`) because `apiFetch` does not support `DELETE` with no body in all scenarios — consistent with `deleteGeneralMeeting`.

### 2. Delete button and flow — `frontend/src/pages/admin/BuildingDetailPage.tsx`

**Visibility rule:** The "Delete Building" button is shown only when `building?.is_archived === true`. When `is_archived` is false, the "Archive Building" button is shown instead (they are mutually exclusive):

```tsx
{!building?.is_archived && (
  <button className="btn btn--secondary" onClick={() => { void handleArchive(); }} disabled={archiving}>
    {archiving ? "Archiving…" : "Archive Building"}
  </button>
)}
{building?.is_archived && (
  <button className="btn btn--secondary" onClick={() => { void handleDelete(); }} disabled={deleting}>
    {deleting ? "Deleting…" : "Delete Building"}
  </button>
)}
```

**Confirmation dialog:** `window.confirm` is shown before calling the API:
```
Permanently delete "${building.name}"?

This action cannot be undone. All lot owners, meetings, and votes will be deleted.
```

**Loading state:** `deleting` state variable set to `true` during the request. Button label changes to "Deleting…" and the button is `disabled`.

**Post-delete navigation:** On success, invalidates the `["admin", "buildings"]` query and navigates to `/admin/buildings`.

**Error handling:** Inline error shown via `deleteError` state:
```tsx
{deleteError && (
  <p className="state-message state-message--error">{deleteError}</p>
)}
```

**State variables:**
```typescript
const [deleting, setDeleting] = useState(false);
const [deleteError, setDeleteError] = useState<string | null>(null);
```

**Handler:**
```typescript
async function handleDelete() {
  if (!buildingId) return;
  const confirmed = window.confirm(
    `Permanently delete "${building?.name ?? "this building"}"?\n\nThis action cannot be undone. All lot owners, meetings, and votes will be deleted.`
  );
  if (!confirmed) return;
  setDeleteError(null);
  setDeleting(true);
  try {
    await deleteBuilding(buildingId);
    await queryClient.invalidateQueries({ queryKey: ["admin", "buildings"] });
    navigate("/admin/buildings");
  } catch (e) {
    setDeleteError(e instanceof Error ? e.message : "Failed to delete building.");
  } finally {
    setDeleting(false);
  }
}
```

---

## Guard Rules

1. **Only archived buildings can be deleted.** The backend enforces this with a 409 check (`if not building.is_archived`). The frontend enforces this by only rendering the Delete button when `building.is_archived === true`.
2. **Cascade is total and irreversible.** Deleting a building deletes all lot owners, lot owner emails, proxy nominations, financial position snapshots, general meetings, motions, votes, ballot submissions, session records, and email delivery records that belong to it.
3. **No soft-delete.** The operation is a hard delete. There is no recovery path once confirmed.

---

## Key Design Decisions

### Archive-first requirement
A building must be archived before it can be deleted. This two-step process (archive → delete) prevents accidental deletion of active buildings. The archive step is a separate action with its own confirmation. Deletion is only surfaced after archiving, making the destructive path deliberate.

### No orphan-check before delete
The service does not check for associated meetings or lot owners before deleting. The cascade handles cleanup atomically. The confirmation dialog warns the user that all associated data will be deleted.

### Raw fetch for deleteBuilding
`deleteBuilding` in `admin.ts` uses raw `fetch` rather than `apiFetch` to match the pattern used by `deleteGeneralMeeting`. Both return `204 No Content` with no JSON body, which `apiFetch` may not handle consistently across all environments.

---

## Files Modified

| File | Change |
|---|---|
| `backend/app/services/admin_service.py` | `delete_building` service function |
| `backend/app/routers/admin.py` | `DELETE /api/admin/buildings/{building_id}` endpoint |
| `frontend/src/api/admin.ts` | `deleteBuilding` function |
| `frontend/src/pages/admin/BuildingDetailPage.tsx` | Delete button, handler, state, error display |
