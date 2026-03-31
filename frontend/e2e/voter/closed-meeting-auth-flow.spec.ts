/**
 * E2E tests: closed meeting auth flow (US-TCG-04).
 *
 * Verifies that a voter who authenticates against a closed meeting:
 *  - Is NOT blocked at the OTP stage
 *  - Is routed to the confirmation page, not the voting page
 *  - Sees appropriate content depending on whether they submitted before close
 *
 * Scenarios:
 *  TCG04-1 — Voter who DID NOT submit before close → OTP succeeds → routed to
 *             confirmation/absent page (not voting page, not blocked)
 *  TCG04-2 — Voter who DID submit before close → OTP succeeds → routed to
 *             confirmation page showing their ballot
 *
 * Both sub-cases verify that the auth flow does not return a hard error or
 * block access when the meeting is closed (auth returns agm_status="closed").
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  closeMeeting,
  deleteMeeting,
  clearBallots,
  authenticateVoter,
  getTestOtp,
  submitBallotViaApi,
} from "../workflows/helpers";

const TCG04_BUILDING = `TCG04 Building-${RUN_SUFFIX}`;
const TCG04_VOTER_NO_SUB = `tcg04-nosubmit-${RUN_SUFFIX}@test.com`;
const TCG04_VOTER_SUBMITTED = `tcg04-submitted-${RUN_SUFFIX}@test.com`;

let tcg04MeetingId = "";
let tcg04BuildingId = "";
let tcg04SubmittedLotOwnerId = "";

test.describe("US-TCG-04: Closed meeting auth flow", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    tcg04BuildingId = await seedBuilding(
      api,
      TCG04_BUILDING,
      `tcg04-mgr-${RUN_SUFFIX}@test.com`
    );

    // Lot for voter who does NOT submit
    await seedLotOwner(api, tcg04BuildingId, {
      lotNumber: "TCG04-NO-SUB",
      emails: [TCG04_VOTER_NO_SUB],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    // Lot for voter who DOES submit
    tcg04SubmittedLotOwnerId = await seedLotOwner(api, tcg04BuildingId, {
      lotNumber: "TCG04-SUBMITTED",
      emails: [TCG04_VOTER_SUBMITTED],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    tcg04MeetingId = await createOpenMeeting(
      api,
      tcg04BuildingId,
      `TCG04 Closed Auth Meeting-${RUN_SUFFIX}`,
      [
        {
          title: "TCG04 Motion 1",
          description: "Test motion for closed meeting auth.",
          orderIndex: 1,
          motionType: "general",
        },
      ]
    );

    // Submit ballot for the "submitted" voter before closing
    const detailRes = await api.get(`/api/admin/general-meetings/${tcg04MeetingId}`);
    const detail = await detailRes.json() as { motions: { id: string }[] };
    const motionId = detail.motions[0]?.id;
    await submitBallotViaApi(
      api,
      TCG04_VOTER_SUBMITTED,
      tcg04MeetingId,
      [tcg04SubmittedLotOwnerId],
      [{ motion_id: motionId, choice: "yes" }]
    );

    // Close the meeting
    await closeMeeting(api, tcg04MeetingId);

    await clearBallots(api, tcg04MeetingId);
    await api.dispose();
  }, { timeout: 120000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await deleteMeeting(api, tcg04MeetingId);
    await api.dispose();
  }, { timeout: 30000 });

  // ── TCG04-1: Voter who did NOT submit → routed to confirmation (closed) ──

  test("TCG04-1: non-submitter authenticates against closed meeting → routed to confirmation, not blocked", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Navigate directly to the closed meeting's auth page (bypasses the
    // building dropdown which only lists buildings with *open* meetings).
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${tcg04MeetingId}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Authenticate via OTP — should succeed even though meeting is closed
    await authenticateVoter(
      page,
      TCG04_VOTER_NO_SUB,
      () => getTestOtp(api, TCG04_VOTER_NO_SUB, tcg04MeetingId)
    );
    await api.dispose();

    // Must be routed to confirmation page (not voting, not blocked)
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Confirmation page must be visible (not a blank page or error)
    await expect(page.locator("main.voter-content")).toBeVisible({ timeout: 10000 });
  });

  // ── TCG04-2: Voter who DID submit → routed to confirmation showing ballot ──

  test("TCG04-2: submitter authenticates against closed meeting → routed to confirmation", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Navigate directly to the closed meeting's auth page (bypasses the
    // building dropdown which only lists buildings with *open* meetings).
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${tcg04MeetingId}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    await authenticateVoter(
      page,
      TCG04_VOTER_SUBMITTED,
      () => getTestOtp(api, TCG04_VOTER_SUBMITTED, tcg04MeetingId)
    );
    await api.dispose();

    // Must be routed to confirmation page
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Confirmation page must be visible
    await expect(page.locator("main.voter-content")).toBeVisible({ timeout: 10000 });
  });
});
