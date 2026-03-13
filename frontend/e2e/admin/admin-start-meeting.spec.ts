/**
 * Functional test: Admin "Start Meeting" button for pending AGMs.
 *
 * Verifies:
 * 1. A pending meeting shows a "Start Meeting" button on the detail page.
 * 2. Clicking "Start Meeting" opens a confirmation dialog; confirming it
 *    transitions the meeting to "Open" and hides the button.
 * 3. Open and closed meetings do NOT show the "Start Meeting" button.
 *
 * Self-contained — seeds its own building, lot owner, and AGMs via the admin
 * API so it does not interfere with other E2E tests.
 */

import { test, expect } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING_NAME = "E2E Admin Start Meeting Test Building";
const AGM_TITLE_PENDING = "E2E Pending Start Test AGM";
const AGM_TITLE_OPEN = "E2E Open Start Test AGM";
const AGM_TITLE_CLOSED = "E2E Closed Start Test AGM";

let pendingAgmId = "";
let openAgmId = "";
let closedAgmId = "";

test.describe("Admin Start Meeting button", () => {
  // Increase hook timeout: seeding requires multiple API calls against the
  // shared Vercel Lambda which can be slow under concurrent load.
  test.describe.configure({ timeout: 120000 });

  test.beforeAll(async () => {
    // Set a generous timeout for the seeding logic which makes multiple API
    // calls against the shared Vercel Lambda (can be slow on cold start).
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, "../.auth/admin.json"),
    });

    // Create or find the building
    const buildingsRes = await api.get("/api/admin/buildings");
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    let building = buildings.find((b) => b.name === BUILDING_NAME);
    if (!building) {
      const res = await api.post("/api/admin/buildings", {
        data: { name: BUILDING_NAME, manager_email: "start-meeting-mgr@test.com" },
      });
      if (!res.ok()) {
        const body = await res.text();
        throw new Error(`Failed to create building (${res.status()}): ${body}`);
      }
      building = (await res.json()) as { id: string; name: string };
    }
    const buildingId = building.id;

    // Ensure at least one lot owner so the building is not empty
    const lotOwnersRes = await api.get(`/api/admin/buildings/${buildingId}/lot-owners`);
    const lotOwners = (await lotOwnersRes.json()) as { lot_number: string }[];
    if (!lotOwners.find((l) => l.lot_number === "START-1")) {
      await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: {
          lot_number: "START-1",
          emails: ["start-voter@test.com"],
          unit_entitlement: 10,
        },
      });
    }

    // Close any active AGMs for this building before creating fresh ones
    const agmsRes = await api.get("/api/admin/general-meetings");
    const agms = (await agmsRes.json()) as {
      id: string;
      status: string;
      building_id: string;
      title: string;
    }[];
    const activeAgms = agms.filter(
      (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
    );
    for (const agm of activeAgms) {
      await api.post(`/api/admin/general-meetings/${agm.id}/close`);
    }

    // Helper to create an AGM with retry logic for transient 500/409 errors
    // (the shared Vercel Lambda can 500 under concurrent load, or a concurrent
    // beforeAll may have created an active meeting before our close step ran)
    async function createAgm(title: string, meetingAt: Date): Promise<string> {
      const closesAt = new Date();
      closesAt.setFullYear(closesAt.getFullYear() + 1);

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          // Wait before retry, and re-close any active meetings that may have appeared
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          const retryAgmsRes = await api.get("/api/admin/general-meetings");
          const retryAgms = (await retryAgmsRes.json()) as {
            id: string;
            status: string;
            building_id: string;
          }[];
          const staleActives = retryAgms.filter(
            (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
          );
          for (const stale of staleActives) {
            await api.post(`/api/admin/general-meetings/${stale.id}/close`);
          }
        }

        const res = await api.post("/api/admin/general-meetings", {
          data: {
            building_id: buildingId,
            title,
            meeting_at: meetingAt.toISOString(),
            voting_closes_at: closesAt.toISOString(),
            motions: [
              {
                title: "Start Test Motion",
                description: "A motion for the start-meeting test.",
                order_index: 1,
                motion_type: "general",
              },
            ],
          },
        });

        if (res.ok()) {
          const agm = (await res.json()) as { id: string };
          return agm.id;
        }

        const body = await res.text();
        if (attempt === 2) {
          throw new Error(`Failed to create AGM "${title}" after 3 attempts (${res.status()}): ${body}`);
        }
        // 500 or 409 — retry after clearing active meetings
      }

      throw new Error(`Unreachable`);
    }

    // Pending AGM: meeting_at 2 hours in the future
    const pendingMeetingAt = new Date();
    pendingMeetingAt.setHours(pendingMeetingAt.getHours() + 2);
    pendingAgmId = await createAgm(AGM_TITLE_PENDING, pendingMeetingAt);

    // Open AGM: meeting_at 1 hour ago
    const openMeetingAt = new Date();
    openMeetingAt.setHours(openMeetingAt.getHours() - 1);
    openAgmId = await createAgm(AGM_TITLE_OPEN, openMeetingAt);

    // Closed AGM: create open, then immediately close it
    const closedMeetingAt = new Date();
    closedMeetingAt.setHours(closedMeetingAt.getHours() - 2);
    closedAgmId = await createAgm(AGM_TITLE_CLOSED, closedMeetingAt);
    await api.post(`/api/admin/general-meetings/${closedAgmId}/close`);

    await api.dispose();
  }, { timeout: 120000 });

  test("pending meeting shows 'Start Meeting' button", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${pendingAgmId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

    // Status badge should read "Pending" — use exact match to avoid strict-mode
    // violations from the meeting title (which also contains "Pending") and
    // the share URL displayed on the page.
    await expect(page.getByText("Pending", { exact: true })).toBeVisible({ timeout: 10000 });

    // "Start Meeting" button must be visible
    await expect(page.getByRole("button", { name: "Start Meeting" })).toBeVisible();
  });

  test("clicking Start Meeting shows confirmation dialog, confirming transitions to Open", async ({
    page,
  }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${pendingAgmId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("button", { name: "Start Meeting" })).toBeVisible({ timeout: 10000 });

    // Click Start Meeting to open the confirmation dialog
    await page.getByRole("button", { name: "Start Meeting" }).click();

    // Dialog must appear with the correct title and body text
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole("heading", { name: "Start Meeting" })).toBeVisible();
    await expect(dialog).toContainText("open voting immediately");

    // Confirm the action
    await dialog.getByRole("button", { name: "Confirm Start" }).click();

    // Dialog should close and the status badge should now read "Open"
    await expect(dialog).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Open", { exact: true })).toBeVisible({ timeout: 15000 });

    // "Start Meeting" button must no longer be visible
    await expect(page.getByRole("button", { name: "Start Meeting" })).not.toBeVisible();

    // "Close Voting" button should now be visible (meeting is open)
    await expect(page.getByRole("button", { name: "Close Voting" })).toBeVisible();
  });

  test("open meeting does NOT show Start Meeting button", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${openAgmId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Open", { exact: true })).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole("button", { name: "Start Meeting" })).not.toBeVisible();
  });

  test("closed meeting does NOT show Start Meeting button", async ({ page }) => {
    test.setTimeout(120000);

    await page.goto(`/admin/general-meetings/${closedAgmId}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Closed", { exact: true })).toBeVisible({ timeout: 10000 });

    await expect(page.getByRole("button", { name: "Start Meeting" })).not.toBeVisible();
  });
});
