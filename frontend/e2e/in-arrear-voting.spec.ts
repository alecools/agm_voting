/**
 * Functional test: in-arrear lot owner voting behaviour.
 *
 * Verifies:
 * 1. General motions are shown as "Not eligible (in arrear)" — no vote buttons
 * 2. Special motions show normal Yes/No/Abstain vote buttons
 * 3. After submission, the confirmation page shows not_eligible for the
 *    general motion and the chosen vote for the special motion
 *
 * Self-contained — seeds its own building, lot owner, and AGM via the admin
 * API so it does not interfere with other E2E tests.
 */

import { test, expect } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING_NAME = "E2E In-Arrear Test Building";
const LOT_NUMBER = "ARR-1";
const LOT_EMAIL = "inarrear-e2e@test.com";
const LOT_ENTITLEMENT = 20;
const AGM_TITLE = "E2E In-Arrear Test AGM";

test.describe("In-arrear lot owner voting", () => {
  // Serial mode prevents parallel workers from each running their own beforeAll,
  // which would cause multiple concurrent Lambda cold starts and timeout races.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    // Reuse the admin session created by global-setup
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, ".auth", "admin.json"),
      // 90s timeout to survive Lambda cold starts (default is 30s)
      timeout: 90000,
    });

    // Create or find the building
    const buildingsRes = await api.get("/api/admin/buildings");
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    let building = buildings.find((b) => b.name === BUILDING_NAME);
    if (!building) {
      const res = await api.post("/api/admin/buildings", {
        data: { name: BUILDING_NAME, manager_email: "inarrear-mgr@test.com" },
      });
      building = (await res.json()) as { id: string; name: string };
    }
    const buildingId = building.id;

    // Create or find the in-arrear lot owner
    const lotOwnersRes = await api.get(`/api/admin/buildings/${buildingId}/lot-owners`);
    const lotOwners = (await lotOwnersRes.json()) as {
      id: string;
      lot_number: string;
      emails: string[];
      financial_position: string;
    }[];
    let lo = lotOwners.find((l) => l.lot_number === LOT_NUMBER);
    if (!lo) {
      const res = await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: {
          lot_number: LOT_NUMBER,
          emails: [LOT_EMAIL],
          unit_entitlement: LOT_ENTITLEMENT,
          financial_position: "in_arrear",
        },
      });
      lo = (await res.json()) as { id: string; lot_number: string; emails: string[]; financial_position: string };
    } else {
      if (lo.financial_position !== "in_arrear") {
        await api.patch(`/api/admin/lot-owners/${lo.id}`, {
          data: { financial_position: "in_arrear" },
        });
      }
      if (!lo.emails?.includes(LOT_EMAIL)) {
        await api.post(`/api/admin/lot-owners/${lo.id}/emails`, {
          data: { email: LOT_EMAIL },
        });
      }
    }

    // Close any open AGMs for this building, then create a fresh one
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
            title: "General Motion — Budget Approval",
            description: "Do you approve the annual budget?",
            order_index: 1,
            motion_type: "general",
          },
          {
            title: "Special Motion — Bylaw Amendment",
            description: "Do you approve the bylaw amendment?",
            order_index: 2,
            motion_type: "special",
          },
        ],
      },
    });
    const newAgm = (await createRes.json()) as { id: string };

    // Clear any prior ballots so the test can always vote fresh
    await api.delete(`/api/admin/general-meetings/${newAgm.id}/ballots`);

    await api.dispose();
  }, { timeout: 60000 }); // 60s timeout for API setup

  test("in-arrear lot: general motion blocked, special motion votable, not_eligible recorded", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto("/");

    // Select the in-arrear building
    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    await select.selectOption({ label: BUILDING_NAME });

    // Enter the AGM voting flow
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("button", { name: "Enter Voting" }).first().click();

    // Auth
    await expect(page.getByLabel("Lot number")).toBeVisible();
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Lot number").fill(LOT_NUMBER);
    await page.getByLabel("Email address").fill(LOT_EMAIL);
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled({ timeout: 10000 });
    await page.getByRole("button", { name: "Continue" }).click();

    // Should land on lot-selection or confirmation
    await expect(page).toHaveURL(/vote\/.*\/(lot-selection|confirmation)/, { timeout: 20000 });

    if (page.url().includes("/lot-selection")) {
      await expect(page.getByRole("button", { name: "Start Voting" })).toBeVisible();
      await page.getByRole("button", { name: "Start Voting" }).click();
      await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });
    }

    if (page.url().includes("/voting")) {
      // ── In-arrear notice must be visible ────────────────────────────────
      await expect(page.getByTestId("in-arrear-notice")).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId("in-arrear-notice")).toContainText("in arrear");
      await expect(page.getByTestId("in-arrear-notice")).toContainText(LOT_NUMBER);

      // ── General motion: buttons aria-disabled, shows "Not eligible" label ──
      const motionCards = page.locator(".motion-card");
      await expect(motionCards).toHaveCount(2);

      const generalCard = motionCards.filter({ hasText: "General Motion — Budget Approval" });
      await expect(generalCard.getByTestId("in-arrear-label")).toBeVisible();
      await expect(generalCard.getByTestId("in-arrear-label")).toContainText("Not eligible");
      // Vote buttons are rendered but aria-disabled (not actually clickable for real vote)
      await expect(generalCard.getByRole("button", { name: "For" })).toHaveAttribute("aria-disabled", "true");
      await expect(generalCard.getByRole("button", { name: "Against" })).toHaveAttribute("aria-disabled", "true");

      // ── Special motion: vote buttons are enabled (not aria-disabled) ──────
      const specialCard = motionCards.filter({ hasText: "Special Motion — Bylaw Amendment" });
      await expect(specialCard.getByRole("button", { name: "For" })).toBeVisible();
      await expect(specialCard.getByRole("button", { name: "Against" })).toBeVisible();
      await expect(specialCard.getByRole("button", { name: "Abstain" })).toBeVisible();
      await expect(specialCard.getByRole("button", { name: "For" })).not.toHaveAttribute("aria-disabled");

      // Vote For on the special motion
      await specialCard.getByRole("button", { name: "For" }).click();

      // Submit ballot
      await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible();
      await page.getByRole("button", { name: "Submit ballot" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "Submit ballot" }).last().click();

      await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
    }

    // ── Confirmation: verify recorded votes ─────────────────────────────
    await expect(page.getByText("Your votes", { exact: true })).toBeVisible({ timeout: 15000 });

    // General motion must show "Not eligible" on the confirmation page
    await expect(
      page.getByText(/not.?eligible/i).first()
    ).toBeVisible({ timeout: 10000 });

    // Special motion must show "For" (the label used for "yes" choice)
    await expect(
      page.locator("*").filter({ hasText: "Special Motion — Bylaw Amendment" }).first()
    ).toBeVisible();
    await expect(page.getByText("For").first()).toBeVisible();
  });
});
