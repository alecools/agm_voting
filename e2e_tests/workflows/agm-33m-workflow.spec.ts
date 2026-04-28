/**
 * 33M Apartments AGM Full Workflow E2E Test
 *
 * End-to-end workflow test against the real "The Vale" building that is
 * permanently seeded in all deployment environments.
 *
 * This test creates a fresh meeting for each run (using RUN_SUFFIX for
 * uniqueness), walks through the full lifecycle:
 *
 *   - Admin creates meeting via UI with CSV motion import
 *   - Admin adds a multi-choice motion via the "Add Motion" modal
 *   - Motions are progressively revealed in batches
 *   - Voters (alecools@gmail.com, dunsgaard@live.com.au) vote across batches
 *   - Per-motion voting close is exercised
 *   - Admin in-person vote entry is used for some lots
 *   - Final tally is verified via admin API
 *
 * alecools@gmail.com  — 6 lots permanently seeded in The Vale
 * dunsgaard@live.com.au — has lot 7 in The Vale
 *
 * Both voter emails are permanently seeded in all deployment environments
 * and must not be created or deleted by this test.
 */

import { test, expect, RUN_SUFFIX } from "../fixtures";
import { request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  makeAdminApi,
  getMeetingDetails,
  assertTally,
  goToAuthPage,
  authenticateVoter,
  getTestOtp,
  submitBallot,
  clearBallots,
  withRetry,
} from "./helpers";
import type { MotionDetail } from "./helpers";

// Extended type that includes fields present in the API response but not in the
// helpers.ts MotionDetail type (which only declares the subset used by other tests).
type FullMotionDetail = MotionDetail & {
  is_visible: boolean;
  voting_closed_at: string | null;
  is_multi_choice: boolean;
};

/** Thin wrapper that casts getMeetingDetails result to FullMotionDetail[]. */
async function getFullMotions(
  api: Parameters<typeof getMeetingDetails>[0],
  meetingId: string
): Promise<FullMotionDetail[]> {
  return (await getMeetingDetails(api, meetingId)) as FullMotionDetail[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use admin session for page navigation (admin pages require auth)
test.use({ storageState: path.join(__dirname, "../.auth/admin.json") });

// ---------------------------------------------------------------------------
// Shared state — populated in beforeAll and step 1
// ---------------------------------------------------------------------------
let buildingId = "";
let meetingId = "";

// motion IDs keyed by display_order (1-indexed, matching CSV row numbers)
// display_order 1-15 = CSV motions, the MC motion appended last
let motionIds: Record<number, string> = {};

// ID of the multi-choice motion created in 33M.2; empty string if that step did not complete
let mcMotionId = "";

const MEETING_TITLE = `33M AGM Workflow-${RUN_SUFFIX}`;
const BUILDING_NAME = "The Vale";

const ALECOOLS_EMAIL = "alecools@gmail.com";
const DUNSGAARD_EMAIL = "dunsgaard@live.com.au";

const MC_TITLE = "Multi-Choice: Committee Nominations";
const MC_OPTIONS = [
  "Alice Brown",
  "Bob Chen",
  "Carol Davis",
  "David Evans",
  "Eva Fischer",
  "Frank Gomez",
  "Grace Han",
  "Henry Ibrahim",
  "Isla Jones",
];

// ---------------------------------------------------------------------------
// Helper: toggle a motion visibility via admin API
// ---------------------------------------------------------------------------
async function setMotionVisible(
  api: APIRequestContext,
  motionId: string,
  isVisible: boolean
): Promise<void> {
  const res = await api.patch(`/api/admin/motions/${motionId}/visibility`, {
    data: { is_visible: isVisible },
  });
  if (!res.ok()) {
    throw new Error(
      `Failed to set motion ${motionId} visibility to ${String(isVisible)} (${res.status()}): ${await res.text()}`
    );
  }
}

// ---------------------------------------------------------------------------
// beforeAll: find The Vale building, close any open/pending meetings
// ---------------------------------------------------------------------------
test.beforeAll(async () => {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);

  try {
    buildingId = await withRetry(async () => {
      const res = await api.get(
        `/api/admin/buildings?name=${encodeURIComponent(BUILDING_NAME)}`
      );
      if (!res.ok()) {
        throw new Error(
          `GET /api/admin/buildings returned ${res.status()}: ${await res.text()}`
        );
      }
      const buildings = (await res.json()) as { id: string; name: string }[];
      const building = buildings.find((b) => b.name === BUILDING_NAME);
      if (!building) {
        throw new Error(`Building "${BUILDING_NAME}" not found`);
      }
      return building.id;
    });

    // Close any open/pending meetings for The Vale so we can create a new one
    const agmsRes = await api.get(
      `/api/admin/general-meetings?building_id=${encodeURIComponent(buildingId)}&limit=100`
    );
    if (agmsRes.ok()) {
      const agms = (await agmsRes.json()) as {
        id: string;
        status: string;
      }[];
      for (const agm of agms.filter(
        (a) => a.status === "open" || a.status === "pending"
      )) {
        await api
          .post(`/api/admin/general-meetings/${agm.id}/close`)
          .catch(() => {}); // best-effort
      }
    }
  } finally {
    await api.dispose();
  }
}, { timeout: 120000 });

// ---------------------------------------------------------------------------
// afterAll: close + delete the test meeting
// ---------------------------------------------------------------------------
test.afterAll(async () => {
  if (!meetingId) return;
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    // Close (ignore 409 if already closed)
    await api
      .post(`/api/admin/general-meetings/${meetingId}/close`)
      .catch(() => {});
    // Delete
    await api.delete(`/api/admin/general-meetings/${meetingId}`).catch(() => {});
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 1: Create meeting via admin UI with CSV motion import
// ===========================================================================
test("33M.1: create meeting via admin UI with CSV motion import", async ({ page }) => {
  test.setTimeout(180000);

  const csvPath = path.join(__dirname, "../../examples/33M_Apartments_AGM_Motions.csv");

  await page.goto("/admin/general-meetings/new");
  await expect(page.getByRole("heading", { name: "Create General Meeting" })).toBeVisible({
    timeout: 15000,
  });

  // Select "The Vale" in the building combobox
  const buildingCombobox = page.locator("#agm-building");
  await buildingCombobox.fill(BUILDING_NAME);
  await page.getByRole("option", { name: BUILDING_NAME, exact: true }).click();

  // Fill title
  await page.locator("#agm-title").fill(MEETING_TITLE);

  // Fill meeting date: 1 hour in the past
  const meetingAt = await page.evaluate(() => {
    const d = new Date();
    d.setHours(d.getHours() - 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.locator("#agm-meeting-at").fill(meetingAt);

  // Fill voting closes at: 1 year in the future
  const closesAt = await page.evaluate(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  await page.locator("#agm-voting-closes-at").fill(closesAt);

  // Upload the motions CSV
  const fileInput = page.locator("#motion-excel-upload");
  await fileInput.setInputFiles(csvPath);

  // Wait for motion inputs to populate (CSV parse populates the motion editor)
  // The MotionEditor renders title inputs; wait for at least 15 to appear
  await expect(page.locator("input[id^='motion-title-'], .field__input").first()).toBeVisible({
    timeout: 15000,
  });
  // Brief pause for the CSV parse to fully populate all 15 motions
  await page.waitForTimeout(2000);

  // Submit the form
  await page.getByRole("button", { name: "Create General Meeting" }).click();

  // Wait for redirect to the created meeting's detail page.
  // Use a UUID pattern so we don't match the current /admin/general-meetings/new URL.
  await page.waitForURL(
    /\/admin\/general-meetings\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    { timeout: 60000 }
  );

  // Extract meeting ID from URL
  const url = page.url();
  const urlMatch = url.match(/\/admin\/general-meetings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  expect(urlMatch, "Expected URL to contain a valid meeting UUID").toBeTruthy();
  meetingId = urlMatch![1];

  // Verify heading is visible
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

  // Verify via admin API that at least 15 motions were created
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    const motions = await getFullMotions(api, meetingId);
    expect(
      motions.length,
      `Expected at least 15 motions from CSV import, got ${motions.length}`
    ).toBeGreaterThanOrEqual(15);

    // Populate motionIds map (display_order -> id)
    for (const m of motions) {
      motionIds[m.display_order] = m.id;
    }

    // Clear any stale ballots (idempotent)
    await clearBallots(api, meetingId);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 2: Add multi-choice motion with 9 options via admin UI
// ===========================================================================
test("33M.2: add multi-choice motion with 9 options and 3-vote limit via admin UI", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  await page.goto(`/admin/general-meetings/${meetingId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

  // Click "Add Motion" button
  await page.getByRole("button", { name: "Add Motion" }).click();

  // Wait for the Add Motion dialog
  await expect(page.getByRole("dialog", { name: "Add Motion" })).toBeVisible({ timeout: 10000 });

  // Fill title
  await page.locator("#add-motion-title").fill(MC_TITLE);

  // Fill description
  await page.locator("#add-motion-description").fill(
    "Select up to 3 nominees for the committee"
  );

  // Enable multi-choice
  await page.locator("#add-motion-is-multi-choice").check();

  // Set option limit to 3
  await page.locator("#add-option-limit").fill("3");

  // Fill the first 2 options (present by default)
  await page.getByRole("textbox", { name: "Option 1", exact: true }).fill(MC_OPTIONS[0]);
  await page.getByRole("textbox", { name: "Option 2", exact: true }).fill(MC_OPTIONS[1]);

  // Add 7 more options (total 9)
  for (let i = 2; i < MC_OPTIONS.length; i++) {
    await page.getByRole("button", { name: "+ Add option" }).click();
    await page.getByRole("textbox", { name: `Option ${i + 1}`, exact: true }).fill(MC_OPTIONS[i]);
  }

  // Save the motion
  await page.getByRole("button", { name: "Save Motion" }).click();

  // Wait for dialog to close
  await expect(page.getByRole("dialog", { name: "Add Motion" })).not.toBeVisible({ timeout: 15000 });

  // Verify multi-choice motion appears in the table with badge
  await expect(page.getByText("Multi-Choice (9)")).toBeVisible({ timeout: 15000 });

  // Fetch the updated motion list and store the MC motion ID
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    const motions = await getFullMotions(api, meetingId);
    const mcMotion = motions.find((m) => m.title === MC_TITLE);
    expect(mcMotion, `Multi-choice motion "${MC_TITLE}" not found`).toBeDefined();
    motionIds[mcMotion!.display_order] = mcMotion!.id;
    mcMotionId = mcMotion!.id;
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 3: Hide all motions, then make motions 1 and 2 visible
// ===========================================================================
test("33M.3: hide all motions, make motions 1 and 2 visible, verify exactly 2 visible", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    const allMotions = await getFullMotions(api, meetingId);

    // Hide all motions that have no votes yet
    for (const m of allMotions) {
      if (m.is_visible) {
        await setMotionVisible(api, m.id, false).catch(() => {
          // Skip if can't hide (e.g. has votes — shouldn't happen at this point)
        });
      }
    }

    // Make motions 1 and 2 visible
    if (motionIds[1]) await setMotionVisible(api, motionIds[1], true);
    if (motionIds[2]) await setMotionVisible(api, motionIds[2], true);

    // Verify exactly 2 motions visible
    const updatedMotions = await getFullMotions(api, meetingId);
    const visibleCount = updatedMotions.filter((m) => m.is_visible).length;
    expect(visibleCount, "Expected exactly 2 motions to be visible").toBe(2);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 4: Voter alecools logs in, sees 2 motions, votes for 3 of 6 lots
// ===========================================================================
test("33M.4: voter alecools logs in, sees 2 motions, votes for 3 of 6 lots", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  // Wait for 2 motion cards to load
  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(2, { timeout: 15000 });

  // Scope to sidebar to avoid mobile drawer duplicate
  const sidebar = page.locator(".voting-layout__sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10000 });

  // Confirm all 6 lots are pending
  await expect(sidebar.getByText(/voting for 6 lots/i)).toBeVisible({ timeout: 15000 });

  // Deselect lots 4, 5, 6 (0-indexed 3, 4, 5) — vote only for first 3
  // Wait for motion cards to ensure the re-seed effect has run before unchecking
  const lotCheckboxes = sidebar.locator('input[type="checkbox"]:not([disabled])');
  await expect(lotCheckboxes).toHaveCount(6, { timeout: 10000 });

  await lotCheckboxes.nth(3).uncheck();
  await lotCheckboxes.nth(4).uncheck();
  await lotCheckboxes.nth(5).uncheck();

  await expect(sidebar.getByText("You are voting for 3 lots.")).toBeVisible({ timeout: 10000 });

  // Vote For on motion 1, Against on motion 2
  await motionCards.nth(0).getByRole("button", { name: "For" }).click();
  await motionCards.nth(1).getByRole("button", { name: "Against" }).click();

  // Submit
  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
});

// ===========================================================================
// Step 5: Verify tally via admin API after first partial vote
// ===========================================================================
test("33M.5: check vote tallies after first partial vote — 3 yes on M1, 3 no on M2", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    const motions = await getFullMotions(api, meetingId);

    const m1 = motions.find((m) => m.display_order === 1);
    const m2 = motions.find((m) => m.display_order === 2);
    expect(m1, "Motion 1 not found").toBeDefined();
    expect(m2, "Motion 2 not found").toBeDefined();

    expect(m1!.tally.yes.voter_count, "Motion 1 yes votes after step 4").toBe(3);
    expect(m1!.tally.no.voter_count, "Motion 1 no votes should be 0").toBe(0);

    expect(m2!.tally.no.voter_count, "Motion 2 no votes after step 4").toBe(3);
    expect(m2!.tally.yes.voter_count, "Motion 2 yes votes should be 0").toBe(0);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 6: Make motions 3 and 4 visible (now 4 visible total)
// ===========================================================================
test("33M.6: admin makes motions 3 and 4 visible", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    if (motionIds[3]) await setMotionVisible(api, motionIds[3], true);
    if (motionIds[4]) await setMotionVisible(api, motionIds[4], true);

    const motions = await getFullMotions(api, meetingId);
    const visibleCount = motions.filter((m) => m.is_visible).length;
    expect(visibleCount, "Expected 4 visible motions").toBe(4);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 7: alecools votes all 6 lots — M3/M4 for all, M1/M2 for the 3 un-voted
// ===========================================================================
test("33M.7: voter alecools re-logs in, all lots unlock, submits for all 6 lots", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  // Wait for 4 motion cards
  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(4, { timeout: 20000 });

  const sidebar = page.locator(".voting-layout__sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10000 });

  // Select all lots (some may have been deselected from prev session)
  await sidebar.getByRole("button", { name: "Select All" }).click();
  await expect(sidebar.getByText(/voting for 6 lots/i)).toBeVisible({ timeout: 15000 });

  // Vote on M1 (For) and M2 (Against) for lots that haven't voted yet
  // Read-only motions will have disabled buttons; clicking enabled ones only
  const m1ForBtn = motionCards.nth(0).getByRole("button", { name: "For" }).first();
  const m2AgainstBtn = motionCards.nth(1).getByRole("button", { name: "Against" }).first();

  if (await m1ForBtn.isEnabled().catch(() => false)) {
    await m1ForBtn.click();
  }
  if (await m2AgainstBtn.isEnabled().catch(() => false)) {
    await m2AgainstBtn.click();
  }

  // Vote For on M3 and M4 (new, all lots can vote)
  await motionCards.nth(2).getByRole("button", { name: "For" }).click();
  await motionCards.nth(3).getByRole("button", { name: "For" }).click();

  // Submit
  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

  // Verify M3 and M4 now have 6 voters each
  const baseURL2 = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api2 = await makeAdminApi(baseURL2);
  try {
    const motions = await getFullMotions(api2, meetingId);
    const m3 = motions.find((m) => m.display_order === 3);
    const m4 = motions.find((m) => m.display_order === 4);
    expect(m3, "Motion 3 not found").toBeDefined();
    expect(m4, "Motion 4 not found").toBeDefined();
    expect(m3!.tally.yes.voter_count, "Motion 3 should have 6 yes votes").toBe(6);
    expect(m4!.tally.yes.voter_count, "Motion 4 should have 6 yes votes").toBe(6);
  } finally {
    await api2.dispose();
  }
});

// ===========================================================================
// Step 8: Admin makes motions 5 and 6 visible (now 6 visible)
// ===========================================================================
test("33M.8: admin makes motions 5 and 6 visible", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    if (motionIds[5]) await setMotionVisible(api, motionIds[5], true);
    if (motionIds[6]) await setMotionVisible(api, motionIds[6], true);

    const motions = await getFullMotions(api, meetingId);
    const visibleCount = motions.filter((m) => m.is_visible).length;
    expect(visibleCount, "Expected 6 visible motions").toBe(6);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 9: alecools votes 3 of 6 lots on M5 (For) and M6 (Against)
// ===========================================================================
test("33M.9: voter alecools votes 3 of 6 lots on motions 5 and 6", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(6, { timeout: 20000 });

  const sidebar = page.locator(".voting-layout__sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10000 });
  await expect(sidebar.getByText(/voting for 6 lots/i)).toBeVisible({ timeout: 15000 });

  // Deselect last 3 lots
  const lotCheckboxes = sidebar.locator('input[type="checkbox"]:not([disabled])');
  await expect(lotCheckboxes).toHaveCount(6, { timeout: 10000 });
  await lotCheckboxes.nth(3).uncheck();
  await lotCheckboxes.nth(4).uncheck();
  await lotCheckboxes.nth(5).uncheck();
  await expect(sidebar.getByText("You are voting for 3 lots.")).toBeVisible({ timeout: 10000 });

  // M1-M4 are read-only (all 6 lots voted). M5 and M6 are interactive.
  const m5Card = motionCards.nth(4);
  const m6Card = motionCards.nth(5);
  await m5Card.getByRole("button", { name: "For" }).click();
  await m6Card.getByRole("button", { name: "Against" }).click();

  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

  // Verify tallies
  const baseURL2 = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api2 = await makeAdminApi(baseURL2);
  try {
    const motions = await getFullMotions(api2, meetingId);
    const m5 = motions.find((m) => m.display_order === 5);
    const m6 = motions.find((m) => m.display_order === 6);
    expect(m5!.tally.yes.voter_count, "M5 should have 3 yes votes").toBe(3);
    expect(m6!.tally.no.voter_count, "M6 should have 3 no votes").toBe(3);
  } finally {
    await api2.dispose();
  }
});

// ===========================================================================
// Step 10: Admin closes voting for motion 5 via admin UI
// ===========================================================================
test("33M.10: admin closes voting for motion 5 via admin UI", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.skip(!motionIds[5], "Skipping: motionIds[5] not populated");
  test.setTimeout(180000);

  await page.goto(`/admin/general-meetings/${meetingId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

  const m5Id = motionIds[5];
  expect(m5Id, "Motion 5 ID must be known").toBeTruthy();

  // Click "Close Motion" for motion 5
  const closeBtn = page.getByTestId(`close-motion-btn-${m5Id}`);
  await expect(closeBtn).toBeVisible({ timeout: 10000 });
  await closeBtn.click();

  // Confirm
  const confirmDialog = page.getByTestId("close-motion-confirm-dialog");
  await expect(confirmDialog).toBeVisible({ timeout: 10000 });
  await page.getByTestId("close-motion-confirm-btn").click();
  await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });

  // "Voting Closed" badge should appear for motion 5
  await expect(page.getByTestId(`motion-voting-closed-badge-${m5Id}`)).toBeVisible({ timeout: 15000 });

  // Verify via API that voting_closed_at is set
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    const res = await api.get(`/api/admin/general-meetings/${meetingId}`);
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as {
      motions: { id: string; voting_closed_at: string | null }[];
    };
    const m5 = data.motions.find((m) => m.id === m5Id);
    expect(m5, "Motion 5 not in API response").toBeDefined();
    expect(m5!.voting_closed_at, "Motion 5 voting_closed_at should be set").not.toBeNull();
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 11: alecools re-logs in — remaining 3 lots can vote on M6 only (M5 closed)
// ===========================================================================
test("33M.11: voter alecools — remaining 3 lots vote on M6 only (M5 closed)", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(6, { timeout: 20000 });

  const sidebar = page.locator(".voting-layout__sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10000 });

  // Exactly 3 lots are pending (the ones that haven't voted on M5/M6 yet)
  await expect(sidebar.getByText(/voting for 3 lots/i)).toBeVisible({ timeout: 15000 });

  // M5 card (index 4) should show "Voting Closed"
  const m5Card = motionCards.nth(4);
  await expect(m5Card.getByText(/Voting Closed/i)).toBeVisible({ timeout: 10000 });

  // M6 is interactive — vote Against
  const m6Card = motionCards.nth(5);
  await m6Card.getByRole("button", { name: "Against" }).click();

  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

  // Verify: M6 now has 6 total voters, M5 still has 3
  const baseURL2 = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api2 = await makeAdminApi(baseURL2);
  try {
    const motions = await getFullMotions(api2, meetingId);
    const m5 = motions.find((m) => m.display_order === 5);
    const m6 = motions.find((m) => m.display_order === 6);
    expect(
      m5!.tally.yes.voter_count,
      "Motion 5 should still have only 3 yes votes"
    ).toBe(3);
    const m6TotalVoters =
      m6!.tally.yes.voter_count + m6!.tally.no.voter_count + m6!.tally.abstained.voter_count;
    expect(m6TotalVoters, "Motion 6 should have 6 total voters").toBe(6);
  } finally {
    await api2.dispose();
  }
});

// ===========================================================================
// Step 12: Admin makes the multi-choice motion visible
// ===========================================================================
test("33M.12: admin makes multi-choice motion visible", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.skip(!mcMotionId, "Skipping: multi-choice motion (33M.2) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    const motions = await getFullMotions(api, meetingId);
    const mcMotion = motions.find((m) => m.title === MC_TITLE);
    expect(mcMotion, "Multi-choice motion not found").toBeDefined();
    motionIds[mcMotion!.display_order] = mcMotion!.id;

    await setMotionVisible(api, mcMotion!.id, true);

    // Verify it is now visible
    const updated = await getFullMotions(api, meetingId);
    const mcUpdated = updated.find((m) => m.title === MC_TITLE);
    expect(mcUpdated!.is_visible, "Multi-choice motion should be visible").toBe(true);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 13: alecools votes MC for 3 lots — 3-option limit enforced in UI
// ===========================================================================
test("33M.13: voter alecools votes multi-choice for 3 lots with 3-option limit enforced", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.skip(!mcMotionId, "Skipping: multi-choice motion (33M.2) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  // 7 visible motions (M1-M6 + MC)
  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(7, { timeout: 20000 });

  const sidebar = page.locator(".voting-layout__sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10000 });
  await expect(sidebar.getByText(/voting for 6 lots/i)).toBeVisible({ timeout: 15000 });

  // Vote only for first 3 lots
  const lotCheckboxes = sidebar.locator('input[type="checkbox"]:not([disabled])');
  await expect(lotCheckboxes).toHaveCount(6, { timeout: 10000 });
  await lotCheckboxes.nth(3).uncheck();
  await lotCheckboxes.nth(4).uncheck();
  await lotCheckboxes.nth(5).uncheck();
  await expect(sidebar.getByText("You are voting for 3 lots.")).toBeVisible({ timeout: 10000 });

  // The MC motion is the last card
  const mcCard = motionCards.last();
  await expect(mcCard.getByText(MC_TITLE)).toBeVisible({ timeout: 10000 });

  // Vote "For" on first 3 options
  const forButtons = mcCard.getByRole("button", { name: "For" });
  await forButtons.nth(0).click();
  await forButtons.nth(1).click();
  await forButtons.nth(2).click();

  // After 3 "For" votes, the 4th "For" button should be disabled
  await expect(forButtons.nth(3)).toBeDisabled({ timeout: 5000 });

  // Vote "Against" on option 4
  const againstButtons = mcCard.getByRole("button", { name: "Against" });
  await againstButtons.nth(3).click();

  // Vote "Abstain" on option 5
  const abstainButtons = mcCard.getByRole("button", { name: "Abstain" });
  await abstainButtons.nth(4).click();

  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
});

// ===========================================================================
// Step 14: Admin makes motion 7 visible (8 visible total)
// ===========================================================================
test("33M.14: admin makes motion 7 visible", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    if (motionIds[7]) await setMotionVisible(api, motionIds[7], true);

    const motions = await getFullMotions(api, meetingId);
    const visibleCount = motions.filter((m) => m.is_visible).length;
    expect(visibleCount, "Expected 8 visible motions (M1-M6, MC, M7)").toBe(8);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 15: alecools votes all 6 lots on M7 and MC for remaining 3 lots
// ===========================================================================
test("33M.15: voter alecools votes all 6 lots on M7, MC for remaining 3 lots", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.skip(!mcMotionId, "Skipping: multi-choice motion (33M.2) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  // 8 visible motions
  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(8, { timeout: 20000 });

  const sidebar = page.locator(".voting-layout__sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10000 });
  await sidebar.getByRole("button", { name: "Select All" }).click();
  await expect(sidebar.getByText(/voting for 6 lots/i)).toBeVisible({ timeout: 15000 });

  // Find M7 card and MC card
  // Motions are ordered by display_order: M1-M6, then MC (display_order > 6 from CSV), then M7
  // Actually M7 from CSV is display_order=7, MC was appended so display_order=16
  // So the order is: M1(0), M2(1), M3(2), M4(3), M5(4), M6(5), M7(6), MC(7)
  const m7Card = motionCards.nth(6);
  const mcCard = motionCards.nth(7);

  // Vote For on M7 if interactive
  const m7ForBtn = m7Card.getByRole("button", { name: "For" }).first();
  if (await m7ForBtn.isEnabled().catch(() => false)) {
    await m7ForBtn.click();
  }

  // MC: first 3 lots already voted, last 3 haven't
  // Vote For on first 3 options for the remaining lots
  const mcForButtons = mcCard.getByRole("button", { name: "For" });
  if (await mcForButtons.nth(0).isEnabled().catch(() => false)) {
    await mcForButtons.nth(0).click();
    if (await mcForButtons.nth(1).isEnabled().catch(() => false)) {
      await mcForButtons.nth(1).click();
    }
    if (await mcForButtons.nth(2).isEnabled().catch(() => false)) {
      await mcForButtons.nth(2).click();
    }
  }

  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

  // Verify M7 has 6 yes voters
  const baseURL2 = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api2 = await makeAdminApi(baseURL2);
  try {
    const motions = await getFullMotions(api2, meetingId);
    const m7 = motions.find((m) => m.display_order === 7);
    expect(m7, "Motion 7 not found").toBeDefined();
    expect(m7!.tally.yes.voter_count, "Motion 7 should have 6 yes votes").toBe(6);
  } finally {
    await api2.dispose();
  }
});

// ===========================================================================
// Step 16: Admin makes motions 8 and 9 visible (10 visible total)
// ===========================================================================
test("33M.16: admin makes motions 8 and 9 visible", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    if (motionIds[8]) await setMotionVisible(api, motionIds[8], true);
    if (motionIds[9]) await setMotionVisible(api, motionIds[9], true);

    const motions = await getFullMotions(api, meetingId);
    const visibleCount = motions.filter((m) => m.is_visible).length;
    expect(visibleCount, "Expected 10 visible motions").toBe(10);
  } finally {
    await api.dispose();
  }
});

// ===========================================================================
// Step 17: alecools visits — sees M8/M9, signs out without voting
// ===========================================================================
test("33M.17: voter alecools visits, sees M8/M9 visible, signs out without voting", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, ALECOOLS_EMAIL, () =>
      getTestOtp(api, ALECOOLS_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

  // 10 visible motions (M1-M9 + MC)
  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(10, { timeout: 20000 });

  // Verify two new cards at positions 8 and 9 are visible
  await expect(motionCards.nth(8)).toBeVisible({ timeout: 10000 });
  await expect(motionCards.nth(9)).toBeVisible({ timeout: 10000 });

  // Sign out without voting
  await page.getByRole("button", { name: "Sign out" }).click();

  // Should be redirected to home page
  await expect(page.getByLabel("Select your building")).toBeVisible({ timeout: 15000 });
});

// ===========================================================================
// Step 18: dunsgaard logs in — lot 7, votes on all interactive motions
// ===========================================================================
test("33M.18: dunsgaard logs in, sees lot 7, votes on all interactive motions", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    await goToAuthPage(page, BUILDING_NAME);
    await authenticateVoter(page, DUNSGAARD_EMAIL, () =>
      getTestOtp(api, DUNSGAARD_EMAIL, meetingId)
    );
  } finally {
    await api.dispose();
  }

  await expect(page).toHaveURL(/vote\/.*\/(voting|confirmation)/, { timeout: 20000 });

  if (!page.url().includes("/voting")) {
    // Already submitted — confirm page shows ballot submitted
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    return;
  }

  // 10 visible motions
  const motionCards = page.locator(".motion-card");
  await expect(motionCards).toHaveCount(10, { timeout: 20000 });

  // Vote For on all interactive (non-read-only) motions for lot 7
  for (let i = 0; i < 10; i++) {
    const card = motionCards.nth(i);
    const forBtn = card.getByRole("button", { name: "For" }).first();
    if (await forBtn.isEnabled().catch(() => false)) {
      await forBtn.click();
    }
  }

  // For the MC motion (last card if visible), click up to 3 "For" buttons
  const mcCard = motionCards.last();
  if (await mcCard.getByText(MC_TITLE).isVisible().catch(() => false)) {
    const mcForButtons = mcCard.getByRole("button", { name: "For" });
    if (await mcForButtons.nth(0).isEnabled().catch(() => false)) {
      await mcForButtons.nth(0).click();
      if (await mcForButtons.nth(1).isEnabled().catch(() => false)) {
        await mcForButtons.nth(1).click();
      }
      if (await mcForButtons.nth(2).isEnabled().catch(() => false)) {
        await mcForButtons.nth(2).click();
      }
    }
  }

  await submitBallot(page);
  await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 30000 });
  await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
});

// ===========================================================================
// Step 19: Admin enters in-person votes for 2 available lots on visible motions
// ===========================================================================
test("33M.19: admin enters in-person votes for available lots", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  await page.goto(`/admin/general-meetings/${meetingId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

  // Click "Enter In-Person Votes"
  await page.getByRole("button", { name: "Enter In-Person Votes" }).click();

  // Wait for step-1 dialog
  await expect(
    page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })
  ).toBeVisible({ timeout: 15000 });

  const dialog1 = page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" });
  const availableCheckboxes = dialog1.locator('input[type="checkbox"]:not([disabled])');
  const checkboxCount = await availableCheckboxes.count();

  if (checkboxCount === 0) {
    // All lots submitted — close the dialog and skip
    await page.keyboard.press("Escape");
    return;
  }

  // Select up to 2 available lots
  await availableCheckboxes.nth(0).check();
  if (checkboxCount >= 2) {
    await availableCheckboxes.nth(1).check();
  }

  // Proceed to vote entry
  await page.getByRole("button", { name: /Proceed to vote entry/ }).click();

  const voteGrid = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
  await expect(voteGrid).toBeVisible({ timeout: 15000 });

  // Vote "yes" (For) for all available (enabled) buttons
  const allForButtons = voteGrid.getByRole("button", { name: /^yes for lot/ });
  const allForCount = await allForButtons.count();
  for (let i = 0; i < allForCount; i++) {
    const btn = allForButtons.nth(i);
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click();
    }
  }

  // Submit votes
  await voteGrid.getByRole("button", { name: "Submit votes" }).click();

  // Confirm dialog (aria-labelledby -> "Submit in-person votes?")
  await expect(page.getByRole("dialog", { name: /Submit in-person votes/ })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Confirm" }).click();

  // On success with no skips the panel closes; if skipped lots exist a "Done" inline button appears.
  const voteGridDialog = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
  const doneButton = page.getByRole("button", { name: "Done" });
  const doneBtnVisible = await doneButton.isVisible().catch(() => false);
  if (doneBtnVisible) {
    await doneButton.click();
  }
  await expect(voteGridDialog).not.toBeVisible({ timeout: 15000 });
});

// ===========================================================================
// Step 20: Make M10 visible, admin enters in-person votes
// ===========================================================================
test("33M.20: admin makes motion 10 visible, enters in-person votes", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    if (motionIds[10]) await setMotionVisible(api, motionIds[10], true);
    const motions = await getFullMotions(api, meetingId);
    const visibleCount = motions.filter((m) => m.is_visible).length;
    expect(visibleCount, "Expected 11 visible motions").toBe(11);
  } finally {
    await api.dispose();
  }

  await page.goto(`/admin/general-meetings/${meetingId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Enter In-Person Votes" }).click();
  await expect(
    page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })
  ).toBeVisible({ timeout: 15000 });

  const dialog1 = page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" });
  const availableCheckboxes = dialog1.locator('input[type="checkbox"]:not([disabled])');
  const checkboxCount = await availableCheckboxes.count();

  if (checkboxCount === 0) {
    await page.keyboard.press("Escape");
    return;
  }

  await availableCheckboxes.nth(0).check();
  await page.getByRole("button", { name: /Proceed to vote entry/ }).click();

  const voteGrid = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
  await expect(voteGrid).toBeVisible({ timeout: 15000 });

  const allForButtons = voteGrid.getByRole("button", { name: /^yes for lot/ });
  const allForCount = await allForButtons.count();
  for (let i = 0; i < allForCount; i++) {
    const btn = allForButtons.nth(i);
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click();
    }
  }

  await voteGrid.getByRole("button", { name: "Submit votes" }).click();
  await expect(page.getByRole("dialog", { name: /Submit in-person votes/ })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  const vgDialog20 = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
  const doneBtn20 = page.getByRole("button", { name: "Done" });
  if (await doneBtn20.isVisible().catch(() => false)) { await doneBtn20.click(); }
  await expect(vgDialog20).not.toBeVisible({ timeout: 15000 });
});

// ===========================================================================
// Step 21: Make M11/M12 visible, close M11 voting, enter votes for M12 only
// ===========================================================================
test("33M.21: admin makes M11/M12 visible, closes M11 voting, enters votes for M12", async ({ page }) => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.skip(!motionIds[11], "Skipping: motionIds[11] not populated");
  test.setTimeout(180000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    if (motionIds[11]) await setMotionVisible(api, motionIds[11], true);
    if (motionIds[12]) await setMotionVisible(api, motionIds[12], true);
  } finally {
    await api.dispose();
  }

  await page.goto(`/admin/general-meetings/${meetingId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });

  const m11Id = motionIds[11];
  expect(m11Id, "Motion 11 ID must be known").toBeTruthy();

  // Close M11 voting
  const closeBtn = page.getByTestId(`close-motion-btn-${m11Id}`);
  await expect(closeBtn).toBeVisible({ timeout: 10000 });
  await closeBtn.click();

  const confirmDialog = page.getByTestId("close-motion-confirm-dialog");
  await expect(confirmDialog).toBeVisible({ timeout: 10000 });
  await page.getByTestId("close-motion-confirm-btn").click();
  await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });

  // M11 should show "Voting Closed"
  await expect(page.getByTestId(`motion-voting-closed-badge-${m11Id}`)).toBeVisible({ timeout: 15000 });

  // Enter in-person votes
  await page.getByRole("button", { name: "Enter In-Person Votes" }).click();
  await expect(
    page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" })
  ).toBeVisible({ timeout: 15000 });

  const dialog1 = page.getByRole("dialog", { name: "Enter In-Person Votes — Select Lots" });
  const availableCheckboxes = dialog1.locator('input[type="checkbox"]:not([disabled])');
  const checkboxCount = await availableCheckboxes.count();

  if (checkboxCount === 0) {
    await page.keyboard.press("Escape");
    return;
  }

  await availableCheckboxes.nth(0).check();
  await page.getByRole("button", { name: /Proceed to vote entry/ }).click();

  const voteGrid = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
  await expect(voteGrid).toBeVisible({ timeout: 15000 });

  const allForButtons = voteGrid.getByRole("button", { name: /^yes for lot/ });
  const allForCount = await allForButtons.count();
  for (let i = 0; i < allForCount; i++) {
    const btn = allForButtons.nth(i);
    if (await btn.isEnabled().catch(() => false)) {
      await btn.click();
    }
  }

  await voteGrid.getByRole("button", { name: "Submit votes" }).click();
  await expect(page.getByRole("dialog", { name: /Submit in-person votes/ })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  const vgDialog21 = page.getByRole("dialog", { name: "Enter In-Person Votes — Vote Grid" });
  const doneBtn21 = page.getByRole("button", { name: "Done" });
  if (await doneBtn21.isVisible().catch(() => false)) { await doneBtn21.click(); }
  await expect(vgDialog21).not.toBeVisible({ timeout: 15000 });

  // Verify M11 has voting_closed_at set
  const baseURL2 = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api2 = await makeAdminApi(baseURL2);
  try {
    const res = await api2.get(`/api/admin/general-meetings/${meetingId}`);
    const data = (await res.json()) as {
      motions: { id: string; voting_closed_at: string | null }[];
    };
    const m11 = data.motions.find((m) => m.id === m11Id);
    expect(m11!.voting_closed_at, "M11 voting_closed_at should be set").not.toBeNull();
  } finally {
    await api2.dispose();
  }
});

// ===========================================================================
// Step 22: Final tally verification — close meeting and check all tallies
// ===========================================================================
test("33M.22: close meeting and verify final tally integrity", async () => {
  test.skip(!meetingId, "Skipping: meeting creation (33M.1) did not complete");
  test.setTimeout(60000);

  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
  const api = await makeAdminApi(baseURL);
  try {
    // Verify key tally invariants before closing
    const motionsBefore = await getFullMotions(api, meetingId);

    // M3: all 6 alecools lots voted For
    const m3 = motionsBefore.find((m) => m.display_order === 3);
    expect(m3, "Motion 3 not found").toBeDefined();
    assertTally(m3!.tally, {
      yes: { voter_count: 6 },
    });

    // M7: all 6 alecools lots voted For
    const m7 = motionsBefore.find((m) => m.display_order === 7);
    expect(m7, "Motion 7 not found").toBeDefined();
    assertTally(m7!.tally, {
      yes: { voter_count: 6 },
    });

    // M5: 3 yes votes from first batch, closed before remaining lots voted
    const m5 = motionsBefore.find((m) => m.display_order === 5);
    expect(m5, "Motion 5 not found").toBeDefined();
    assertTally(m5!.tally, {
      yes: { voter_count: 3 },
    });
    expect(m5!.voting_closed_at, "M5 should be closed").not.toBeNull();

    // M11: should be closed
    const m11 = motionsBefore.find((m) => m.display_order === 11);
    if (m11) {
      expect(m11.voting_closed_at, "M11 should be closed").not.toBeNull();
    }

    // Close the meeting
    const closeRes = await api.post(`/api/admin/general-meetings/${meetingId}/close`);
    // 409 is acceptable (meeting may already be closed if a prior step failed mid-run)
    if (!closeRes.ok() && closeRes.status() !== 409) {
      throw new Error(
        `Failed to close meeting (${closeRes.status()}): ${await closeRes.text()}`
      );
    }

    // Re-fetch after close — absent records now exist for non-voters
    const motionsAfter = await getFullMotions(api, meetingId);

    // All visible non-closed motions should have voters + absent accounting for all lots
    for (const m of motionsAfter.filter((m) => m.is_visible && !m.is_multi_choice)) {
      const totalVoters =
        m.tally.yes.voter_count +
        m.tally.no.voter_count +
        m.tally.abstained.voter_count +
        m.tally.not_eligible.voter_count +
        m.tally.absent.voter_count;
      expect(
        totalVoters,
        `Motion ${m.display_order} total voters after close should be > 0`
      ).toBeGreaterThan(0);
    }
  } finally {
    await api.dispose();
  }
});
