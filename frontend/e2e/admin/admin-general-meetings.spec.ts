import { test, expect } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  createPendingMeeting,
  closeMeeting,
  clearBallots,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
} from "../workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe("Admin General Meetings", () => {
  test("open General Meeting shows Close Voting button", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings?limit=1000");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const openMeeting = meetings.find((a) => a.status === "open");

    if (!openMeeting) {
      test.skip();
      return;
    }

    // Verify the meeting is still open before navigating — a concurrent test run
    // may have closed it between the list fetch and the navigation.
    const verifyRes = await request.get(`/api/admin/general-meetings/${openMeeting.id}`);
    if (!verifyRes.ok() || (await verifyRes.json() as any).status !== "open") {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${openMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Close Voting" })).toBeVisible({ timeout: 10000 });
  });

  test("Close Voting shows confirmation dialog", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings?limit=1000");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const openMeeting = meetings.find((a) => a.status === "open");

    if (!openMeeting) {
      test.skip();
      return;
    }

    // Verify the meeting is still open before navigating — a concurrent test run
    // may have closed it between the list fetch and the navigation.
    const verifyRes = await request.get(`/api/admin/general-meetings/${openMeeting.id}`);
    if (!verifyRes.ok() || (await verifyRes.json() as any).status !== "open") {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${openMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Close Voting" }).click();
    await expect(page.getByText(/This cannot be undone/)).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Confirm Close" })).toBeVisible();
  });

  test("closed General Meeting does not show Close Voting button", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings?limit=1000");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const closedMeeting = meetings.find((a) => a.status === "closed");

    if (!closedMeeting) {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${closedMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Close Voting" })).not.toBeVisible();
  });

  test("General Meeting detail page shows Results Report section", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings?limit=1000");
    const meetings = await meetingsRes.json() as { id: string }[];
    const meeting = meetings[0];

    await page.goto(`/admin/general-meetings/${meeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Results Report" })).toBeVisible({ timeout: 10000 });
  });

  test("clicking General Meeting row in list navigates to detail", async ({ page }) => {
    await page.goto("/admin/general-meetings");
    // Wait for at least one data row to be visible (not the loading skeleton row)
    // before clicking, so we don't race against the inline table loading state.
    const table = page.getByRole("table");
    await expect(table).toBeVisible({ timeout: 15000 });
    const firstDataRow = table.getByRole("row").nth(1);
    await expect(firstDataRow).toBeVisible({ timeout: 15000 });
    await firstDataRow.click();
    await expect(page).toHaveURL(/\/admin\/general-meetings\/[^/]+$/);
  });
});

// ── New tests: motion type badge, delete meeting, absent count ────────────────

test.describe("Admin General Meetings — motion type badges", () => {
  // No serial needed — single test with its own beforeAll that seeds independent data

  const BUILDING_NAME = `AGM Badge Test Building-${Date.now()}`;
  let buildingId = "";
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    buildingId = await seedBuilding(api, BUILDING_NAME, "badge-mgr@test.com");
    await seedLotOwner(api, buildingId, {
      lotNumber: "BADGE-1",
      emails: ["badge-voter@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, `Badge Test AGM-${Date.now()}`, [
      {
        title: "Motion A — General",
        description: "A general motion for badge test.",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: "Motion B — Special",
        description: "A special resolution for badge test.",
        orderIndex: 2,
        motionType: "special",
      },
    ]);
    await clearBallots(api, meetingId);
    await closeMeeting(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  test("results page shows General badge for first motion and Special badge for second motion", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // First motion: General badge
    await expect(page.getByLabel("Motion type: General").first()).toBeVisible({ timeout: 10000 });

    // Second motion: Special badge
    await expect(page.getByLabel("Motion type: Special").first()).toBeVisible({ timeout: 10000 });
  });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await api.delete(`/api/admin/general-meetings/${meetingId}`);
    await api.dispose();
  });
});

test.describe("Admin General Meetings — delete meeting button", () => {
  // No serial needed — each test creates its own meeting inline and is idempotent

  const BUILDING_NAME = `AGM Delete Test Building-${Date.now()}`;
  let buildingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    buildingId = await seedBuilding(api, BUILDING_NAME, "delete-mgr@test.com");
    await seedLotOwner(api, buildingId, {
      lotNumber: "DEL-1",
      emails: ["del-voter@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await api.dispose();
  }, { timeout: 60000 });

  test("open meeting: Delete Meeting button is NOT visible", async ({ page }) => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const openMeetingId = await createOpenMeeting(api, buildingId, `Delete Test Open AGM-${Date.now()}`, [
      {
        title: "Open Meeting Motion",
        description: "A motion for the open meeting delete test.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);
    await api.dispose();

    await page.goto(`/admin/general-meetings/${openMeetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Delete Meeting" })).not.toBeVisible();
  });

  test("pending meeting: Delete Meeting button is visible and shows 409 error on confirm", async ({
    page,
  }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    // Any pending meeting seeded through this building will have lot weights (from the
    // lot owner seeded in beforeAll) and motions (required by the API), so the backend
    // always returns 409 on delete for pending meetings.
    const pendingMeetingId = await createPendingMeeting(
      api,
      buildingId,
      `Delete Test Pending AGM-${Date.now()}`,
      [
        {
          title: "Pending Meeting Motion",
          description: "A motion for the pending meeting delete test.",
          orderIndex: 1,
          motionType: "general",
        },
      ]
    );
    await api.dispose();

    await page.goto(`/admin/general-meetings/${pendingMeetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Delete Meeting button is visible for pending meetings
    await expect(page.getByRole("button", { name: "Delete Meeting" })).toBeVisible({ timeout: 10000 });

    // Click Delete Meeting to open confirmation modal
    await page.getByRole("button", { name: "Delete Meeting" }).click();
    await expect(page.getByRole("dialog", { name: "Delete Meeting" })).toBeVisible({ timeout: 5000 });

    // Confirm deletion — backend returns 409 because meeting has motions/lot weights
    const deleteDialog = page.getByRole("dialog", { name: "Delete Meeting" });
    await deleteDialog.getByRole("button", { name: "Delete Meeting" }).click();

    // Inline error message should appear inside the modal
    await expect(deleteDialog.getByRole("alert")).toBeVisible({ timeout: 10000 });
    await expect(deleteDialog.getByRole("alert")).toContainText("Cannot delete");

    // Modal stays open — user remains on the meeting detail page
    await expect(page.getByRole("dialog", { name: "Delete Meeting" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/admin\/general-meetings$/, { timeout: 3000 });

    // Cleanup — close the meeting first (lifts the pending guard), then delete
    const cleanupApi = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await cleanupApi.post(`/api/admin/general-meetings/${pendingMeetingId}/close`);
    await cleanupApi.delete(`/api/admin/general-meetings/${pendingMeetingId}`);
    await cleanupApi.dispose();
  });

  test("closed meeting: Delete Meeting button is visible", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const closedMeetingId = await createOpenMeeting(
      api,
      buildingId,
      `Delete Test Closed AGM-${Date.now()}`,
      [
        {
          title: "Closed Meeting Motion",
          description: "A motion for the closed meeting delete test.",
          orderIndex: 1,
          motionType: "general",
        },
      ]
    );
    await closeMeeting(api, closedMeetingId);
    await api.dispose();

    await page.goto(`/admin/general-meetings/${closedMeetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Delete Meeting button is visible for closed meetings
    await expect(page.getByRole("button", { name: "Delete Meeting" })).toBeVisible({ timeout: 10000 });

    // Cleanup — delete the meeting
    const cleanupApi = await playwrightRequest.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173",
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await cleanupApi.delete(`/api/admin/general-meetings/${closedMeetingId}`);
    await cleanupApi.dispose();
  });
});

test.describe("Admin General Meetings — absent count", () => {
  // No serial needed — single test with its own beforeAll that seeds independent data

  const BUILDING_NAME = `AGM Absent Test Building-${Date.now()}`;
  let buildingId = "";
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    buildingId = await seedBuilding(api, BUILDING_NAME, "absent-mgr@test.com");
    // Seed two lot owners — neither will vote, so after close one appears absent
    await seedLotOwner(api, buildingId, {
      lotNumber: "ABS-1",
      emails: ["absent-voter1@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: "ABS-2",
      emails: ["absent-voter2@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, `Absent Test AGM-${Date.now()}`, [
      {
        title: "Absent Test Motion",
        description: "A motion for the absent count test.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);
    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  test("absent count is zero for open meeting; non-zero after close", async ({ page, request }) => {
    test.setTimeout(120000);

    // Open meeting: navigate to detail page
    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // The Absent row should show voter count 0 for an open meeting
    // (backend returns absent_ids = empty set for non-closed meetings)
    // Scope to the tally table (identified by its "Category" column header) to avoid
    // matching motion title rows that also contain the word "Absent".
    const tallyTable = page.locator("table").filter({
      has: page.getByRole("columnheader", { name: "Category" }),
    });
    const absentRow = tallyTable.getByRole("row").filter({ hasText: "Absent" });
    await expect(absentRow).toBeVisible({ timeout: 10000 });
    // Voter count cell: second td in the Absent row
    const absentCountCell = absentRow.getByRole("cell").nth(1);
    await expect(absentCountCell).toHaveText("0", { timeout: 5000 });

    // Close the meeting via API
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await closeMeeting(api, meetingId);
    await api.dispose();

    // Reload the page
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // After close, both lots have no ballots → they are absent
    const tallyTableAfterClose = page.locator("table").filter({
      has: page.getByRole("columnheader", { name: "Category" }),
    });
    const absentRowAfterClose = tallyTableAfterClose.getByRole("row").filter({ hasText: "Absent" });
    await expect(absentRowAfterClose).toBeVisible({ timeout: 10000 });
    const absentCountAfterClose = absentRowAfterClose.getByRole("cell").nth(1);
    // 2 lots, neither voted → absent count should be 2
    await expect(absentCountAfterClose).not.toHaveText("0", { timeout: 5000 });
  });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await api.delete(`/api/admin/general-meetings/${meetingId}`);
    await api.dispose();
  });
});

// ── Admin General Meetings — motion number workflows ──────────────────────────

test.describe("Admin General Meetings — motion number workflows", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING_NAME = `E2E Motion Number Building-${Date.now()}`;
  let buildingId = "";
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    buildingId = await seedBuilding(api, BUILDING_NAME, "mn-mgr@test.com");
    await seedLotOwner(api, buildingId, {
      lotNumber: "MN-1",
      emails: ["mn-voter@test.com"],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    // Create an open meeting with one hidden motion that has motion_number "1"
    meetingId = await createOpenMeeting(api, buildingId, `Test Motion Number AGM-${Date.now()}`, [
      {
        title: "Initial Motion",
        description: "A motion for the motion number test.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    // Set motion_number on the first motion via the API, and ensure it is hidden
    // so the Edit button is enabled (UI requires motion to be hidden before editing).
    const detailRes = await api.get(`/api/admin/general-meetings/${meetingId}`);
    const detail = await detailRes.json() as { motions: { id: string }[] };
    const motionId = detail.motions[0]?.id;
    if (motionId) {
      await api.patch(`/api/admin/motions/${motionId}`, {
        data: { motion_number: "1" },
      });
      // Motions default to is_visible=false, but explicitly set it to ensure
      // the Edit button is enabled (it is disabled when is_visible=true).
      await api.patch(`/api/admin/motions/${motionId}/visibility`, {
        data: { is_visible: false },
      });
    }

    await api.dispose();
  }, { timeout: 60000 });

  // Scenario A — Edit motion number persists
  test("Scenario A: editing motion number to SR-1 persists after page refresh", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Motion must be hidden to enable Edit button
    const editBtn = page.getByRole("button", { name: "Edit" });
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await expect(editBtn).toBeEnabled({ timeout: 5000 });
    await editBtn.click();

    // The edit modal opens — clear the motion number field and type SR-1
    const motionNumberInput = page.getByLabel("Motion number (optional)");
    await expect(motionNumberInput).toBeVisible({ timeout: 5000 });
    await motionNumberInput.fill("");
    await motionNumberInput.fill("SR-1");

    // Save
    await page.getByRole("button", { name: "Save Changes" }).click();

    // Motion table should show SR-1 in the # column without page refresh
    await expect(page.getByRole("cell", { name: "SR-1" })).toBeVisible({ timeout: 10000 });

    // Refresh and assert it persisted
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("cell", { name: "SR-1" })).toBeVisible({ timeout: 10000 });
  });

  // Scenario B — Add motion with motion number
  test("Scenario B: adding a motion with motion number 5a shows in table", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Open the Add Motion dialog
    await page.getByRole("button", { name: "Add Motion" }).click();
    await expect(page.getByRole("dialog", { name: "Add Motion" })).toBeVisible({ timeout: 5000 });

    // Fill in title and motion number
    await page.getByLabel("Title *").fill("Test Motion B");
    await page.getByLabel("Motion number (optional)").fill("5a");

    // Save
    await page.getByRole("button", { name: "Save Motion" }).click();

    // New motion should appear in the table with motion number 5a
    await expect(page.getByRole("cell", { name: "5a" })).toBeVisible({ timeout: 10000 });
  });

  // Scenario C — Motion number cleared stores null (blank)
  test("Scenario C: clearing motion number leaves the column blank", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Find the motion with SR-1 motion_number (from Scenario A) and edit it
    const editBtns = page.getByRole("button", { name: "Edit" });
    await expect(editBtns.first()).toBeVisible({ timeout: 10000 });
    await expect(editBtns.first()).toBeEnabled({ timeout: 5000 });
    await editBtns.first().click();

    // Clear the motion number field
    const motionNumberInput = page.getByLabel("Motion number (optional)");
    await expect(motionNumberInput).toBeVisible({ timeout: 5000 });
    await motionNumberInput.fill("");

    // Save
    await page.getByRole("button", { name: "Save Changes" }).click();

    // The SR-1 cell should no longer be present
    await expect(page.getByRole("cell", { name: "SR-1" })).not.toBeVisible({ timeout: 10000 });
  });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await api.delete(`/api/admin/general-meetings/${meetingId}`);
    await api.dispose();
  });
});

// ── US-TCG-01: Admin hides motion → voter no longer sees it ───────────────────

test.describe("US-TCG-01: admin hides motion — voter no longer sees it on voting page", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING_NAME = `TCG01 Building-${Date.now()}`;
  const LOT_EMAIL = `tcg01-voter-${Date.now()}@test.com`;
  const MOTION1_TITLE = "TCG01 Motion 1 — Always visible";
  const MOTION2_TITLE = "TCG01 Motion 2 — Will be hidden";
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const bId = await seedBuilding(api, BUILDING_NAME, "tcg01-mgr@test.com");
    await seedLotOwner(api, bId, {
      lotNumber: "TCG01-1",
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, bId, `TCG01 Meeting-${Date.now()}`, [
      {
        title: MOTION1_TITLE,
        description: "Always visible motion for TCG01 test.",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "This motion will be hidden by the admin.",
        orderIndex: 2,
        motionType: "general",
      },
    ]);
    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await api.delete(`/api/admin/general-meetings/${meetingId}`);
    await api.dispose();
  });

  test("TCG01.1: voter sees 2 motions before admin hides one", async ({ page }) => {
    test.setTimeout(90000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Both motions must be visible — each motion card has an h3 title
    const motionHeadings = page.getByRole("heading", { level: 3 });
    await expect(motionHeadings).toHaveCount(2, { timeout: 10000 });
  });

  test("TCG01.2: admin hides motion 2 via visibility toggle in admin UI", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${meetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Wait for the motions table to render — the row for Motion 2 is the anchor.
    // Use locator("tr").filter to scope to the table row, not any heading card.
    const motion2Row = page.locator("tr").filter({ hasText: MOTION2_TITLE });
    await expect(motion2Row).toBeVisible({ timeout: 10000 });

    // The visibility toggle is a custom styled checkbox.  The <input> is visually hidden;
    // the clickable element is the <label> wrapper containing the "Visible" span.
    // Use exact: true to scope to the toggle label span only (not the motion title text).
    const visibleLabel = motion2Row.getByText("Visible", { exact: true });
    await expect(visibleLabel).toBeVisible({ timeout: 5000 });
    await visibleLabel.click();

    // After clicking, the toggle label changes to "Hidden" (exact match, not title substring)
    await expect(motion2Row.getByText("Hidden", { exact: true })).toBeVisible({ timeout: 10000 });
    // The underlying checkbox should now be unchecked
    const toggle = motion2Row.getByRole("checkbox");
    await expect(toggle).not.toBeChecked({ timeout: 5000 });
  });

  test("TCG01.3: voter sees only 1 motion card after admin hid motion 2", async ({ page }) => {
    test.setTimeout(90000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Only motion 1 should be visible — exactly one h3 motion heading
    const motionHeadings = page.getByRole("heading", { level: 3 });
    await expect(motionHeadings).toHaveCount(1, { timeout: 10000 });
    await expect(page.getByText(MOTION1_TITLE)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(MOTION2_TITLE)).not.toBeVisible({ timeout: 5000 });
  });
});
