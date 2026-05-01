/**
 * Functional test: Admin "Start Meeting" button for pending AGMs.
 *
 * Verifies:
 * 1. A pending meeting shows a "Start Meeting" button on the detail page.
 * 2. Clicking "Start Meeting" opens a confirmation dialog; confirming it
 *    transitions the meeting to "Open" and hides the button.
 * 3. Open and closed meetings do NOT show the "Start Meeting" button.
 *
 * Self-contained — seeds its own buildings, lot owners, and AGMs via the admin
 * API so it does not interfere with other E2E tests.
 *
 * Each AGM uses a SEPARATE building because the API allows only one
 * active (open/pending) meeting per building at a time.  Tests 1 and 2
 * each get their own pending AGM so parallel execution does not cause
 * test 2's "Start Meeting" click to mutate the meeting that test 1 reads.
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { makeAdminApi } from "../workflows/helpers";

const BUILDING_NAME_PENDING = `E2E Start Meeting Pending Building-${RUN_SUFFIX}`;
const BUILDING_NAME_START = `E2E Start Meeting Start Building-${RUN_SUFFIX}`;
const BUILDING_NAME_OPEN = `E2E Start Meeting Open Building-${RUN_SUFFIX}`;
const BUILDING_NAME_CLOSED = `E2E Start Meeting Closed Building-${RUN_SUFFIX}`;
const AGM_TITLE_PENDING = `E2E Pending Start Test AGM-${RUN_SUFFIX}`;
const AGM_TITLE_START = `E2E Start Action Test AGM-${RUN_SUFFIX}`;
const AGM_TITLE_OPEN = `E2E Open Start Test AGM-${RUN_SUFFIX}`;
const AGM_TITLE_CLOSED = `E2E Closed Start Test AGM-${RUN_SUFFIX}`;

let pendingAgmId = "";
let startAgmId = "";   // used exclusively by the "click Start Meeting" test
let openAgmId = "";
let closedAgmId = "";

test.describe("Admin Start Meeting button", () => {
  // Run tests serially in this describe block to prevent parallel beforeAll
  // calls from competing workers from closing each other's seeded meetings.
  // Also sets a generous suite-level timeout for the heavy seeding in beforeAll.
  test.describe.configure({ mode: "serial", timeout: 120000 });

  test.beforeAll(async () => {
    // Set a generous timeout for the seeding logic which makes multiple API
    // calls against the shared Vercel Lambda (can be slow on cold start).
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await makeAdminApi(baseURL);

    // Helper: create or find a building by name, with retry for transient 500s.
    // On 409 (already exists), re-fetch the list to get the existing ID.
    async function getOrCreateBuilding(name: string, managerEmail: string): Promise<string> {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }

        // Try to find an existing building first
        const listRes = await api.get(`/api/admin/buildings?name=${encodeURIComponent(name)}`);
        if (listRes.ok()) {
          const buildings = (await listRes.json()) as { id: string; name: string }[];
          const existing = buildings.find((b) => b.name === name);
          if (existing) return existing.id;

          // Not found in list — create it
          const createRes = await api.post("/api/admin/buildings", {
            data: { name, manager_email: managerEmail },
          });
          if (createRes.ok()) {
            const b = (await createRes.json()) as { id: string };
            return b.id;
          }
          if (createRes.status() === 409) {
            // Race: building exists — retry the list to get its ID
            continue;
          }
          if (attempt === 2) {
            const body = await createRes.text();
            throw new Error(`Failed to create building "${name}" (${createRes.status()}): ${body}`);
          }
        }
        // List returned 500 — retry
      }
      throw new Error(`Could not create or find building "${name}" after 3 attempts`);
    }

    // Helper: ensure at least one lot owner for a building.
    async function ensureLotOwner(buildingId: string, lotNumber: string, email: string): Promise<void> {
      const listRes = await api.get(`/api/admin/buildings/${buildingId}/lot-owners`);
      if (listRes.ok()) {
        const owners = (await listRes.json()) as { lot_number: string }[];
        if (owners.find((o) => o.lot_number === lotNumber)) return;
      }
      await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: { lot_number: lotNumber, emails: [email], unit_entitlement: 10 },
      });
    }

    // Helper: close all active (open/pending) AGMs for a building.
    // Silently ignores Lambda errors — create will 409 if anything is still active.
    async function closeActiveAgms(buildingId: string): Promise<void> {
      const listRes = await api.get("/api/admin/general-meetings?limit=1000");
      if (!listRes.ok()) return;
      const agms = (await listRes.json()) as { id: string; status: string; building_id: string }[];
      const active = agms.filter(
        (a) => a.building_id === buildingId && (a.status === "open" || a.status === "pending")
      );
      for (const agm of active) {
        await api.post(`/api/admin/general-meetings/${agm.id}/close`);
      }
    }

    // Helper: create an AGM with retry for transient 500s or 409s.
    // Each AGM is on its own building so 409 only occurs if a previous test
    // run left a stale active meeting; closeActiveAgms() handles that.
    async function createAgm(buildingId: string, title: string, meetingAt: Date): Promise<string> {
      const closesAt = new Date();
      closesAt.setFullYear(closesAt.getFullYear() + 1);

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          await closeActiveAgms(buildingId);
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
                display_order: 1,
                motion_type: "general",
              },
            ],
          },
        });

        if (res.ok()) {
          const agm = (await res.json()) as { id: string };
          return agm.id;
        }

        if (attempt === 2) {
          const body = await res.text();
          throw new Error(
            `Failed to create AGM "${title}" after 3 attempts (${res.status()}): ${body}`
          );
        }
      }

      throw new Error("Unreachable");
    }

    // --- Pending AGM (building A — read-only by test 1) ---
    const pendingBuildingId = await getOrCreateBuilding(
      BUILDING_NAME_PENDING,
      "start-pending-mgr@test.com"
    );
    await ensureLotOwner(pendingBuildingId, "SP-1", "start-pending-voter@test.com");
    await closeActiveAgms(pendingBuildingId);
    const pendingMeetingAt = new Date();
    pendingMeetingAt.setHours(pendingMeetingAt.getHours() + 2);
    pendingAgmId = await createAgm(pendingBuildingId, AGM_TITLE_PENDING, pendingMeetingAt);

    // --- Start-action AGM (building B — mutated by test 2's "click Start Meeting") ---
    // Uses a separate building so test 1 and test 2 do not share state when
    // running in parallel with fullyParallel: true.
    const startBuildingId = await getOrCreateBuilding(
      BUILDING_NAME_START,
      "start-action-mgr@test.com"
    );
    await ensureLotOwner(startBuildingId, "SA-1", "start-action-voter@test.com");
    await closeActiveAgms(startBuildingId);
    const startMeetingAt = new Date();
    startMeetingAt.setHours(startMeetingAt.getHours() + 2);
    startAgmId = await createAgm(startBuildingId, AGM_TITLE_START, startMeetingAt);

    // --- Open AGM (building C) ---
    const openBuildingId = await getOrCreateBuilding(
      BUILDING_NAME_OPEN,
      "start-open-mgr@test.com"
    );
    await ensureLotOwner(openBuildingId, "SO-1", "start-open-voter@test.com");
    await closeActiveAgms(openBuildingId);
    const openMeetingAt = new Date();
    openMeetingAt.setHours(openMeetingAt.getHours() - 1);
    openAgmId = await createAgm(openBuildingId, AGM_TITLE_OPEN, openMeetingAt);

    // --- Closed AGM (building D) ---
    const closedBuildingId = await getOrCreateBuilding(
      BUILDING_NAME_CLOSED,
      "start-closed-mgr@test.com"
    );
    await ensureLotOwner(closedBuildingId, "SC-1", "start-closed-voter@test.com");
    await closeActiveAgms(closedBuildingId);
    const closedMeetingAt = new Date();
    closedMeetingAt.setHours(closedMeetingAt.getHours() - 2);
    closedAgmId = await createAgm(closedBuildingId, AGM_TITLE_CLOSED, closedMeetingAt);
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

    // Uses startAgmId (not pendingAgmId) so this test's mutation does not
    // interfere with the read-only "pending meeting shows Start Meeting button" test.
    await page.goto(`/admin/general-meetings/${startAgmId}`);
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
