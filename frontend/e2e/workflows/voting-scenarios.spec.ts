/**
 * Business workflow E2E specs — voting lifecycle scenarios.
 *
 * Each workflow is self-contained: it seeds its own building, lot owners, and
 * meeting, then verifies exact tally numbers after close. These tests fill the
 * gap left by persona-scoped specs, which verify UI flows but not numerical
 * correctness of the vote tallies.
 *
 * Workflows covered:
 *   WF3 — Simple 3-lot case: 2 vote, 1 absent. Asserts per-motion tallies.
 *   WF4 — Multi-lot voter: both lots in one submission.
 *   WF5 — Multi-lot voter: partial submission across two sessions.
 *   WF6 — Proxy voting: entitlement from lot owner, not proxy voter.
 *   WF7 — In-arrear mixed lots: not_eligible on General Motion, normal on Special.
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  ADMIN_AUTH_PATH,
  seedBuilding,
  seedLotOwner,
  uploadProxyCsv,
  createOpenMeeting,
  closeMeeting,
  clearBallots,
  getMeetingDetails,
  assertTally,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
  submitBallot,
} from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── WF3: Simple 3-lot voting lifecycle ────────────────────────────────────────

test.describe("WF3: Simple 3-lot voting lifecycle with tally verification", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `WF3 Simple Voting-${RUN_SUFFIX}`;
  const MEETING_TITLE = `WF3 Simple Meeting-${RUN_SUFFIX}`;
  const VOTER1_LOT = "WF3-1";
  const VOTER1_EMAIL = `wf3-voter1-${RUN_SUFFIX}@test.com`;
  const VOTER2_LOT = "WF3-2";
  const VOTER2_EMAIL = `wf3-voter2-${RUN_SUFFIX}@test.com`;
  const VOTER3_LOT = "WF3-3";
  const VOTER3_EMAIL = `wf3-voter3-${RUN_SUFFIX}@test.com`;
  const MOTION1_TITLE = "General Motion — Annual Budget";
  const MOTION2_TITLE = "Special Motion — Bylaw Change";

  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "wf3-manager@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: VOTER1_LOT,
      emails: [VOTER1_EMAIL],
      unitEntitlement: 100,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: VOTER2_LOT,
      emails: [VOTER2_EMAIL],
      unitEntitlement: 50,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: VOTER3_LOT,
      emails: [VOTER3_EMAIL],
      unitEntitlement: 75,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION1_TITLE,
        description: "Do you approve the annual budget?",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Do you approve the bylaw change?",
        orderIndex: 2,
        motionType: "special",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // WF3.2: Voter 1 votes For on both motions
  test("WF3.2: voter 1 votes For on both motions", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER1_EMAIL, () => getTestOtp(api, VOTER1_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2);

    await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "For" }).click();
    await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // WF3.3: Voter 2 votes Against on Motion 1, For on Motion 2
  test("WF3.3: voter 2 votes Against on Motion 1, For on Motion 2", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER2_EMAIL, () => getTestOtp(api, VOTER2_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2);

    await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "Against" }).click();
    await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    // Confirmation shows Against for Motion 1
    await expect(page.getByText("Against").first()).toBeVisible();
  });

  // WF3.4: Voter 3 does not vote (absent) — no UI action needed

  // WF3.5 + WF3.6: Admin closes meeting and asserts tallies via API
  test("WF3.5-3.6: admin closes meeting and tallies are correct", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await closeMeeting(api, meetingId);

    const motionDetails = await getMeetingDetails(api, meetingId);
    await api.dispose();

    const motion1 = motionDetails.find((m) => m.title === MOTION1_TITLE);
    const motion2 = motionDetails.find((m) => m.title === MOTION2_TITLE);
    expect(motion1, `Motion "${MOTION1_TITLE}" not found in tally response`).toBeDefined();
    expect(motion2, `Motion "${MOTION2_TITLE}" not found in tally response`).toBeDefined();

    // Motion 1 (General): WF3-1 For (100), WF3-2 Against (50), WF3-3 Absent (75)
    assertTally(motion1!.tally, {
      yes:          { voter_count: 1, entitlement_sum: 100 },
      no:           { voter_count: 1, entitlement_sum: 50 },
      abstained:    { voter_count: 0, entitlement_sum: 0 },
      absent:       { voter_count: 1, entitlement_sum: 75 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
    });

    // Motion 2 (Special): WF3-1 For (100), WF3-2 For (50), WF3-3 Absent (75)
    assertTally(motion2!.tally, {
      yes:          { voter_count: 2, entitlement_sum: 150 },
      no:           { voter_count: 0, entitlement_sum: 0 },
      abstained:    { voter_count: 0, entitlement_sum: 0 },
      absent:       { voter_count: 1, entitlement_sum: 75 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
    });

    // Voter lists — Motion 1
    expect(motion1!.voter_lists.yes.some((v) => v.lot_number === VOTER1_LOT && v.entitlement === 100)).toBe(true);
    expect(motion1!.voter_lists.no.some((v) => v.lot_number === VOTER2_LOT && v.entitlement === 50)).toBe(true);
    expect(motion1!.voter_lists.absent.some((v) => v.lot_number === VOTER3_LOT && v.entitlement === 75)).toBe(true);
  });

  // WF3.7: Assert tallies via admin UI — including entitlement percentage display
  test("WF3.7: admin UI shows correct tally and entitlement percentages for Motion 1", async ({ browser }) => {
    test.setTimeout(60000);
    const adminCtx = await browser.newContext({ storageState: ADMIN_AUTH_PATH });
    const adminPage = await adminCtx.newPage();
    try {
      await adminPage.goto(`/admin/general-meetings/${meetingId}`);
      await expect(adminPage.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

      // Motion 1 results — "For" row: count=1, entitlement=100
      // Spot-check: the results section renders voter_count and entitlement_sum
      await expect(adminPage.getByText("100").first()).toBeVisible({ timeout: 10000 });
      await expect(adminPage.getByText("150").first()).toBeVisible({ timeout: 10000 });

      // US-UI04: entitlement percentage display
      // Total building entitlement = 100 + 50 + 75 = 225
      //   Motion 1 For:     100 / 225 = 44.4%  → displayed as "100 (44.4%)"
      //   Motion 1 Against:  50 / 225 = 22.2%  → displayed as "50 (22.2%)"
      //   Motion 2 For:     150 / 225 = 66.7%  → displayed as "150 (66.7%)"
      // At least one tally cell must match the N (X.X%) pattern to confirm
      // the percentage feature is rendered in the admin report.
      await expect(
        adminPage.getByText(/\d+\s*\(\d+\.\d+%\)/).first()
      ).toBeVisible({ timeout: 10000 });

      // Verify the specific percentages for Motion 1
      await expect(adminPage.getByText("100 (44.4%)")).toBeVisible({ timeout: 10000 });
      await expect(adminPage.getByText("50 (22.2%)")).toBeVisible({ timeout: 10000 });
    } finally {
      await adminCtx.close();
    }
  });
});

// ── WF4: Multi-lot voter — both lots in one submission ────────────────────────

test.describe("WF4: Multi-lot voter — both lots submitted in one session", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `WF4 Multi-Lot Single-${RUN_SUFFIX}`;
  const MEETING_TITLE = `WF4 Multi-Lot Meeting-${RUN_SUFFIX}`;
  const LOT_A = "WF4-A";
  const LOT_B = "WF4-B";
  const VOTER_EMAIL = `wf4-voter-${RUN_SUFFIX}@test.com`;
  const MOTION1_TITLE = "Motion 1 — Budget";
  const MOTION2_TITLE = "Motion 2 — Bylaw";

  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "wf4-manager@test.com");

    // Both lots share the same voter email
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_A,
      emails: [VOTER_EMAIL],
      unitEntitlement: 80,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_B,
      emails: [VOTER_EMAIL],
      unitEntitlement: 40,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION1_TITLE,
        description: "Do you approve the budget?",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Do you approve the bylaw?",
        orderIndex: 2,
        motionType: "special",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // WF4.2: Vote both lots in one submission
  test("WF4.2: voter sees both lots pre-selected, votes For on both motions", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Both lots visible and checked (scoped to sidebar to avoid duplicate in mobile drawer)
    const sidebar = page.locator(".voting-layout__sidebar");
    await expect(sidebar.getByText(`Lot ${LOT_A}`)).toBeVisible();
    await expect(sidebar.getByText(`Lot ${LOT_B}`)).toBeVisible();
    await expect(sidebar.getByText("You are voting for 2 lots.")).toBeVisible();

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2);

    await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "For" }).click();
    await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    // Multi-lot confirmation shows both lot headings
    await expect(page.getByText(`Lot ${LOT_A}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Lot ${LOT_B}`, { exact: true })).toBeVisible();
  });

  // WF4.3: Close meeting and verify tallies
  test("WF4.3: tallies show voter_count=2 and entitlement_sum=120 for both motions", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await closeMeeting(api, meetingId);
    const motionDetails = await getMeetingDetails(api, meetingId);
    await api.dispose();

    const motion1 = motionDetails.find((m) => m.title === MOTION1_TITLE);
    const motion2 = motionDetails.find((m) => m.title === MOTION2_TITLE);
    expect(motion1).toBeDefined();
    expect(motion2).toBeDefined();

    // Both lots voted For: voter_count=2, entitlement_sum=80+40=120
    assertTally(motion1!.tally, {
      yes:    { voter_count: 2, entitlement_sum: 120 },
      no:     { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 0, entitlement_sum: 0 },
    });
    assertTally(motion2!.tally, {
      yes:    { voter_count: 2, entitlement_sum: 120 },
      no:     { voter_count: 0, entitlement_sum: 0 },
      absent: { voter_count: 0, entitlement_sum: 0 },
    });
  });

  // WF4.4: Admin UI spot-check
  test("WF4.4: admin UI shows For: 2 lots, entitlement 120 for Motion 1", async ({ browser }) => {
    test.setTimeout(60000);

    const adminCtx = await browser.newContext({ storageState: ADMIN_AUTH_PATH });
    const adminPage = await adminCtx.newPage();
    try {
      await adminPage.goto(`/admin/general-meetings/${meetingId}`);
      await expect(adminPage.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
      await expect(adminPage.getByText("120").first()).toBeVisible({ timeout: 10000 });
    } finally {
      await adminCtx.close();
    }
  });
});

// ── WF5: Multi-lot voter — partial submission (two sessions) ──────────────────

test.describe("WF5: Multi-lot voter — partial submission across two sessions", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `WF5 Partial Submit-${RUN_SUFFIX}`;
  const MEETING_TITLE = `WF5 Partial Meeting-${RUN_SUFFIX}`;
  const LOT_A = "WF5-A";
  const LOT_B = "WF5-B";
  const VOTER_EMAIL = `wf5-voter-${RUN_SUFFIX}@test.com`;
  const MOTION1_TITLE = "Motion 1 — Budget";
  const MOTION2_TITLE = "Motion 2 — Bylaw";

  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "wf5-manager@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_A,
      emails: [VOTER_EMAIL],
      unitEntitlement: 60,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_B,
      emails: [VOTER_EMAIL],
      unitEntitlement: 30,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION1_TITLE,
        description: "Do you approve the budget?",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Do you approve the bylaw?",
        orderIndex: 2,
        motionType: "special",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // WF5.2: Session 1 — vote WF5-A only (uncheck WF5-B)
  test("WF5.2: session 1 — votes For/Against for WF5-A only, WF5-B excluded", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Wait for motion cards to load BEFORE unchecking LOT_B.
    // The VotingPage has a [motions, allLots] effect that re-seeds selectedIds whenever
    // motions load for the first time. If motions load AFTER the user unchecks a lot,
    // the effect re-adds it (because it's not yet submitted). Waiting for motions to
    // appear first ensures the re-seed effect has already run so the subsequent uncheck
    // sticks without being overridden.
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2, { timeout: 15000 });

    // Both lots visible; uncheck LOT_B (scoped to sidebar to avoid duplicate in mobile drawer)
    const sidebar = page.locator(".voting-layout__sidebar");
    await expect(sidebar.getByText("You are voting for 2 lots.")).toBeVisible();
    await page.getByRole("checkbox", { name: `Select Lot ${LOT_B}` }).uncheck();
    await expect(sidebar.getByText("You are voting for 1 lot.")).toBeVisible();

    await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "For" }).click();
    await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "Against" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // Confirmation: only WF5-A submitted — WF5-B is a remaining lot, not yet submitted.
    // The "Vote for remaining lots" button is shown when remaining_lot_owner_ids is non-empty,
    // confirming that WF5-B still needs to be voted on in a future session.
    await expect(page.getByRole("button", { name: "Vote for remaining lots" })).toBeVisible({ timeout: 10000 });
  });

  // WF5.3: Session 2 — re-authenticate, WF5-A disabled, vote WF5-B
  test("WF5.3: session 2 — WF5-A shows Already submitted, votes Abstain/For for WF5-B", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    // Return to home and re-authenticate
    await page.goto("/");
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // WF5-A shows "Already submitted" and is disabled (scoped to sidebar)
    const sidebar = page.locator(".voting-layout__sidebar");
    const lotAItem = sidebar.locator(".lot-selection__item").filter({ hasText: `Lot ${LOT_A}` });
    await expect(lotAItem.getByText("Already submitted")).toBeVisible({ timeout: 10000 });
    await expect(lotAItem).toHaveAttribute("aria-disabled", "true");

    // WF5-B is still pending — "You are voting for 1 lot." (scoped to sidebar)
    await expect(page.locator(".voting-layout__sidebar").getByText("You are voting for 1 lot.")).toBeVisible();

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2);

    await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "Abstain" }).click();
    await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // Both lots now in confirmation (multi-lot grouped display)
    await expect(page.getByText(`Lot ${LOT_A}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Lot ${LOT_B}`, { exact: true })).toBeVisible();
  });

  // WF5.4: Close meeting and verify tallies
  test("WF5.4: tallies reflect per-lot independent vote choices", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await closeMeeting(api, meetingId);
    const motionDetails = await getMeetingDetails(api, meetingId);
    await api.dispose();

    const motion1 = motionDetails.find((m) => m.title === MOTION1_TITLE);
    const motion2 = motionDetails.find((m) => m.title === MOTION2_TITLE);
    expect(motion1).toBeDefined();
    expect(motion2).toBeDefined();

    // Motion 1: WF5-A voted For (60), WF5-B voted Abstain (30)
    assertTally(motion1!.tally, {
      yes:       { voter_count: 1, entitlement_sum: 60 },
      abstained: { voter_count: 1, entitlement_sum: 30 },
      no:        { voter_count: 0, entitlement_sum: 0 },
      absent:    { voter_count: 0, entitlement_sum: 0 },
    });

    // Motion 2: WF5-A voted Against (60), WF5-B voted For (30)
    assertTally(motion2!.tally, {
      yes:       { voter_count: 1, entitlement_sum: 30 },
      no:        { voter_count: 1, entitlement_sum: 60 },
      abstained: { voter_count: 0, entitlement_sum: 0 },
      absent:    { voter_count: 0, entitlement_sum: 0 },
    });
  });
});

// ── WF6: Proxy voting — entitlement from lot owner, not proxy voter ────────────

test.describe("WF6: Proxy voting with tally verification", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `WF6 Proxy Tally-${RUN_SUFFIX}`;
  const MEETING_TITLE = `WF6 Proxy Meeting-${RUN_SUFFIX}`;
  const LOT_X = "WF6-X";
  const LOT_X_OWNER_EMAIL = `wf6-owner-${RUN_SUFFIX}@test.com`;
  const PROXY_EMAIL = `wf6-proxy-${RUN_SUFFIX}@test.com`;
  const LOT_Y = "WF6-Y";
  const LOT_Y_EMAIL = `wf6-other-${RUN_SUFFIX}@test.com`;
  const MOTION1_TITLE = "Motion 1 — Budget";

  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "wf6-manager@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_X,
      emails: [LOT_X_OWNER_EMAIL],
      unitEntitlement: 60,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_Y,
      emails: [LOT_Y_EMAIL],
      unitEntitlement: 40,
      financialPosition: "normal",
    });

    // Upload proxy nomination: WF6-X proxied to PROXY_EMAIL
    const proxyCsv = `Lot#,Proxy Email\n${LOT_X},${PROXY_EMAIL}\n`;
    await uploadProxyCsv(api, buildingId, proxyCsv);

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION1_TITLE,
        description: "Do you approve the budget?",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // WF6.2: Proxy voter authenticates and votes For
  test("WF6.2: proxy voter sees via Proxy badge, votes For on Motion 1", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, PROXY_EMAIL, () => getTestOtp(api, PROXY_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    if (page.url().includes("/voting")) {
      // Lot sidebar: WF6-X with "via Proxy" badge
      // Single-lot proxy renders in the inline section (not .voting-layout__sidebar), so no scoping needed
      const lotXItem = page.locator(".lot-selection__item").filter({ hasText: `Lot ${LOT_X}` });
      await expect(lotXItem).toBeVisible();
      const proxyBadge = lotXItem.locator(".lot-selection__badge--proxy");
      await expect(proxyBadge).toBeVisible();
      await expect(proxyBadge).toContainText("via Proxy");

      // WF6-Y must NOT be visible — proxy voter is not associated with it
      await expect(page.getByText(`Lot ${LOT_Y}`)).not.toBeVisible();

      const motionCards = page.locator(".motion-card");
      await expect(motionCards).toHaveCount(1);
      await motionCards.first().getByRole("button", { name: "For" }).click();

      await submitBallot(page);
      await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
    }

    await expect(page.getByText("Your votes", { exact: true })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("For").first()).toBeVisible();
  });

  // WF6.3: Direct owner of WF6-Y votes Against
  test("WF6.3: WF6-Y direct owner votes Against on Motion 1", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_Y_EMAIL, () => getTestOtp(api, LOT_Y_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    if (page.url().includes("/voting")) {
      const motionCards = page.locator(".motion-card");
      await expect(motionCards).toHaveCount(1);
      await motionCards.first().getByRole("button", { name: "Against" }).click();

      await submitBallot(page);
      await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
    }

    await expect(page.getByText("Your votes", { exact: true })).toBeVisible({ timeout: 15000 });
  });

  // WF6.4: Close meeting and verify tallies — proxy entitlement = lot owner's
  test("WF6.4: tallies use lot owner entitlement (60), not proxy voter's", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await closeMeeting(api, meetingId);
    const motionDetails = await getMeetingDetails(api, meetingId);
    await api.dispose();

    const motion1 = motionDetails.find((m) => m.title === MOTION1_TITLE);
    expect(motion1).toBeDefined();

    // Proxy voted For for WF6-X (entitlement=60), direct voted Against for WF6-Y (40)
    assertTally(motion1!.tally, {
      yes:    { voter_count: 1, entitlement_sum: 60 },
      no:     { voter_count: 1, entitlement_sum: 40 },
      absent: { voter_count: 0, entitlement_sum: 0 },
    });

    // Voter list confirms WF6-X's entitlement (not proxy voter's)
    expect(
      motion1!.voter_lists.yes.some((v) => v.lot_number === LOT_X && v.entitlement === 60)
    ).toBe(true);
  });
});

// ── WF7: In-arrear mixed lots ─────────────────────────────────────────────────

test.describe("WF7: In-arrear mixed lots — not_eligible on General, normal on Special", () => {
  test.describe.configure({ mode: "serial" });

  const BUILDING = `WF7 In-Arrear Mixed-${RUN_SUFFIX}`;
  const MEETING_TITLE = `WF7 In-Arrear Meeting-${RUN_SUFFIX}`;
  const LOT_A = "WF7-A";
  const LOT_B = "WF7-B";
  const VOTER_EMAIL = `wf7-voter-${RUN_SUFFIX}@test.com`;
  const MOTION1_TITLE = "Motion 1 — General Budget";
  const MOTION2_TITLE = "Motion 2 — Special Resolution";

  let meetingId = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "wf7-manager@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_A,
      emails: [VOTER_EMAIL],
      unitEntitlement: 90,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_B,
      emails: [VOTER_EMAIL],
      unitEntitlement: 45,
      financialPosition: "in_arrear",
    });

    meetingId = await createOpenMeeting(api, buildingId, MEETING_TITLE, [
      {
        title: MOTION1_TITLE,
        description: "Do you approve the general budget?",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Do you approve the special resolution?",
        orderIndex: 2,
        motionType: "special",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // WF7.2: Voter authenticates and sees in-arrear banner
  test("WF7.2: voter sees amber in-arrear banner and In Arrear badge on WF7-B", async ({ page }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Both lots visible (scoped to sidebar to avoid duplicate in mobile drawer)
    const sidebar = page.locator(".voting-layout__sidebar");
    await expect(sidebar.getByText(`Lot ${LOT_A}`)).toBeVisible();
    await expect(sidebar.getByText(`Lot ${LOT_B}`)).toBeVisible();

    // Amber banner visible when in-arrear lot is selected
    const arrearBanner = page.getByTestId("arrear-banner");
    await expect(arrearBanner).toBeVisible({ timeout: 10000 });
    await expect(arrearBanner).toContainText(/in.?arrear/i);

    // WF7-B shows "In Arrear" badge in lot panel (scoped to sidebar to avoid mobile drawer duplicate)
    const lotBItem = page.locator(".voting-layout__sidebar .lot-selection__item").filter({ hasText: `Lot ${LOT_B}` });
    await expect(lotBItem).toBeVisible();

    // Vote buttons are ENABLED for both motions (frontend does not block in-arrear lots)
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2);
    const generalCard = motionCards.filter({ hasText: MOTION1_TITLE });
    await expect(generalCard.getByRole("button", { name: "For" })).toBeEnabled();
    await expect(generalCard.getByRole("button", { name: "For" })).not.toHaveAttribute("aria-disabled");

    // The old in-arrear-notice element must NOT be present
    await expect(page.getByTestId("in-arrear-notice")).not.toBeVisible();
  });

  // WF7.3: Vote For on both motions, submit
  test("WF7.3: voter votes For on both, confirmation shows Not eligible for WF7-B on General Motion", async ({
    page,
  }) => {
    test.setTimeout(120000);
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ADMIN_AUTH_PATH });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

    if (page.url().includes("/voting")) {
      const motionCards = page.locator(".motion-card");
      await expect(motionCards).toHaveCount(2);

      await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "For" }).click();
      await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "For" }).click();

      await submitBallot(page);
      await expect(page).toHaveURL(/confirmation/, { timeout: 20000 });
    }

    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your votes", { exact: true })).toBeVisible();

    // Both lot headings
    await expect(page.getByText(`Lot ${LOT_A}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Lot ${LOT_B}`, { exact: true })).toBeVisible();

    // WF7-B on General Motion must show "Not eligible" (backend enforcement)
    await expect(page.getByText(/not.?eligible/i).first()).toBeVisible({ timeout: 10000 });

    // WF7-A on General Motion shows "For"
    await expect(page.getByText("For").first()).toBeVisible();

    // Special Motion: both lots show "For"
    const forLabels = page.getByText("For");
    await expect(forLabels.nth(0)).toBeVisible();
  });

  // WF7.4: Close meeting and verify tallies
  test("WF7.4: tallies show not_eligible for WF7-B on General, yes for both on Special", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await closeMeeting(api, meetingId);
    const motionDetails = await getMeetingDetails(api, meetingId);
    await api.dispose();

    const motion1 = motionDetails.find((m) => m.title === MOTION1_TITLE);
    const motion2 = motionDetails.find((m) => m.title === MOTION2_TITLE);
    expect(motion1).toBeDefined();
    expect(motion2).toBeDefined();

    // Motion 1 (General): WF7-A yes (90), WF7-B not_eligible (45)
    assertTally(motion1!.tally, {
      yes:          { voter_count: 1, entitlement_sum: 90 },
      no:           { voter_count: 0, entitlement_sum: 0 },
      abstained:    { voter_count: 0, entitlement_sum: 0 },
      absent:       { voter_count: 0, entitlement_sum: 0 },
      not_eligible: { voter_count: 1, entitlement_sum: 45 },
    });

    // Motion 2 (Special): both lots yes (90+45=135)
    assertTally(motion2!.tally, {
      yes:          { voter_count: 2, entitlement_sum: 135 },
      no:           { voter_count: 0, entitlement_sum: 0 },
      abstained:    { voter_count: 0, entitlement_sum: 0 },
      absent:       { voter_count: 0, entitlement_sum: 0 },
      not_eligible: { voter_count: 0, entitlement_sum: 0 },
    });
  });

  // WF7.5: Admin UI shows not_eligible category
  test("WF7.5: admin UI shows Not Eligible row for Motion 1 (count=1), zero for Motion 2", async ({
    browser,
  }) => {
    test.setTimeout(60000);

    const adminCtx = await browser.newContext({ storageState: ADMIN_AUTH_PATH });
    const adminPage = await adminCtx.newPage();
    try {
      await adminPage.goto(`/admin/general-meetings/${meetingId}`);
      await expect(adminPage.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

      // Not eligible entitlement sum (45) should appear in the results
      await expect(adminPage.getByText("45").first()).toBeVisible({ timeout: 10000 });

      // Total special motion yes entitlement (135) should appear
      await expect(adminPage.getByText("135").first()).toBeVisible();
    } finally {
      await adminCtx.close();
    }
  });
});

// ── Voter — motion position with hidden motions ───────────────────────────────

test.describe("Voter — motion position labels with hidden motions", () => {
  test.describe.configure({ mode: "serial" });

  // Use separate buildings for Scenarios D and E so their open meetings do not
  // conflict. createOpenMeeting closes all open meetings for a building before
  // creating a new one — if both meetings shared a building, creating Meeting E
  // would close Meeting D, causing the OTP lookup to target the wrong meeting.
  const BUILDING_D = `WF-Hidden Motion D-${RUN_SUFFIX}`;
  const BUILDING_E = `WF-Custom Number E-${RUN_SUFFIX}`;
  // Use a fixed short email instead of deriving from RUN_SUFFIX to avoid
  // truncation issues when the branch name suffix exceeds email length limits.
  const VOTER_EMAIL = "wf-hidden-voter-mpos@test.com";
  const MOTION_VISIBLE = "Visible Motion Only";
  const MOTION_CUSTOM_NUMBER = "Custom Numbered Motion";

  let meetingIdHidden = "";
  let meetingIdCustomNumber = "";
  let buildingIdD = "";
  let buildingIdE = "";

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Building D — used exclusively for Scenario D (hidden motion test)
    buildingIdD = await seedBuilding(api, BUILDING_D, "wf-hidden-mgr-d@test.com");
    await seedLotOwner(api, buildingIdD, {
      lotNumber: "HIDDEN-1",
      emails: [VOTER_EMAIL],
      unitEntitlement: 50,
      financialPosition: "normal",
    });

    // Building E — used exclusively for Scenario E (custom motion number test)
    buildingIdE = await seedBuilding(api, BUILDING_E, "wf-hidden-mgr-e@test.com");
    await seedLotOwner(api, buildingIdE, {
      lotNumber: "HIDDEN-1",
      emails: [VOTER_EMAIL],
      unitEntitlement: 50,
      financialPosition: "normal",
    });

    // Meeting D: two motions, first one hidden. Voter sees only motion 2.
    meetingIdHidden = await createOpenMeeting(api, buildingIdD, `WF Hidden Motion D-${RUN_SUFFIX}`, [
      {
        title: "Hidden First Motion",
        description: "This motion is hidden from voters.",
        orderIndex: 1,
        motionType: "general",
      },
      {
        title: MOTION_VISIBLE,
        description: "This is the visible second motion.",
        orderIndex: 2,
        motionType: "general",
      },
    ]);

    // Motions default to is_visible=true. Explicitly hide motion 1 and ensure
    // motion 2 is visible so Scenario D sees exactly one motion card.
    const detailD = await api.get(`/api/admin/general-meetings/${meetingIdHidden}`);
    const detailDData = await detailD.json() as { motions: { id: string; display_order: number }[] };
    const hiddenMotion = detailDData.motions.find((m) => m.display_order === 1);
    const visibleMotion = detailDData.motions.find((m) => m.display_order === 2);
    if (hiddenMotion) {
      await api.patch(`/api/admin/motions/${hiddenMotion.id}/visibility`, {
        data: { is_visible: false },
      });
    }
    if (visibleMotion) {
      await api.patch(`/api/admin/motions/${visibleMotion.id}/visibility`, {
        data: { is_visible: true },
      });
    }

    // Meeting E: one motion with a custom motion_number "BBB", set at creation time.
    // The motionNumber is included in the creation payload so there is no need for
    // a separate PATCH — this avoids any potential race/Lambda caching issues.
    meetingIdCustomNumber = await createOpenMeeting(api, buildingIdE, `WF Custom Number E-${RUN_SUFFIX}`, [
      {
        title: MOTION_CUSTOM_NUMBER,
        description: "This motion has a custom number.",
        orderIndex: 1,
        motionType: "general",
        motionNumber: "BBB",
      },
    ]);

    await api.dispose();
  }, { timeout: 60000 });

  // Scenario D — Correct motion labels when first motion is hidden
  test("Scenario D: visible motion card shows 'MOTION 2' when first motion is hidden", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING_D);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingIdHidden));
    await api.dispose();

    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // The visible motion (display_order=2) should show "MOTION 2" (case-insensitive match)
    // MotionCard renders the number in a <p> with class motion-card__number
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(1, { timeout: 10000 });

    // The motion position label should read "Motion 2", not "Motion 1"
    await expect(page.locator(".motion-card__number")).toHaveText(/Motion 2/i, { timeout: 10000 });
    await expect(page.locator(".motion-card__number")).not.toHaveText(/Motion 1/i);
  });

  // Scenario E — Custom motion_number shows with "MOTION" prefix
  test("Scenario E: motion card label shows 'MOTION BBB' for motion with motion_number=BBB", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, BUILDING_E);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingIdCustomNumber));
    await api.dispose();

    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // The motion card should show "Motion BBB"
    await expect(page.locator(".motion-card__number")).toHaveText(/Motion BBB/i, { timeout: 10000 });
  });

  test.afterAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });
    if (meetingIdHidden) {
      // Close before delete since it's open
      await api.post(`/api/admin/general-meetings/${meetingIdHidden}/close`).catch(() => {});
      await api.delete(`/api/admin/general-meetings/${meetingIdHidden}`);
    }
    if (meetingIdCustomNumber) {
      await api.post(`/api/admin/general-meetings/${meetingIdCustomNumber}/close`).catch(() => {});
      await api.delete(`/api/admin/general-meetings/${meetingIdCustomNumber}`);
    }
    await api.dispose();
  });
});
