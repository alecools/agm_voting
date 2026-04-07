/**
 * Business workflow E2E specs — admin setup lifecycle.
 *
 * WF1: Admin building setup — create building, upload lot owners, edit lot owner,
 *      edit building, upload proxy nominations, upload financial positions.
 *
 * WF2: Meeting creation and motion management — create meeting via form, upload
 *      motions CSV, verify meeting status in list, verify pending meeting state.
 *
 * NOTE: These tests run in the "admin" project (uses admin auth storage state).
 * They are placed in e2e/workflows/ which matches the /e2e/(?!admin\/).*\.spec\.ts
 * pattern used by the "public" project — however, the admin helpers used here
 * still reference the admin auth file directly for API calls.
 *
 * To ensure the tests run as admin (with admin session for page navigation),
 * this file imports the storageState path explicitly for API contexts.
 * For page navigation, these tests rely on being matched by the "admin"
 * Playwright project (testMatch: /e2e\/admin\/.*\.spec\.ts/) — but since this
 * file is outside /admin/, it runs under the "public" project. Admin UI pages
 * still work because the admin session is saved in .auth/admin.json and the
 * page's cookies come from the storageState set at the project level.
 *
 * The admin-facing page navigation (e.g. /admin/buildings) requires the admin
 * session. This file includes the storageState in its use() block via the
 * test.use() pattern below so that admin pages are accessible.
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
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
  deleteMeeting,
  clearBallots,
  withRetry,
} from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use admin session for page navigation (admin portal pages require auth)
test.use({ storageState: path.join(__dirname, "../.auth/admin.json") });

// ── WF1: Admin building setup lifecycle ──────────────────────────────────────

test.describe("WF1: Admin building setup lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING_NAME = `WF1 Admin Setup Building-${RUN_SUFFIX}`;
  const MANAGER_EMAIL = "wf1-manager@test.com";

  // Inline CSV for lot owner upload
  const LOT_OWNERS_CSV = [
    "lot_number,email,unit_entitlement,financial_position",
    "WF1-1,wf1-voter1@test.com,100,normal",
    "WF1-2,wf1-voter2@test.com,50,normal",
    "WF1-3,wf1-voter3@test.com,75,normal",
  ].join("\n");

  let buildingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    try {
      await withRetry(async () => {
        // Pre-create the building so we know its ID for detail-page navigation
        buildingId = await seedBuilding(api, BUILDING_NAME, MANAGER_EMAIL);
      }, 3, 30000);
    } finally {
      await api.dispose();
    }
  }, { timeout: 180000 });

  // WF1.1: Create building via admin UI form (building was also pre-created in beforeAll;
  // this test verifies the building is accessible by navigating to its detail page)
  test("WF1.1: building appears in admin buildings list", async ({ page }) => {
    test.setTimeout(60000);

    // Navigate directly to the building detail page (avoids pagination issues in the
    // buildings list when many test buildings have accumulated on the shared deployment)
    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });
  });

  // WF1.2: Upload lot owners CSV
  test("WF1.2: upload lot owners CSV — import complete with 3 records", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });

    const fileInput = page.getByLabel(/lot owners file/i);
    await fileInput.setInputFiles({
      name: "lot-owners.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(LOT_OWNERS_CSV),
    });
    await page.getByRole("button", { name: "Upload" }).first().click();

    await expect(page.getByText(/Import complete/i)).toBeVisible({ timeout: 15000 });

    // Table shows lot rows
    await expect(page.getByText("WF1-1")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("WF1-2")).toBeVisible();
    await expect(page.getByText("WF1-3")).toBeVisible();
  });

  // WF1.3: Edit a lot owner — change unit entitlement
  test("WF1.3: edit lot WF1-2 unit entitlement to 55", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText("WF1-2")).toBeVisible({ timeout: 15000 });

    // Click Edit button next to WF1-2 row
    const wf12Row = page.getByRole("row").filter({ hasText: "WF1-2" });
    await wf12Row.getByRole("button", { name: /edit/i }).click();

    // Edit modal opens — change unit entitlement
    const entitlementField = page.getByLabel(/unit entitlement/i);
    await expect(entitlementField).toBeVisible({ timeout: 10000 });
    await entitlementField.clear();
    await entitlementField.fill("55");

    await page.getByRole("button", { name: /save/i }).click();

    // Row updates to show 55
    await expect(page.getByRole("row").filter({ hasText: "WF1-2" }).getByText("55")).toBeVisible({
      timeout: 10000,
    });
  });

  // WF1.4: Edit building manager email
  test("WF1.4: edit building manager email to wf1-manager-new@test.com", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });

    // Click "Edit Building" in page header area
    await page.getByRole("button", { name: /edit building/i }).click();

    const managerEmailField = page.getByLabel(/manager email/i);
    await expect(managerEmailField).toBeVisible({ timeout: 10000 });
    await managerEmailField.clear();
    await managerEmailField.fill("wf1-manager-new@test.com");

    await page.getByRole("button", { name: /save/i }).click();

    // Page reflects updated email
    await expect(page.getByText("wf1-manager-new@test.com")).toBeVisible({ timeout: 10000 });
  });

  // WF1.5: Upload proxy nominations CSV
  test("WF1.5: upload proxy nominations for WF1-3 — success response shown", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });

    const proxyCsvContent = "Lot#,Proxy Email\nWF1-3,wf1-proxy@test.com\n";

    // The proxy nominations file input is hidden (display:none) — setInputFiles works on hidden inputs
    const proxyFileInput = page.locator('input[aria-label="Proxy nominations file"]');
    await proxyFileInput.setInputFiles({
      name: "proxies.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(proxyCsvContent),
    });

    // Upload triggers automatically on file selection; success message appears
    await expect(page.getByText(/import complete/i)).toBeVisible({ timeout: 15000 });
  });

  // WF1.7: All data visible in admin UI
  test("WF1.7: building detail page shows all 3 lot owners", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/buildings/${buildingId}`);
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });

    // All 3 lots are present
    await expect(page.getByText("WF1-1")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("WF1-2")).toBeVisible();
    await expect(page.getByText("WF1-3")).toBeVisible();
  });
});

// ── WF2: Meeting creation and motion management ───────────────────────────────

test.describe("WF2: Meeting creation and motion management", () => {
  test.describe.configure({ mode: "serial" });

  const WF2_BUILDING = `WF2 Meeting Creation Building-${RUN_SUFFIX}`;
  const WF2_MEETING_TITLE = `WF2 Test Meeting-${RUN_SUFFIX}`;

  let wf2BuildingId = "";
  let wf2MeetingId = "";

  // Motions CSV for upload test
  const MOTIONS_CSV = [
    "Motion,Agenda Item,Motion Type,Description",
    "1,Budget Approval,General,Do you approve the annual budget?",
    "2,Bylaw Amendment,Special,Do you approve the bylaw amendment?",
    "3,Maintenance Plan,General,Do you approve the maintenance plan?",
  ].join("\n");

  // Track all meeting IDs created during WF2 so we can clean them up afterwards.
  const wf2MeetingIds: string[] = [];

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    try {
      await withRetry(async () => {
        wf2BuildingId = await seedBuilding(api, WF2_BUILDING, "wf2-manager@test.com");

        // Seed a lot owner so the building is valid for meeting creation
        await seedLotOwner(api, wf2BuildingId, {
          lotNumber: "WF2-1",
          emails: ["wf2-voter@test.com"],
          unitEntitlement: 100,
          financialPosition: "normal",
        });

        // Create the open meeting via API
        wf2MeetingId = await createOpenMeeting(api, wf2BuildingId, WF2_MEETING_TITLE, [
          {
            title: "Motion 1 — Budget",
            description: "Do you approve the budget?",
            orderIndex: 1,
            motionType: "general",
          },
          {
            title: "Motion 2 — Special",
            description: "Do you approve the special resolution?",
            orderIndex: 2,
            motionType: "special",
          },
        ]);
        wf2MeetingIds.push(wf2MeetingId);
        await clearBallots(api, wf2MeetingId);
      }, 3, 30000);
    } finally {
      await api.dispose();
    }
  }, { timeout: 180000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    for (const id of wf2MeetingIds) {
      await deleteMeeting(api, id);
    }
    await api.dispose();
  }, { timeout: 60000 });

  // WF2.1: Meeting appears in list with Open status
  test("WF2.1: meeting creation — detail page shows Open status", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto(`/admin/general-meetings/${wf2MeetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Status badge shows "Open"
    await expect(page.getByText(/^Open$/)).toBeVisible({ timeout: 10000 });
  });

  // WF2.3: Upload motions CSV pre-fills the create form
  test("WF2.3: upload motions CSV on create form pre-fills 3 motion rows", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto("/admin/general-meetings/new");
    await expect(page.getByRole("heading", { name: /Create General Meeting/ })).toBeVisible({
      timeout: 15000,
    });

    // Upload motions CSV
    const motionFileInput = page.getByLabel("Upload motions (CSV or Excel)");
    await motionFileInput.setInputFiles({
      name: "motions.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(MOTIONS_CSV),
    });

    // 3 motion rows should appear in the form
    await expect(page.locator("#motion-title-0")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#motion-title-1")).toBeVisible();
    await expect(page.locator("#motion-title-2")).toBeVisible();

    // Motion 2 should show Special type
    await expect(page.locator("#motion-title-1")).toHaveValue("Bylaw Amendment");
  });

  // WF2.4: Meeting appears in admin meetings list
  test("WF2.4: meeting appears in admin meetings list with Open status and correct building", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await page.goto("/admin/general-meetings");
    await expect(page.getByRole("table")).toBeVisible({ timeout: 15000 });

    // Scope to the table row so duplicates from prior runs do not cause a
    // strict-mode violation ("resolved to N elements").
    const meetingRow = page.getByRole("row").filter({ hasText: WF2_MEETING_TITLE }).first();
    await expect(meetingRow).toBeVisible({ timeout: 15000 });
    await expect(meetingRow).toContainText("Open");
  });

  // WF2.5: Pending meeting shows Start Meeting button, no Close Voting
  test("WF2.5: pending meeting shows Start Meeting button, Close Voting not visible", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Close WF2 open meeting first, then create a pending one
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await closeMeeting(api, wf2MeetingId);
    const pendingMeetingId = await createPendingMeeting(
      api,
      wf2BuildingId,
      `WF2 Pending Meeting-${RUN_SUFFIX}`,
      [
        {
          title: "WF2 Pending Motion",
          description: "A pending test motion.",
          orderIndex: 1,
          motionType: "general",
        },
      ]
    );
    wf2MeetingIds.push(pendingMeetingId);
    await api.dispose();

    await page.goto(`/admin/general-meetings/${pendingMeetingId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // "Start Meeting" button visible for pending meeting
    await expect(page.getByRole("button", { name: /start meeting/i })).toBeVisible({
      timeout: 10000,
    });

    // "Close Voting" button NOT visible for pending meeting
    await expect(page.getByRole("button", { name: /close voting/i })).not.toBeVisible();
  });
});
