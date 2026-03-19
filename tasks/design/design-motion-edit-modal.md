# Technical Design: Motion Edit Modal + Button Saturation

**PRD references:** US-AM02 (updated), US-AM06 (new)
**Branch:** `feat/motion-edit-modal`

---

## 1. Summary of Changes

Two UI improvements to `GeneralMeetingDetailPage`:

1. **Motion Edit Modal** — Replace the inline table-row edit form with a floating modal dialog. No backend changes required; `PATCH /api/admin/motions/{id}` already exists and is correct.
2. **Edit/Delete Button Saturation** — Verify the enabled state of Edit/Delete buttons uses `.btn--secondary` / `.btn--danger` as intended, producing clearly saturated colours that contrast with the disabled grey state.

---

## 2. Scope of Changes

### Backend
None. All required endpoints (`PATCH /api/admin/motions/{id}`) are already implemented and tested.

### Frontend

| File | Change |
|---|---|
| `frontend/src/pages/admin/GeneralMeetingDetailPage.tsx` | Remove inline edit row. Add `editingMotion: MotionDetail \| null` state. Render `MotionEditModal` (inline or extracted component). Adjust button classes if needed. |
| `frontend/src/styles/index.css` | No changes required — `.btn--secondary`, `.btn--danger`, and `.btn:disabled { opacity: 0.45 }` already exist. |

---

## 3. Motion Edit Modal (US-AM02)

### 3.1 State changes in `GeneralMeetingDetailPage`

Replace the existing `editingMotionId: string | null` + `editForm` state pair with a single piece of state that holds the full motion object being edited:

```tsx
// Replace:
const [editingMotionId, setEditingMotionId] = useState<string | null>(null);
const [editForm, setEditForm] = useState<{ title: string; description: string; motion_type: MotionType }>({ ... });
const [editMotionError, setEditMotionError] = useState<string | null>(null);

// With:
const [editingMotion, setEditingMotion] = useState<MotionDetail | null>(null);
```

`MotionDetail` is already imported from `../../api/admin`. Opening the modal: `setEditingMotion(motion)`. Closing: `setEditingMotion(null)`.

The `updateMotionMutation` `onSuccess` handler changes from `setEditingMotionId(null)` to `setEditingMotion(null)`. The `onError` handler sets the error on the modal's local state (see §3.3).

### 3.2 Inline edit row removal

Remove the second `<tr key={`edit-${motion.id}`}>` row that is currently rendered inside the `{meeting.motions.map(...)}` loop when `editingMotionId === motion.id`. Also remove the wrapping `<>` fragment — each iteration can return a plain `<tr>` again.

### 3.3 Modal implementation

The modal is small enough to implement inline in `GeneralMeetingDetailPage` (same file, below the main `return`). Extract to a named component `MotionEditModal` only if the file exceeds ~650 lines after the change.

**Modal structure** — follow the `BuildingEditModal` pattern from `BuildingDetailPage.tsx`:

```tsx
{editingMotion && (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Edit Motion"
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }}
    onClick={(e) => { if (e.target === e.currentTarget) setEditingMotion(null); }}
  >
    <div
      style={{
        background: "#fff",
        borderRadius: "var(--r-lg)",
        padding: 32,
        minWidth: 360,
        maxWidth: 480,
        width: "100%",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <h2 style={{ marginTop: 0, marginBottom: 20 }}>Edit Motion</h2>
      <form onSubmit={handleEditSubmit}>
        <div className="field">
          <label className="field__label" htmlFor="modal-edit-title">Title</label>
          <input
            id="modal-edit-title"
            className="field__input"
            type="text"
            required
            value={editForm.title}
            onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="modal-edit-description">Description</label>
          <textarea
            id="modal-edit-description"
            className="field__input"
            value={editForm.description}
            onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="modal-edit-type">Motion Type</label>
          <select
            id="modal-edit-type"
            className="field__select"
            value={editForm.motion_type}
            onChange={(e) => setEditForm((f) => ({ ...f, motion_type: e.target.value as MotionType }))}
          >
            <option value="general">General</option>
            <option value="special_resolution">Special Resolution</option>
          </select>
        </div>
        {editMotionError && (
          <span role="alert" className="field__error">{editMotionError}</span>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setEditingMotion(null)}
            disabled={updateMotionMutation.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={updateMotionMutation.isPending}
          >
            {updateMotionMutation.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  </div>
)}
```

**Note:** `editForm` state is still kept as a separate `useState` (pre-populated when the modal opens). This avoids mutating the `editingMotion` object directly.

### 3.4 Keyboard handling (Escape to close)

Add a `useEffect` that listens for `keydown` on `document` and calls `setEditingMotion(null)` when `event.key === "Escape"` and `updateMotionMutation.isPending` is false. Clean up the listener when the modal unmounts.

```tsx
useEffect(() => {
  if (!editingMotion) return;
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && !updateMotionMutation.isPending) {
      setEditingMotion(null);
    }
  }
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}, [editingMotion, updateMotionMutation.isPending]);
```

### 3.5 Opening the modal

In the Edit button's `onClick` handler, replace:

```tsx
// Old:
onClick={() => {
  setEditingMotionId(motion.id);
  setEditForm({ title: motion.title, description: motion.description ?? "", motion_type: motion.motion_type });
  setEditMotionError(null);
}}

// New:
onClick={() => {
  setEditingMotion(motion);
  setEditForm({ title: motion.title, description: motion.description ?? "", motion_type: motion.motion_type });
  setEditMotionError(null);
}}
```

### 3.6 `updateMotionMutation` changes

```tsx
const updateMotionMutation = useMutation({
  mutationFn: ({ motionId, data }: { motionId: string; data: UpdateMotionRequest }) =>
    updateMotion(motionId, data),
  onSuccess: () => {
    setEditingMotion(null);   // was: setEditingMotionId(null)
    setEditMotionError(null);
    void queryClient.invalidateQueries({ queryKey: ["admin", "general-meetings", meetingId] });
  },
  onError: (error: Error) => {
    setEditMotionError(error.message || "Failed to update motion");
  },
});
```

### 3.7 Form submit handler

Extract into a named function for clarity (and to be referenced by the form's `onSubmit`):

```tsx
function handleEditSubmit(e: React.FormEvent) {
  e.preventDefault();
  if (!editingMotion) return;
  updateMotionMutation.mutate({
    motionId: editingMotion.id,
    data: {
      title: editForm.title || undefined,
      description: editForm.description || undefined,
      motion_type: editForm.motion_type,
    },
  });
}
```

---

## 4. Add Motion Modal (US-AM01)

### 4.1 Background

The "Add Motion" form was originally specified as an inline expanding row. The final implementation converts it to a modal dialog, consistent with the Edit Motion modal, so both add and edit flows share the same UX pattern.

### 4.2 State

```tsx
const [showAddMotionModal, setShowAddMotionModal] = useState<boolean>(false);
```

The "Add Motion" button is always rendered (not conditionally) when the meeting is `pending` or `open`. Clicking it sets `showAddMotionModal = true`. The button is not shown when the meeting is `closed`.

### 4.3 Modal structure

Same backdrop and centred-panel structure as the Edit Motion modal (§3.3 above):

- `role="dialog"`, `aria-modal="true"`, `aria-label="Add Motion"`
- Fixed-position backdrop at `zIndex: 1000`; clicking the backdrop closes the modal (sets `showAddMotionModal = false`)
- Escape key closes the modal when no mutation is in flight (same `useEffect` pattern as §3.4)
- Form fields: Description (`<textarea>`, required) and Motion Type (`<select>`, required)
- Footer: **Cancel** (`.btn--secondary`) and **Add Motion** (`.btn--primary`)

### 4.4 Form reset and close behaviour

- Opening the modal resets the add-form state to empty values (`description: ""`, `motion_type: "general"`)
- On successful `POST /api/admin/general-meetings/{id}/motions`:
  - Close modal (`setShowAddMotionModal(false)`)
  - Reset form state
  - Invalidate the meeting detail query so the new motion appears immediately
- On Cancel / Escape / backdrop click: close without saving, reset form state
- On API error: display error message inside the modal using `.field__error`; modal stays open

---

## 5. Motion Row Opacity Pattern (US-AM06)

### 5.1 Hidden motion rows

Apply `.admin-table__cell--muted` (opacity 0.45) to the individual `<td>` elements for the motion number (#), title, type, and visibility columns. The actions `<td>` must **not** carry this class — the Edit and Delete buttons must render at full opacity so they are clearly actionable.

```tsx
<td className="admin-table__cell--muted">{motion.order_index}</td>
<td className="admin-table__cell--muted">{motion.title}</td>
<td className="admin-table__cell--muted">…</td>  {/* type badge */}
<td className="admin-table__cell--muted">…</td>  {/* visibility toggle */}
<td>  {/* actions — NO muting class */}
  <button className="btn btn--secondary" style={{ padding: "5px 14px", fontSize: "0.8rem" }}>Edit</button>
  <button className="btn btn--danger btn--sm">Delete</button>
</td>
```

### 5.2 Visible motion rows

Text cells render at full opacity (no muting class). The Edit and Delete buttons carry the `disabled` attribute. The global CSS rule `.btn:disabled { opacity: 0.45 }` handles the visual fade — no additional class is needed.

```tsx
<button className="btn btn--secondary" disabled title="Hide this motion first to edit or delete">Edit</button>
<button className="btn btn--danger btn--sm" disabled title="Hide this motion first to edit or delete">Delete</button>
```

### 5.3 Why cell-level, not row-level

Row-level `admin-table__row--muted` applies opacity to the entire `<tr>`, including the actions cell. This prevents the Edit/Delete buttons from standing out at full saturation on hidden rows. Cell-level muting gives independent control: content cells are greyed out while action buttons remain visually prominent.

**Do not use `admin-table__row--muted` on motion rows.**

---

## 6. Test coverage

### Unit / integration tests (Vitest + RTL)

All tests live in `frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx`.

New / updated scenarios:

| Scenario | What to assert |
|---|---|
| Edit button click opens modal | Modal with role="dialog" and "Edit Motion" heading is visible after click |
| Modal pre-fills fields | Title input, description textarea, motion type select contain the motion's current values |
| Cancel closes modal without calling API | Modal is not in DOM after Cancel; `updateMotion` mock not called |
| Escape closes modal without calling API | Same as Cancel, triggered via keyboard event |
| Backdrop click closes modal | Same as Cancel, triggered by clicking the overlay div |
| Save calls PATCH with correct payload | `updateMotion` called with `(motionId, { title, description, motion_type })` |
| Saving… state during pending | Save button shows "Saving…" and is disabled while mutation is pending |
| Error state | Error message appears inside modal with correct text when API rejects |
| Success closes modal and refetches | Modal closes and `invalidateQueries` called on success |
| Edit button disabled when visible | Button has `disabled` attribute when `motion.is_visible === true` |
| Edit button disabled when meeting closed | Button has `disabled` attribute when `meeting.status === "closed"` |
| Delete button class | `className` includes `btn--danger` |
| Edit button class | `className` includes `btn--secondary` |

### E2E scenarios (Playwright)

Add to the existing motion visibility E2E spec (or create `motion-edit-modal.spec.ts`):

1. **Happy path**: Admin opens meeting detail → clicks Edit on a hidden motion → modal opens with pre-filled fields → changes title → clicks Save Changes → modal closes → updated title visible in table
2. **Cancel discards changes**: Admin opens modal → changes title → clicks Cancel → modal closes → original title still in table
3. **Escape discards changes**: Same as Cancel, using keyboard Escape
4. **Backdrop click discards changes**: Click the overlay outside the modal panel
5. **API error shown in modal**: Mock PATCH to return 409 → error message visible inside modal → modal stays open
6. **Disabled on visible motion**: Edit button is disabled (verify `disabled` attribute) on a visible motion row
7. **Disabled on closed meeting**: Edit button is disabled on any motion when meeting is closed

---

## 6. No-op items

- No new API endpoints
- No schema migrations
- No new CSS classes
- No changes to the voter-facing pages
- No changes to the admin report view
