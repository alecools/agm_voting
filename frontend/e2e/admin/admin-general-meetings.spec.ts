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
} from "../workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe("Admin General Meetings", () => {
  test("open General Meeting shows Close Voting button", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const openMeeting = meetings.find((a) => a.status === "open");

    if (!openMeeting) {
      test.skip();
      return;
    }

    await page.goto(`/admin/general-meetings/${openMeeting.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Close Voting" })).toBeVisible({ timeout: 10000 });
  });

  test("Close Voting shows confirmation dialog", async ({ page, request }) => {
    const meetingsRes = await request.get("/api/admin/general-meetings");
    const meetings = await meetingsRes.json() as { id: string; status: string }[];
    const openMeeting = meetings.find((a) => a.status === "open");

    if (!openMeeting) {
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
    const meetingsRes = await request.get("/api/admin/general-meetings");
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
    const meetingsRes = await request.get("/api/admin/general-meetings");
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
  test.describe.configure({ mode: "serial" });

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
  test.describe.configure({ mode: "serial" });

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

  test("pending meeting: Delete Meeting button is visible and deletes meeting on confirm", async ({
    page,
  }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
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

    // Accept the confirm dialog and click delete
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Meeting" }).click();

    // Should be redirected to the meetings list
    await expect(page).toHaveURL(/\/admin\/general-meetings$/, { timeout: 15000 });

    // Meeting no longer appears in the list
    await expect(page.getByRole("table")).toBeVisible({ timeout: 15000 });
    const rows = page.getByRole("row");
    await expect(rows.filter({ hasText: pendingMeetingId })).toHaveCount(0);
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
  test.describe.configure({ mode: "serial" });

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
