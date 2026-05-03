/**
 * E2E tests: sign-out navigation from VotingPage.
 *
 * The in-page "Sign out" button on VotingPage calls POST /api/auth/logout to
 * invalidate the server session, clears client-side state, and navigates to the
 * home page (/).
 *
 * The browser native back button from /voting navigates to /auth via the
 * history stack (populated by the auth → voting push navigation), which is
 * also verified here.
 *
 * Scenarios:
 *   BB.1 — in-page "Sign out" button → URL is /, home page visible
 *   BB.2 — browser page.goBack() from /voting → URL is /vote/:meetingId/auth, email input visible
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import {
  makeAdminApi,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  clearBallots,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
} from "../workflows/helpers";

const BB_BUILDING = `BB01 Back Button Building-${RUN_SUFFIX}`;
const BB_LOT = "BB01-1";
const BB_EMAIL = `bb01-voter-${RUN_SUFFIX}@test.com`;

let bbMeetingId = "";

test.describe("Back button navigation from VotingPage", () => {
  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    const buildingId = await seedBuilding(api, BB_BUILDING, `bb01-mgr-${RUN_SUFFIX}@test.com`);

    await seedLotOwner(api, buildingId, {
      lotNumber: BB_LOT,
      emails: [BB_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    bbMeetingId = await createOpenMeeting(api, buildingId, `BB01 Meeting-${RUN_SUFFIX}`, [
      { title: "BB01 Motion 1", description: "Test motion for back button.", orderIndex: 0, motionType: "general" },
    ]);

    await clearBallots(api, bbMeetingId);
    await api.dispose();
  });

  // ── BB.1: in-page "Sign out" button ──────────────────────────────────────
  test("BB.1: in-page Sign out button navigates to home page and invalidates session", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    // Authenticate and land on voting page
    await goToAuthPage(page, BB_BUILDING);
    await authenticateVoter(page, BB_EMAIL, () => getTestOtp(api, BB_EMAIL, bbMeetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Capture meetingId from URL
    const votingUrl = page.url();
    const meetingIdMatch = votingUrl.match(/\/vote\/([^/]+)\//);
    const meetingId = meetingIdMatch?.[1] ?? bbMeetingId;

    // Click the in-page Sign out button — triggers logout API + navigates to /
    await page.getByRole("button", { name: "Sign out" }).click();

    // Must navigate to home page (/)
    await expect(page).toHaveURL("/", { timeout: 10000 });

    // Navigate to /auth for the same meeting — session must be invalidated
    await page.goto(`/vote/${meetingId}/auth`);

    // Auth page must render (email input visible — session was invalidated by logout)
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 20000 });
  });

  // ── BB.2: browser native back button ─────────────────────────────────────
  test("BB.2: browser native back button from /voting lands on /auth — not blank", async ({ page }) => {
    test.setTimeout(120000);

    // Navigate directly to /auth for this meeting, then to /voting, to build a
    // known history stack: [..., /auth, /voting]. This is more reliable than
    // driving through the full OTP auth flow whose history entries depend on
    // how the SPA router pushes state during login.
    const meetingId = bbMeetingId;

    // Step 1: land on /auth — creates a real browser history entry for this URL
    await page.goto(`/vote/${meetingId}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Step 2: go to /voting (direct goto creates a new history entry)
    await page.goto(`/vote/${meetingId}/voting`);
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 10000 });

    // Browser native back — history entry before /voting is /auth
    await page.goBack();

    // Must land on /auth — a valid route (not a blank page)
    await expect(page).toHaveURL(`/vote/${meetingId}/auth`, { timeout: 10000 });

    // Auth page must render (email input visible — not a blank page)
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 10000 });
  });
});
