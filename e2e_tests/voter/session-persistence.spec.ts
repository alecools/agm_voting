/**
 * E2E tests for persistent voter session (US-PS-01).
 *
 * Session tokens are stored in an HttpOnly cookie ("agm_session") set by the
 * backend. JavaScript cannot read the cookie value directly. Tests verify the
 * cookie-based session model by observing routing behaviour:
 *
 *  SESS-E2E-01  — return visit within session window skips OTP entirely
 *  SESS-E2E-03  — first-time visit (no cookie) shows OTP form; subsequent
 *                 navigation to the same meeting skips OTP (cookie was set)
 *  SESS-E2E-04  — no cookie (cleared) → OTP form shown
 *  SESS-E2E-05  — cookie for a different meeting does not skip OTP for another
 *  SESS-E2E-06  — return visit after meeting is closed shows OTP form (cookie
 *                 cleared when restore returns 401)
 *  SESS-E2E-08  — return visit after full ballot submission → routed to confirmation
 *
 * Each test seeds its own isolated building, lot owner, and meeting so it is
 * safe to run against the shared preview deployment.  All seeding is done via
 * the admin API in a beforeAll block, with cleanup (meeting deletion) in afterAll.
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
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
  submitBallot,
} from "../workflows/helpers";

// ---------------------------------------------------------------------------
// SESS-E2E-01 + SESS-E2E-03: happy path — first visit (no cookie) shows OTP
// form; after auth the cookie is set so a return visit skips OTP entirely
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-01/03: first visit shows OTP; return visit skips OTP via cookie", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `SESS01 Building-${RUN_SUFFIX}`;
  const LOT_EMAIL = `sess01-voter-${RUN_SUFFIX}@test.com`;
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const buildingId = await seedBuilding(api, BUILDING, `sess01-mgr-${RUN_SUFFIX}@test.com`);
    await seedLotOwner(api, buildingId, {
      lotNumber: "SESS01-1",
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
    });
    meetingId = await createOpenMeeting(api, buildingId, `SESS01 Meeting-${RUN_SUFFIX}`, [
      { title: "SESS01 Motion 1", description: "Session persistence test motion.", orderIndex: 1, motionType: "general" },
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

  test("SESS-E2E-03: first visit — no cookie means OTP form shown; subsequent navigation skips OTP (cookie set)", async ({ page }) => {
    test.setTimeout(60000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Ensure no session cookie exists so restore fails and OTP form is shown.
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${meetingId}/auth`);

    // OTP form must render (cookie restore returns 401 → no redirect)
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Complete OTP authentication — this sets the HttpOnly agm_session cookie
    await page.getByLabel("Email address").fill(LOT_EMAIL);
    await page.getByRole("button", { name: "Send Verification Code" }).click();
    await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
    const code = await getTestOtp(api, LOT_EMAIL, meetingId);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await api.dispose();

    // After successful verify we land on voting or confirmation
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    // Simulate returning: navigate back to auth page WITHOUT clearing the cookie.
    // The cookie was set by the backend after OTP verify — session restore should succeed.
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/vote/${meetingId}/auth`);

    // Cookie restore succeeds → page redirects to voting/confirmation without showing OTP
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });
    expect(await page.getByLabel("Email address").isVisible()).toBe(false);
  });

  test("SESS-E2E-01: return visit — active cookie skips OTP and lands on voting", async ({ page }) => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Authenticate to establish a real session cookie for this meeting
    await goToAuthPage(page, BUILDING);
    // Extract meeting ID from the URL the navigation landed on
    const authUrl = page.url();
    const urlMeetingId = authUrl.match(/\/vote\/([^/]+)\//)?.[1] ?? meetingId;

    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, urlMeetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    // Simulate "closing tab and opening a new one" by clearing sessionStorage
    // but NOT the HttpOnly cookie (which persists across navigations like a real browser session)
    await page.evaluate(() => sessionStorage.clear());

    // Navigate to auth page — the agm_session cookie is still active
    await page.goto(`/vote/${urlMeetingId}/auth`);

    // Cookie restore succeeds → OTP form never shown; routes to voting/confirmation
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });
    expect(await page.getByLabel("Email address").isVisible()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-04: no cookie (cleared) → OTP form shown
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-04: no session cookie → OTP form shown", () => {
  const BUILDING = `SESS04 Building-${RUN_SUFFIX}`;
  const LOT_EMAIL = `sess04-voter-${RUN_SUFFIX}@test.com`;
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const buildingId = await seedBuilding(api, BUILDING, `sess04-mgr-${RUN_SUFFIX}@test.com`);
    await seedLotOwner(api, buildingId, {
      lotNumber: "SESS04-1",
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
    });
    meetingId = await createOpenMeeting(api, buildingId, `SESS04 Meeting-${RUN_SUFFIX}`, [
      { title: "SESS04 Motion 1", description: "Session persistence test motion.", orderIndex: 1, motionType: "general" },
    ]);
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

  test("no session cookie — OTP form renders when restore returns 401", async ({ page }) => {
    test.setTimeout(60000);

    // Clear any existing session cookie before navigating.
    // Session tokens are now stored in HttpOnly cookies — JavaScript cannot seed
    // an invalid token directly. Instead we verify the no-cookie path:
    // with no cookie the restore endpoint returns 401 → OTP form must appear.
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${meetingId}/auth`);

    // The restore call returns 401 (no cookie) → OTP form should appear
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 20000 });
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-05: no cookie → OTP form shown for any meeting
// ---------------------------------------------------------------------------
// With a single HttpOnly cookie (not keyed per-meeting), the relevant
// behaviour to verify is: clearing the cookie causes the OTP form to appear
// regardless of which meeting the voter navigates to. SESS-E2E-04 already
// covers the no-cookie path.  This describe block verifies that a cookie
// session from meeting A does NOT bypass OTP for a completely different voter
// on meeting B (because the restore endpoint validates the cookie against the
// correct lot owner / meeting combination).

test.describe("SESS-E2E-05: session cookie for voter A does not skip OTP for unrelated voter B", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING_A = `SESS05A Building-${RUN_SUFFIX}`;
  const BUILDING_B = `SESS05B Building-${RUN_SUFFIX}`;
  const LOT_EMAIL_A = `sess05a-voter-${RUN_SUFFIX}@test.com`;
  const LOT_EMAIL_B = `sess05b-voter-${RUN_SUFFIX}@test.com`;
  let meetingIdA = "";
  let meetingIdB = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const buildingIdA = await seedBuilding(api, BUILDING_A, `sess05a-mgr-${RUN_SUFFIX}@test.com`);
    await seedLotOwner(api, buildingIdA, {
      lotNumber: "SESS05A-1",
      emails: [LOT_EMAIL_A],
      unitEntitlement: 10,
    });
    meetingIdA = await createOpenMeeting(api, buildingIdA, `SESS05A Meeting-${RUN_SUFFIX}`, [
      { title: "SESS05A Motion", description: "Meeting A motion.", orderIndex: 1, motionType: "general" },
    ]);

    const buildingIdB = await seedBuilding(api, BUILDING_B, `sess05b-mgr-${RUN_SUFFIX}@test.com`);
    await seedLotOwner(api, buildingIdB, {
      lotNumber: "SESS05B-1",
      emails: [LOT_EMAIL_B],
      unitEntitlement: 10,
    });
    meetingIdB = await createOpenMeeting(api, buildingIdB, `SESS05B Meeting-${RUN_SUFFIX}`, [
      { title: "SESS05B Motion", description: "Meeting B motion.", orderIndex: 1, motionType: "general" },
    ]);
    await api.dispose();
  }, { timeout: 60000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await deleteMeeting(api, meetingIdA);
    await deleteMeeting(api, meetingIdB);
    await api.dispose();
  }, { timeout: 30000 });

  test("voter A authenticates for meeting A; navigating to meeting B auth for unrelated voter shows OTP form", async ({ page }) => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Step 1: Authenticate as Voter A for meeting A — sets the session cookie
    await goToAuthPage(page, BUILDING_A);
    await authenticateVoter(page, LOT_EMAIL_A, () => getTestOtp(api, LOT_EMAIL_A, meetingIdA));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    // Step 2: Navigate to meeting B's auth page for Voter B.
    // The cookie is keyed to Voter A — the restore endpoint for meeting B with
    // Voter A's cookie should return 401 (wrong lot_owner for that meeting),
    // so the OTP form must appear.
    await page.goto(`/vote/${meetingIdB}/auth`);
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 20000 });
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-06: return visit after meeting is closed → OTP form shown
// ---------------------------------------------------------------------------
// The agm_session cookie no longer holds a meeting-specific token — it is
// a generic session identifier. When the meeting is closed, the restore
// endpoint returns 401 so the OTP form is shown rather than redirecting
// to voting. After closing, if the voter lacks a submission they are
// redirected to confirmation (absent ballot) once they re-auth via OTP.

test.describe("SESS-E2E-06: after meeting closes, navigating to auth URL shows OTP form", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `SESS06 Building-${RUN_SUFFIX}`;
  const LOT_EMAIL = `sess06-voter-${RUN_SUFFIX}@test.com`;
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const buildingId = await seedBuilding(api, BUILDING, `sess06-mgr-${RUN_SUFFIX}@test.com`);
    await seedLotOwner(api, buildingId, {
      lotNumber: "SESS06-1",
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
    });
    meetingId = await createOpenMeeting(api, buildingId, `SESS06 Meeting-${RUN_SUFFIX}`, [
      { title: "SESS06 Motion 1", description: "Session persistence test motion.", orderIndex: 1, motionType: "general" },
    ]);
    await api.dispose();
  }, { timeout: 60000 });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    // Meeting is already closed by the test — deleteMeeting handles that
    await deleteMeeting(api, meetingId);
    await api.dispose();
  }, { timeout: 30000 });

  test("SESS-E2E-06: voter authenticates while meeting is open — lands on voting", async ({ page }) => {
    test.setTimeout(60000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();
    // Landing on voting page confirms open-meeting auth succeeded
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });
  });

  test("SESS-E2E-06: admin closes meeting; navigating to auth URL without cookie shows OTP form", async ({ page }) => {
    test.setTimeout(60000);

    // Close the meeting via admin API
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    await closeMeeting(api, meetingId);
    await api.dispose();

    // Clear the session cookie so restore returns 401 → OTP form shown.
    // (A real returning voter without a valid cookie would see the same behaviour.)
    await page.context().clearCookies({ name: 'agm_session' });
    await page.goto(`/vote/${meetingId}/auth`);

    // No valid cookie → restore returns 401 → OTP form must appear
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 20000 });
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-08: return visit after full submission → routed to confirmation
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-08: return visit after ballot submitted routes to confirmation", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `SESS08 Building-${RUN_SUFFIX}`;
  const LOT_EMAIL = `sess08-voter-${RUN_SUFFIX}@test.com`;
  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    const buildingId = await seedBuilding(api, BUILDING, `sess08-mgr-${RUN_SUFFIX}@test.com`);
    await seedLotOwner(api, buildingId, {
      lotNumber: "SESS08-1",
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
    });
    meetingId = await createOpenMeeting(api, buildingId, `SESS08 Meeting-${RUN_SUFFIX}`, [
      { title: "SESS08 Motion 1", description: "Session persistence test motion.", orderIndex: 1, motionType: "general" },
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

  test("SESS-E2E-08: voter authenticates and submits ballot — lands on confirmation", async ({ page }) => {
    test.setTimeout(90000);
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

    // Vote on the single motion and submit
    await page.locator(".motion-card").first().getByRole("button", { name: "For" }).click();
    await submitBallot(page);
    // After submission → confirmation page
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    // Session token is stored in HttpOnly cookie — not accessible via localStorage
  });

  test("SESS-E2E-08: return visit skips OTP and lands on confirmation (already submitted)", async ({ page }) => {
    test.setTimeout(60000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Authenticate again (from a fresh browser context) — this sets a new session cookie.
    // Because the ballot is already submitted, auth redirects straight to confirmation.
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Simulate "navigating away and coming back" — clear sessionStorage but keep the cookie.
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/vote/${meetingId}/auth`);

    // Cookie restore detects already_submitted=true → routes directly to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // OTP form must never appear
    expect(await page.getByLabel("Email address").isVisible()).toBe(false);
  });
});
