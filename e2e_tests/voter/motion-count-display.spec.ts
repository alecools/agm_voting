/**
 * E2E regression test: motion count display starts at 1 (not 0).
 *
 * MotionCard renders `Motion {order_index + 1}`.  Before the fix it rendered
 * `Motion {order_index}` which produced "Motion 0" for the first motion
 * (order_index=0).
 *
 * Scenario: voter reaches the voting screen with one motion whose order_index
 * is 0 — the card must read "Motion 1", not "Motion 0".
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
} from "../workflows/helpers";

const BUILDING = `MC01 Motion Count Building-${RUN_SUFFIX}`;
const LOT = "MC01-1";
const LOT_EMAIL = `mc01-voter-${RUN_SUFFIX}@test.com`;
const MOTION_TITLE = "MC01 Single Motion — Annual Budget";

let meetingId = "";

test.describe("Motion count display starts at 1 (not 0)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "mc01-mgr@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: LOT,
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    // Seed with orderIndex: 0 so the DB stores order_index=0.
    // After the fix, the card renders "Motion 1" (0 + 1).
    // Before the fix it would have rendered "Motion 0".
    meetingId = await createOpenMeeting(api, buildingId, `MC01 Meeting-${RUN_SUFFIX}`, [
      {
        title: MOTION_TITLE,
        description: "A single-motion meeting for count display testing.",
        orderIndex: 0,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  test("first motion card shows 'Motion 1', not 'Motion 0'", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();

    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // One motion card is visible
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(1);

    // The card must display "Motion 1" (order_index + 1 = 0 + 1)
    await expect(page.getByText("Motion 1", { exact: true })).toBeVisible({ timeout: 10000 });

    // "Motion 0" must NOT be present — that was the pre-fix broken label
    await expect(page.getByText("Motion 0", { exact: true })).not.toBeVisible();
  });
});
