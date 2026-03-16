/**
 * Business workflow E2E specs — edge cases (WF8).
 *
 * Covers error conditions, boundary states, and negative paths:
 *   WF8.1 — Re-submission blocked after all lots submitted
 *   WF8.2 — All lots submitted → direct to confirmation from home
 *   WF8.3 — Voting after meeting closes → read-only confirmation with absent ballot
 *   WF8.4 — Wrong credentials → clear error message
 *   WF8.5 — Building dropdown requires selection before meeting list appears
 *   WF8.6 — Pending meeting → "Voting Not Yet Open" disabled, auth redirects home
 *
 * Uses a shared building seeded in beforeAll; each sub-test seeds its own
 * meeting as needed via API to remain independent.
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
  clearBallots,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
  submitBallot,
} from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING = `WF8 Edge Cases-${RUN_SUFFIX}`;
const LOT1 = "WF8-1";
const LOT1_EMAIL = `wf8-voter1-${RUN_SUFFIX}@test.com`;
const LOT2 = "WF8-2";
const LOT2_EMAIL = `wf8-voter2-${RUN_SUFFIX}@test.com`;
const MOTION_TITLE = "WF8 Test Motion — Budget";

let buildingId = "";
let openMeetingId = "";

test.describe("WF8: Edge cases", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    buildingId = await seedBuilding(api, BUILDING, "wf8-manager@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: LOT1,
      emails: [LOT1_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT2,
      emails: [LOT2_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    // Create a fresh open meeting
    openMeetingId = await createOpenMeeting(api, buildingId, `WF8 Open Meeting-${RUN_SUFFIX}`, [
      {
        title: MOTION_TITLE,
        description: "A test motion for edge case scenarios.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    // Clear any prior ballots
    await clearBallots(api, openMeetingId);

    await api.dispose();
  }, { timeout: 60000 });

  // ── WF8.1: Re-submission blocked after full submission ─────────────────────
  test("WF8.1: after submitting, re-auth routes to confirmation — no submit button visible", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Clear ballots so we start fresh
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    {
      const adminApi = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });
      await clearBallots(adminApi, openMeetingId);
      await adminApi.dispose();
    }
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    // First session: authenticate and vote
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT1_EMAIL, () => getTestOtp(api, LOT1_EMAIL, openMeetingId));
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(1);
    await motionCards.first().getByRole("button", { name: "For" }).click();
    await submitBallot(page);
    await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // Navigate back to home — go directly to avoid aborting in-flight confirmation requests
    await page.goto("/");
    await expect(page).toHaveURL("/", { timeout: 10000 });

    // Second session: re-authenticate
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT1_EMAIL, () => getTestOtp(api, LOT1_EMAIL, openMeetingId));
    await api.dispose();

    // All lots submitted → AuthPage redirects directly to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // No "Submit ballot" button — cannot re-submit
    await expect(page.getByRole("button", { name: "Submit ballot" })).not.toBeVisible();
  });

  // ── WF8.2: All lots submitted → direct to confirmation from home ───────────
  test("WF8.2: voter with all lots already submitted goes directly to confirmation on re-auth", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // WF8.1 already submitted a ballot for LOT1_EMAIL. Navigate to home and
    // re-auth to trigger the "all submitted" direct-to-confirmation path.
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT1_EMAIL, () => getTestOtp(api, LOT1_EMAIL, openMeetingId));
    await api.dispose();

    // Should land directly on confirmation (not voting)
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your votes", { exact: true })).toBeVisible();
  });

  // ── WF8.3: Voting after meeting closes → read-only confirmation ────────────
  test("WF8.3: voter who never voted accesses closed meeting → confirmation shows absent ballot", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Close the meeting via admin API (LOT2_EMAIL has never voted)
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await closeMeeting(api, openMeetingId);
    // Keep api alive for OTP retrieval
    // Navigate to the closed meeting's auth page directly
    await page.goto(`/vote/${openMeetingId}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Auth as the voter who never voted
    await authenticateVoter(page, LOT2_EMAIL, () => getTestOtp(api, LOT2_EMAIL, openMeetingId));
    await api.dispose();

    // Should be routed to confirmation (closed meeting)
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Absent voter on closed meeting sees "You did not submit a ballot for this meeting."
    await expect(page.getByText("You did not submit a ballot for this meeting.")).toBeVisible({ timeout: 15000 });

    // No voting actions available — meeting is closed
    await expect(page.getByRole("button", { name: "Submit ballot" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "For" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Against" })).not.toBeVisible();
  });

  // ── WF8.4: Wrong credentials → clear error ────────────────────────────────
  test("WF8.4: wrong credentials show error, URL stays on auth page", async ({ page }) => {
    test.setTimeout(60000);

    // Create a new open meeting for this test (previous one was closed)
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const newMeetingId = await createOpenMeeting(api, buildingId, `WF8 Auth Test Meeting-${RUN_SUFFIX}`, [
      {
        title: "WF8.4 Test Motion",
        description: "A motion for the wrong credentials test.",
        orderIndex: 1,
        motionType: "general",
      },
    ]);
    await api.dispose();

    await page.goto(`/vote/${newMeetingId}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Step 1: enter unknown email — request-otp always returns 200 (enumeration protection)
    await page.getByLabel("Email address").fill("nobody@test.com");
    await page.getByRole("button", { name: "Send Verification Code" }).click();

    // Step 2 appears — enter a wrong OTP code
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 10000 });
    await page.getByLabel("Verification code").fill("BADCODE1");
    await page.getByRole("button", { name: "Verify" }).click();

    // Error message appears (invalid OTP)
    await expect(
      page.getByText("Invalid or expired code. Please try again.")
    ).toBeVisible({ timeout: 10000 });

    // URL remains on the auth page
    await expect(page).toHaveURL(/\/auth$/, { timeout: 5000 });
  });

  // ── WF8.5: Building dropdown requires selection ────────────────────────────
  test("WF8.5: no building selected → Enter Voting not visible; select building → meeting list appears", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await page.goto("/");

    // Without selecting a building, "Enter Voting" should not appear
    await expect(page.getByLabel("Select your building")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enter Voting" })).not.toBeVisible();

    // Select the WF8 building → meeting list appears
    await page.getByLabel("Select your building").selectOption({ label: BUILDING });

    // After selection, at least one meeting button should appear
    // (either Enter Voting for an open one, or View My Submission for a closed one)
    await expect(
      page.getByRole("button", { name: /Enter Voting|View My Submission|Voting Not Yet Open/ }).first()
    ).toBeVisible({ timeout: 15000 });
  });

  // ── WF8.6: Pending meeting → disabled button, auth redirects home ──────────
  test("WF8.6: pending meeting shows Voting Not Yet Open button; auth redirects to home", async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Create a fresh pending meeting
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const pendingMeetingId = await createPendingMeeting(
      api,
      buildingId,
      `WF8 Pending Meeting-${RUN_SUFFIX}`,
      [
        {
          title: "WF8.6 Pending Test Motion",
          description: "A motion for the pending meeting test.",
          orderIndex: 1,
          motionType: "general",
        },
      ]
    );
    // Keep api alive for OTP retrieval after pending meeting navigation
    // On home page, select WF8 building — pending meeting shows disabled button
    await page.goto("/");
    await page.getByLabel("Select your building").selectOption({ label: BUILDING });

    const agmItem = page.getByTestId(`agm-item-${pendingMeetingId}`);
    await expect(agmItem).toBeVisible({ timeout: 15000 });

    const notOpenBtn = agmItem.getByRole("button", { name: "Voting Not Yet Open" });
    await expect(notOpenBtn).toBeVisible();
    await expect(notOpenBtn).toBeDisabled();

    // "Enter Voting" button must NOT be present for the pending meeting
    await expect(agmItem.getByRole("button", { name: "Enter Voting" })).not.toBeVisible();

    // Navigate directly to the auth page for the pending meeting
    await page.goto(`/vote/${pendingMeetingId}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Submit valid credentials via OTP flow
    await authenticateVoter(page, LOT1_EMAIL, () => getTestOtp(api, LOT1_EMAIL, pendingMeetingId));
    await api.dispose();

    // Should be redirected back to the home page
    await expect(page).toHaveURL("/", { timeout: 20000 });

    // Informational message about the meeting not having started must be shown
    const banner = page.getByTestId("pending-message");
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText(/not started yet/i);
  });
});
