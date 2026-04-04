/**
 * US-TCG-06 / RR2-08: E2E test — voter confirmation receipt is vote-driven,
 * not filtered by current motion visibility.
 *
 * Backend fix (RR2-08): get_my_ballot now queries from Vote records instead
 * of filtering by Motion.is_visible, so the confirmation receipt is immutable
 * from the voter's perspective.
 *
 * Note: The backend correctly rejects hiding a motion that already has
 * submitted votes (409).  To exercise the vote-driven receipt path E2E, this
 * test verifies that ALL voted motions appear in the confirmation after the
 * meeting is closed — the closed state does not suppress any vote from the
 * receipt.  The backend integration test (test_phase2_api.py::
 * TestMyBallotHiddenMotions::test_voted_motion_appears_after_being_hidden...)
 * covers the exact hide-after-vote scenario at the API level.
 *
 * Scenario:
 *   1. Seed meeting with 2 visible motions and 1 lot owner.
 *   2. Voter votes on both motions and submits.
 *   3. Admin closes the meeting.
 *   4. Voter re-authenticates via direct URL (closed meeting -> confirmation route).
 *   5. Assert: BOTH motion 1 and motion 2 appear in the confirmation receipt.
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  clearBallots,
  closeMeeting,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
  submitBallot,
  deleteMeeting,
} from "../workflows/helpers";

const BUILDING = `TCG06 Building-${RUN_SUFFIX}`;
const VOTER_EMAIL = `tcg06-voter-${RUN_SUFFIX}@test.com`;
const MOTION1_TITLE = "TCG06 Motion 1 — General budget";
const MOTION2_TITLE = "TCG06 Motion 2 — Bylaw change";

let meetingId = "";

test.describe("US-TCG-06: confirmation receipt shows all voted motions after meeting closes", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, `tcg06-mgr-${RUN_SUFFIX}@test.com`);

    await seedLotOwner(api, buildingId, {
      lotNumber: "TCG06-1",
      emails: [VOTER_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, `TCG06 Meeting-${RUN_SUFFIX}`, [
      {
        title: MOTION1_TITLE,
        description: "First motion — general.",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Second motion — special.",
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
    await deleteMeeting(api, meetingId);
    await api.dispose();
  }, { timeout: 30000 });

  // -- Step 1: voter votes on both motions and submits

  test("TCG06.1: voter votes on both motions and submits ballot", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Both motions visible — each card has a data-testid="motion-card-<uuid>"
    const allCards = page.locator("[data-testid^='motion-card-']");
    await expect(allCards).toHaveCount(2, { timeout: 10000 });
    // Filter each card by title text, then click its vote button
    const motion1Card = allCards.filter({ hasText: MOTION1_TITLE });
    const motion2Card = allCards.filter({ hasText: MOTION2_TITLE });
    await motion1Card.getByRole("button", { name: "For" }).click();
    await motion2Card.getByRole("button", { name: "Against" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // -- Step 2: admin closes the meeting

  test("TCG06.2: admin closes the meeting", async () => {
    test.setTimeout(30000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await closeMeeting(api, meetingId);
    await api.dispose();
  });

  // -- Step 3: voter re-auth shows both motions in confirmation

  test("TCG06.3: voter confirmation receipt shows both voted motions after close", async ({ page }) => {
    test.setTimeout(90000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Navigate directly to auth for the closed meeting (not via home-page dropdown).
    // Clear only the session cookie -- clearing all would remove the Vercel bypass cookie.
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${meetingId}/auth`);

    // Wait for auth URL to stabilise (session restore for closed meeting returns 401)
    await expect(page).toHaveURL(/vote\/.*\/auth/, { timeout: 20000 });
    const emailInput = page.getByLabel("Email address");
    await expect(emailInput).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "Send Verification Code" })).toBeVisible({ timeout: 20000 });

    await emailInput.fill(VOTER_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    const code = await getTestOtp(api, VOTER_EMAIL, meetingId);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();

    // After auth on closed meeting -> confirmation page
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // Both voted motions must appear in the receipt -- the receipt is vote-driven,
    // not filtered by current motion list (RR2-08 fix).
    await expect(page.getByText(MOTION1_TITLE)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(MOTION2_TITLE)).toBeVisible({ timeout: 10000 });
  });
});
