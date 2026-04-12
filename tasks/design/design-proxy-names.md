# Design: Proxy Names + LotOwner Modal Cleanup (Fix 11)

PRD reference: `tasks/prd/prd-buildings-and-lots.md` — US-FIX11-A, US-FIX11-B

**Status:** Implemented

---

## Overview

Two closely related UI fixes to the lot owner editing experience:

**Problem A — Redundant name fields in EditModal**: The `EditModal` (and `AddForm`) in `LotOwnerForm.tsx` renders standalone `given_name` / `surname` inputs that update `LotOwner.given_name` / `LotOwner.surname`. These top-level name fields on `LotOwner` are a legacy artefact — since US-BO-01 (named owner emails) was implemented, names are captured per owner email entry (`LotOwnerEmail.given_name` / `LotOwnerEmail.surname`). Showing them on the LotOwner level creates confusion about which name fields to fill. They should be removed from both the `EditModal` edit form and the `AddForm`.

**Problem B — Proxy section shows email only, not name**: The proxy section of `EditModal` shows only the proxy email when a proxy is set, and provides only an email input when setting a new proxy. The backend (`LotProxy` model) already stores `given_name` and `surname`; the `SetProxyRequest` schema and `setLotOwnerProxy()` API function already support sending names; but the UI never collects or displays them. The proxy entry should mirror the owner-email pattern: name inputs (given name + surname, optional) shown alongside the email input when adding a proxy, and name + email displayed in the proxy row when a proxy is set.

---

## Root Cause / Background

**Problem A root cause:** `LotOwner.given_name` / `LotOwner.surname` were added in US-LON-01 before per-email names existed. US-BO-01 subsequently moved the authoritative name to `LotOwnerEmail`. The two sets of name fields now coexist on screen, causing confusion. The `LotOwner`-level columns remain in the DB for backward-compatibility (they are still returned by all `LotOwnerOut` responses and used by the admin table's Name column) — only the edit inputs are removed from the UI, not the backend fields themselves.

**Problem B root cause:** `LotProxy.given_name` / `LotProxy.surname` were added in US-LON-02 (schema + service), but the frontend was never updated to display or collect them. The `LotOwner` TypeScript type and `LotOwnerOut` Pydantic schema also do not surface proxy name fields — the response only includes `proxy_email: str | null`.

---

## Technical Design

### Database changes

None. `lot_proxies.given_name` and `lot_proxies.surname` already exist (added in the US-LON-02 migration).

### Backend changes

#### 1. Extend `LotOwnerOut` to include proxy name fields

**File:** `backend/app/schemas/admin.py`

Add two optional fields to `LotOwnerOut`:

```python
proxy_given_name: str | None = None
proxy_surname: str | None = None
```

These sit alongside the existing `proxy_email: str | None = None`. Together they surface the full proxy contact.

#### 2. Extend `_get_proxy_email` → `_get_proxy_info` in service

**File:** `backend/app/services/admin_service.py`

Replace the existing `_get_proxy_email` helper (which selects only `LotProxy.proxy_email`) with `_get_proxy_info` that returns a small dict (or named tuple):

```python
async def _get_proxy_info(lot_owner_id: uuid.UUID, db: AsyncSession) -> dict | None:
    """Return {proxy_email, given_name, surname} for the lot owner's proxy, or None."""
    result = await db.execute(
        select(LotProxy.proxy_email, LotProxy.given_name, LotProxy.surname)
        .where(LotProxy.lot_owner_id == lot_owner_id)
    )
    row = result.first()
    if row is None:
        return None
    return {"proxy_email": row[0], "given_name": row[1], "surname": row[2]}
```

All call-sites that currently do `proxy_email = await _get_proxy_email(...)` must be updated to use `_get_proxy_info` and populate three response dict keys instead of one.

#### 3. Update batch proxy load in `list_lot_owners`

**File:** `backend/app/services/admin_service.py` — `list_lot_owners()` function (approx. line 480)

The batch SELECT currently projects only `LotProxy.lot_owner_id, LotProxy.proxy_email`. Extend it to also select `LotProxy.given_name` and `LotProxy.surname`:

```python
proxies_result = await db.execute(
    select(LotProxy.lot_owner_id, LotProxy.proxy_email, LotProxy.given_name, LotProxy.surname)
    .where(LotProxy.lot_owner_id.in_(owner_ids))
)
proxy_by_owner: dict[uuid.UUID, dict] = {
    row[0]: {"proxy_email": row[1], "given_name": row[2], "surname": row[3]}
    for row in proxies_result.all()
}
```

The response dict for each owner becomes:

```python
proxy_info = proxy_by_owner.get(owner.id, {})
...
"proxy_email": proxy_info.get("proxy_email"),
"proxy_given_name": proxy_info.get("given_name"),
"proxy_surname": proxy_info.get("surname"),
```

#### 4. Update all per-owner response dicts

Every service function that builds a `LotOwnerOut`-compatible dict must include the three proxy fields. Affected functions (all in `admin_service.py`):

- `get_lot_owner` (single owner GET)
- `update_lot_owner`
- `add_owner_email_to_lot_owner`
- `update_owner_email`
- `remove_owner_email_by_id`
- `set_lot_owner_proxy` — already has `proxy_email`; add `proxy_given_name` and `proxy_surname`
- `remove_lot_owner_proxy` — sets `proxy_email: None`; add `proxy_given_name: None` and `proxy_surname: None`
- `add_lot_owner`

The `_get_proxy_info` helper replaces `_get_proxy_email` in all of these.

### Frontend changes

#### 1. Extend `LotOwner` TypeScript type

**File:** `frontend/src/types/index.ts`

Add two optional fields to the `LotOwner` interface:

```typescript
proxy_given_name: string | null;
proxy_surname: string | null;
```

#### 2. Update MSW fixture

**File:** `frontend/tests/msw/handlers.ts`

Add `proxy_given_name: null` and `proxy_surname: null` to both `ADMIN_LOT_OWNERS` entries. The entry for `lo2` (which has `proxy_email: "proxy@example.com"`) should retain `proxy_given_name: null` and `proxy_surname: null` (no test fixture name needed — the fields are optional).

#### 3. Remove redundant LotOwner-level name fields from EditModal

**File:** `frontend/src/components/admin/LotOwnerForm.tsx` — `EditModal` component

Remove all state and UI for the top-level `given_name`/`surname` on `LotOwner`:

- Remove state variables: `givenName`, `setGivenName`, `surname`, `setSurname`
- Remove their `useEffect` reset lines
- Remove from `handleSubmit`: the `trimmedGivenName`/`trimmedSurname` diff logic and the `updateData.given_name` / `updateData.surname` assignments
- Remove the two `<div className="field">` blocks rendering "Given Name (optional)" and "Surname (optional)" inputs in the edit form

The `LotOwnerUpdateRequest` type in `admin.ts` retains `given_name`/`surname` as the backend endpoint still accepts them — they are simply no longer sent from this form.

**Important — `AddForm`:** The `AddForm` modal has its own top-level `givenName`/`surname` fields passed into `addMutation.mutate({ ..., given_name, surname, ... })`. These are separate from owner email names and act as the lot-level name. The `AddForm` is less problematic (it's a creation form, not confused with per-email names), but for consistency with the stated goal of removing redundant name inputs from the lot owner forms, these fields should also be removed from `AddForm`. The `LotOwnerCreateRequest` sent to the backend will omit `given_name` / `surname` (they default to `null`). This is safe: `LotOwner.given_name` defaults to `null` in the DB.

#### 4. Add proxy name fields to EditModal proxy section

**File:** `frontend/src/components/admin/LotOwnerForm.tsx` — `EditModal` component

**State additions:**

```typescript
const [proxyGivenName, setProxyGivenName] = useState(lotOwner.proxy_given_name ?? "");
const [proxySurname, setProxySurname] = useState(lotOwner.proxy_surname ?? "");
```

Add these to the `useEffect` reset block.

**"Set proxy" input section** (currently just one `<input type="email">`):

Change to match the owner-email "Add owner row" pattern — name fields above the email input:

```tsx
{/* Name row */}
<div style={{ display: "flex", gap: 6 }}>
  <input
    className="field__input"
    type="text"
    placeholder="Given name (optional)"
    value={proxyGivenName}
    onChange={(e) => setProxyGivenName(e.target.value)}
    aria-label="Proxy given name"
  />
  <input
    className="field__input"
    type="text"
    placeholder="Surname (optional)"
    value={proxySurname}
    onChange={(e) => setProxySurname(e.target.value)}
    aria-label="Proxy surname"
  />
</div>
{/* Email + button row */}
<div style={{ display: "flex", gap: 8 }}>
  <input ... type="email" aria-label="Set proxy email" />
  <button ...>Set proxy</button>
</div>
```

**`handleSetProxy`** — pass names when calling `setLotOwnerProxy`:

```typescript
setProxyMutation.mutate({ email: trimmed, givenName: proxyGivenName.trim() || null, surname: proxySurname.trim() || null });
```

The mutation type changes from `useMutation<LotOwner, Error, string>` to `useMutation<LotOwner, Error, { email: string; givenName: string | null; surname: string | null }>`.

**"Proxy is set" display row** (currently shows `<span>{proxyEmail}</span>`):

Change to show name + email like the owner-email display:

```tsx
<span>
  {(lotOwner.proxy_given_name || lotOwner.proxy_surname)
    ? `${lotOwner.proxy_given_name ?? ""} ${lotOwner.proxy_surname ?? ""}`.trim()
    : <em style={{ color: "var(--text-muted)" }}>— no name —</em>
  }
  {" "}
  <span style={{ color: "var(--text-secondary)" }}>{proxyEmail}</span>
</span>
```

Note: use `lotOwner.proxy_given_name`/`proxy_surname` (from props, already reflecting the last successful set) rather than local state, to avoid stale display on re-render.

On successful `setProxyMutation`, update local state:

```typescript
setProxyGivenName(updated.proxy_given_name ?? "");
setProxySurname(updated.proxy_surname ?? "");
```

On `removeProxyMutation` success, clear:

```typescript
setProxyGivenName("");
setProxySurname("");
```

#### 5. Update `LotOwnerTable` proxy column display (optional improvement)

**File:** `frontend/src/components/admin/LotOwnerTable.tsx`

Currently: `{lo.proxy_email ?? "None"}`

Update to show name + email when both are available:

```tsx
{lo.proxy_email
  ? (lo.proxy_given_name || lo.proxy_surname)
      ? `${lo.proxy_given_name ?? ""} ${lo.proxy_surname ?? ""}`.trim() + ` (${lo.proxy_email})`
      : lo.proxy_email
  : "None"}
```

This is a read-only display change — no API or state changes required.

---

## Data Flow

**Happy path — setting a proxy with name:**

1. Admin opens the lot owner `EditModal`.
2. No proxy set → "Set proxy" section shows: given-name input + surname input + email input + "Set proxy" button.
3. Admin fills in name fields and email, clicks "Set proxy".
4. `handleSetProxy` validates the email, calls `setLotOwnerProxy(lotOwner.id, email, givenName, surname)`.
5. `PUT /api/admin/lot-owners/{id}/proxy` with body `{ "proxy_email": "…", "given_name": "…", "surname": "…" }`.
6. Backend `set_lot_owner_proxy` upserts `LotProxy`; response dict includes `proxy_email`, `proxy_given_name`, `proxy_surname`.
7. Frontend `onSuccess` receives updated `LotOwner` with all three proxy fields populated.
8. Modal proxy section switches to "proxy is set" display: "Jane Doe proxy@example.com" + "Remove proxy" button.

**Happy path — viewing existing proxy:**

1. Admin opens `EditModal` for a lot that has a proxy with names stored.
2. `lotOwner.proxy_email`, `lotOwner.proxy_given_name`, `lotOwner.proxy_surname` are all populated (from the `GET /api/admin/buildings/{id}/lot-owners` response).
3. Proxy section shows name + email immediately.

---

## Key Design Decisions

- **No schema migration**: `lot_proxies.given_name`/`surname` already exist. This is a pure backend-response and frontend-display change.
- **Remove top-level name fields from both EditModal and AddForm**: Consistency — neither form should show LotOwner-level names if the goal is to use per-email names. This is a display-only removal; the `given_name`/`surname` columns on `lot_owners` are preserved for backward-compatibility and may be removed in a future cleanup pass.
- **Proxy name display mirrors owner-email display**: Admin UX consistency — both sections show "Given Surname email@domain.com" or "— no name —" for unnamed entries.
- **LotOwnerTable proxy column update is included**: The table already shows proxy email; extending it to show name when available is low-cost and makes the change visible outside the modal.

---

## Security Considerations

No security implications. All changes are within existing admin-authenticated endpoints. Proxy `given_name` / `surname` inputs follow the same `max_length=255` constraints already defined in `SetProxyRequest`. No new endpoints, secrets, or auth paths are introduced.

---

## Files to Change

| File | Change |
|------|--------|
| `backend/app/schemas/admin.py` | Add `proxy_given_name: str \| None = None` and `proxy_surname: str \| None = None` to `LotOwnerOut` |
| `backend/app/services/admin_service.py` | Replace `_get_proxy_email` with `_get_proxy_info`; extend batch proxy SELECT in `list_lot_owners`; update all per-owner response dicts to include `proxy_given_name` and `proxy_surname` |
| `frontend/src/types/index.ts` | Add `proxy_given_name: string \| null` and `proxy_surname: string \| null` to `LotOwner` interface |
| `frontend/src/components/admin/LotOwnerForm.tsx` | (A) Remove top-level `given_name`/`surname` state and inputs from `EditModal` and `AddForm`; (B) Add proxy name state, inputs in "set proxy" section, and name display in "proxy is set" row |
| `frontend/src/components/admin/LotOwnerTable.tsx` | Update proxy column cell to show "Name (email)" when proxy name is available |
| `frontend/tests/msw/handlers.ts` | Add `proxy_given_name: null`, `proxy_surname: null` to both `ADMIN_LOT_OWNERS` fixture entries |
| `frontend/src/components/admin/__tests__/LotOwnerForm.test.tsx` | Update tests: remove tests for top-level name editing; add tests for proxy name inputs in "set proxy" section; add test that proxy display shows name + email |
| `frontend/src/components/admin/__tests__/LotOwnerTable.test.tsx` | Update proxy column display test; add test for name+email display |
| `backend/tests/test_admin_lot_owners_api.py` | Add assertions that `proxy_given_name`/`proxy_surname` are returned in `LotOwnerOut`; update existing proxy tests |

---

## Test Cases

### Unit / Integration (backend)

- `GET /api/admin/buildings/{id}/lot-owners` — response includes `proxy_given_name` and `proxy_surname` for a lot that has a proxy with names set
- `GET /api/admin/buildings/{id}/lot-owners` — response has `proxy_given_name: null` and `proxy_surname: null` for a lot with no proxy
- `GET /api/admin/lot-owners/{id}` — returns `proxy_given_name` and `proxy_surname` when proxy exists with names
- `PUT /api/admin/lot-owners/{id}/proxy` — stores and returns `proxy_given_name` and `proxy_surname`
- `PUT /api/admin/lot-owners/{id}/proxy` with omitted name fields — stores and returns `null` for both name fields
- `DELETE /api/admin/lot-owners/{id}/proxy` — returns `proxy_given_name: null` and `proxy_surname: null`
- All existing proxy tests continue to pass (names fields are nullable and backward-compatible)

### Unit / Integration (frontend)

- `EditModal` does not render a "Given Name" or "Surname" input for the top-level LotOwner edit form (Problem A)
- `AddForm` does not render top-level "Given Name" or "Surname" fields (Problem A)
- `EditModal` proxy section with no proxy: renders "Proxy given name", "Proxy surname", and "Set proxy email" inputs + "Set proxy" button
- `EditModal` proxy section with proxy and names set: displays name + email text and "Remove proxy" button; name inputs not shown
- `EditModal` proxy section with proxy but no names: displays "— no name —" + email text
- Setting proxy with given name and surname calls `setLotOwnerProxy` with correct name arguments
- Setting proxy with blank name fields calls `setLotOwnerProxy` with `givenName: null, surname: null`
- After successful proxy set, modal reflects new name + email display
- After successful proxy remove, proxy section reverts to the "set proxy" inputs
- Validation: clicking "Set proxy" with empty email shows "Proxy email is required."
- Validation: invalid email shows "Please enter a valid email address."
- `LotOwnerTable` proxy column shows "Name (email)" when proxy has name; shows email-only when no name; shows "None" when no proxy

### E2E

- Admin opens lot owner EditModal; proxy section shows name inputs and email input when no proxy set
- Admin enters proxy given name, surname, and email; clicks "Set proxy"; modal updates to show "Given Surname proxy@example.com" + "Remove proxy" button
- Admin clicks "Remove proxy"; modal reverts to the "Set proxy" form inputs
- Admin opens a lot owner that already has a named proxy; the modal proxy section shows name + email immediately (no re-fetch required)
- After the full sequence (set proxy → remove proxy → set again with different name), the final proxy display reflects the new name

---

## Schema Migration Required

No

---

## E2E Test Scenarios

### Affected persona journeys

The **Admin** journey (login → building/lot management) is affected. Existing E2E specs that exercise:
- Opening the lot owner `EditModal`
- Setting/removing a proxy from the modal
- Viewing the lot owner table's proxy column

must be updated to expect the new UI layout (name inputs in the proxy section, no top-level name inputs in the edit form).

### Multi-step sequence (required)

**Scenario: Proxy name lifecycle — set, display, remove, set again**

1. Admin logs in and navigates to a building's lot owners list.
2. Admin opens the edit modal for a lot with no proxy.
3. Proxy section shows: "Proxy given name" input, "Proxy surname" input, email input, "Set proxy" button.
4. Admin types `Jane` into the given name, `Doe` into the surname, `jane@proxy.com` into the email.
5. Admin clicks "Set proxy".
6. Modal proxy section updates to: `Jane Doe jane@proxy.com` + "Remove proxy" button. The "Set proxy" input form is gone.
7. Admin closes and re-opens the modal for the same lot.
8. Proxy section immediately shows `Jane Doe jane@proxy.com` (data came from the list refresh).
9. Admin clicks "Remove proxy".
10. Modal reverts to the empty "Set proxy" form with three inputs.
11. Admin sets a new proxy: `Bob Smith bob@proxy.com`.
12. Modal shows `Bob Smith bob@proxy.com`.
13. The lot owner table's proxy column (visible in the list) shows `Bob Smith (bob@proxy.com)`.

### Existing E2E specs to update

- Any spec that tests the `EditModal` and asserts on the form fields must be updated to not expect top-level "Given Name" / "Surname" inputs.
- Any spec that tests the proxy section must be updated to expect the new name + email layout.
