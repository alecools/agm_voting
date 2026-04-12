/**
 * Functional test: multi-lot voter journey — re-entry and View Submission path.
 *
 * Scenarios 1 and 2 (vote both lots in one submission; partial submission) have
 * been retired — they are superseded by WF4 and WF5 in
 * e2e/workflows/voting-scenarios.spec.ts, which additionally verify exact tally
 * numbers after close.
 *
 * Remaining scenarios:
 *
 * 3. Re-entry after full submission — all lots show "Already submitted" on the
 *    lot selection screen and auth redirects directly to confirmation.
 *
 * 4. Lot-selection "View Submission" button when all lots are already submitted
 *    (navigate via /voting URL directly).
 *
 * Self-contained — seeds its own building, lot owners, and AGM via the admin
 * API so it does not interfere with other E2E tests.
 */

import { test, expect, RUN_SUFFIX } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { getTestOtp, makeAdminApi } from "./workflows/helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING_NAME = `E2E Multi-Lot Test Building-${RUN_SUFFIX}`;
const LOT_NUMBER_1 = "ML-1";
const LOT_NUMBER_2 = "ML-2";
const LOT_EMAIL = "multi-voter@test.com";
const LOT_ENTITLEMENT_1 = 15;
const LOT_ENTITLEMENT_2 = 25;
const AGM_TITLE = `E2E Multi-Lot Test AGM-${RUN_SUFFIX}`;

// Seeded data shared across scenarios — populated in beforeAll
let meetingId = "";

test.describe("Multi-lot voter journey", () => {
  // Serial mode prevents parallel workers from each running their own beforeAll,
  // which would cause multiple concurrent Lambda cold starts and timeout races.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await makeAdminApi(baseURL);

    // ── Building ──────────────────────────────────────────────────────────
    const buildingsRes = await api.get(`/api/admin/buildings?name=${encodeURIComponent(BUILDING_NAME)}`);
    if (!buildingsRes.ok()) throw new Error(`GET /api/admin/buildings returned ${buildingsRes.status()}: ${await buildingsRes.text()}`);
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    let building = buildings.find((b) => b.name === BUILDING_NAME);
    if (!building) {
      const res = await api.post("/api/admin/buildings", {
        data: { name: BUILDING_NAME, manager_email: "ml-mgr@test.com" },
      });
      building = (await res.json()) as { id: string; name: string };
    }
    const buildingId = building.id;

    // ── Lot owners ────────────────────────────────────────────────────────
    const lotOwnersRes = await api.get(`/api/admin/buildings/${buildingId}/lot-owners`);
    const lotOwners = (await lotOwnersRes.json()) as {
      id: string;
      lot_number: string;
      emails: string[];
      financial_position: string;
    }[];

    // Lot ML-1
    let lo1 = lotOwners.find((l) => l.lot_number === LOT_NUMBER_1);
    if (!lo1) {
      const res = await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: {
          lot_number: LOT_NUMBER_1,
          emails: [LOT_EMAIL],
          unit_entitlement: LOT_ENTITLEMENT_1,
          financial_position: "normal",
        },
      });
      lo1 = (await res.json()) as { id: string; lot_number: string; emails: string[]; financial_position: string };
    } else {
      if (!lo1.emails?.includes(LOT_EMAIL)) {
        await api.post(`/api/admin/lot-owners/${lo1.id}/emails`, {
          data: { email: LOT_EMAIL },
        });
      }
    }

    // Lot ML-2
    let lo2 = lotOwners.find((l) => l.lot_number === LOT_NUMBER_2);
    if (!lo2) {
      const res = await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
        data: {
          lot_number: LOT_NUMBER_2,
          emails: [LOT_EMAIL],
          unit_entitlement: LOT_ENTITLEMENT_2,
          financial_position: "normal",
        },
      });
      lo2 = (await res.json()) as { id: string; lot_number: string; emails: string[]; financial_position: string };
    } else {
      if (!lo2.emails?.includes(LOT_EMAIL)) {
        await api.post(`/api/admin/lot-owners/${lo2.id}/emails`, {
          data: { email: LOT_EMAIL },
        });
      }
    }

    // ── Close any existing open/pending AGMs for this building ─────────────
    const agmsRes = await api.get("/api/admin/general-meetings?limit=1000");
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

    // ── Create a fresh AGM with two motions ────────────────────────────────
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
            title: "Motion 1 — Annual Budget",
            description: "Do you approve the annual budget?",
            display_order: 1,
            motion_type: "general",
          },
          {
            title: "Motion 2 — Special Resolution",
            description: "Do you approve the special resolution?",
            display_order: 2,
            motion_type: "special",
          },
        ],
      },
    });
    const newAgm = (await createRes.json()) as { id: string };
    meetingId = newAgm.id;

    // Clear any prior ballots for a clean slate
    await api.delete(`/api/admin/general-meetings/${meetingId}/ballots`);
    await api.dispose();
  });

  // ── Helper: navigate to the auth page for this AGM ──────────────────────────
  async function goToAuthPage(page: import("@playwright/test").Page) {
    // Clear session cookie so any prior HttpOnly session does not auto-restore
    // and bypass the OTP form. Session tokens are stored in cookies, not localStorage.
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto("/");
    const combobox = page.getByLabel("Select your building");
    await expect(combobox).toBeVisible();
    await combobox.fill(BUILDING_NAME);
    await page.getByRole("option", { name: BUILDING_NAME, exact: true }).click();
    await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("button", { name: "Enter Voting" }).first().click();
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });
  }

  // ── Helper: authenticate with the shared email via OTP flow ─────────────────
  async function authenticate(page: import("@playwright/test").Page) {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: path.join(__dirname, ".auth", "admin.json"), timeout: 60000});
    await page.getByLabel("Email address").fill(LOT_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    const code = await getTestOtp(api, LOT_EMAIL, meetingId);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 4 (regression): lot-selection "View Submission" button when all
  //             lots are already submitted (navigate via lot-selection URL directly)
  // ────────────────────────────────────────────────────────────────────────────
  test("lot-selection shows View Submission and all lots as Already submitted when fully voted", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Ensure both lots have submitted ballots
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, ".auth", "admin.json"),
      // 60s: get_db retries for up to ~55s under pool pressure; 30s default is too short
      timeout: 60000,
    });
    await api.delete(`/api/admin/general-meetings/${meetingId}/ballots`);
    await api.dispose();

    // Authenticate and vote both lots via the normal flow
    await goToAuthPage(page);
    await authenticate(page);
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // No "Start Voting" button — motions are immediately visible

    const cards = page.locator(".motion-card");
    await expect(cards).toHaveCount(2);
    await cards.nth(0).getByRole("button", { name: "For" }).click();
    await cards.nth(1).getByRole("button", { name: "Abstain" }).click();

    await page.getByRole("button", { name: "Submit ballot" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Submit ballot" }).last().click();
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Navigate back to home then re-authenticate
    await page.getByRole("button", { name: "← Back to home" }).click();
    await expect(page).toHaveURL("/", { timeout: 10000 });

    await goToAuthPage(page);
    await authenticate(page);

    // All lots already submitted → AuthPage redirects directly to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your votes", { exact: true })).toBeVisible();

    // Confirm both lot headings visible (multi-lot grouped display)
    await expect(page.getByText(`Lot ${LOT_NUMBER_1}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Lot ${LOT_NUMBER_2}`, { exact: true })).toBeVisible();

    // Navigate directly to /voting to exercise the "all submitted" path via the lot panel
    await page.goto(`/vote/${meetingId}/voting`);
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });

    // Both items show "Already submitted" badge in the sidebar (scoped to avoid mobile drawer duplicate)
    const sidebar = page.locator(".voting-layout__sidebar");
    await expect(sidebar.locator(".lot-selection__item--submitted")).toHaveCount(2);

    // The subtitle says "All lots have been submitted." (scoped to sidebar)
    await expect(sidebar.getByText("All lots have been submitted.")).toBeVisible();

    // "View Submission" button is shown (not "Start Voting")
    await expect(page.getByRole("button", { name: "View Submission" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Voting" })).not.toBeVisible();

    // Clicking "View Submission" navigates to confirmation
    await page.getByRole("button", { name: "View Submission" }).click();
    await expect(page).toHaveURL(/confirmation/, { timeout: 10000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });
});
