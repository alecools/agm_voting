/**
 * Functional test: public AGM summary page.
 *
 * Verifies:
 * 1. The summary page loads and displays AGM details without any authentication
 * 2. An invalid AGM ID shows a "Meeting not found" message
 * 3. A closed AGM's summary page is still accessible
 *
 * Self-contained — seeds its own building, lot owner, and AGM via the admin
 * API so it does not interfere with other E2E tests.
 */

import { test, expect } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING_NAME = "E2E Summary Test Building";
const LOT_NUMBER = "SUM-1";
const LOT_EMAIL = "summary-e2e@test.com";
const LOT_ENTITLEMENT = 15;
const AGM_TITLE = "E2E Summary Test AGM";
const GENERAL_MOTION_TITLE = "General Motion — Budget Approval";
const SPECIAL_MOTION_TITLE = "Special Motion — Bylaw Amendment";

let seededAgmId = "";

test.describe("Public AGM summary page", () => {
  // Serial mode prevents parallel workers from each running their own beforeAll,
  // which would cause multiple concurrent Lambda cold starts and timeout races.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, ".auth", "admin.json"),
    });

    // Create or find the building
    const buildingsRes = await api.get("/api/admin/buildings");
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    let building = buildings.find((b) => b.name === BUILDING_NAME);
    if (!building) {
      const res = await api.post("/api/admin/buildings", {
        data: { name: BUILDING_NAME, manager_email: "summary-mgr@test.com" },
      });
      building = (await res.json()) as { id: string; name: string };
    }
    const buildingId = building.id;

    // Create or find the lot owner
    const lotOwnersRes = await api.get(`/api/admin/buildings/${buildingId}/lot-owners`);
    const lotOwners = (await lotOwnersRes.json()) as {
      id: string;
      lot_number: string;
      emails: string[];
    }[];
    const existingLo = lotOwners.find((l) => l.lot_number === LOT_NUMBER);
    if (!existingLo) {
      await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: {
          lot_number: LOT_NUMBER,
          emails: [LOT_EMAIL],
          unit_entitlement: LOT_ENTITLEMENT,
        },
      });
    } else if (!existingLo.emails?.includes(LOT_EMAIL)) {
      await api.post(`/api/admin/lot-owners/${existingLo.id}/emails`, {
        data: { email: LOT_EMAIL },
      });
    }

    // Close any existing open/pending AGMs for this building, then create a fresh one
    const agmsRes = await api.get("/api/admin/general-meetings");
    const agms = (await agmsRes.json()) as {
      id: string;
      status: string;
      building_id: string;
    }[];
    const openAgms = agms.filter(
      (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
    );
    for (const agm of openAgms) {
      await api.post(`/api/admin/general-meetings/${agm.id}/close`);
    }

    const meetingStarted = new Date();
    meetingStarted.setHours(meetingStarted.getHours() - 1);
    const closesAt = new Date();
    closesAt.setFullYear(closesAt.getFullYear() + 1);

    const createRes = await api.post("/api/admin/general-meetings", {
      data: {
        building_id: buildingId,
        title: AGM_TITLE,
        meeting_at: meetingStarted.toISOString(),
        voting_closes_at: closesAt.toISOString(),
        motions: [
          {
            title: GENERAL_MOTION_TITLE,
            description: "Do you approve the annual budget?",
            order_index: 1,
            motion_type: "general",
          },
          {
            title: SPECIAL_MOTION_TITLE,
            description: "Do you approve the bylaw amendment?",
            order_index: 2,
            motion_type: "special",
          },
        ],
      },
    });
    const newAgm = (await createRes.json()) as { id: string };
    seededAgmId = newAgm.id;

    await api.dispose();
  }, { timeout: 60000 });

  test("summary page loads and displays AGM details without authentication", async ({ page }) => {
    test.setTimeout(120000);

    // Navigate directly — no auth required
    await page.goto(`/general-meeting/${seededAgmId}/summary`);

    // Page title (h1) shows the AGM title
    await expect(page.getByRole("heading", { level: 1 })).toContainText(AGM_TITLE, {
      timeout: 20000,
    });

    // Building name is shown
    await expect(page.getByText(BUILDING_NAME)).toBeVisible();

    // Both motions are visible in order
    const listItems = page.locator("ol li");
    await expect(listItems).toHaveCount(2);

    const firstItem = listItems.nth(0);
    const secondItem = listItems.nth(1);
    await expect(firstItem).toContainText(GENERAL_MOTION_TITLE);
    await expect(secondItem).toContainText(SPECIAL_MOTION_TITLE);

    // Descriptions are shown
    await expect(page.getByText("Do you approve the annual budget?")).toBeVisible();
    await expect(page.getByText("Do you approve the bylaw amendment?")).toBeVisible();

    // Status is shown (open)
    await expect(page.getByText(/open/i)).toBeVisible();
  });

  test("invalid AGM ID shows not-found state", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto("/general-meeting/00000000-0000-0000-0000-000000000000/summary");

    // Component renders "Meeting not found" for a 404 response
    await expect(page.getByText("Meeting not found")).toBeVisible({ timeout: 20000 });
  });

  test("closed AGM summary is still accessible", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    // Close the AGM via admin API
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, ".auth", "admin.json"),
    });
    await api.post(`/api/admin/general-meetings/${seededAgmId}/close`);
    await api.dispose();

    // Navigate to summary — must still load
    await page.goto(`/general-meeting/${seededAgmId}/summary`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText(AGM_TITLE, {
      timeout: 20000,
    });

    // Building name still shown
    await expect(page.getByText(BUILDING_NAME)).toBeVisible();

    // Both motions still visible
    const listItems = page.locator("ol li");
    await expect(listItems).toHaveCount(2);
    await expect(listItems.nth(0)).toContainText(GENERAL_MOTION_TITLE);
    await expect(listItems.nth(1)).toContainText(SPECIAL_MOTION_TITLE);

    // Status now shows closed
    await expect(page.getByText(/closed/i)).toBeVisible();
  });
});
