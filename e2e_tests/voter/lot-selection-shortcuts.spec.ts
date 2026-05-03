/**
 * E2E tests: lot-selection shortcut buttons on the VotingPage.
 *
 * The VotingPage sidebar contains four shortcut buttons:
 *   - "Select All"        — checks all non-submitted lots
 *   - "Deselect All"      — unchecks all lots
 *   - "Select Proxy Lots" — checks only proxy lots (visible only when proxies exist)
 *   - "Select Owned Lots" — checks only owned lots (visible only when proxies exist)
 *
 * Seed: building with 3 lots sharing the same voter email:
 *   - Lot LS-A  (owned directly by the voter)
 *   - Lot LS-B  (owned directly by the voter)
 *   - Lot LS-C  (owned by a different email, proxied to the voter)
 *
 * Scenarios:
 *   LS.1: "Select All" selects all selectable lots
 *   LS.2: "Deselect All" unchecks all lots
 *   LS.3: "Select Proxy Lots" checks only proxy lots
 *   LS.4: "Select Owned Lots" checks only owned lots
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";
import {
  makeAdminApi,
  seedBuilding,
  seedLotOwner,
  uploadProxyCsv,
  createOpenMeeting,
  clearBallots,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
} from "../workflows/helpers";

const BUILDING = `LS Shortcuts Building-${RUN_SUFFIX}`;
const LOT_A = "LS-A";
const LOT_B = "LS-B";
const LOT_C = "LS-C";
const VOTER_EMAIL = `ls-voter-${RUN_SUFFIX}@test.com`;
const PROXY_OWNER_EMAIL = `ls-proxy-owner-${RUN_SUFFIX}@test.com`;

let meetingId = "";

test.describe("Lot-selection shortcut buttons", () => {
  // ── Seed ────────────────────────────────────────────────────────────────────
  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    const buildingId = await seedBuilding(api, BUILDING, `ls-mgr-${RUN_SUFFIX}@test.com`);

    // LS-A and LS-B: owned directly by the voter
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

    // LS-C: owned by a different person, proxied to the voter
    await seedLotOwner(api, buildingId, {
      lotNumber: LOT_C,
      emails: [PROXY_OWNER_EMAIL],
      unitEntitlement: 15,
      financialPosition: "normal",
    });
    await uploadProxyCsv(api, buildingId, `Lot#,Proxy Email\n${LOT_C},${VOTER_EMAIL}\n`);

    meetingId = await createOpenMeeting(api, buildingId, `LS Meeting-${RUN_SUFFIX}`, [
      {
        title: "LS Motion — Budget",
        description: "Do you approve the annual budget?",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  });

  // Helper: authenticate the voter and wait for the VotingPage to load.
  // Returns the page already on /voting.
  async function loginAndWaitForVotingPage(
    page: Parameters<Parameters<typeof test>[1]>[0],
    api: APIRequestContext
  ) {
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, VOTER_EMAIL, () => getTestOtp(api, VOTER_EMAIL, meetingId));
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });
    // Use networkidle so all lot data is rendered before we interact with checkboxes
    await page.waitForLoadState("networkidle");
  }

  // ── LS.1: "Select All" checks all selectable lots ──────────────────────────
  test("LS.1: Select All — all three lots become checked", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    await loginAndWaitForVotingPage(page, api);
    await api.dispose();

    const sidebar = page.locator(".voting-layout__sidebar");

    // Deselect all first so we start from a known state
    // Scope to sidebar to avoid matching the duplicate button in the hidden mobile drawer
    await sidebar.getByRole("button", { name: "Deselect all lots", exact: true }).click();

    const lotACheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_A}` }).locator('input[type="checkbox"]');
    const lotBCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_B}` }).locator('input[type="checkbox"]');
    const lotCCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_C}` }).locator('input[type="checkbox"]');

    await expect(lotACheckbox).not.toBeChecked({ timeout: 5000 });
    await expect(lotBCheckbox).not.toBeChecked({ timeout: 5000 });
    await expect(lotCCheckbox).not.toBeChecked({ timeout: 5000 });

    // Click "Select All"
    await sidebar.getByRole("button", { name: "Select all lots", exact: true }).click();

    // All three lots must now be checked
    await expect(lotACheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotBCheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotCCheckbox).toBeChecked({ timeout: 5000 });
  });

  // ── LS.2: "Deselect All" unchecks all lots ─────────────────────────────────
  test("LS.2: Deselect All — all three lots become unchecked", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    await loginAndWaitForVotingPage(page, api);
    await api.dispose();

    const sidebar = page.locator(".voting-layout__sidebar");

    // Ensure all are checked first (Select All)
    // Scope to sidebar to avoid matching the duplicate button in the hidden mobile drawer
    await sidebar.getByRole("button", { name: "Select all lots", exact: true }).click();

    const lotACheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_A}` }).locator('input[type="checkbox"]');
    const lotBCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_B}` }).locator('input[type="checkbox"]');
    const lotCCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_C}` }).locator('input[type="checkbox"]');

    await expect(lotACheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotBCheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotCCheckbox).toBeChecked({ timeout: 5000 });

    // Click "Deselect All"
    await sidebar.getByRole("button", { name: "Deselect all lots", exact: true }).click();

    // All three lots must now be unchecked
    await expect(lotACheckbox).not.toBeChecked({ timeout: 5000 });
    await expect(lotBCheckbox).not.toBeChecked({ timeout: 5000 });
    await expect(lotCCheckbox).not.toBeChecked({ timeout: 5000 });
  });

  // ── LS.3: "Select Proxy Lots" checks only proxy lots ──────────────────────
  test("LS.3: Select Proxy Lots — only proxy lot (LS-C) is checked", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    await loginAndWaitForVotingPage(page, api);
    await api.dispose();

    const sidebar = page.locator(".voting-layout__sidebar");

    // Start with all selected, then apply "Select Proxy Lots"
    // Scope to sidebar to avoid matching the duplicate button in the hidden mobile drawer
    await sidebar.getByRole("button", { name: "Select all lots", exact: true }).click();

    const lotACheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_A}` }).locator('input[type="checkbox"]');
    const lotBCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_B}` }).locator('input[type="checkbox"]');
    const lotCCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_C}` }).locator('input[type="checkbox"]');

    // "Select Proxy Lots" button is only shown when proxies exist
    // Scope to sidebar to avoid matching the duplicate button in the hidden mobile drawer
    const selectProxyBtn = sidebar.getByRole("button", { name: "Select proxy lots only" });
    await expect(selectProxyBtn).toBeVisible({ timeout: 10000 });
    await selectProxyBtn.click();

    // Only LOT_C (proxy) is checked; owned lots (LOT_A, LOT_B) are unchecked
    await expect(lotCCheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotACheckbox).not.toBeChecked({ timeout: 5000 });
    await expect(lotBCheckbox).not.toBeChecked({ timeout: 5000 });
  });

  // ── LS.4: "Select Owned Lots" checks only owned lots ──────────────────────
  test("LS.4: Select Owned Lots — only owned lots (LS-A, LS-B) are checked", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    await loginAndWaitForVotingPage(page, api);
    await api.dispose();

    const sidebar = page.locator(".voting-layout__sidebar");

    // Start from all selected
    // Scope to sidebar to avoid matching the duplicate button in the hidden mobile drawer
    await sidebar.getByRole("button", { name: "Select all lots", exact: true }).click();

    const lotACheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_A}` }).locator('input[type="checkbox"]');
    const lotBCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_B}` }).locator('input[type="checkbox"]');
    const lotCCheckbox = sidebar.locator('.lot-selection__item', { hasText: `Lot ${LOT_C}` }).locator('input[type="checkbox"]');

    // "Select Owned Lots" button is only shown when proxies exist
    // Scope to sidebar to avoid matching the duplicate button in the hidden mobile drawer
    const selectOwnedBtn = sidebar.getByRole("button", { name: "Select owned lots only" });
    await expect(selectOwnedBtn).toBeVisible({ timeout: 10000 });
    await selectOwnedBtn.click();

    // Owned lots (LOT_A, LOT_B) are checked; proxy lot (LOT_C) is unchecked
    await expect(lotACheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotBCheckbox).toBeChecked({ timeout: 5000 });
    await expect(lotCCheckbox).not.toBeChecked({ timeout: 5000 });
  });
});
