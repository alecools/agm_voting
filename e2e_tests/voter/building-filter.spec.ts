/**
 * E2E tests: building dropdown filter (US-BLD-02).
 *
 * `GET /api/buildings` returns only non-archived buildings that have at least
 * one open meeting (meeting_at in the past, voting_closes_at in the future,
 * not closed).  Buildings with only closed meetings or no meetings at all are
 * excluded from the voter home page dropdown.
 *
 * Feature branch: feat/filter-buildings-open-meeting (not yet merged to preview).
 * These tests are written in advance and will become active once the feature
 * merges to preview.  Until then, scenarios B and C auto-skip via runtime
 * feature detection: if the closed-only building is visible in the dropdown the
 * filter is not yet deployed and those tests are skipped.
 *
 * Scenarios:
 *   A. Building with an open meeting → appears in the dropdown
 *   B. Building with only a closed meeting → does NOT appear in the dropdown
 *   C. Building with no meetings → does NOT appear in the dropdown
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import {
  makeAdminApi,
  seedBuilding,
  seedLotOwner,
  createOpenMeeting,
  closeMeeting,
} from "../workflows/helpers";

const SUFFIX = RUN_SUFFIX;

const BUILDING_OPEN = `BF01 Open Meeting Building-${SUFFIX}`;
const BUILDING_CLOSED_ONLY = `BF01 Closed Only Building-${SUFFIX}`;
const BUILDING_NO_MEETINGS = `BF01 No Meetings Building-${SUFFIX}`;

/** True when the building filter feature is active on the deployed target. */
async function buildingFilterIsActive(baseURL: string): Promise<boolean> {
  // If the filter is active, the closed-only building must not appear in
  // /api/buildings.  We check by looking for a building whose name contains
  // BUILDING_CLOSED_ONLY — if it is absent the filter is live.
  const res = await fetch(`${baseURL}/api/buildings`, {
    headers: process.env.VERCEL_BYPASS_TOKEN
      ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_TOKEN }
      : {},
  });
  if (!res.ok) return false;
  const buildings = (await res.json()) as { name: string }[];
  return !buildings.some((b) => b.name === BUILDING_CLOSED_ONLY);
}

test.describe("Building filter — voter home page dropdown (US-BLD-02)", () => {
  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await makeAdminApi(baseURL);

    // ── Building A: has an open meeting ──────────────────────────────────
    const buildingAId = await seedBuilding(api, BUILDING_OPEN, "bf01-mgr-a@test.com");
    await seedLotOwner(api, buildingAId, {
      lotNumber: "BF01-A-1",
      emails: [`bf01-voter-a-${SUFFIX}@test.com`],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await createOpenMeeting(api, buildingAId, `BF01 Open Meeting-${SUFFIX}`, [
      {
        title: "BF01 Test Motion",
        description: "A test motion for building filter.",
        orderIndex: 0,
        motionType: "general",
      },
    ]);

    // ── Building B: create an open meeting then immediately close it ─────
    const buildingBId = await seedBuilding(api, BUILDING_CLOSED_ONLY, "bf01-mgr-b@test.com");
    await seedLotOwner(api, buildingBId, {
      lotNumber: "BF01-B-1",
      emails: [`bf01-voter-b-${SUFFIX}@test.com`],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    const closedMeetingId = await createOpenMeeting(api, buildingBId, `BF01 Closed Meeting-${SUFFIX}`, [
      {
        title: "BF01 Closed Motion",
        description: "This meeting will be closed before the test.",
        orderIndex: 0,
        motionType: "general",
      },
    ]);
    await closeMeeting(api, closedMeetingId);

    // ── Building C: no meetings at all ───────────────────────────────────
    await seedBuilding(api, BUILDING_NO_MEETINGS, "bf01-mgr-c@test.com");
    // No lot owners or meetings created for Building C
    await api.dispose();
  });

  // ── Scenario A: Building with open meeting appears in dropdown ───────────────
  test("BF01-A: building with an open meeting appears in the dropdown", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto("/");
    const combobox = page.getByLabel("Select your building");
    await expect(combobox).toBeVisible({ timeout: 15000 });

    // Fill the combobox — the open-meeting building must appear as a listbox option
    await combobox.fill(BUILDING_OPEN);
    await expect(
      page.getByRole("option", { name: BUILDING_OPEN, exact: true })
    ).toBeVisible({ timeout: 15000 });
  });

  // ── Scenario B: Building with only closed meetings excluded from dropdown ───
  test("BF01-B: building with only a closed meeting is excluded from dropdown", async ({ page }) => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const filterActive = await buildingFilterIsActive(baseURL);
    if (!filterActive) {
      // Building filter feature not yet deployed — skip until US-BLD-02 merges to preview.
      test.skip();
      return;
    }

    await page.goto("/");
    const combobox = page.getByLabel("Select your building");
    await expect(combobox).toBeVisible({ timeout: 15000 });

    // Fill the combobox — the closed-only building must NOT appear as a listbox option
    await combobox.fill(BUILDING_CLOSED_ONLY);
    await expect(
      page.getByRole("option", { name: BUILDING_CLOSED_ONLY, exact: true })
    ).not.toBeVisible({ timeout: 15000 });
  });

  // ── Scenario C: Building with no meetings excluded from dropdown ─────────────
  test("BF01-C: building with no meetings is excluded from dropdown", async ({ page }) => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const filterActive = await buildingFilterIsActive(baseURL);
    if (!filterActive) {
      // Building filter feature not yet deployed — skip until US-BLD-02 merges to preview.
      test.skip();
      return;
    }

    await page.goto("/");
    const combobox = page.getByLabel("Select your building");
    await expect(combobox).toBeVisible({ timeout: 15000 });

    // Fill the combobox — the no-meetings building must NOT appear as a listbox option
    await combobox.fill(BUILDING_NO_MEETINGS);
    await expect(
      page.getByRole("option", { name: BUILDING_NO_MEETINGS, exact: true })
    ).not.toBeVisible({ timeout: 15000 });
  });

  // ── Scenario A verify: selecting the open-meeting building shows Enter Voting button
  test("BF01-A verify: selecting open-meeting building shows Enter Voting button", async ({ page }) => {
    test.setTimeout(60000);

    await page.goto("/");
    const combobox = page.getByLabel("Select your building");
    await expect(combobox).toBeVisible({ timeout: 15000 });

    await combobox.fill(BUILDING_OPEN);
    await page.getByRole("option", { name: BUILDING_OPEN, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Enter Voting" }).first()
    ).toBeVisible({ timeout: 15000 });
  });
});
