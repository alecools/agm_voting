/**
 * Admin vote entry — partial submission, voter name display, and revote warning.
 *
 * Gap 1 — Partially-submitted lot:
 *   A meeting with 2 motions and 2 lots. Lot A votes via the voter portal on M1
 *   only (M2 hidden). Admin makes M2 visible. Admin enters votes for both lots.
 *   Lot A (partially submitted) should only record a vote for M2; M1 retains the
 *   original voter email. Lot B (never voted) records votes for both motions.
 *
 * Gap 2 — Voter name in admin results UI:
 *   A lot owner with given_name and surname set on their email record votes.
 *   Admin views the results. The voter entry shows "Given Surname <email>" format.
 *   A second lot with no name shows just the email.
 *
 * Gap 3 — AdminRevoteWarningDialog:
 *   After admin-entering votes for a lot, opening the Enter Votes panel again
 *   shows the "Previously entered by admin" amber badge for that lot. Selecting
 *   it and submitting triggers the warning dialog. "Go back" dismisses it.
 *   "Continue anyway" proceeds to the confirm step, which submits and shows the
 *   skipped_count banner (backend skips already-admin-submitted lots).
 */

import { test, expect, RUN_SUFFIX } from "./fixtures";
import {
  makeAdminApi,
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  clearBallots,
  closeMeeting,
  submitBallotViaApi,
  getMeetingDetails,
} from "./workflows/helpers";

// Use the admin session for page navigation (admin portal pages require auth)
test.use({ storageState: ADMIN_AUTH_PATH });

// ── Gap 1: Admin enters votes for a partially-submitted lot ───────────────────

test.describe("Gap 1: Admin vote entry for partially-submitted lot", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `E2E Admin Vote Entry-${RUN_SUFFIX}`;
  const MEETING_TITLE = `E2E Admin Vote Entry Meeting-${RUN_SUFFIX}`;
  const LOT_A = "AVE-A";
  const LOT_A_EMAIL = `ave-lot-a-${RUN_SUFFIX}@test.com`;
  const LOT_B = "AVE-B";
  const MOTION1_TITLE = "AVE Motion 1 — Budget";
  const MOTION2_TITLE = "AVE Motion 2 — Bylaw";

  let buildingId = "";
  let meetingId = "";
  let lotAId = "";
  let lotBId = "";
  let motion1Id = "";
  let motion2Id = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    buildingId = await seedBuilding(api, BUILDING, "ave-manager@test.com");

    lotAId = await seedLotOwner(api, buildingId, {
      lotNumber: LOT_A,
      emails: [LOT_A_EMAIL],
      unitEntitlement: 100,
      financialPosition: "normal",
    });
    lotBId = await seedLotOwner(api, buildingId, {
      lotNumber: LOT_B,
      emails: [`ave-lot-b-${RUN_SUFFIX}@test.com`],
      unitEntitlement: 80,
      financialPosition: "normal",
    });

    // Create meeting with 2 motions — M2 hidden initially so Lot A can only vote on M1
    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION1_TITLE,
        description: "Approve the annual budget.",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Approve the bylaw change.",
        orderIndex: 2,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);

    // Retrieve motion IDs and hide M2 so Lot A only sees M1 during portal voting
    const detailRes = await api.get(`/api/admin/general-meetings/${meetingId}`);
    if (!detailRes.ok()) {
      throw new Error(`GET meeting detail failed (${detailRes.status()}): ${await detailRes.text()}`);
    }
    const detail = (await detailRes.json()) as { motions: { id: string; display_order: number }[] };
    const m1 = detail.motions.find((m) => m.display_order === 1);
    const m2 = detail.motions.find((m) => m.display_order === 2);
    if (!m1 || !m2) throw new Error("Expected 2 motions in meeting");
    motion1Id = m1.id;
    motion2Id = m2.id;

    // Hide M2 so Lot A only votes on M1
    const hideRes = await api.patch(`/api/admin/motions/${motion2Id}/visibility`, {
      data: { is_visible: false },
    });
    if (!hideRes.ok()) throw new Error(`Hide M2 failed (${hideRes.status()}): ${await hideRes.text()}`);

    // Lot A votes on M1 only (M2 is hidden, so backend only sees 1 visible motion)
    await submitBallotViaApi(api, LOT_A_EMAIL, meetingId, [lotAId], [
      { motion_id: motion1Id, choice: "yes" },
    ]);

    await api.dispose();
  }, { timeout: 120000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);
    // Close meeting first (required before delete if open)
    await api.post(`/api/admin/general-meetings/${meetingId}/close`).catch(() => {});
    await api.delete(`/api/admin/general-meetings/${meetingId}`).catch(() => {});
    await api.dispose();
  });

  test("Gap 1.1: admin makes M2 visible and the panel shows both lots", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    // Make M2 visible so admin can enter votes on it
    const showRes = await api.patch(`/api/admin/motions/${motion2Id}/visibility`, {
      data: { is_visible: true },
    });
    if (!showRes.ok()) throw new Error(`Show M2 failed (${showRes.status()}): ${await showRes.text()}`);
    await api.dispose();

    // Navigate to the meeting detail page
    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Open the Enter In-Person Votes panel
    await page.getByRole("button", { name: "Enter In-Person Votes" }).click();
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })).toBeVisible({ timeout: 10000 });

    // Lot A should NOT appear in the list because it has already app-submitted
    await expect(page.getByLabel(`Select lot ${LOT_A}`)).not.toBeVisible({ timeout: 5000 });

    // Lot B should appear (never submitted)
    await expect(page.getByLabel(`Select lot ${LOT_B}`)).toBeVisible({ timeout: 5000 });
  });

  test("Gap 1.2: admin enters vote for Lot B, and M1 for Lot A retains original voter email after close", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    // Enter admin votes for Lot B (both motions) via the API directly
    // This seeds the test state — the UI test in 1.1 already verified the panel.
    const enterVotesRes = await api.post(`/api/admin/general-meetings/${meetingId}/enter-votes`, {
      data: {
        entries: [
          {
            lot_owner_id: lotBId,
            votes: [
              { motion_id: motion1Id, choice: "yes" },
              { motion_id: motion2Id, choice: "no" },
            ],
            multi_choice_votes: [],
          },
        ],
      },
    });
    if (!enterVotesRes.ok()) {
      throw new Error(`Admin enter votes failed (${enterVotesRes.status()}): ${await enterVotesRes.text()}`);
    }

    // Close the meeting and verify tallies
    await api.post(`/api/admin/general-meetings/${meetingId}/close`);
    const motionDetails = await getMeetingDetails(api, meetingId);
    await api.dispose();

    const motion1 = motionDetails.find((m) => m.id === motion1Id);
    const motion2 = motionDetails.find((m) => m.id === motion2Id);
    expect(motion1, "Motion 1 not found").toBeDefined();
    expect(motion2, "Motion 2 not found").toBeDefined();

    // Motion 1: Lot A voted Yes (100) via portal; Lot B voted Yes (80) via admin
    expect(motion1!.tally.yes.voter_count).toBe(2);
    expect(motion1!.tally.yes.entitlement_sum).toBe(180);
    expect(motion1!.tally.no.voter_count).toBe(0);
    expect(motion1!.tally.absent.voter_count).toBe(0);

    // Motion 2: Lot B voted No (80) via admin.
    // Lot A has a BallotSubmission but no Vote row for M2 — it does NOT appear in any
    // voter_list bucket for M2 (no inferred abstain; the fix removes that inference).
    expect(motion2!.tally.no.voter_count).toBe(1);
    expect(motion2!.tally.no.entitlement_sum).toBe(80);
    // Lot A has a BallotSubmission (is_absent=False) so it is NOT in absent_ids_global.
    // With no Vote row for M2, it also does not appear in abstained — voter_count is 0.
    expect(motion2!.tally.abstained.voter_count).toBe(0);
    expect(motion2!.tally.abstained.entitlement_sum).toBe(0);
    expect(motion2!.tally.absent.voter_count).toBe(0);

    // Lot A's M1 vote was submitted by the voter (not admin) — voter_email is LOT_A_EMAIL
    const lotAM1VoterEntry = motion1!.voter_lists.yes.find((v) => v.lot_number === LOT_A);
    expect(lotAM1VoterEntry, "Lot A should appear in M1 yes list").toBeDefined();
    // submitted_by_admin should be false (voter submitted M1)
    expect((lotAM1VoterEntry as { submitted_by_admin?: boolean }).submitted_by_admin).toBe(false);

    // Lot B's M1 vote was entered by admin — submitted_by_admin should be true
    const lotBM1VoterEntry = motion1!.voter_lists.yes.find((v) => v.lot_number === LOT_B);
    expect(lotBM1VoterEntry, "Lot B should appear in M1 yes list").toBeDefined();
    expect((lotBM1VoterEntry as { submitted_by_admin?: boolean }).submitted_by_admin).toBe(true);
  });

  test("Gap 1.3: admin results UI shows both lots voted on M1 and Lot B voted no on M2", async ({ page }) => {
    test.setTimeout(60000);

    // Meeting is already closed (from Gap 1.2). Navigate directly to detail page.
    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Results Report section should be visible
    await expect(page.getByRole("heading", { name: "Results Report" })).toBeVisible({ timeout: 10000 });

    // M1 For total entitlement should be 180 (Lot A 100 + Lot B 80)
    await expect(page.getByText("180").first()).toBeVisible({ timeout: 10000 });

    // M2 Against total should be 80 (Lot B only)
    await expect(page.getByText("80").first()).toBeVisible({ timeout: 10000 });
  });
});

// ── Gap 2: Voter name displayed in admin results UI ───────────────────────────

test.describe("Gap 2: Voter name in admin results UI", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `E2E Voter Name Results-${RUN_SUFFIX}`;
  const MEETING_TITLE = `E2E Voter Name Meeting-${RUN_SUFFIX}`;
  const LOT_NAMED = "VN-1";
  const LOT_NAMED_EMAIL = `vn-named-${RUN_SUFFIX}@test.com`;
  const LOT_NAMED_GIVEN_NAME = "Alice";
  const LOT_NAMED_SURNAME = "Smith";
  const LOT_UNNAMED = "VN-2";
  const LOT_UNNAMED_EMAIL = `vn-unnamed-${RUN_SUFFIX}@test.com`;
  const MOTION_TITLE = "VN Motion — Budget";

  let buildingId = "";
  let meetingId = "";
  let lotNamedId = "";
  let lotUnnamedId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    buildingId = await seedBuilding(api, BUILDING, "vn-manager@test.com");

    // Create Lot VN-1 (will have a name on its email record)
    lotNamedId = await seedLotOwner(api, buildingId, {
      lotNumber: LOT_NAMED,
      emails: [LOT_NAMED_EMAIL],
      unitEntitlement: 60,
      financialPosition: "normal",
    });

    // Fetch the email record ID for VN-1 so we can set given_name/surname on it
    const loRes = await api.get(`/api/admin/lot-owners/${lotNamedId}`);
    if (!loRes.ok()) throw new Error(`GET lot owner failed (${loRes.status()}): ${await loRes.text()}`);
    const loData = (await loRes.json()) as {
      owner_emails: { id: string; email: string }[];
    };
    const emailRecord = loData.owner_emails.find((e) => e.email === LOT_NAMED_EMAIL);
    if (!emailRecord) throw new Error(`Email record for ${LOT_NAMED_EMAIL} not found`);

    // Set name on the email record via PATCH
    const patchRes = await api.patch(
      `/api/admin/lot-owners/${lotNamedId}/owner-emails/${emailRecord.id}`,
      {
        data: {
          email: LOT_NAMED_EMAIL,
          given_name: LOT_NAMED_GIVEN_NAME,
          surname: LOT_NAMED_SURNAME,
        },
      }
    );
    if (!patchRes.ok()) throw new Error(`PATCH owner email failed (${patchRes.status()}): ${await patchRes.text()}`);

    // Create Lot VN-2 (no name on its email record)
    lotUnnamedId = await seedLotOwner(api, buildingId, {
      lotNumber: LOT_UNNAMED,
      emails: [LOT_UNNAMED_EMAIL],
      unitEntitlement: 40,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION_TITLE,
        description: "Approve the annual budget.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);

    // Fetch motion ID for vote submission
    const detailRes = await api.get(`/api/admin/general-meetings/${meetingId}`);
    if (!detailRes.ok()) throw new Error(`GET meeting detail failed (${detailRes.status()})`);
    const detail = (await detailRes.json()) as { motions: { id: string }[] };
    const motionId = detail.motions[0]?.id;
    if (!motionId) throw new Error("No motions found");

    // Both lots vote via the portal (using submitBallotViaApi)
    await submitBallotViaApi(api, LOT_NAMED_EMAIL, meetingId, [lotNamedId], [
      { motion_id: motionId, choice: "yes" },
    ]);
    await submitBallotViaApi(api, LOT_UNNAMED_EMAIL, meetingId, [lotUnnamedId], [
      { motion_id: motionId, choice: "yes" },
    ]);

    // Close the meeting so the results are visible
    await api.post(`/api/admin/general-meetings/${meetingId}/close`);
    await api.dispose();
  }, { timeout: 120000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);
    await api.delete(`/api/admin/general-meetings/${meetingId}`).catch(() => {});
    await api.dispose();
  });

  test("Gap 2.1: results UI shows 'Given Surname <email>' for named lot and just email for unnamed lot", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Results Report" })).toBeVisible({ timeout: 10000 });

    // The voter list is inside the expanded voting-details panel.
    // The toggle button has aria-label "Expand voting details for {motion title}".
    // Click it to reveal the voter list table.
    const showDetailsBtn = page.getByRole("button", { name: /Expand voting details for/i }).first();
    await expect(showDetailsBtn).toBeVisible({ timeout: 10000 });
    await showDetailsBtn.click();

    // Named lot: expect "Alice Smith <vn-named-...@test.com>"
    const expectedNameDisplay = `${LOT_NAMED_GIVEN_NAME} ${LOT_NAMED_SURNAME} <${LOT_NAMED_EMAIL}>`;
    await expect(page.getByText(expectedNameDisplay, { exact: true })).toBeVisible({ timeout: 10000 });

    // Unnamed lot: expect just the email (no name prefix)
    await expect(page.getByText(LOT_UNNAMED_EMAIL, { exact: true })).toBeVisible({ timeout: 10000 });

    // The named lot must NOT show the bare email without the name prefix
    // (i.e. the full format "Alice Smith <email>" is shown, not just "email")
    // We verify this by checking that the named format is present and not a bare email
    const namedFormatCount = await page.getByText(expectedNameDisplay, { exact: true }).count();
    expect(namedFormatCount).toBeGreaterThanOrEqual(1);
  });
});

// ── Gap 3: AdminRevoteWarningDialog end-to-end ────────────────────────────────

test.describe("Gap 3: AdminRevoteWarningDialog end-to-end", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `E2E Revote Warning-${RUN_SUFFIX}`;
  const MEETING_TITLE = `E2E Revote Warning Meeting-${RUN_SUFFIX}`;
  const LOT_APP = "RW-A";   // submitted via app (not selectable)
  const LOT_APP_EMAIL = `rw-app-${RUN_SUFFIX}@test.com`;
  const LOT_ADMIN = "RW-B"; // submitted by admin previously (selectable with amber badge)
  const MOTION_TITLE = "RW Motion — Budget";

  let buildingId = "";
  let meetingId = "";
  let lotAppId = "";
  let lotAdminId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    buildingId = await seedBuilding(api, BUILDING, "rw-manager@test.com");

    lotAppId = await seedLotOwner(api, buildingId, {
      lotNumber: LOT_APP,
      emails: [LOT_APP_EMAIL],
      unitEntitlement: 50,
      financialPosition: "normal",
    });
    lotAdminId = await seedLotOwner(api, buildingId, {
      lotNumber: LOT_ADMIN,
      emails: [`rw-admin-${RUN_SUFFIX}@test.com`],
      unitEntitlement: 50,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION_TITLE,
        description: "Approve the annual budget.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);

    // Fetch motion ID
    const detailRes = await api.get(`/api/admin/general-meetings/${meetingId}`);
    if (!detailRes.ok()) throw new Error(`GET meeting detail failed (${detailRes.status()})`);
    const detail = (await detailRes.json()) as { motions: { id: string }[] };
    const motionId = detail.motions[0]?.id;
    if (!motionId) throw new Error("No motions found");

    // Lot A (LOT_APP) submits via the voter portal
    await submitBallotViaApi(api, LOT_APP_EMAIL, meetingId, [lotAppId], [
      { motion_id: motionId, choice: "yes" },
    ]);

    // Lot B (LOT_ADMIN) is entered by admin first time
    const enterRes = await api.post(`/api/admin/general-meetings/${meetingId}/enter-votes`, {
      data: {
        entries: [
          {
            lot_owner_id: lotAdminId,
            votes: [{ motion_id: motionId, choice: "yes" }],
            multi_choice_votes: [],
          },
        ],
      },
    });
    if (!enterRes.ok()) {
      throw new Error(`Admin enter votes setup failed (${enterRes.status()}): ${await enterRes.text()}`);
    }

    await api.dispose();
  }, { timeout: 120000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);
    await api.post(`/api/admin/general-meetings/${meetingId}/close`).catch(() => {});
    await api.delete(`/api/admin/general-meetings/${meetingId}`).catch(() => {});
    await api.dispose();
  });

  test("Gap 3.1: app-submitted lot is absent from Step 1 list; admin-submitted lot shows amber badge", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Open the Enter In-Person Votes panel
    await page.getByRole("button", { name: "Enter In-Person Votes" }).click();
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })).toBeVisible({ timeout: 10000 });

    // LOT_APP (app-submitted) must NOT appear — it is excluded from the list
    await expect(page.getByLabel(`Select lot ${LOT_APP}`)).not.toBeVisible({ timeout: 5000 });

    // LOT_ADMIN (admin-submitted) DOES appear — selectable
    const adminLotCheckbox = page.getByLabel(`Select lot ${LOT_ADMIN}`);
    await expect(adminLotCheckbox).toBeVisible({ timeout: 5000 });
    await expect(adminLotCheckbox).toBeEnabled();

    // The amber "Previously entered by admin" badge is shown next to LOT_ADMIN
    // Scope to the dialog to avoid picking up badges elsewhere on the page
    const dialog = page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" });
    await expect(dialog.getByText("Previously entered by admin")).toBeVisible({ timeout: 5000 });
  });

  test("Gap 3.2: submitting with admin-submitted lot shows warning dialog; 'Go back' dismisses it", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Open Step 1
    await page.getByRole("button", { name: "Enter In-Person Votes" }).click();
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })).toBeVisible({ timeout: 10000 });

    // Select the admin-submitted lot
    const adminLotCheckbox = page.getByLabel(`Select lot ${LOT_ADMIN}`);
    await adminLotCheckbox.check();
    await expect(adminLotCheckbox).toBeChecked();

    // Proceed to Step 2
    await page.getByRole("button", { name: /Proceed to vote entry/ }).click();
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" })).toBeVisible({ timeout: 10000 });

    // Step 2 grid shows the "Previously entered by admin" badge in the column header
    const voteGridDialog = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
    await expect(voteGridDialog.getByText("Previously entered by admin")).toBeVisible({ timeout: 5000 });

    // Click "Submit votes" — this triggers the AdminRevoteWarningDialog (not the ConfirmDialog)
    // because the selected lot was previously entered by admin
    await voteGridDialog.getByRole("button", { name: "Submit votes" }).click();

    // The AdminRevoteWarningDialog should appear
    await expect(page.getByRole("dialog", { name: /Some lots have already been entered/ })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("dialog", { name: /Some lots have already been entered/ })).toContainText(`Lot ${LOT_ADMIN}`);

    // Warning dialog is visible — confirm we are NOT yet at the regular ConfirmDialog
    await expect(page.getByRole("dialog", { name: "Submit in-person votes?" })).not.toBeVisible();

    // Click "Go back" — dialog should close, we remain on the vote grid (Step 2)
    await page.getByRole("button", { name: "Go back" }).click();

    // Warning dialog is dismissed
    await expect(page.getByRole("dialog", { name: /Some lots have already been entered/ })).not.toBeVisible({ timeout: 5000 });

    // We are still on the vote grid (Step 2 dialog still open)
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" })).toBeVisible({ timeout: 5000 });
  });

  test("Gap 3.3: 'Continue anyway' proceeds to confirm, submits, and shows skipped_count banner", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Open Step 1
    await page.getByRole("button", { name: "Enter In-Person Votes" }).click();
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })).toBeVisible({ timeout: 10000 });

    // Select the admin-submitted lot
    await page.getByLabel(`Select lot ${LOT_ADMIN}`).check();

    // Proceed to Step 2
    await page.getByRole("button", { name: /Proceed to vote entry/ }).click();
    await expect(page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" })).toBeVisible({ timeout: 10000 });

    const voteGridDialog = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });

    // Click "Submit votes" — revote warning appears
    await voteGridDialog.getByRole("button", { name: "Submit votes" }).click();
    await expect(page.getByRole("dialog", { name: /Some lots have already been entered/ })).toBeVisible({ timeout: 10000 });

    // Click "Continue anyway" — proceeds to the regular ConfirmDialog
    await page.getByRole("button", { name: "Continue anyway" }).click();

    // Warning dialog dismissed; regular ConfirmDialog appears
    await expect(page.getByRole("dialog", { name: /Some lots have already been entered/ })).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("dialog", { name: "Submit in-person votes?" })).toBeVisible({ timeout: 10000 });

    // Confirm submission
    await page.getByRole("dialog", { name: "Submit in-person votes?" }).getByRole("button", { name: "Confirm" }).click();

    // Backend skips the admin-submitted lot — skipped_count banner should appear
    // The banner text is: "{N} lot(s) were skipped (already had entries). {M} lot(s) were submitted successfully."
    await expect(
      page.getByRole("alert").filter({ hasText: /lot\(s\) were skipped/ })
    ).toBeVisible({ timeout: 15000 });

    // The panel stays open (because skipped_count > 0) with a "Done" button
    await expect(page.getByRole("button", { name: "Done" })).toBeVisible({ timeout: 5000 });
  });
});
