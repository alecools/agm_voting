/**
 * E2E tests for persistent voter session (US-PS-01).
 *
 * Verifies that:
 *  SESS-E2E-01  — return visit within session window skips OTP entirely
 *  SESS-E2E-03  — first-time visit (no token) shows OTP form; token written after auth
 *  SESS-E2E-04  — expired/invalid token in localStorage → OTP form shown, token cleared
 *  SESS-E2E-05  — token for a different meeting does not affect the current meeting
 *  SESS-E2E-06  — token for a now-closed meeting → OTP form shown, token cleared
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
// SESS-E2E-01 + SESS-E2E-03: happy path — first visit stores token; return
// visit skips OTP and goes straight to voting screen
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-01/03: first visit stores token; return visit skips OTP", () => {
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

  test("SESS-E2E-03: first visit — OTP form shown and token written to localStorage after verify", async ({ page }) => {
    test.setTimeout(60000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Start with no localStorage token
    await page.goto(`/vote/${meetingId}/auth`);
    await page.evaluate((id) => localStorage.removeItem(`agm_session_${id}`), meetingId);

    // OTP form must render immediately (no loading/restore state)
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });
    expect(await page.evaluate((id) => localStorage.getItem(`agm_session_${id}`), meetingId)).toBeNull();

    // Complete OTP authentication
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();

    // After successful verify the token should be in localStorage
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });
    const storedToken = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      meetingId
    );
    expect(storedToken).toBeTruthy();
    expect(typeof storedToken).toBe("string");
    expect((storedToken as string).length).toBeGreaterThan(0);
  });

  test("SESS-E2E-01: return visit — valid localStorage token skips OTP and lands on voting", async ({ page }) => {
    test.setTimeout(60000);

    // Navigate directly to the auth page; the previous test left a token in
    // localStorage for this meetingId, but localStorage is per-origin, not
    // per-browser-context in Playwright.  We must set the token via page.evaluate
    // because each test.describe serial block uses a fresh browser context.
    // Obtain a real token by doing a full verify first, then simulate a "new tab"
    // by navigating to the auth page again.
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Authenticate to get a real session token written to localStorage
    await goToAuthPage(page, BUILDING);
    // Extract meeting ID from the URL the navigation landed on
    const authUrl = page.url();
    const urlMeetingId = authUrl.match(/\/vote\/([^/]+)\//)?.[1] ?? meetingId;

    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, urlMeetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    // Capture the token that was stored after successful auth
    const token = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      urlMeetingId
    );
    expect(token).toBeTruthy();

    // Simulate "closing tab and opening a new one" by navigating back to the auth page
    // (sessionStorage is wiped between navigations away from the page, matching real tab-close behaviour)
    await page.evaluate(() => sessionStorage.clear());

    // Navigate to auth page — localStorage token is still set
    await page.goto(`/vote/${urlMeetingId}/auth`);

    // The OTP form must NOT appear; the page should show the loading indicator
    // briefly then navigate to voting (or confirmation if already submitted)
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    // OTP email input must never become visible during the restore flow
    expect(await page.getByLabel("Email address").isVisible()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-04: expired/invalid token → OTP form shown, localStorage cleared
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-04: invalid/expired token shows OTP form and clears localStorage", () => {
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

  test("invalid token in localStorage — OTP form renders and token is cleared", async ({ page }) => {
    test.setTimeout(60000);

    // Navigate to the page first so we are on the same origin
    await page.goto(`/vote/${meetingId}/auth`);
    // Inject a tampered/garbage token
    await page.evaluate(
      ([id]) => localStorage.setItem(`agm_session_${id}`, "totally-invalid-garbage-token-xyz"),
      [meetingId]
    );

    // Reload to trigger the session-restore useEffect
    await page.reload();

    // The restore call returns 401 → OTP form should appear
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 20000 });

    // Token must be cleared from localStorage
    const remaining = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      meetingId
    );
    expect(remaining).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-05: token for meeting A does not affect meeting B's auth page
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-05: token for different meeting does not affect unrelated meeting", () => {
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

  test("valid token for meeting A does not skip OTP for meeting B", async ({ page }) => {
    test.setTimeout(60000);

    // Navigate to the app to establish origin context
    await page.goto(`/vote/${meetingIdB}/auth`);

    // Write a token keyed to meeting A (not B) to localStorage
    await page.evaluate(
      ([idA]) => localStorage.setItem(`agm_session_${idA}`, "valid-looking-token-for-meeting-a"),
      [meetingIdA]
    );
    // Ensure no token exists for meeting B
    await page.evaluate(
      (idB) => localStorage.removeItem(`agm_session_${idB}`),
      meetingIdB
    );

    // Reload — auth page for meeting B should see no token for its own key
    await page.reload();

    // Meeting B auth page must show the OTP form immediately
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });

    // Token for meeting A must be untouched
    const tokenA = await page.evaluate(
      (idA) => localStorage.getItem(`agm_session_${idA}`),
      meetingIdA
    );
    expect(tokenA).toBe("valid-looking-token-for-meeting-a");
  });
});

// ---------------------------------------------------------------------------
// SESS-E2E-06: token in localStorage for a now-closed meeting → OTP form shown
// ---------------------------------------------------------------------------

test.describe("SESS-E2E-06: token for a closed meeting → OTP form shown, token cleared", () => {
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

  test("SESS-E2E-06: voter authenticates and token stored", async ({ page }) => {
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
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    const token = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      meetingId
    );
    expect(token).toBeTruthy();
  });

  test("SESS-E2E-06: admin closes meeting; return visit shows OTP form and clears token", async ({ page }) => {
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

    // Set a plausible (but now-invalid for closed meeting) token in localStorage
    await page.goto(`/vote/${meetingId}/auth`);
    await page.evaluate(
      (id) => localStorage.setItem(`agm_session_${id}`, "plausible-token-but-meeting-closed"),
      meetingId
    );

    // Reload to trigger session restore attempt
    await page.reload();

    // Restore returns 401 (closed meeting) → OTP form must appear
    await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 20000 });

    // Stale token must be removed from localStorage
    const remaining = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      meetingId
    );
    expect(remaining).toBeNull();
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

  test("SESS-E2E-08: voter authenticates, submits ballot — token stored", async ({ page }) => {
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
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Token must be in localStorage
    const token = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      meetingId
    );
    expect(token).toBeTruthy();
  });

  test("SESS-E2E-08: return visit skips OTP and lands on confirmation (already submitted)", async ({ page }) => {
    test.setTimeout(60000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Authenticate to get a fresh token in localStorage for this browser context
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Capture the session token that was just stored
    const token = await page.evaluate(
      (id) => localStorage.getItem(`agm_session_${id}`),
      meetingId
    );
    expect(token).toBeTruthy();

    // Simulate returning to auth page (clear sessionStorage as if tab was closed and reopened)
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/vote/${meetingId}/auth`);

    // Session restore detects already_submitted=true → routes directly to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // OTP form must never appear
    expect(await page.getByLabel("Email address").isVisible()).toBe(false);
  });
});
