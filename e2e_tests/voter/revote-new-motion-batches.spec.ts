/**
 * E2E regression test: US-FIX-NM01-B
 *
 * Covers the BUG-NM-01-B fix: lots must remain unlocked on EVERY return to the
 * VotingPage after a new motion batch is revealed — not just the first time.
 *
 * Scenario (NMB): 3 batches of motions with 2 lots sharing the same email.
 *
 *   NMB.setup : seed building + 2 lots + open meeting with Motion 1
 *   NMB.1     : voter authenticates, votes Motion 1 for both lots → both lots
 *               navigate to confirmation ("Ballot submitted")
 *   NMB.2     : admin reveals Motion 2 → voter returns to VotingPage → both
 *               lots are UNLOCKED (checkbox enabled, no "Already submitted"
 *               badge), Motion 1 is read-only, Motion 2 is interactive
 *   NMB.3     : voter votes Motion 2 → both lots show "Already submitted"
 *   NMB.4     : admin reveals Motion 3 → voter returns to VotingPage → both
 *               lots UNLOCKED again, Motions 1+2 read-only, Motion 3
 *               interactive
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
} from "../workflows/helpers";

const BUILDING = `NMB Building-${RUN_SUFFIX}`;
const LOT_A = "NMB-A";
const LOT_B = "NMB-B";
const VOTER_EMAIL = `nmb-voter-${RUN_SUFFIX}@test.com`;
const MOTION1 = "NMB Motion 1 — Budget";
const MOTION2 = "NMB Motion 2 — Bylaws";
const MOTION3 = "NMB Motion 3 — Safety";

let meetingId = "";

test.describe("US-FIX-NM01-B: lots unlock on every new motion batch", () => {
  test.describe.configure({ mode: "serial" });

  // ── NMB.setup: seed building, 2 lots, meeting with Motion 1 ────────────────
  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, `nmb-mgr-${RUN_SUFFIX}@test.com`);

    // Both lots share the same voter email so a single auth sees both
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_A,
      emails: [VOTER_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_B,
      emails: [VOTER_EMAIL],
      unitEntitlement: 20,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, `NMB Meeting-${RUN_SUFFIX}`, [
      {
        title: MOTION1,
        description: "Do you approve the annual budget?",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // ── NMB.1: voter votes Motion 1 for both lots → confirmation ───────────────
  test("NMB.1: voter votes Motion 1 for both lots and lands on confirmation", async ({ page }) => {
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

    // Both lots should be pre-selected — vote on the single motion
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(1, { timeout: 15000 });
    await motionCards.first().getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── NMB.2: admin reveals Motion 2; voter returns — lots unlocked ───────────
  test("NMB.2: admin reveals Motion 2; voter returns and both lots are unlocked", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Admin adds and reveals Motion 2
    const addRes = await api.post(`/api/admin/general-meetings/${meetingId}/motions`, {
      data: {
        title: MOTION2,
        description: "Do you approve the bylaw change?",
        motion_type: "general",
      },
    });
    expect(addRes.ok(), `add motion 2: ${addRes.status()} ${await addRes.text()}`).toBe(true);
    const motion2 = (await addRes.json()) as { id: string; is_visible: boolean };
    expect(motion2.is_visible).toBe(false);

    const visRes = await api.patch(`/api/admin/motions/${motion2.id}/visibility`, {
      data: { is_visible: true },
    });
    expect(visRes.ok(), `visibility patch m2: ${visRes.status()} ${await visRes.text()}`).toBe(true);

    // Voter navigates from confirmation back to the voting page by re-authenticating
    await page.goto("/");
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();

    // Must land on /voting (not /confirmation) — Motion 2 is unvoted
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Two motions visible now
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2, { timeout: 15000 });

    // --- Key assertion (BUG-NM-01-B fix): both lots must be UNLOCKED ---
    // The sidebar lot list (not the mobile drawer) is the reliable target on desktop.
    // A lot is unlocked when its checkbox is enabled and there is no "Already submitted" badge.
    const sidebar = page.locator(".voting-layout__sidebar");

    const lotACheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_A}` }).locator('input[type="checkbox"]');
    const lotBCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_B}` }).locator('input[type="checkbox"]');

    await expect(lotACheckbox).toBeEnabled({ timeout: 10000 });
    await expect(lotBCheckbox).toBeEnabled({ timeout: 10000 });

    // No "Already submitted" badge on either lot item
    const submittedBadges = sidebar.getByText("Already submitted");
    await expect(submittedBadges).toHaveCount(0, { timeout: 5000 });

    // Motion 1 must be read-only (already voted badge present)
    await expect(
      motionCards.filter({ hasText: MOTION1 }).getByText("Already voted")
    ).toBeVisible({ timeout: 10000 });

    // Motion 2 must be interactive (For button enabled)
    const m2ForBtn = motionCards.filter({ hasText: MOTION2 }).getByRole("button", { name: "For" });
    await expect(m2ForBtn).not.toBeDisabled({ timeout: 10000 });

    // Submit ballot button must be visible (unvoted motion present)
    await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible({ timeout: 10000 });
  });

  // ── NMB.3: voter votes Motion 2 → confirmation ─────────────────────────────
  test("NMB.3: voter votes Motion 2 and lands on confirmation again", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await page.goto("/");
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();

    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Only Motion 2 should be interactive
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2, { timeout: 15000 });

    const m2Card = motionCards.filter({ hasText: MOTION2 });
    await m2Card.getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── NMB.4: admin reveals Motion 3; voter returns — lots unlocked AGAIN ──────
  test("NMB.4: admin reveals Motion 3; voter returns and both lots are STILL unlocked (second batch cycle)", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Admin adds and reveals Motion 3
    const addRes = await api.post(`/api/admin/general-meetings/${meetingId}/motions`, {
      data: {
        title: MOTION3,
        description: "Do you approve the safety policy?",
        motion_type: "general",
      },
    });
    expect(addRes.ok(), `add motion 3: ${addRes.status()} ${await addRes.text()}`).toBe(true);
    const motion3 = (await addRes.json()) as { id: string; is_visible: boolean };

    const visRes = await api.patch(`/api/admin/motions/${motion3.id}/visibility`, {
      data: { is_visible: true },
    });
    expect(visRes.ok(), `visibility patch m3: ${visRes.status()} ${await visRes.text()}`).toBe(true);

    // Voter re-authenticates (VotingPage unmounts and remounts — this is the critical case
    // for BUG-NM-01-B: the component re-mounts fresh but lots must still be unlocked)
    await page.goto("/");
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await api.dispose();

    // Must land on /voting (not /confirmation) — Motion 3 is unvoted
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Three motions visible now
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(3, { timeout: 15000 });

    // --- Key regression assertion ---
    // After the SECOND re-mount, both lots must STILL be unlocked.
    // BUG-NM-01-B caused this to fail on the second batch cycle.
    const sidebar = page.locator(".voting-layout__sidebar");

    const lotACheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_A}` }).locator('input[type="checkbox"]');
    const lotBCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_B}` }).locator('input[type="checkbox"]');

    await expect(lotACheckbox).toBeEnabled({ timeout: 10000 });
    await expect(lotBCheckbox).toBeEnabled({ timeout: 10000 });

    // No "Already submitted" badges
    const submittedBadges = sidebar.getByText("Already submitted");
    await expect(submittedBadges).toHaveCount(0, { timeout: 5000 });

    // Motions 1 and 2 must be read-only
    await expect(
      motionCards.filter({ hasText: MOTION1 }).getByText("Already voted")
    ).toBeVisible({ timeout: 10000 });
    await expect(
      motionCards.filter({ hasText: MOTION2 }).getByText("Already voted")
    ).toBeVisible({ timeout: 10000 });

    // Motion 3 must be interactive
    const m3ForBtn = motionCards.filter({ hasText: MOTION3 }).getByRole("button", { name: "For" });
    await expect(m3ForBtn).not.toBeDisabled({ timeout: 10000 });

    // Submit ballot button must still be visible
    await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible({ timeout: 10000 });

    // Complete the flow: vote and submit
    await m3ForBtn.click();
    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });
});
