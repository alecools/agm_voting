# Technical Design: Add Motions After Meeting Creation

**Status:** Implemented

## Overview

This feature adds a backend endpoint and a frontend inline form so admins can add new motions to an existing General Meeting while it is `pending` or `open`. Adding to a `closed` meeting is blocked with 409.

In addition, admins can edit and delete individual motions, but only when the motion is hidden (`is_visible = false`) and the meeting is not `closed`. This prevents any modification of live or finalised vote data.

**PRD:** `tasks/prd/prd-add-motions-post-create.md` (US-AM01 through US-AM05)

**Schema migration needed: NO** — all required columns already exist on the `motions` table.

---

## Database Changes

None. The `motions` table already has:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK, auto-generated |
| `general_meeting_id` | UUID FK | References `general_meetings.id`, CASCADE DELETE |
| `title` | String | NOT NULL |
| `description` | Text | nullable |
| `order_index` | Integer | NOT NULL; unique per meeting via `uq_motions_general_meeting_order` |
| `motion_type` | Enum(MotionType) | `general` or `special`; default `general` |
| `is_visible` | Boolean | NOT NULL; DB default `true`; service must explicitly set `false` |

The unique constraint `uq_motions_general_meeting_order` on `(general_meeting_id, order_index)` already exists and is safe as long as the service always uses `MAX(order_index) + 1`.

---

## Backend Changes

### 1. New schema: `MotionAddRequest` in `backend/app/schemas/admin.py`

Add a new Pydantic model for the request body. The existing `MotionCreate` schema requires `order_index` to be supplied by the caller — the new schema omits it because `order_index` is auto-assigned:

```python
class MotionAddRequest(BaseModel):
    title: str
    description: str | None = None
    motion_type: MotionType = MotionType.general

    @field_validator("title")
    @classmethod
    def title_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("title must not be empty")
        return v
```

The existing `MotionOut` schema is the response type for the add endpoint and requires no changes:

```python
class MotionOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    order_index: int
    motion_type: MotionType
    is_visible: bool = True
    model_config = {"from_attributes": True}
```

### 2. New schema: `MotionUpdateRequest` in `backend/app/schemas/admin.py`

Add a new Pydantic model for the PATCH request body. All three fields are optional; a model validator enforces that at least one is provided:

```python
class MotionUpdateRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    motion_type: MotionType | None = None

    @model_validator(mode="after")
    def at_least_one_field(self) -> "MotionUpdateRequest":
        if all(v is None for v in [self.title, self.description, self.motion_type]):
            raise ValueError("At least one field must be provided")
        return self
```

The update endpoint returns `MotionVisibilityOut` (already defined in `admin.py` from the motion-visibility feature — id, title, description, order_index, motion_type, is_visible). If `MotionVisibilityOut` does not yet exist, define it:

```python
class MotionVisibilityOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str | None
    order_index: int
    motion_type: MotionType
    is_visible: bool
    model_config = {"from_attributes": True}
```

### 3. New service function: `add_motion_to_meeting` in `backend/app/services/admin_service.py`

Location: in the `# General Meetings` section, alongside `create_general_meeting`, `close_general_meeting`, etc.

```python
async def add_motion_to_meeting(
    general_meeting_id: uuid.UUID,
    data: MotionAddRequest,
    db: AsyncSession,
) -> dict:
```

Logic:

1. Load the `GeneralMeeting` by `general_meeting_id`. If not found, raise `HTTPException(404, "General Meeting not found")`.
2. Check `get_effective_status(meeting)`. If `closed`, raise `HTTPException(409, "Cannot add a motion to a closed meeting")`.
3. Query `SELECT MAX(order_index) FROM motions WHERE general_meeting_id = ?`. If result is `None` (no motions exist), use `next_order_index = 0`; otherwise `next_order_index = max_order_index + 1`.
4. Create `Motion(general_meeting_id=general_meeting_id, title=data.title.strip(), description=data.description, order_index=next_order_index, motion_type=data.motion_type, is_visible=False)`.
5. `db.add(motion)` → `await db.commit()` → `await db.refresh(motion)`.
6. Return a dict matching `MotionOut` shape:
   ```python
   {
       "id": motion.id,
       "title": motion.title,
       "description": motion.description,
       "order_index": motion.order_index,
       "motion_type": motion.motion_type.value if hasattr(motion.motion_type, "value") else motion.motion_type,
       "is_visible": motion.is_visible,
   }
   ```

### 4. New service function: `update_motion` in `backend/app/services/admin_service.py`

Location: in the `# Motions` section, alongside `toggle_motion_visibility`.

```python
async def update_motion(
    motion_id: uuid.UUID,
    data: MotionUpdateRequest,
    db: AsyncSession,
) -> dict:
```

Logic:

1. Fetch the `Motion` by `motion_id`. If not found, raise `HTTPException(404, "Motion not found")`.
2. Fetch the parent `GeneralMeeting` via `motion.general_meeting_id`.
3. Check `get_effective_status(meeting)`. If `closed`, raise `HTTPException(409, "Cannot edit a motion on a closed meeting")`.
4. Check `motion.is_visible`. If `True`, raise `HTTPException(409, "Cannot edit a visible motion. Hide it first.")`.
5. Apply partial update: for each of `title`, `description`, `motion_type` — if the field is not `None` in `data`, set it on `motion`. For `title`, strip whitespace.
6. `await db.flush()` → `await db.commit()` → `await db.refresh(motion)`.
7. Return a dict matching `MotionVisibilityOut` shape.

### 5. New service function: `delete_motion` in `backend/app/services/admin_service.py`

Location: in the `# Motions` section, alongside `toggle_motion_visibility` and `update_motion`.

```python
async def delete_motion(
    motion_id: uuid.UUID,
    db: AsyncSession,
) -> None:
```

Logic:

1. Fetch the `Motion` by `motion_id`. If not found, raise `HTTPException(404, "Motion not found")`.
2. Fetch the parent `GeneralMeeting` via `motion.general_meeting_id`.
3. Check `get_effective_status(meeting)`. If `closed`, raise `HTTPException(409, "Cannot delete a motion on a closed meeting")`.
4. Check `motion.is_visible`. If `True`, raise `HTTPException(409, "Cannot delete a visible motion. Hide it first.")`.
5. `await db.delete(motion)` → `await db.flush()` → `await db.commit()`.
6. Return `None` (caller returns 204).

### 6. New router endpoint: `add_motion_to_meeting_endpoint` in `backend/app/routers/admin.py`

Location: in the `# Motions` section, after the existing `toggle_motion_visibility_endpoint` and before `# General Meetings`.

Import additions to `admin.py`:
- Add `MotionAddRequest` and `MotionOut` to the `from app.schemas.admin import ...` block.

```python
@router.post(
    "/general-meetings/{general_meeting_id}/motions",
    response_model=MotionOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_motion_to_meeting_endpoint(
    general_meeting_id: uuid.UUID,
    data: MotionAddRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionOut:
    """Add a new motion to an existing General Meeting.

    Returns 201 with the created motion.
    Returns 404 if the meeting does not exist.
    Returns 409 if the meeting is closed.
    """
    result = await admin_service.add_motion_to_meeting(general_meeting_id, data, db)
    return MotionOut(**result)
```

### 7. New router endpoint: `update_motion_endpoint` in `backend/app/routers/admin.py`

Import additions: add `MotionUpdateRequest` and `MotionVisibilityOut` to the import block.

```python
@router.patch(
    "/motions/{motion_id}",
    response_model=MotionVisibilityOut,
    status_code=status.HTTP_200_OK,
)
async def update_motion_endpoint(
    motion_id: uuid.UUID,
    data: MotionUpdateRequest,
    db: AsyncSession = Depends(get_db),
) -> MotionVisibilityOut:
    """Edit title, description, or motion_type of a hidden motion.

    Returns 200 with the updated motion.
    Returns 404 if the motion does not exist.
    Returns 409 if the motion is visible or the meeting is closed.
    """
    result = await admin_service.update_motion(motion_id, data, db)
    return MotionVisibilityOut(**result)
```

### 8. New router endpoint: `delete_motion_endpoint` in `backend/app/routers/admin.py`

```python
@router.delete(
    "/motions/{motion_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_motion_endpoint(
    motion_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a hidden motion permanently.

    Returns 204 on success.
    Returns 404 if the motion does not exist.
    Returns 409 if the motion is visible or the meeting is closed.
    """
    await admin_service.delete_motion(motion_id, db)
```

### 9. Tests

**File:** `backend/tests/test_admin_add_motion.py` (new file — covers US-AM01, US-AM03, US-AM04)

Test categories:

```
# --- Happy path (add) ---
# add motion to open meeting → 201, is_visible=False, correct order_index
# add motion to pending meeting → 201
# motion_type defaults to general
# order_index is max+1 when meeting already has motions
# order_index is 0 when meeting has no motions

# --- Input validation (add) ---
# missing title → 422
# blank title → 422
# unknown motion_type → 422
# extra fields in body → ignored (Pydantic default)

# --- State / precondition errors (add) ---
# closed meeting → 409
# meeting not found → 404

# --- Edge cases (add) ---
# add multiple motions sequentially → order_indexes are 0,1,2 with no constraint violation
# description is null when not provided

# --- Happy path (edit / PATCH) ---
# update all three fields → 200, all fields reflected in response
# partial update: title only → other fields unchanged
# partial update: description only → other fields unchanged
# partial update: motion_type only → other fields unchanged

# --- Input validation (edit) ---
# body with all fields absent/null → 422

# --- State / precondition errors (edit) ---
# motion not found → 404
# motion is visible → 409 "Cannot edit a visible motion. Hide it first."
# meeting is closed → 409 "Cannot edit a motion on a closed meeting."
# not admin → 403

# --- Happy path (delete) ---
# delete a hidden motion → 204, row absent from DB

# --- State / precondition errors (delete) ---
# motion not found → 404
# motion is visible → 409 "Cannot delete a visible motion. Hide it first."
# meeting is closed → 409 "Cannot delete a motion on a closed meeting."
# not admin → 403
```

---

## Frontend Changes

### 1. New API functions in `frontend/src/api/admin.ts`

Add a new request interface and API function for adding a motion. The existing `MotionOut` interface already exists in this file and is the return type.

New interface:

```typescript
export interface AddMotionRequest {
  title: string;
  description: string | null;
  motion_type: MotionType;
}
```

New add function (add after `toggleMotionVisibility`):

```typescript
export async function addMotionToMeeting(
  meetingId: string,
  data: AddMotionRequest,
): Promise<MotionOut> {
  return apiFetch<MotionOut>(`/api/admin/general-meetings/${meetingId}/motions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
```

New update interface and function:

```typescript
export interface UpdateMotionRequest {
  title?: string;
  description?: string;
  motion_type?: MotionType;
}

export async function updateMotion(
  motionId: string,
  data: UpdateMotionRequest,
): Promise<MotionVisibilityOut> {
  return apiFetch<MotionVisibilityOut>(`/api/admin/motions/${motionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
```

New delete function:

```typescript
export async function deleteMotion(motionId: string): Promise<void> {
  return apiFetch<void>(`/api/admin/motions/${motionId}`, {
    method: "DELETE",
  });
}
```

`MotionVisibilityOut` should be defined alongside `MotionOut` if not already present:

```typescript
export interface MotionVisibilityOut {
  id: string;
  title: string;
  description: string | null;
  order_index: number;
  motion_type: MotionType;
  is_visible: boolean;
}
```

### 2. Changes to `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx`

**Import change:** Add `addMotionToMeeting`, `AddMotionRequest`, `updateMotion`, `UpdateMotionRequest`, `deleteMotion`, and `MotionVisibilityOut` to the import from `../../api/admin`.

**New state variables for add motion** (alongside existing `visibilityErrors`, `pendingVisibilityMotionId`):

```typescript
const [showAddMotionForm, setShowAddMotionForm] = useState(false);
const [addMotionError, setAddMotionError] = useState<string | null>(null);
```

**New state variables for edit/delete:**

```typescript
const [editingMotionId, setEditingMotionId] = useState<string | null>(null);
const [editForm, setEditForm] = useState<{
  title: string;
  description: string;
  motion_type: MotionType;
}>({ title: "", description: "", motion_type: "general" });
const [editMotionError, setEditMotionError] = useState<string | null>(null);
const [deleteMotionError, setDeleteMotionError] = useState<Record<string, string>>({});
```

**New mutation — add:**

```typescript
const addMotionMutation = useMutation({
  mutationFn: (data: AddMotionRequest) => addMotionToMeeting(meetingId!, data),
  onSuccess: () => {
    setShowAddMotionForm(false);
    setAddMotionError(null);
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  },
  onError: (error: Error) => {
    setAddMotionError(error.message || "Failed to add motion");
  },
});
```

**New mutation — update:**

```typescript
const updateMotionMutation = useMutation({
  mutationFn: ({ motionId, data }: { motionId: string; data: UpdateMotionRequest }) =>
    updateMotion(motionId, data),
  onSuccess: () => {
    setEditingMotionId(null);
    setEditMotionError(null);
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  },
  onError: (error: Error) => {
    setEditMotionError(error.message || "Failed to update motion");
  },
});
```

**New mutation — delete:**

```typescript
const deleteMotionMutation = useMutation({
  mutationFn: (motionId: string) => deleteMotion(motionId),
  onSuccess: (_data, motionId) => {
    setDeleteMotionError((prev) => { const next = { ...prev }; delete next[motionId]; return next; });
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  },
  onError: (error: Error, motionId) => {
    setDeleteMotionError((prev) => ({ ...prev, [motionId]: error.message || "Failed to delete motion" }));
  },
});
```

**Inline add motion form** (rendered inside `GeneralMeetingDetailPage`, below the `<h2>Motion Visibility</h2>` heading):

The "Add Motion" button is only rendered when `meeting.status !== "closed"`:

```tsx
{meeting.status !== "closed" && (
  <button
    type="button"
    className="btn btn--primary"
    onClick={() => { setShowAddMotionForm(true); setAddMotionError(null); }}
  >
    Add Motion
  </button>
)}
```

When `showAddMotionForm` is `true`, an inline form is shown. The form contains:

- `<input type="text" ... aria-label="Title" />` (required)
- `<textarea aria-label="Description" />` (optional)
- `<select aria-label="Motion Type">` with `<option value="general">General</option>` and `<option value="special">Special</option>`
- `<button type="submit" disabled={addMotionMutation.isPending}>Save Motion</button>`
- `<button type="button" onClick={() => setShowAddMotionForm(false)}>Cancel</button>`

On form submit:
1. If title is blank, show local validation error without calling the API.
2. Otherwise call `addMotionMutation.mutate({ title, description: description || null, motion_type })`.

If `addMotionError` is set, show it in a `role="alert"` span.

**Edit and Delete buttons per motion row** (add to the motions table in the Motion Visibility section):

For each motion row, alongside the existing visibility toggle:

```tsx
const isEditDeleteDisabled =
  motion.is_visible || meeting.status === "closed";
const disabledTitle = "Hide this motion first to edit or delete";

<button
  type="button"
  disabled={isEditDeleteDisabled}
  title={isEditDeleteDisabled ? disabledTitle : undefined}
  onClick={() => {
    setEditingMotionId(motion.id);
    setEditForm({
      title: motion.title,
      description: motion.description ?? "",
      motion_type: motion.motion_type,
    });
    setEditMotionError(null);
  }}
>
  Edit
</button>

<button
  type="button"
  disabled={isEditDeleteDisabled}
  title={isEditDeleteDisabled ? disabledTitle : undefined}
  onClick={() => {
    if (window.confirm("Delete this motion? This cannot be undone.")) {
      deleteMotionMutation.mutate(motion.id);
    }
  }}
>
  Delete
</button>
```

When `editingMotionId === motion.id`, render an inline edit form in/below the row:

```tsx
{editingMotionId === motion.id && (
  <form onSubmit={(e) => {
    e.preventDefault();
    updateMotionMutation.mutate({
      motionId: motion.id,
      data: {
        title: editForm.title || undefined,
        description: editForm.description || undefined,
        motion_type: editForm.motion_type,
      },
    });
  }}>
    <input
      aria-label="Edit Title"
      value={editForm.title}
      onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
    />
    <textarea
      aria-label="Edit Description"
      value={editForm.description}
      onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
    />
    <select
      aria-label="Edit Motion Type"
      value={editForm.motion_type}
      onChange={(e) => setEditForm((f) => ({ ...f, motion_type: e.target.value as MotionType }))}
    >
      <option value="general">General</option>
      <option value="special">Special</option>
    </select>
    <button type="submit" disabled={updateMotionMutation.isPending}>Save</button>
    <button type="button" onClick={() => setEditingMotionId(null)}>Cancel</button>
    {editMotionError && <span role="alert">{editMotionError}</span>}
  </form>
)}
```

If `deleteMotionError[motion.id]` is set, show it in a `role="alert"` span near the row.

**Section structure after all changes:**

```
<h2>Motion Visibility</h2>
<div>
  {meeting.status !== "closed" && <button>Add Motion</button>}
  {showAddMotionForm && <form>…add form…</form>}
  {addMotionError && <span role="alert">{addMotionError}</span>}
  {meeting.motions.length === 0 ? (
    <p>No motions.</p>
  ) : (
    <table>
      {meeting.motions.map((motion) => (
        <tr key={motion.id}>
          …visibility toggle…
          <td>
            <button Edit … />
            <button Delete … />
          </td>
          {deleteMotionError[motion.id] && <span role="alert">…</span>}
        </tr>
        {editingMotionId === motion.id && <tr><td colSpan={…}><form>…edit form…</form></td></tr>}
      ))}
    </table>
  )}
</div>
```

### 3. Test changes to `frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx`

Add a new describe block `"Add Motion form"` with the following tests:

```
# --- Happy path ---
# "Add Motion" button is visible for open meeting
# "Add Motion" button is visible for pending meeting
# clicking Add Motion shows the inline form
# submitting the form with valid data calls the API and closes the form
# after successful submission, the meeting detail query is invalidated

# --- Input validation ---
# submitting with blank title shows validation error without calling API

# --- State / precondition errors ---
# "Add Motion" button is NOT shown for closed meeting
# API error is shown inline when submission fails

# --- Edge cases ---
# Cancel button hides the form without calling the API
# Save button is disabled while mutation is pending
```

Add a new describe block `"Edit motion"` with the following tests:

```
# --- Happy path ---
# Edit button is present on hidden motion row for open/pending meeting
# clicking Edit opens inline form pre-filled with current title/description/motion_type
# submitting edit form calls PATCH and closes form on success
# meeting detail query is invalidated after successful edit

# --- Input validation ---
# (PATCH endpoint validates; frontend form defers to API error display)

# --- State / precondition errors ---
# Edit button is disabled when motion is visible
# Edit button is disabled when meeting is closed
# disabled Edit button has correct title tooltip
# API error is shown inline when PATCH fails

# --- Edge cases ---
# Cancel button closes edit form without calling API
# Save button is disabled while mutation is pending
```

Add a new describe block `"Delete motion"` with the following tests:

```
# --- Happy path ---
# Delete button is present on hidden motion row for open/pending meeting
# confirming delete calls DELETE endpoint and row disappears
# meeting detail query is invalidated after successful delete

# --- State / precondition errors ---
# Delete button is disabled when motion is visible
# Delete button is disabled when meeting is closed
# disabled Delete button has correct title tooltip
# API error is shown inline when DELETE fails

# --- Edge cases ---
# dismissing confirm dialog makes no API call
```

New MSW handlers needed in `tests/msw/handlers.ts` (or equivalent):

```typescript
// Add motion
http.post("/api/admin/general-meetings/:meetingId/motions", () => {
  return HttpResponse.json({
    id: "motion-new",
    title: "New Motion",
    description: null,
    order_index: 3,
    motion_type: "general",
    is_visible: false,
  }, { status: 201 });
}),

// Update motion
http.patch("/api/admin/motions/:motionId", () => {
  return HttpResponse.json({
    id: "motion-1",
    title: "Updated Title",
    description: "Updated description",
    order_index: 0,
    motion_type: "special",
    is_visible: false,
  });
}),

// Delete motion
http.delete("/api/admin/motions/:motionId", () => {
  return new HttpResponse(null, { status: 204 });
}),
```

---

## Key Design Decisions

### `is_visible = false` on creation

The `Motion` model has `default=True` and `server_default=sa.text("true")`. The service function must explicitly pass `is_visible=False` when constructing the `Motion` object. This is a deliberate override — new motions added post-creation should not be visible until the admin explicitly publishes them via the existing visibility toggle.

### `order_index` auto-assignment

Use `SELECT MAX(order_index) FROM motions WHERE general_meeting_id = ?`:
- If `NULL` (no motions), assign `0`.
- Otherwise assign `max + 1`.

This guarantees the `uq_motions_general_meeting_order` unique constraint on `(general_meeting_id, order_index)` is never violated. No locking is needed for the expected load (admin-only, single concurrent admin).

### Closed-meeting guard uses `get_effective_status`

The existing codebase uses `get_effective_status(meeting)` rather than `meeting.status` directly throughout motion visibility and meeting management code. This function accounts for time-based auto-close (when `voting_closes_at` has passed). All new service functions must follow the same pattern.

### `MotionAddRequest` vs `MotionCreate`

The existing `MotionCreate` schema requires the caller to supply `order_index`. It is used only in `GeneralMeetingCreate` (batch creation at meeting setup time) and must not be changed. A separate `MotionAddRequest` schema is introduced that omits `order_index`, keeping concerns separate.

### Edit/delete blocked on visible motions

A visible motion may already have votes recorded against it. Allowing title or type changes after voters have seen (and possibly voted on) the motion would create inconsistencies in the audit trail. The guard at the service layer (`motion.is_visible == True` → 409) is the single source of truth; the UI merely mirrors this with disabled buttons.

### Partial update semantics for PATCH

`MotionUpdateRequest` uses `None` as the sentinel for "not provided". The service only writes fields to the DB when their value in `data` is not `None`. This means a client can update just the `title` without touching `description` or `motion_type`. The `at_least_one_field` validator ensures an all-`None` body is rejected with 422 rather than silently becoming a no-op.

### No renumbering after delete

`order_index` values are used only for display ordering. Gaps (e.g. 0, 1, 3 after deleting index 2) are acceptable and avoid the complexity of a renumbering transaction that could violate the unique constraint mid-update.

### `MotionVisibilityOut` reuse

The update endpoint returns `MotionVisibilityOut`. If this schema already exists in `admin.py` (from the motion-visibility feature), it must be reused unchanged. If it does not exist yet, define it as shown in section 2 above. The implementation agent must check before adding a duplicate.

### No `MotionOut.is_visible` default override

`MotionOut` already has `is_visible: bool = True` as a field default. The service returns `is_visible: False` explicitly in the dict, so the response will always reflect `False` for newly created motions regardless of the schema default.

---

## Data Flow: Happy Path — Add Motion

1. Admin is on `/admin/general-meetings/{meetingId}` viewing an open or pending meeting.
2. Admin clicks "Add Motion" button.
3. Inline form appears with empty fields and Motion Type = General.
4. Admin enters a title (e.g. "Motion 4"), optional description, selects Special.
5. Admin clicks "Save Motion".
6. `addMotionMutation.mutate({ title: "Motion 4", description: null, motion_type: "special" })` is called.
7. Frontend POSTs to `POST /api/admin/general-meetings/{meetingId}/motions`.
8. Router calls `admin_service.add_motion_to_meeting(general_meeting_id, data, db)`.
9. Service:
   a. Loads meeting — found, status is open.
   b. `get_effective_status` → `open`, not closed.
   c. Queries `MAX(order_index)` for the meeting → result is `2` (3 existing motions at indices 0,1,2).
   d. Creates `Motion(…, order_index=3, is_visible=False)`.
   e. Commits and returns dict.
10. Router returns `MotionOut` with `order_index=3, is_visible=false` and HTTP 201.
11. `addMotionMutation.onSuccess` fires: form is hidden, `queryClient.invalidateQueries` triggers a refetch of the meeting detail.
12. Meeting detail refetches; the table now shows 4 motions, the new one at position 4 with a "Hidden" badge.

## Data Flow: Happy Path — Edit Motion

1. Admin sees a motion row with `is_visible = false` in a non-closed meeting.
2. Admin clicks the **Edit** button (enabled).
3. Inline edit form appears, pre-filled with current title/description/motion_type.
4. Admin changes the title, clicks **Save**.
5. `updateMotionMutation.mutate({ motionId, data: { title: "New title" } })` is called.
6. Frontend PATCHes `/api/admin/motions/{motionId}`.
7. Service loads motion, checks visible (false) and meeting closed (false), updates title, commits, returns updated dict.
8. Router returns `MotionVisibilityOut` with updated title and HTTP 200.
9. `updateMotionMutation.onSuccess` fires: edit form hidden, meeting detail query invalidated.
10. Table row now shows updated title.

## Data Flow: Happy Path — Delete Motion

1. Admin sees a motion row with `is_visible = false` in a non-closed meeting.
2. Admin clicks the **Delete** button (enabled).
3. Browser `confirm()` dialog appears: "Delete this motion? This cannot be undone."
4. Admin clicks OK.
5. `deleteMotionMutation.mutate(motionId)` is called.
6. Frontend sends `DELETE /api/admin/motions/{motionId}`.
7. Service loads motion, checks visible (false) and meeting closed (false), deletes row, commits.
8. Router returns HTTP 204.
9. `deleteMotionMutation.onSuccess` fires: meeting detail query invalidated.
10. Motion row disappears from the table.

---

## E2E Test Scenarios

Key Playwright scenarios to cover (add to existing voter/admin E2E spec or create `e2e/admin-add-motion.spec.ts`):

| Scenario | Steps | Expected outcome |
|---|---|---|
| Add motion to open meeting | Auth as admin → open meeting detail → click "Add Motion" → fill form → Save | Motion appears in table, Hidden badge, no page reload required |
| Add motion to pending meeting | Auth as admin → pending meeting detail → click "Add Motion" → fill form → Save | Motion appears in table, Hidden badge |
| Form cancel | Click "Add Motion" → click "Cancel" | Form disappears, no new motion in table |
| Blank title validation | Click "Add Motion" → leave Title empty → click "Save Motion" | Inline validation error shown, no API call made, form remains open |
| Motion type defaults to General | Submit form without changing Motion Type select | New motion has `motion_type = general` |
| Visibility toggle after adding | Add motion → toggle its visibility switch to Visible | Motion is now visible (Visible badge) |
| No "Add Motion" on closed meeting | Navigate to a closed meeting detail | "Add Motion" button is absent |
| Order index increments correctly | Add three motions sequentially | order_indexes are max_existing+1, max_existing+2, max_existing+3 respectively |
| Admin edits a hidden motion | Open meeting detail → click Edit on a hidden motion → change title, description, motion_type → Save | Changes reflected immediately in the table row |
| Admin cannot edit a visible motion | View meeting detail with a visible motion | Edit button is disabled (greyed out) |
| Admin deletes a hidden motion | Click Delete on a hidden motion → confirm in dialog | Row disappears from the table |
| Admin cannot delete a visible motion | View meeting detail with a visible motion | Delete button is disabled (greyed out) |
| Admin hides, edits, then reveals motion | Hide a visible motion → Edit it → reveal it | Voters see the updated text when the motion is visible |
| API guard: PATCH visible motion | Call `PATCH /api/admin/motions/{id}` on a visible motion directly | 409 with detail "Cannot edit a visible motion. Hide it first." |
| API guard: DELETE visible motion | Call `DELETE /api/admin/motions/{id}` on a visible motion directly | 409 with detail "Cannot delete a visible motion. Hide it first." |
