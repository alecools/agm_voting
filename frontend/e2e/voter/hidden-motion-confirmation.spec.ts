/**
 * US-TCG-06 / RR2-08: E2E test — hidden motions still appear in voter's
 * ballot confirmation receipt after admin hides them post-submission.
 *
 * Legal requirement: a voter's confirmation receipt must be immutable from
 * their perspective.  Admin hiding a motion after votes are recorded must not
 * alter what the voter sees on their confirmation page.
 *
 * Scenario:
 *   1. Seed a meeting with 2 visible motions and 1 lot owner.
 *   2. Voter votes on both motions and submits.
 *   3. Admin hides motion 2 via the visibility toggle API.
 *   4. Voter navigates to the confirmation page (re-authenticates or direct nav).
 *   5. Assert: both motion 1 AND motion 2 appear on the confirmation page.
 *
 * NOTE: This test verifies the behaviour specified by RR2-08 (get_my_ballot
 * must not filter on Motion.is_visible).  If the backend filters on is_visible
 * when returning ballot data, motion 2 will be absent and this test will fail,
 * correctly indicating the implementation gap.
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  clearBallots,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
  submitBallot,
  deleteMeeting,
} from "../workflows/helpers";

const BUILDING = `TCG06 Building-${RUN_SUFFIX}`;
const VOTER_EMAIL = `tcg06-voter-${RUN_SUFFIX}@test.com`;
const MOTION1_TITLE = "TCG06 Motion 1 — Stays visible";
const MOTION2_TITLE = "TCG06 Motion 2 — Hidden after vote";

let meetingId = "";

test.describe("US-TCG-06: hidden motions still appear in voter confirmation receipt", () => {
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
        description: "First motion — will remain visible.",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Second motion — will be hidden after voter submits.",
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

  // ── Step 1: voter votes on both motions and submits ───────────────────────

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

    // Both motions visible — each has an h3 title heading
    const motionHeadings = page.getByRole("heading", { level: 3 });
    await expect(motionHeadings).toHaveCount(2, { timeout: 10000 });
    // Locate each motion's card by its heading, then find the vote button within it
    const motion1Card = page.locator("div").filter({ has: page.getByRole("heading", { name: MOTION1_TITLE }) });
    const motion2Card = page.locator("div").filter({ has: page.getByRole("heading", { name: MOTION2_TITLE }) });
    await motion1Card.getByRole("button", { name: "For" }).click();
    await motion2Card.getByRole("button", { name: "Against" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── Step 2: admin hides motion 2 ─────────────────────────────────────────

  test("TCG06.2: admin hides motion 2 after voter has submitted", async () => {
    test.setTimeout(30000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Fetch meeting motions to get motion 2 ID
    const detailRes = await api.get(`/api/admin/general-meetings/${meetingId}`);
    const detail = await detailRes.json() as { motions: { id: string; title: string; is_visible: boolean }[] };
    const m2 = detail.motions.find((m) => m.title === MOTION2_TITLE);
    expect(m2, `Motion "${MOTION2_TITLE}" not found`).toBeDefined();

    // Hide motion 2 via admin API
    const hideRes = await api.patch(`/api/admin/motions/${m2!.id}/visibility`, {
      data: { is_visible: false },
    });
    expect(hideRes.ok(), `Hiding motion failed: ${hideRes.status()}`).toBeTruthy();

    // Verify motion 2 is now hidden
    const updatedMotion = await hideRes.json() as { is_visible: boolean };
    expect(updatedMotion.is_visible).toBe(false);

    await api.dispose();
  });

  // ── Step 3: voter's confirmation page still shows both motions ────────────

  test("TCG06.3: voter confirmation receipt still shows both motions (motion 2 not erased)", async ({ page }) => {
    test.setTimeout(90000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Navigate directly to the confirmation page (session cookie from step 1 may still be valid)
    // Clear session cookie to force re-auth via OTP, ensuring a fresh load of the confirmation.
    await page.context().clearCookies();
    await page.goto(`/vote/${meetingId}/auth`);

    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();

    // After re-auth, the voter has already submitted → routed to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // Both motions must appear in the confirmation receipt regardless of visibility
    await expect(page.getByText(MOTION1_TITLE)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(MOTION2_TITLE)).toBeVisible({ timeout: 10000 });
  });
});
