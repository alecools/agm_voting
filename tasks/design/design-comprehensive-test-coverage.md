# Design: Comprehensive Test Coverage for Recent Bug Fixes

## Overview

This document audits the test coverage for seven recent bug fixes in the AGM voting app. For each fix it records:
- what tests already exist,
- what is missing (unit, integration, or E2E), and
- the exact scenario or assertion the implementation agent must add.

The output is a prioritised gap table followed by per-fix sections with exact test specifications.

---

## Gap Table

| # | Fix | Test level | Gap description |
|---|-----|------------|-----------------|
| 1 | Motion number on edit (PATCH) | Backend unit/integration | `motion_number` persisted to DB verified — covered. **No gap.** |
| 2 | Motion number on add (POST) | Backend integration | `motion_number` accepted and persisted — **NOT tested**. |
| 3 | Motion number label on voting page | Frontend unit (MotionCard) | `motion_number` display covered. **No gap at component level.** |
| 3 | Motion number label on voting page | Frontend integration (VotingPage) | VotingPage never exercises a motion whose `motion_number` is set — **NOT tested**. |
| 4 | Motion position uses `display_order` | Frontend unit (VotingPage) | `position` is currently `index + 1`; no test verifies that when the first visible motion has `display_order > 1` its heading still reads `Motion {display_order}` — **NOT tested**. |
| 4 | Motion position uses `display_order` | E2E | No E2E scenario seeds a meeting where the first visible motion has `display_order > 1` and verifies the heading — **NOT tested**. |
| 5 | Visibility toggle optimistic update | Frontend unit (GeneralMeetingDetailPage) | Existing test only verifies no alert is shown after toggle (waits for MSW). Immediate (pre-response) checkbox state change is **NOT tested**. |
| 6 | Reorder buttons (top/bottom only in Actions) | Frontend unit (MotionManagementTable) | Move-up/down AND move-to-top/bottom all exist in current source; tests already cover all four. **No gap** — tests reflect current four-button design. |
| 7 | Admin login logo uses `useBranding()` | Source code | `AdminLoginPage.tsx` still uses hardcoded `/logo.png`. Fix has **NOT been applied**. No tests cover branding-driven logo on the login page. Two branches needed: `logo_url` set and `logo_url` empty. |
| 7 | Admin login logo uses `useBranding()` | E2E | No E2E scenario visits `/admin/login` and verifies the logo `src` changes when `logo_url` is configured. **NOT tested**. |

---

## Fix-by-fix analysis

### Fix 1 — Motion number on edit (`PATCH /api/admin/motions/{id}`)

**Existing coverage:**

`TestMotionManagement` in `backend/tests/test_admin_api.py` contains:

- `test_update_motion_all_fields_includes_motion_number` (line 6859) — asserts `data["motion_number"] == "42"` in response.
- `test_update_motion_partial_motion_number_only` (line 6876) — asserts `data["motion_number"] == "SR-1"`.
- `test_update_motion_motion_number_empty_string_clears` (line 6890) — asserts `data["motion_number"] is None`.
- `test_update_motion_persists_to_db` (line 6731) — asserts `motion.motion_number == "99"` against the DB session.

Frontend `GeneralMeetingDetailPage.test.tsx` "Edit motion modal" describe block:
- `submitting edit sends updated motion_number value` — captures request body and asserts `capturedBody.motion_number === "M-99"`.
- `modal pre-fills motion_number from the motion being edited` — asserts input has value "M-42".
- `whitespace-only motion_number sends null` — asserts null sent when whitespace entered.

**Verdict: no gaps.**

---

### Fix 2 — Motion number on add (`POST /api/admin/agms/{id}/motions`)

**Existing coverage:**

`TestMotionManagement.test_add_motion_to_open_meeting_returns_201` (line 6473) does NOT include `motion_number` in the JSON payload and does NOT assert on `motion_number` in the response. None of the `test_add_motion_*` tests send or check `motion_number`.

`GeneralMeetingDetailPage.test.tsx` "Add Motion form" describe block:
- `submitting add motion with motion_number sends it in the payload` (line 887) — captures request body and asserts `capturedBody.motion_number === "S-1"`. Frontend covered.

**Gaps:**

#### Gap 2a — Backend integration: `motion_number` accepted and persisted on POST

**File:** `backend/tests/test_admin_api.py`, class `TestMotionManagement`

Add these tests:

```python
# --- motion_number on add ---

async def test_add_motion_with_motion_number_returns_201_and_field(
    self, client: AsyncClient, db_session: AsyncSession
):
    """POST with motion_number returns 201 with motion_number in response."""
    agm = await self._create_meeting(db_session, "AddWithMN")
    response = await client.post(
        f"/api/admin/general-meetings/{agm.id}/motions",
        json={"title": "Numbered Motion", "motion_number": "SR-1"},
    )
    assert response.status_code == 201
    assert response.json()["motion_number"] == "SR-1"

async def test_add_motion_with_motion_number_persists_to_db(
    self, client: AsyncClient, db_session: AsyncSession
):
    """motion_number sent on POST is persisted in the DB row."""
    agm = await self._create_meeting(db_session, "AddMNPersist")
    response = await client.post(
        f"/api/admin/general-meetings/{agm.id}/motions",
        json={"title": "Persist MN", "motion_number": "A-1"},
    )
    assert response.status_code == 201
    motion_id = uuid.UUID(response.json()["id"])
    result = await db_session.execute(select(Motion).where(Motion.id == motion_id))
    motion = result.scalar_one_or_none()
    assert motion is not None
    assert motion.motion_number == "A-1"

async def test_add_motion_without_motion_number_returns_null(
    self, client: AsyncClient, db_session: AsyncSession
):
    """POST without motion_number returns motion_number=null in response."""
    agm = await self._create_meeting(db_session, "AddNoMN")
    response = await client.post(
        f"/api/admin/general-meetings/{agm.id}/motions",
        json={"title": "No Number"},
    )
    assert response.status_code == 201
    assert response.json()["motion_number"] is None

async def test_add_motion_duplicate_motion_number_returns_409(
    self, client: AsyncClient, db_session: AsyncSession
):
    """POST with a motion_number that already exists in the same meeting returns 409."""
    agm, _ = await self._create_meeting_with_motion(
        db_session, "DupMN", motion_number="DUP"
    )
    response = await client.post(
        f"/api/admin/general-meetings/{agm.id}/motions",
        json={"title": "Second with same number", "motion_number": "DUP"},
    )
    assert response.status_code == 409
```

---

### Fix 3 — Motion number label on voting page (always prefixed "Motion")

**Existing coverage:**

`MotionCard.test.tsx`:
- `displays motion_number when it is set` — renders `<MotionCard motion={motionWithNumber} position={4} />` and expects `screen.getByText("SR-1")`.
- `falls back to 'Motion {position}' label when motion_number is null`.
- `falls back to 'Motion {position}' label when motion_number is empty string after trim`.

The `MotionCard` component renders:
```tsx
<p className="motion-card__number">{motion.motion_number?.trim() || `Motion ${position}`}</p>
```

So when `motion_number` is set (e.g. `"SR-1"`), the heading reads `"SR-1"` — **not** `"Motion SR-1"`. The fix description says the label is always prefixed with "Motion " (e.g. `MOTION BBB`). This suggests the intended behaviour changed to always prepend "Motion ".

**Gap 3a — Frontend unit (MotionCard): verify the "Motion " prefix is always present**

If the fix changes the rendering to `Motion {motion_number}` when `motion_number` is set, the existing test `displays motion_number when it is set` which expects `"SR-1"` (no prefix) will now need to assert `"Motion SR-1"` instead.

**File:** `frontend/src/components/vote/__tests__/MotionCard.test.tsx`

Replace or update:
```tsx
it("displays motion_number prefixed with 'Motion ' when it is set", () => {
  render(
    <MotionCard
      motion={{ ...motion, motion_number: "SR-1" }}
      position={4}
      choice={null}
      onChoiceChange={vi.fn()}
      disabled={false}
      highlight={false}
      readOnly={false}
    />
  );
  expect(screen.getByText("Motion SR-1")).toBeInTheDocument();
  // Raw motion_number without prefix must NOT appear as a standalone element
  expect(screen.queryByText("SR-1")).not.toBeInTheDocument();
});

it("displays 'Motion {position}' fallback when motion_number is null (still prefixed)", () => {
  render(
    <MotionCard
      motion={{ ...motion, motion_number: null }}
      position={1}
      choice={null}
      onChoiceChange={vi.fn()}
      disabled={false}
      highlight={false}
      readOnly={false}
    />
  );
  expect(screen.getByText("Motion 1")).toBeInTheDocument();
});
```

**Gap 3b — Frontend integration (VotingPage): motion_number set on a motion renders with "Motion " prefix**

The `VotingPage` test fixture uses `motion_number: null` for both motions in the default MSW handler. No test covers the case where a motion has `motion_number` set.

**File:** `frontend/src/pages/vote/__tests__/VotingPage.test.tsx`

Add:
```tsx
it("motion with motion_number set shows 'Motion {motion_number}' label", async () => {
  server.use(
    http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
      HttpResponse.json([
        {
          id: MOTION_ID_1,
          title: "Budget Approval",
          description: null,
          display_order: 1,
          motion_number: "S-1",
          motion_type: "general",
          is_visible: true,
        },
      ])
    )
  );
  renderPage();
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Motion S-1" })).toBeInTheDocument();
  });
  // Raw motion_number without prefix must not be the heading
  expect(screen.queryByRole("heading", { name: "S-1" })).not.toBeInTheDocument();
});
```

---

### Fix 4 — Motion position uses `display_order` not array index

**Current code in VotingPage.tsx (line 695):**
```tsx
position={index + 1}
```

This means if the API returns two visible motions with `display_order` values `[3, 5]`, the headings read `"Motion 1"` and `"Motion 2"` instead of `"Motion 3"` and `"Motion 5"`.

**The fix** changes `position={index + 1}` to `position={motion.display_order}`.

**Existing coverage:** All VotingPage tests use motions with `display_order: 1` and `display_order: 2`, which happen to equal `index + 1`. No test catches the renumbering bug.

**Gap 4a — Frontend unit (VotingPage): display_order used as position when first visible motion has display_order > 1**

**File:** `frontend/src/pages/vote/__tests__/VotingPage.test.tsx`

Add:
```tsx
it("uses display_order not array index for motion position heading", async () => {
  // Simulate a meeting where the first visible motion has display_order=3
  // (e.g. motions 1 and 2 were hidden). With the bug, heading would read
  // "Motion 1"; after the fix it reads "Motion 3".
  server.use(
    http.get(`${BASE}/api/general-meeting/${AGM_ID}/motions`, () =>
      HttpResponse.json([
        {
          id: MOTION_ID_1,
          title: "Third Motion",
          description: null,
          display_order: 3,
          motion_number: null,
          motion_type: "general",
          is_visible: true,
        },
        {
          id: MOTION_ID_2,
          title: "Fifth Motion",
          description: null,
          display_order: 5,
          motion_number: null,
          motion_type: "special",
          is_visible: true,
        },
      ])
    )
  );
  renderPage();
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Motion 3" })).toBeInTheDocument();
  });
  expect(screen.getByRole("heading", { name: "Motion 5" })).toBeInTheDocument();
  // Bug: array-index-based headings must NOT appear
  expect(screen.queryByRole("heading", { name: "Motion 1" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Motion 2" })).not.toBeInTheDocument();
});
```

**Gap 4b — E2E: hidden motions do not cause renumbering on voting page**

No E2E spec seeds a meeting with a hidden first motion and verifies the heading on the voting page.

**Spec file to update:** `frontend/e2e/workflows/voting-scenarios.spec.ts`

The existing voter journey tests in that file must be updated (not just supplemented) to include this scenario.

Add a scenario inside an appropriate `describe` block or as a new `test.describe("Voter — motion position with hidden motions")`:

```
Given admin creates a meeting with three motions (display_order 1, 2, 3) where motion 1 is hidden and motions 2 and 3 are visible,
When a voter authenticates and reaches the voting page,
Then the first visible motion heading reads "Motion 2" (not "Motion 1"),
And the second visible motion heading reads "Motion 3".
```

---

### Fix 5 — Visibility toggle optimistic update

**Existing coverage:**

`GeneralMeetingDetailPage.test.tsx`, line 660:
```tsx
it("clicking toggle on open meeting calls toggleMotionVisibility API", async () => {
  await user.click(checkbox);
  // After successful toggle, query refetches — no error shown
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
```

This test waits for the MSW response to settle before asserting. It does **not** verify that the checkbox flips immediately (before the API responds). The `onMutate` optimistic update in `GeneralMeetingDetailPage.tsx` (lines 241-253) sets `is_visible` in the query cache synchronously. No test verifies this intermediate state.

**Gap 5a — Frontend unit: checkbox reflects new state immediately after click, before API responds**

**File:** `frontend/src/pages/admin/__tests__/GeneralMeetingDetailPage.test.tsx`

Add to the "Motion visibility toggle" section:
```tsx
it("toggle checkbox reflects new state immediately before API responds (optimistic update)", async () => {
  // Use a handler that never resolves so we can observe the in-flight state
  server.use(
    http.patch(
      "http://localhost:8000/api/admin/motions/:motionId/visibility",
      async () => {
        await new Promise(() => {}); // never resolves
      }
    )
  );
  const user = userEvent.setup();
  renderPage(); // agm1 — single visible motion, checkbox starts checked
  await waitFor(() => {
    expect(screen.getByText("Motions")).toBeInTheDocument();
  });
  const checkbox = screen.getAllByRole("checkbox")[0];
  expect(checkbox).toBeChecked();

  await user.click(checkbox);

  // Optimistic update must flip the checkbox immediately — without waiting
  // for the API response which never arrives
  expect(checkbox).not.toBeChecked();
});

it("toggle checkbox reverts to original state when API responds with error", async () => {
  server.use(
    http.patch("http://localhost:8000/api/admin/motions/:motionId/visibility", () => {
      return HttpResponse.json({ detail: "Internal server error" }, { status: 500 });
    })
  );
  const user = userEvent.setup();
  renderPage();
  await waitFor(() => {
    expect(screen.getByText("Motions")).toBeInTheDocument();
  });
  const checkbox = screen.getAllByRole("checkbox")[0];
  expect(checkbox).toBeChecked();

  await user.click(checkbox);

  // After error, React Query rolls back the optimistic update
  await waitFor(() => {
    expect(checkbox).toBeChecked();
  });
});
```

---

### Fix 6 — Reorder buttons (top/bottom only in Actions column)

**Current source code state:**

`MotionManagementTable.tsx` lines 118-175 renders four buttons per motion row: "Move to top", "Move up", "Move down", "Move to bottom". The fix description says "only top/bottom (⤒ ⤓)". Inspecting the current source, all four buttons are still present.

**Existing test coverage in `MotionManagementTable.test.tsx`:**

Tests cover all four buttons:
- `'Move to top' and 'Move up' disabled for first motion`
- `'Move down' and 'Move to bottom' disabled for last motion`
- `middle motion's all four buttons are enabled`
- Click interactions for all four buttons

**Verdict:** The fix to remove "Move up" and "Move down" buttons and keep only "Move to top" and "Move to bottom" has either not been applied, or the tests are still testing the old four-button design. If the fix IS applied:

**Gap 6a — Frontend unit: "Move up" and "Move down" buttons must NOT be present after the fix**

**File:** `frontend/src/components/admin/__tests__/MotionManagementTable.test.tsx`

These existing tests must be **replaced** (not supplemented):

Remove tests that assert `"Move Alpha Motion up"` and `"Move Beta Motion down"` exist. Replace with:
```tsx
it("only 'Move to top' and 'Move to bottom' buttons are rendered (no Move up/down)", () => {
  renderTable();
  // Only top/bottom buttons exist
  expect(screen.getByRole("button", { name: "Move Alpha Motion to top" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Move Alpha Motion to bottom" })).toBeInTheDocument();
  // Up/down step buttons must NOT exist
  expect(screen.queryByRole("button", { name: /Move .* up$/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Move .* down$/ })).not.toBeInTheDocument();
});
```

Also update `GeneralMeetingDetailPage.test.tsx`: the tests "clicking 'Move up' in visibility table calls reorder API" and "clicking 'Move down' in visibility table calls reorder API" (lines 512-586) must be removed, and the assertions using `"Move Motion Beta up"` / `"Move Motion Gamma down"` must be replaced with `"Move Motion Beta to top"` / `"Move Motion Gamma to bottom"` (or removed entirely if the buttons no longer exist).

**Note:** The E2E spec `admin-general-meetings.spec.ts` already uses only `"Move First Motion to bottom"` and `"Move Motion Last to top"` — it does not test step-move buttons — so no E2E change is needed for this fix.

---

### Fix 7 — Admin login logo uses `useBranding()` / `config.logo_url`

**Current source code state:**

`AdminLoginPage.tsx` (line 34-35) still uses:
```tsx
<source srcSet="/logo.webp" type="image/webp" />
<img src="/logo.png" alt="General Meeting Vote" className="admin-login-card__logo" />
```

The fix has **not been applied yet**. The tests below are needed once the implementation is complete.

**Existing coverage:**

`AdminLoginPage.test.tsx` has 7 tests covering: render, navigation, loading state, error state. None touch the logo element.

The smoke test `e2e/smoke.spec.ts` line 26 verifies that `/logo.png` returns a non-image response (file has been deleted). This confirms the hardcoded `/logo.png` is broken in production and the fix is required.

**Gap 7a — Frontend unit: logo renders from `config.logo_url` when set**

The fix requires wrapping `AdminLoginPage` in `BrandingContext` or consuming `useBranding()`.

**File:** `frontend/src/pages/admin/__tests__/AdminLoginPage.test.tsx`

Add a `renderPageWithBranding` helper that wraps the page in a `BrandingContext.Provider` with a controlled value, then add:

```tsx
it("renders logo using logo_url from branding config when set", async () => {
  // Render with a branding config that has logo_url set
  renderPageWithBranding({ logo_url: "https://cdn.example.com/logo.png", app_name: "Test App" });
  const img = screen.getByRole("img", { name: /Test App|General Meeting Vote/ });
  expect(img).toHaveAttribute("src", "https://cdn.example.com/logo.png");
});

it("renders fallback logo when logo_url is empty string", async () => {
  renderPageWithBranding({ logo_url: "", app_name: "Test App" });
  // When logo_url is empty the img should either not render or show a default fallback
  // (exact assertion depends on the chosen implementation — either no img, or src="/favicon.ico")
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  // OR: expect(screen.getByRole("img")).toHaveAttribute("src", "/favicon.ico");
});

it("does not use hardcoded /logo.png as img src", async () => {
  renderPageWithBranding({ logo_url: "https://cdn.example.com/logo.png", app_name: "Test App" });
  const img = screen.queryByAltText("General Meeting Vote") as HTMLImageElement | null;
  if (img) {
    expect(img.src).not.toBe("/logo.png");
    expect(img.src).not.toContain("/logo.png");
  }
});
```

**Gap 7b — E2E: admin login page shows branding logo**

**Spec file to update:** `frontend/e2e/admin/admin-settings.spec.ts`

The existing settings E2E tests already cover the sidebar logo; the same `describe` block should be extended (not a new file) to cover the login page logo. Add to the serial describe block:

```
Given the admin has configured a custom logo_url via the Settings API,
When an unauthenticated user visits /admin/login,
Then the <img> element on the login page has src equal to the configured logo_url
  (not "/logo.png").

Given the admin has cleared logo_url (empty string),
When an unauthenticated user visits /admin/login,
Then no broken image is displayed (either no img element, or a valid fallback).
```

---

## Affected persona journeys

| Persona journey | Affected by which fix |
|---|---|
| **Voter** — auth → lot selection → voting → confirmation | Fix 3 (motion number label), Fix 4 (position using display_order) |
| **Admin** — login → building/meeting management | Fix 7 (login logo), Fix 2 (add motion), Fix 1 (edit motion), Fix 5 (toggle), Fix 6 (reorder buttons) |

The existing E2E specs for the voter journey (`frontend/e2e/workflows/voting-scenarios.spec.ts`, `frontend/e2e/voting-flow.spec.ts`) must be **updated** — not just supplemented — to include Fix 3 and Fix 4 scenarios. Similarly the admin journey spec (`frontend/e2e/admin/admin-general-meetings.spec.ts`) must be updated to include Fix 2 and Fix 5 scenarios.

---

## E2E Test Scenarios

### Scenario E1 — Motion number on add (Fix 2)

**Spec file:** `frontend/e2e/admin/admin-general-meetings.spec.ts` (new `describe` block)

**Given** admin creates an AGM via the UI "Add Motion" dialog and enters a motion number "SR-1",
**When** the motion is saved,
**Then** the motion table row shows "SR-1" in the # column without a page refresh.

**Given** admin subsequently edits the same motion and changes the motion number to "SR-2",
**When** Save Changes is clicked,
**Then** the # column updates to "SR-2" without a page refresh.

### Scenario E2 — Motion position with hidden motions (Fix 4)

**Spec file:** `frontend/e2e/workflows/voting-scenarios.spec.ts` (update existing voter journey)

**Given** an open AGM where motion 1 (display_order=1) is hidden and motion 2 (display_order=2) is visible,
**When** a voter authenticates and navigates to the voting page,
**Then** the single visible motion card heading reads "Motion 2" (not "Motion 1").

**Given** an open AGM where motions 1–3 are hidden and motions 4–5 are visible,
**When** a voter navigates to the voting page,
**Then** the first card heading reads "Motion 4" and the second reads "Motion 5".

### Scenario E3 — Visibility toggle optimistic update (Fix 5)

**Spec file:** `frontend/e2e/admin/admin-general-meetings.spec.ts` (extend existing motions describe)

**Given** admin is on the meeting detail page for an open meeting with a visible motion,
**When** admin clicks the visibility toggle,
**Then** the toggle label changes from "Visible" to "Hidden" immediately (before the page reloads),
**And** after the API response arrives the toggle label remains "Hidden".

### Scenario E4 — Admin login logo from branding (Fix 7)

**Spec file:** `frontend/e2e/admin/admin-settings.spec.ts` (extend the serial branding describe block)

**Given** a custom `logo_url` is configured via `PATCH /api/admin/config`,
**When** an unauthenticated browser navigates to `/admin/login`,
**Then** the `<img>` on the login card has `src` equal to the configured `logo_url`
  and does not have `src="/logo.png"`.

**Given** `logo_url` is set to empty string,
**When** a browser navigates to `/admin/login`,
**Then** no image with `src="/logo.png"` is rendered (no broken image).

---

## Schema migration note

Schema migration needed: **No.** All fixes are UI and API behaviour changes. No new database columns, tables, or enum values are required.

---

## Vertical slice decomposition

All gaps are independent of each other (different files, different components, no shared DB state):

| Slice | Files touched | Can run in parallel? |
|---|---|---|
| Backend: Fix 2 add-motion motion_number | `test_admin_api.py` | Yes |
| Frontend unit: Fix 3 VotingPage + MotionCard | `VotingPage.test.tsx`, `MotionCard.test.tsx` | Yes |
| Frontend unit: Fix 4 display_order position | `VotingPage.test.tsx` | Yes (same file as Fix 3 — combine into one slice) |
| Frontend unit: Fix 5 optimistic toggle | `GeneralMeetingDetailPage.test.tsx` | Yes |
| Frontend unit: Fix 6 reorder buttons | `MotionManagementTable.test.tsx`, `GeneralMeetingDetailPage.test.tsx` | Yes |
| Frontend unit + E2E: Fix 7 login logo | `AdminLoginPage.test.tsx`, `admin-settings.spec.ts` | Yes, but depends on Fix 7 implementation being applied first |
| E2E: Fix 4 hidden-motion renumbering | `voting-scenarios.spec.ts` | Yes |

Recommended grouping for implementation:
- **Slice A** (backend only): Fix 2 backend tests.
- **Slice B** (frontend unit only): Fix 3 + Fix 4 + Fix 5 + Fix 6 (all frontend unit, no DB).
- **Slice C** (frontend unit + E2E): Fix 7 — depends on the implementation of `useBranding()` in `AdminLoginPage.tsx` being landed first.
- **Slice D** (E2E only): Fix 4 E2E scenario — can run once the Fix 4 implementation is confirmed.
