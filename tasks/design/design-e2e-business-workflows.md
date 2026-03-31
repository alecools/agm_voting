# Design: Comprehensive Business-Workflow E2E Test Suite

**Status:** Implemented

## Overview and Rationale

The existing E2E suite is **persona-scoped**: each spec file tests one persona's journey (voter, admin, proxy voter, in-arrear voter) in isolation. What is missing is **business-lifecycle coverage** — tests that run the full sequence from admin setup through voting through results verification, asserting exact tally numbers at the end.

The existing specs verify that UI flows work (buttons are visible, navigation happens) but do not verify the numerical correctness of the vote tallies. A bug that accepts votes but records the wrong entitlement sum, or fails to create absent records for non-voters, would pass the existing suite.

This design adds a new `frontend/e2e/workflows/` directory containing specs that:

1. Cover the complete lifecycle end-to-end in a single test or tightly coupled serial test group
2. Assert **exact pre-calculated tally numbers** — `voter_count` and `entitlement_sum` for every outcome on every motion
3. Cross-persona: each workflow uses both the admin API (for setup and results verification) and the voter UI (for authentication and voting)
4. Are self-contained: each workflow seeds its own isolated building/meeting and cleans up via ballot deletion

---

## Data Isolation Strategy

### Branch-name suffix pattern (inherited from existing tests)

Every workflow uses the `RUN_SUFFIX` from `fixtures.ts`. All seeded building names include this suffix so concurrent branch deployments against the shared Neon DB do not collide.

Example: `E2E WF3 Simple Voting-${RUN_SUFFIX}`.

### One building per workflow

Each workflow creates its own building. This ensures:
- No `409 Only one open AGM per building` conflicts between workflows running in parallel
- No tally contamination between workflows
- `beforeAll` cleanup (close open AGMs) is scoped only to the workflow's own building

### Serial mode within each workflow file

Each workflow `test.describe` block uses `test.describe.configure({ mode: "serial" })`. Tests within a workflow must run in order: setup → voting → results verification.

### Parallelism between workflow files

Workflow files are independent and can run in parallel (each has its own building). The Playwright worker pool handles this naturally.

### Ballot wipe pattern

Every `beforeAll` ends with `DELETE /api/admin/general-meetings/{id}/ballots` to ensure idempotent re-runs on a shared deployment.

---

## Admin Results API Structure

The admin `GET /api/admin/general-meetings/{id}` returns a `motion_details` array. Each entry has:

```json
{
  "motion_id": "...",
  "title": "...",
  "order_index": 1,
  "motion_type": "general",
  "tally": {
    "yes":          { "voter_count": N, "entitlement_sum": N },
    "no":           { "voter_count": N, "entitlement_sum": N },
    "abstained":    { "voter_count": N, "entitlement_sum": N },
    "absent":       { "voter_count": N, "entitlement_sum": N },
    "not_eligible": { "voter_count": N, "entitlement_sum": N }
  },
  "voter_lists": {
    "yes":          [{ "lot_number": "...", "unit_entitlement": N }],
    ...
  }
}
```

Note: the voter-facing vote choices are `yes`/`no`/`abstained` (mapped to "For"/"Against"/"Abstain" in the UI). The tally keys use these values. In-arrear general motion votes are stored as `not_eligible`.

**UI mapping**: The voting page buttons are labelled "For", "Against", "Abstain". These map to backend choices `yes`, `no`, `abstained` respectively.

---

## Workflow Files and Test Scenarios

### File: `frontend/e2e/workflows/voting-scenarios.spec.ts`

Contains Workflows 3 through 7 (the voting lifecycle scenarios). These are the highest-value tests.

### File: `frontend/e2e/workflows/admin-setup.spec.ts`

Contains Workflow 1 (admin building setup) and Workflow 2 (meeting creation and motion management).

### File: `frontend/e2e/workflows/edge-cases.spec.ts`

Contains Workflow 8 (edge cases).

---

## Workflow 1: Admin Building Setup

**Purpose:** Verify the full admin data-entry lifecycle for a building before any meeting is created.

**File:** `frontend/e2e/workflows/admin-setup.spec.ts`

### Seed Data

```
Building name: "WF1 Admin Setup Building-${RUN_SUFFIX}"
Manager email: "wf1-manager@test.com"
```

### Test Steps

**Step 1.1: Create building via form**
- Navigate to `/admin/buildings`
- Click "+ New Building"
- Fill name and manager email
- Submit — assert building appears in the list

**Step 1.2: Upload lot owners via CSV**

CSV content:
```
lot_number,email,unit_entitlement,financial_position
WF1-1,wf1-voter1@test.com,100,normal
WF1-2,wf1-voter2@test.com,50,normal
WF1-3,wf1-voter3@test.com,75,normal
```

- Navigate to building detail page
- Upload CSV via "Lot owners file" input + Upload button
- Assert: "Import complete: 3 records imported"
- Assert table shows 3 lot rows with correct lot numbers and entitlements

**Step 1.3: Edit a lot owner (change entitlement and email)**
- Click Edit on lot WF1-2
- Change unit entitlement from 50 to 55
- Add email `wf1-voter2-alt@test.com`
- Save — assert row updates to show entitlement 55

**Step 1.4: Edit building name and manager email**
- Click "Edit Building" in page header
- Change manager email to `wf1-manager-new@test.com`
- Save — assert page header shows updated email

**Step 1.5: Upload proxy nominations CSV**

CSV content:
```
Lot#,Proxy Email
WF1-3,wf1-proxy@test.com
```

- Click "Import Proxy Nominations"
- Upload the CSV
- Assert: `{ "upserted": 1, "removed": 0, "skipped": 0 }` (or equivalent success message)
- Navigate to lot WF1-3's edit modal — assert proxy email shows `wf1-proxy@test.com`

**Step 1.6: Upload financial positions CSV**

CSV content:
```
Lot#,Financial Position
WF1-2,In Arrear
```

- Click "Import Financial Positions"
- Upload the CSV
- Assert: `{ "updated": 1, "skipped": 0 }` (or equivalent success message)
- Assert lot WF1-2 row in admin table shows "In Arrear" badge

**Step 1.7: Verify all data visible in admin UI**
- Assert building detail page shows all 3 lot owners
- Assert WF1-2 shows "In Arrear" badge
- Assert WF1-3 edit modal shows proxy email

---

## Workflow 2: Meeting Creation and Motion Management

**Purpose:** Verify an admin can create a meeting, upload motions from CSV, and see it in the meeting list with the correct status.

**File:** `frontend/e2e/workflows/admin-setup.spec.ts` (second `describe` block)

### Seed Data

```
Building: reuse or create "WF2 Meeting Creation Building-${RUN_SUFFIX}"
Lot owner: WF2-1, email wf2-voter@test.com, entitlement 100
```

### Test Steps

**Step 2.1: Create meeting via form with manual motions**
- Navigate to `/admin/general-meetings/new`
- Select the WF2 building
- Fill title: `"WF2 Test Meeting-${RUN_SUFFIX}"`
- Set `meeting_at` to 1 hour in the past (so status is "open")
- Set `voting_closes_at` to 1 year in the future
- Add motion 1: title "Motion 1 — Budget", type General
- Add motion 2: title "Motion 2 — Special", type Special
- Submit
- Assert: navigates to `/admin/general-meetings/{id}`
- Assert: status badge shows "Open"

**Step 2.2: Download motion CSV template**
- On the create form, click "Download template"
- Assert: download initiates for `agm_motions_template.csv`

**Step 2.3: Upload motions CSV pre-fills the form**
- Navigate back to `/admin/general-meetings/new`
- Upload a CSV with 3 motions:
  ```
  Motion,Title,Motion Type,Description
  1,Budget Approval,General,Do you approve the annual budget?
  2,Bylaw Amendment,Special,Do you approve the bylaw amendment?
  3,Maintenance Plan,General,Do you approve the maintenance plan?
  ```
- Assert: 3 motion rows appear on the form
- Assert: motion 2 shows "Special" type
- Edit motion 1 title to "Budget Approval (edited)"
- Assert: change is reflected before save
- (Do not save — this test is for the upload pre-fill UX, not the meeting creation API)

**Step 2.4: Meeting appears in list with correct status**
- Navigate to `/admin/general-meetings`
- Assert: the WF2 meeting from Step 2.1 appears in the table
- Assert: status column shows "Open"
- Assert: building column shows the WF2 building name

**Step 2.5: Pending meeting status (meeting_at in the future)**
- Via admin API: close the WF2 meeting
- Via admin API: create a new meeting with `meeting_at` 2 hours in the future
- Navigate to `/admin/general-meetings`
- Assert: new meeting shows "Pending" status
- Navigate to the meeting detail page
- Assert: "Start Meeting" button is visible
- Assert: "Close Voting" button is NOT visible

---

## Workflow 3: Complete Voting Lifecycle — Simple Case

**Purpose:** Three voters, two motion types, one absent voter. Verify exact tallies after close.

**File:** `frontend/e2e/workflows/voting-scenarios.spec.ts`

### Seed Data

```
Building: "WF3 Simple Voting-${RUN_SUFFIX}"
Manager email: "wf3-manager@test.com"

Lot owners:
  WF3-1: email wf3-voter1@test.com, entitlement 100, financial_position normal
  WF3-2: email wf3-voter2@test.com, entitlement  50, financial_position normal
  WF3-3: email wf3-voter3@test.com, entitlement  75, financial_position normal

Total building entitlement: 225

Meeting: "WF3 Simple Meeting-${RUN_SUFFIX}"
  meeting_at: 1 hour ago
  voting_closes_at: 1 year from now

Motions:
  1: "General Motion — Annual Budget"  type: general  order_index: 1
  2: "Special Motion — Bylaw Change"   type: special  order_index: 2
```

### Voting Actions

| Voter | Lot | Entitlement | Motion 1 (General) | Motion 2 (Special) |
|-------|-----|-------------|--------------------|--------------------|
| wf3-voter1@test.com | WF3-1 | 100 | For (yes) | For (yes) |
| wf3-voter2@test.com | WF3-2 |  50 | Against (no) | For (yes) |
| wf3-voter3@test.com | WF3-3 |  75 | (does not vote — absent) | (absent) |

### Expected Tallies After Close

**Motion 1 — Annual Budget (General)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes (For) | 1 | 100 |
| no (Against) | 1 | 50 |
| abstained | 0 | 0 |
| absent | 1 | 75 |
| not_eligible | 0 | 0 |

**Motion 2 — Bylaw Change (Special)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes (For) | 2 | 150 |
| no (Against) | 0 | 0 |
| abstained | 0 | 0 |
| absent | 1 | 75 |
| not_eligible | 0 | 0 |

### Test Steps

**Step 3.1: Seed (beforeAll)**
- Create building, lot owners, meeting via admin API
- Delete any prior ballots

**Step 3.2: Voter 1 votes (UI)**
- Navigate to `/`, select WF3 building
- Click "Enter Voting"
- Auth with lot WF3-1 + email wf3-voter1@test.com
- Land on `/vote/{id}/voting`
- Click "For" on Motion 1; click "For" on Motion 2
- Click "Submit ballot" → confirm dialog → confirm
- Assert: navigates to `/vote/{id}/confirmation`
- Assert: confirmation shows "For" for both motions

**Step 3.3: Voter 2 votes (UI)**
- New page/context: navigate to `/`, select WF3 building
- Auth with lot WF3-2 + email wf3-voter2@test.com
- Land on voting page
- Click "Against" on Motion 1; click "For" on Motion 2
- Submit and confirm
- Assert: confirmation shows "Against" for Motion 1, "For" for Motion 2

**Step 3.4: Voter 3 does not vote**
- No browser action needed — voter 3 never submits

**Step 3.5: Admin closes meeting (via admin API)**
- `POST /api/admin/general-meetings/{id}/close`
- Assert: 200 OK

**Step 3.6: Assert tallies via admin API**
- `GET /api/admin/general-meetings/{id}`
- Parse `motion_details`
- Find Motion 1 by title "General Motion — Annual Budget"
- Assert tally matches the expected table above (exact values)
- Find Motion 2 by title "Special Motion — Bylaw Change"
- Assert tally matches the expected table above

**Step 3.7: Assert tallies via admin UI**
- Navigate to `/admin/general-meetings/{id}`
- Find the Results Report section
- For Motion 1:
  - Assert "For" row shows voter_count=1 and entitlement_sum=100
  - Assert "Against" row shows voter_count=1 and entitlement_sum=50
  - Assert "Absent" row shows voter_count=1 and entitlement_sum=75
- For Motion 2:
  - Assert "For" row shows voter_count=2 and entitlement_sum=150
  - Assert "Absent" row shows voter_count=1 and entitlement_sum=75
- Assert total building entitlement shows 225 (or entitlement percentages are visible if the UI shows them)

**Step 3.8: Admin views voter lists**
- In the Results Report, assert:
  - Motion 1 "For" voter list contains lot WF3-1 with entitlement 100
  - Motion 1 "Against" voter list contains lot WF3-2 with entitlement 50
  - Motion 1 "Absent" voter list contains lot WF3-3 with entitlement 75

---

## Workflow 4: Multi-Lot Voter — Both Lots in One Submission

**Purpose:** Two lots owned by the same email, voted together. Verify tally treats each lot separately.

**File:** `frontend/e2e/workflows/voting-scenarios.spec.ts`

### Seed Data

```
Building: "WF4 Multi-Lot Single-${RUN_SUFFIX}"
Manager email: "wf4-manager@test.com"

Lot owners:
  WF4-A: email wf4-voter@test.com, entitlement  80, financial_position normal
  WF4-B: email wf4-voter@test.com, entitlement  40, financial_position normal

Total building entitlement: 120

Meeting: "WF4 Multi-Lot Meeting-${RUN_SUFFIX}"
Motions:
  1: "Motion 1 — Budget"  type: general  order_index: 1
  2: "Motion 2 — Bylaw"   type: special  order_index: 2
```

### Voting Actions

Voter `wf4-voter@test.com` selects **both lots** and votes:
- Motion 1: For (yes)
- Motion 2: For (yes)

### Expected Tallies After Close

**Motion 1 — Budget (General)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes | 2 | 120 |
| no | 0 | 0 |
| abstained | 0 | 0 |
| absent | 0 | 0 |

**Motion 2 — Bylaw (Special)** — same as Motion 1.

### Test Steps

**Step 4.1: Seed (beforeAll)**

**Step 4.2: Vote both lots in one submission (UI)**
- Navigate to `/`, select WF4 building, "Enter Voting"
- Auth with any lot number field value + email `wf4-voter@test.com`
- Land on `/vote/{id}/voting`
- Assert: lot panel shows both WF4-A and WF4-B, both checked
- Assert: subtitle says "You are voting for 2 lots."
- Vote "For" on both motions
- Submit ballot → confirm
- Assert: navigates to confirmation
- Assert: confirmation shows "Ballot submitted"
- Assert: confirmation shows both lot headings "Lot WF4-A" and "Lot WF4-B"
- Assert: each lot shows "For" for Motion 1 and "For" for Motion 2

**Step 4.3: Close meeting and verify tallies (admin API)**
- `POST /api/admin/general-meetings/{id}/close`
- `GET /api/admin/general-meetings/{id}`
- Motion 1: assert `yes.voter_count = 2`, `yes.entitlement_sum = 120`, `absent.voter_count = 0`
- Motion 2: assert same

**Step 4.4: Assert tallies in admin UI**
- Navigate to `/admin/general-meetings/{id}`
- Results Report: Motion 1 "For" shows 2 lots, entitlement 120

---

## Workflow 5: Multi-Lot Voter — Partial Submission (Two Sessions)

**Purpose:** Same voter submits for one lot, re-authenticates, submits for the second lot. Verify each lot's independent choice is correctly reflected in tallies.

**File:** `frontend/e2e/workflows/voting-scenarios.spec.ts`

### Seed Data

```
Building: "WF5 Partial Submit-${RUN_SUFFIX}"
Manager email: "wf5-manager@test.com"

Lot owners:
  WF5-A: email wf5-voter@test.com, entitlement  60, financial_position normal
  WF5-B: email wf5-voter@test.com, entitlement  30, financial_position normal

Total building entitlement: 90

Meeting: "WF5 Partial Meeting-${RUN_SUFFIX}"
Motions:
  1: "Motion 1 — Budget"  type: general  order_index: 1
  2: "Motion 2 — Bylaw"   type: special  order_index: 2
```

### Voting Actions

| Session | Lot | Motion 1 | Motion 2 |
|---------|-----|----------|----------|
| Session 1 | WF5-A (entitlement 60) | For (yes) | Against (no) |
| Session 2 | WF5-B (entitlement 30) | Abstain (abstained) | For (yes) |

### Expected Tallies After Close

**Motion 1 — Budget (General)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes | 1 | 60 |
| no | 0 | 0 |
| abstained | 1 | 30 |
| absent | 0 | 0 |

**Motion 2 — Bylaw (Special)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes | 1 | 30 |
| no | 1 | 60 |
| abstained | 0 | 0 |
| absent | 0 | 0 |

### Test Steps

**Step 5.1: Seed (beforeAll)**

**Step 5.2: Session 1 — vote WF5-A only (UI)**
- Navigate to `/`, select WF5 building, "Enter Voting"
- Auth with `wf5-voter@test.com`
- Land on voting page — both lots checked by default
- **Uncheck WF5-B** via the sidebar checkbox
- Assert: subtitle says "You are voting for 1 lot."
- Vote "For" on Motion 1, "Against" on Motion 2
- Submit ballot → confirm
- Assert: navigates to confirmation
- Assert: confirmation shows only "Lot WF5-A" (WF5-B not shown — not submitted yet)
- Assert: Motion 1 shows "For", Motion 2 shows "Against"

**Step 5.3: Navigate back and re-authenticate for session 2 (UI)**
- Click "← Back to home"
- Navigate to `/`, select WF5 building, "Enter Voting"
- Auth with `wf5-voter@test.com`
- Land on voting page
- Assert: WF5-A shows "Already submitted" and is disabled
- Assert: WF5-B is checked (pending)
- Assert: subtitle says "You are voting for 1 lot."
- Vote "Abstain" on Motion 1, "For" on Motion 2
- Submit ballot → confirm
- Assert: navigates to confirmation
- Assert: confirmation now shows both "Lot WF5-A" and "Lot WF5-B"

**Step 5.4: Close meeting and verify tallies (admin API)**
- `POST /api/admin/general-meetings/{id}/close`
- `GET /api/admin/general-meetings/{id}`
- Motion 1:
  - `yes.voter_count = 1`, `yes.entitlement_sum = 60`
  - `abstained.voter_count = 1`, `abstained.entitlement_sum = 30`
  - `absent.voter_count = 0`, `absent.entitlement_sum = 0`
- Motion 2:
  - `yes.voter_count = 1`, `yes.entitlement_sum = 30`
  - `no.voter_count = 1`, `no.entitlement_sum = 60`
  - `absent.voter_count = 0`, `absent.entitlement_sum = 0`

---

## Workflow 6: Proxy Voting — Entitlement in Tally

**Purpose:** A proxy voter submits on behalf of a lot. Verify the lot owner's entitlement appears in the tally (not the proxy voter's entitlement), and the DB audit field is set.

**File:** `frontend/e2e/workflows/voting-scenarios.spec.ts`

### Seed Data

```
Building: "WF6 Proxy Tally-${RUN_SUFFIX}"
Manager email: "wf6-manager@test.com"

Lot owners:
  WF6-X: email wf6-owner@test.com, entitlement  60, financial_position normal
         proxy: wf6-proxy@test.com

  WF6-Y: email wf6-other@test.com, entitlement  40, financial_position normal
         (no proxy)

Total building entitlement: 100

Meeting: "WF6 Proxy Meeting-${RUN_SUFFIX}"
Motions:
  1: "Motion 1 — Budget"  type: general  order_index: 1
```

### Voting Actions

| Voter | Auth email | Voting for | Entitlement used | Motion 1 |
|-------|-----------|-----------|-----------------|----------|
| Proxy voter | wf6-proxy@test.com | WF6-X | 60 | For (yes) |
| Direct owner | wf6-other@test.com | WF6-Y | 40 | Against (no) |

### Expected Tallies After Close

**Motion 1 — Budget (General)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes | 1 | 60 |
| no | 1 | 40 |
| abstained | 0 | 0 |
| absent | 0 | 0 |

### Test Steps

**Step 6.1: Seed (beforeAll)**
- Create building, lot owners, meeting via admin API
- Upload proxy nomination CSV: `Lot#,Proxy Email\nWF6-X,wf6-proxy@test.com`
- Delete any prior ballots

**Step 6.2: Proxy voter authenticates and votes (UI)**
- Navigate to `/`, select WF6 building, "Enter Voting"
- Auth with any lot number + email `wf6-proxy@test.com`
- Land on voting page
- Assert: lot panel shows "WF6-X" with "via Proxy" badge
- Assert: WF6-Y is NOT visible (proxy voter is not associated with it)
- Vote "For" on Motion 1
- Submit → confirm
- Assert: confirmation shows "For"

**Step 6.3: WF6-Y direct owner votes (UI)**
- Navigate to `/`, select WF6 building, "Enter Voting"
- Auth with `wf6-other@test.com`
- Vote "Against" on Motion 1
- Submit → confirm

**Step 6.4: Close meeting and verify tallies (admin API)**
- `POST /api/admin/general-meetings/{id}/close`
- `GET /api/admin/general-meetings/{id}`
- Motion 1:
  - `yes.voter_count = 1`, `yes.entitlement_sum = 60` — lot WF6-X's entitlement
  - `no.voter_count = 1`, `no.entitlement_sum = 40`
  - `absent.voter_count = 0`

**Step 6.5: DB audit trail assertion (admin API — voter_lists)**
- Assert: voter_lists.yes contains `{ lot_number: "WF6-X", unit_entitlement: 60 }`
- Note: `proxy_email` is not exposed in the API response — verify only via voter_lists

---

## Workflow 7: In-Arrear Lot — Mixed Selection

**Purpose:** Voter has one normal lot and one in-arrear lot. General Motion vote for in-arrear lot is recorded as `not_eligible`. Special Motion is recorded normally for both lots.

**File:** `frontend/e2e/workflows/voting-scenarios.spec.ts`

### Seed Data

```
Building: "WF7 In-Arrear Mixed-${RUN_SUFFIX}"
Manager email: "wf7-manager@test.com"

Lot owners:
  WF7-A: email wf7-voter@test.com, entitlement  90, financial_position normal
  WF7-B: email wf7-voter@test.com, entitlement  45, financial_position in_arrear

Total building entitlement: 135

Meeting: "WF7 In-Arrear Meeting-${RUN_SUFFIX}"
Motions:
  1: "Motion 1 — General Budget"     type: general  order_index: 1
  2: "Motion 2 — Special Resolution" type: special  order_index: 2
```

### Voting Actions

Voter `wf7-voter@test.com` selects both lots and votes "For" on both motions.

Backend enforcement at submission time:
- WF7-A + Motion 1 (General): recorded as `yes` (normal lot, no restriction)
- WF7-B + Motion 1 (General): recorded as `not_eligible` (in-arrear lot, overrides frontend choice)
- WF7-A + Motion 2 (Special): recorded as `yes`
- WF7-B + Motion 2 (Special): recorded as `yes`

### Expected Tallies After Close

**Motion 1 — General Budget (General)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes | 1 | 90 |
| no | 0 | 0 |
| abstained | 0 | 0 |
| absent | 0 | 0 |
| not_eligible | 1 | 45 |

**Motion 2 — Special Resolution (Special)**

| Category | voter_count | entitlement_sum |
|----------|-------------|-----------------|
| yes | 2 | 135 |
| no | 0 | 0 |
| abstained | 0 | 0 |
| absent | 0 | 0 |
| not_eligible | 0 | 0 |

### Test Steps

**Step 7.1: Seed (beforeAll)**
- Create building, WF7-A (normal), WF7-B (in_arrear), meeting, clear ballots

**Step 7.2: Voter authenticates and sees in-arrear banner (UI)**
- Navigate to `/`, select WF7 building, "Enter Voting"
- Auth with `wf7-voter@test.com`
- Land on voting page with both lots checked
- Assert: amber banner (`data-testid="arrear-banner"`) is visible
- Assert: banner contains text about "in arrear" and "not eligible" for General Motions
- Assert: WF7-B shows "In Arrear" badge in the lot panel
- Assert: vote buttons for Motion 1 (General) are enabled (NOT disabled — frontend does not block)
- Assert: vote buttons for Motion 2 (Special) are enabled

**Step 7.3: Vote "For" on both motions (UI)**
- Click "For" on Motion 1 (General Budget)
- Click "For" on Motion 2 (Special Resolution)
- Submit ballot → confirm
- Assert: navigates to confirmation
- Assert: confirmation shows both lots
- Assert: Motion 1 for WF7-B shows "Not eligible" (backend enforced)
- Assert: Motion 1 for WF7-A shows "For"
- Assert: Motion 2 for both lots shows "For"

**Step 7.4: Close meeting and verify tallies (admin API)**
- `POST /api/admin/general-meetings/{id}/close`
- `GET /api/admin/general-meetings/{id}`
- Motion 1 (General):
  - `yes.voter_count = 1`, `yes.entitlement_sum = 90`
  - `not_eligible.voter_count = 1`, `not_eligible.entitlement_sum = 45`
  - `absent.voter_count = 0`
- Motion 2 (Special):
  - `yes.voter_count = 2`, `yes.entitlement_sum = 135`
  - `not_eligible.voter_count = 0`
  - `absent.voter_count = 0`

**Step 7.5: Admin UI shows not_eligible category**
- Navigate to `/admin/general-meetings/{id}`
- Find Motion 1 in Results Report
- Assert "Not Eligible" row shows voter_count=1, entitlement=45
- Find Motion 2 in Results Report
- Assert "Not Eligible" row shows voter_count=0 (or row is absent/zero)

---

## Workflow 8: Edge Cases

**Purpose:** Cover error conditions and boundary states.

**File:** `frontend/e2e/workflows/edge-cases.spec.ts`

### Seed Data

Each test case within this workflow uses a shared building seeded in `beforeAll`:

```
Building: "WF8 Edge Cases-${RUN_SUFFIX}"
Lot owners:
  WF8-1: email wf8-voter1@test.com, entitlement 10
  WF8-2: email wf8-voter2@test.com, entitlement 10
Meeting seeded fresh per test via API
```

### Edge Case 8.1: Re-authentication after full submission redirects to confirmation

**Steps:**
- Clear ballots; authenticate as wf8-voter1@test.com; vote; submit
- Navigate back to home; re-authenticate with same email
- Assert: URL immediately moves to `/vote/{id}/confirmation` without passing through voting page
- Assert: confirmation shows "Ballot submitted"

### Edge Case 8.2: Voter with all lots submitted sees confirmation directly from home

**Steps:**
- Ensure both lots for wf8-voter1@test.com are submitted (voter1 has only 1 lot — it is already submitted from 8.1)
- From home page, re-select building and click "Enter Voting"
- Auth with wf8-voter1@test.com
- Assert: navigates directly to `/confirmation` without going to `/voting`

### Edge Case 8.3: Voting after meeting closes returns to read-only confirmation

**Steps:**
- Via admin API: close the WF8 meeting
- Navigate to the closed meeting's auth page directly: `/vote/{id}/auth`
- Auth with wf8-voter2@test.com (who never voted)
- Assert: URL navigates to `/vote/{id}/confirmation`
- Assert: confirmation page shows "Ballot submitted" with "Abstained" votes (absent ballot created at close)
- Assert: NO "Submit ballot" button is visible
- Assert: NO "For"/"Against"/"Abstain" vote buttons are visible

### Edge Case 8.4: Wrong credentials return clear error

**Steps:**
- Navigate to auth page for an open WF8 meeting
- Fill lot number "NONEXISTENT-999" + email "nobody@test.com"
- Click "Continue"
- Assert: error message "Lot number and email address do not match our records" is visible
- Assert: URL remains on auth page (no navigation)

### Edge Case 8.5: Building dropdown requires selection before proceeding

**Steps:**
- Navigate to home page `/`
- Do not select a building
- Assert: "Enter Voting" button is not visible
- Select a building
- Assert: meeting list appears

### Edge Case 8.6: Pending meeting cannot be voted on from auth page

**Steps:**
- Via admin API: create a new pending meeting (meeting_at 2 hours in the future) for WF8 building
- On home page, select WF8 building
- Assert: the pending meeting shows "Voting Not Yet Open" button (disabled)
- Assert: "Enter Voting" button is NOT visible for this meeting
- Navigate directly to `/vote/{id}/auth` (force auth against pending meeting)
- Auth with wf8-voter1@test.com
- Assert: navigates to home page `/`
- Assert: informational message about meeting not started is shown

---

## File Structure

### New files to create

```
frontend/e2e/workflows/
  admin-setup.spec.ts       — Workflows 1 and 2
  voting-scenarios.spec.ts  — Workflows 3, 4, 5, 6, 7
  edge-cases.spec.ts        — Workflow 8
```

The new workflow files specifically fill the **tally verification gap** — asserting exact `voter_count` and `entitlement_sum` numbers — which no existing spec does.

---

## Consolidation Plan — Existing Specs

When the new workflow specs ship, the existing specs should be trimmed or retired as described below. The trimming happens in the same PR as the new workflow specs so the net change is: old redundant tests removed, new comprehensive workflow tests added.

### Retire entirely

- `in-arrear-voting.spec.ts` — fully superseded by WF7. Add a `data-testid="in-arrear-notice"` absence check to WF7 Step 7.2 before retiring.

### Trim (delete superseded scenarios, keep unique ones)

- `multi-lot-voting.spec.ts` — retire Scenarios 1 & 2 once WF4/WF5 ship; keep Scenarios 3 & 4 (re-entry UI, "View Submission" path, direct `/voting` navigation after full submission).
- `proxy-voting.spec.ts` — retire Test 1 once WF6 ships; keep Tests 2 & 3 (mixed voter badges, auth isolation).
- `closed-meeting.spec.ts` — retire Test 2 once WF8.3 ships; keep Test 1 (voted voter accessing closed meeting via "View My Submission" from home page).

### Keep as-is (unique coverage not replicated by new workflows)

| File | Why kept |
|------|----------|
| `smoke.spec.ts` | Health checks, login, environment sanity |
| `voting-flow.spec.ts` | Global-setup building smoke test; credentials recovery path |
| `public-summary.spec.ts` | Public summary page (unauthenticated) |
| `pending-meeting.spec.ts` | Pending AGM voter UI + testid regression guards |
| `admin/admin-buildings.spec.ts` | Building CSV import; sidebar navigation |
| `admin/admin-general-meetings.spec.ts` | Close Voting dialog; eligible/submitted counts |
| `admin/admin-lot-owners.spec.ts` | Add lot owner form; buildings CSV seed side-effect |
| `admin/admin-start-meeting.spec.ts` | Start Meeting dialog; status transition negative cases |

---

## Implementation Order

The workflow specs are independent (each uses its own building). They can be implemented and run in any order. The suggested implementation sequence:

1. **Workflow 3** — simplest case, establishes the tally assertion pattern used by all others
2. **Workflow 4 and 5** — extend multi-lot patterns (similar seed/assertion structure)
3. **Workflow 6** — adds proxy nomination to seed; otherwise similar structure
4. **Workflow 7** — adds in-arrear and `not_eligible` category assertion
5. **Workflow 8** — edge cases (mostly API-level, less UI-heavy)
6. **Workflows 1 and 2** — admin setup UX flows (more UI-heavy, lower tally priority)

---

## Helper Functions to Implement

The implementation agent should extract these into a shared `workflows/helpers.ts` (not a Playwright fixture):

### `seedWorkflowBuilding(api, name, managerEmail)`
Creates or finds a building by name. Returns `{ buildingId }`.

### `seedLotOwner(api, buildingId, { lotNumber, emails, entitlement, financialPosition })`
Creates or finds a lot owner. Returns `{ lotOwnerId }`.

### `createMeeting(api, buildingId, title, motions)`
Closes any open/pending meetings for the building, then creates a fresh open meeting. Returns `{ meetingId }`.

### `clearBallots(api, meetingId)`
Calls `DELETE /api/admin/general-meetings/{id}/ballots`. Idempotent.

### `closeMeeting(api, meetingId)`
Calls `POST /api/admin/general-meetings/{id}/close`. Asserts 200.

### `getMeetingTallies(api, meetingId)`
Calls `GET /api/admin/general-meetings/{id}` and returns `{ motionDetails }` — the array of `{ title, tally, voter_lists }` objects.

### `assertTally(tally, expected)`
Asserts that a single motion tally matches an expected `{ yes, no, abstained, absent, not_eligible }` object where each key is `{ voter_count, entitlement_sum }`.

Example usage in a test:
```typescript
const tallies = await getMeetingTallies(api, meetingId);
const motion1 = tallies.find(m => m.title === "Motion 1 — General Budget")!;
assertTally(motion1.tally, {
  yes:          { voter_count: 1, entitlement_sum: 90 },
  no:           { voter_count: 0, entitlement_sum: 0 },
  abstained:    { voter_count: 0, entitlement_sum: 0 },
  absent:       { voter_count: 0, entitlement_sum: 0 },
  not_eligible: { voter_count: 1, entitlement_sum: 45 },
});
```

---

## Auth Helper Pattern

The existing test suite uses a `Lot number` field even though the backend is now email-only. The auth form currently still shows a "Lot number" field for frontend validation. All workflow tests should follow the existing pattern:

```typescript
await page.getByLabel("Lot number").fill(LOT_NUMBER);  // any valid lot for this email
await page.getByLabel("Email address").fill(LOT_EMAIL);
await page.getByRole("button", { name: "Continue" }).click();
```

If the auth form is later changed to email-only, all tests using this pattern will need updating at the same time — flag this in a comment in `helpers.ts`.

---

## Playwright Configuration Notes

- All workflow specs use `test.describe.configure({ mode: "serial" })` within each workflow's `describe` block to ensure setup → vote → verify ordering
- Workflow specs across files can run in parallel (handled by Playwright's worker pool)
- `storageState: path.join(__dirname, "../.auth/admin.json")` for admin API calls (note the extra `../` relative to the `workflows/` subdirectory)
- Use `test.setTimeout(120000)` on tests that involve multiple vote submissions
- `beforeAll` timeout: `{ timeout: 60000 }`

---

## Key Assertions Summary

This table captures the "must pass" assertions that represent the core value of this suite:

| Workflow | What is being verified |
|----------|------------------------|
| WF3 | 3-lot meeting with 1 absent: exact per-motion tallies after close, including absent |
| WF4 | Same-email multi-lot, both voted: voter_count=2, entitlement sums correctly doubled |
| WF5 | Two-session partial: per-lot vote choice independently recorded in correct tally bucket |
| WF6 | Proxy vote: entitlement from lot owner (60), not from proxy voter; voter_list shows correct lot |
| WF7 | In-arrear: `not_eligible.voter_count=1`, `not_eligible.entitlement_sum=45` for General Motion; Special Motion unaffected |
| WF8.3 | Absent ballot created at close: confirmation shows "Abstained", no voting buttons |
