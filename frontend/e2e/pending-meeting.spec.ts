/**
 * Functional test: voter-facing pending AGM behaviour.
 *
 * Verifies:
 * 1. A pending AGM appears in the building list with a "Voting Not Yet Open"
 *    button (disabled) and no "Enter Voting" CTA.
 * 2. Authenticating against a pending AGM (via direct URL) returns
 *    agm_status: "pending" and redirects the voter back to the home page
 *    with an informational message.
 *
 * Self-contained — seeds its own building, lot owner, and pending AGM via
 * the admin API so it does not interfere with other E2E tests.
 */

import { test, expect } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING_NAME = "E2E Pending Meeting Test Building";
const LOT_NUMBER = "PEND-1";
const LOT_EMAIL = "pending-e2e@test.com";
const LOT_ENTITLEMENT = 10;
const AGM_TITLE = "E2E Pending Test AGM";

let seededAgmId = "";

test.describe("Pending AGM voter-facing behaviour", () => {
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
        data: { name: BUILDING_NAME, manager_email: "pending-mgr@test.com" },
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
    let lo = lotOwners.find((l) => l.lot_number === LOT_NUMBER);
    if (!lo) {
      const res = await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: {
          lot_number: LOT_NUMBER,
          emails: [LOT_EMAIL],
          unit_entitlement: LOT_ENTITLEMENT,
        },
      });
      lo = (await res.json()) as { id: string; lot_number: string; emails: string[] };
    } else if (!lo.emails?.includes(LOT_EMAIL)) {
      await api.post(`/api/admin/lot-owners/${lo.id}/emails`, {
        data: { email: LOT_EMAIL },
      });
    }

    // Close any open/pending AGMs for this building, then create a fresh pending one
    const agmsRes = await api.get("/api/admin/general-meetings");
    const agms = (await agmsRes.json()) as {
      id: string;
      status: string;
      building_id: string;
    }[];
    const activeAgms = agms.filter(
      (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
    );
    for (const agm of activeAgms) {
      await api.post(`/api/admin/general-meetings/${agm.id}/close`);
    }

    // Create a pending AGM: meeting_at 2 hours in the future
    const meetingAt = new Date();
    meetingAt.setHours(meetingAt.getHours() + 2);
    const closesAt = new Date();
    closesAt.setFullYear(closesAt.getFullYear() + 1);

    const createRes = await api.post("/api/admin/general-meetings", {
      data: {
        building_id: buildingId,
        title: AGM_TITLE,
        meeting_at: meetingAt.toISOString(),
        voting_closes_at: closesAt.toISOString(),
        motions: [
          {
            title: "Pending Test Motion",
            description: "A motion for the pending meeting test.",
            order_index: 1,
            motion_type: "general",
          },
        ],
      },
    });
    const newAgm = (await createRes.json()) as { id: string };
    seededAgmId = newAgm.id;

    await api.dispose();
  }, 60000);

  test("pending AGM shows 'Voting Not Yet Open' button, no 'Enter Voting' button", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto("/");

    // Select the building
    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    await select.selectOption({ label: BUILDING_NAME });

    // Wait for the meeting list to load
    await expect(page.getByText(AGM_TITLE)).toBeVisible({ timeout: 15000 });

    // The pending meeting should show the status badge "Pending"
    const agmItem = page.locator("[data-testid^='agm-item-']").filter({ hasText: AGM_TITLE });
    await expect(agmItem).toBeVisible();
    await expect(agmItem.getByTestId("status-badge")).toContainText("Pending");

    // The disabled "Voting Not Yet Open" button must be present
    const notOpenBtn = agmItem.getByRole("button", { name: "Voting Not Yet Open" });
    await expect(notOpenBtn).toBeVisible();
    await expect(notOpenBtn).toBeDisabled();

    // The active "Enter Voting" button must NOT be present
    await expect(agmItem.getByRole("button", { name: "Enter Voting" })).not.toBeVisible();
  });

  test("authenticating against a pending AGM redirects to home with informational message", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Navigate directly to the auth page for the pending AGM
    await page.goto(`/vote/${seededAgmId}/auth`);

    // Wait for the form to load
    await expect(page.getByLabel("Lot number")).toBeVisible({ timeout: 15000 });

    // Submit valid credentials
    await page.getByLabel("Lot number").fill(LOT_NUMBER);
    await page.getByLabel("Email address").fill(LOT_EMAIL);
    await page.getByRole("button", { name: "Continue" }).click();

    // Should be redirected back to the home page
    await expect(page).toHaveURL("/", { timeout: 20000 });

    // An informational message about the meeting not having started must be shown
    const banner = page.getByTestId("pending-message");
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText(/not started yet/i);
  });
});
