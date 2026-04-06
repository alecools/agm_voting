/**
 * E2E regression test: BUG-RV-01
 *
 * After a voter submits on all currently-visible motions, the admin reveals a
 * new motion.  On the voter's next login the submit button must reappear so
 * they can vote on the newly-visible motion.
 *
 * Steps:
 *   1. Seed building + AGM with 2 visible motions, one lot owner
 *   2. Voter submits votes on both motions
 *   3. Admin adds a 3rd motion to the meeting and makes it visible
 *   4. Voter re-authenticates in a fresh session
 *   5. Assert: voting page is shown (not confirmation) — submit button visible
 *   6. Voter votes on motion 3 and submits — lands on confirmation
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
  submitBallotViaApi,
  withRetry,
} from "../workflows/helpers";

const BUILDING = `RV01 Revote Building-${RUN_SUFFIX}`;
const LOT = "RV01-1";
const LOT_EMAIL = `rv01-voter-${RUN_SUFFIX}@test.com`;
const MOTION1_TITLE = "RV01 Motion 1 — Budget";
const MOTION2_TITLE = "RV01 Motion 2 — Bylaws";
const MOTION3_TITLE = "RV01 Motion 3 — New Item";

let meetingId = "";

test.describe("BUG-RV-01: submit button visible after admin reveals new motion", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const buildingId = await seedBuilding(api, BUILDING, "rv01-mgr@test.com");

    await seedLotOwner(api, buildingId, {
      lotNumber: LOT,
      emails: [LOT_EMAIL],
      unitEntitlement: 10,
      financialPosition: "normal",
    });

    meetingId = await createOpenMeeting(api, buildingId, `RV01 Meeting-${RUN_SUFFIX}`, [
      {
        title: MOTION1_TITLE,
        description: "Do you approve the annual budget?",
        orderIndex: 0,
        motionType: "general",
      },
      {
        title: MOTION2_TITLE,
        description: "Do you approve the bylaw change?",
        orderIndex: 1,
        motionType: "general",
      },
    ]);

    await clearBallots(api, meetingId);
    await api.dispose();
  }, { timeout: 60000 });

  // ── Step 1: voter submits on all 2 visible motions ─────────────────────────
  test("RV01.1: voter submits on both visible motions — lands on confirmation", async ({ page }) => {
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

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2);
    await motionCards.filter({ hasText: MOTION1_TITLE }).getByRole("button", { name: "For" }).click();
    await motionCards.filter({ hasText: MOTION2_TITLE }).getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── Step 2: admin adds + reveals a 3rd motion ──────────────────────────────
  test("RV01.2: admin adds a 3rd motion to the meeting and makes it visible", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Add a 3rd motion (new motions are created with is_visible=False)
    const addRes = await api.post(`/api/admin/general-meetings/${meetingId}/motions`, {
      data: {
        title: MOTION3_TITLE,
        description: "A newly added agenda item.",
        motion_type: "general",
      },
    });
    expect(addRes.ok(), `add motion: ${addRes.status()} ${await addRes.text()}`).toBe(true);
    const newMotion = (await addRes.json()) as { id: string; is_visible: boolean };
    expect(newMotion.is_visible).toBe(false);

    // Make the new motion visible
    const visRes = await api.patch(`/api/admin/motions/${newMotion.id}/visibility`, {
      data: { is_visible: true },
    });
    expect(visRes.ok(), `visibility patch: ${visRes.status()} ${await visRes.text()}`).toBe(true);
    const updated = (await visRes.json()) as { is_visible: boolean };
    expect(updated.is_visible).toBe(true);

    await api.dispose();
  });

  // ── Step 3: voter re-authenticates and sees submit button ──────────────────
  test("RV01.3: voter re-authenticates — submit button is visible for new motion", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Navigate to home first to clear any in-memory session state
    await page.goto("/");
    await expect(page).toHaveURL("/", { timeout: 10000 });

    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();

    // Must land on /voting (not /confirmation) — new motion is unvoted
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Three motions visible: 2 already-voted (read-only) + 1 new (interactive)
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(3);

    // Submit ballot button must be visible
    await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible({ timeout: 15000 });
  });

  // ── Step 4: voter votes on motion 3 and submits ────────────────────────────
  test("RV01.4: voter votes on motion 3 and submits — lands on confirmation", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await page.goto("/");
    await goToAuthPage(page, BUILDING);
    await authenticateVoter(page, LOT_EMAIL, () => getTestOtp(api, LOT_EMAIL, meetingId));
    await api.dispose();

    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Vote on the new motion — the previous 2 are read-only (already voted)
    const newMotionCard = page.locator(".motion-card").filter({ hasText: MOTION3_TITLE });
    await expect(newMotionCard).toBeVisible({ timeout: 15000 });
    await newMotionCard.getByRole("button", { name: "For" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WF9: Revote — motion locking (BUG-RV-03)
//
// After a voter submits motions 1–3 and an admin makes motion 4 visible,
// the voter re-authenticates. Motions 1–3 must be locked (show "Already voted"
// badge, have disabled vote buttons, pre-populated with original choices) because
// ALL selected lots have voted on them. Only motion 4 must be interactive.
// ═══════════════════════════════════════════════════════════════════════════════

const WF9_BUILDING = `WF9 Revote Lock Building-${RUN_SUFFIX}`;
const WF9_LOT = "WF9-1";
const WF9_EMAIL = `wf9-voter-${RUN_SUFFIX}@test.com`;
const WF9_MOTION1 = "WF9 Motion 1 — Budget";
const WF9_MOTION2 = "WF9 Motion 2 — Bylaws";
const WF9_MOTION3 = "WF9 Motion 3 — Safety";
const WF9_MOTION4 = "WF9 Motion 4 — New Item";

let wf9MeetingId = "";

test.describe("WF9: Revote — motion locking (BUG-RV-03)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    try {
      await withRetry(async () => {
        const buildingId = await seedBuilding(api, WF9_BUILDING, `wf9-mgr-${RUN_SUFFIX}@test.com`);

        await seedLotOwner(api, buildingId, {
          lotNumber: WF9_LOT,
          emails: [WF9_EMAIL],
          unitEntitlement: 10,
          financialPosition: "normal",
        });

        wf9MeetingId = await createOpenMeeting(api, buildingId, `WF9 Meeting-${RUN_SUFFIX}`, [
          { title: WF9_MOTION1, description: "Approve the annual budget.", orderIndex: 0, motionType: "general" },
          { title: WF9_MOTION2, description: "Approve the bylaw change.", orderIndex: 1, motionType: "general" },
          { title: WF9_MOTION3, description: "Approve the safety policy.", orderIndex: 2, motionType: "general" },
        ]);

        await clearBallots(api, wf9MeetingId);
      }, 6, 10000);  // 6 retries × 10s = up to 60s recovery time
    } finally {
      await api.dispose();
    }
  }, { timeout: 180000 });

  // ── Step 1: voter submits motions 1–3 ─────────────────────────────────────
  test("WF9.0: voter submits motions 1, 2, 3 with distinct choices", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, WF9_BUILDING);
    await authenticateVoter(page, WF9_EMAIL, () => getTestOtp(api, WF9_EMAIL, wf9MeetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(3);

    // Vote: Motion 1 → For, Motion 2 → Against, Motion 3 → Abstain
    await motionCards.filter({ hasText: WF9_MOTION1 }).getByRole("button", { name: "For" }).click();
    await motionCards.filter({ hasText: WF9_MOTION2 }).getByRole("button", { name: "Against" }).click();
    await motionCards.filter({ hasText: WF9_MOTION3 }).getByRole("button", { name: "Abstain" }).click();

    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── Step 2: admin adds and reveals motion 4 ───────────────────────────────
  test("WF9.setup: admin reveals motion 4", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    const addRes = await api.post(`/api/admin/general-meetings/${wf9MeetingId}/motions`, {
      data: {
        title: WF9_MOTION4,
        description: "A newly added agenda item.",
        motion_type: "general",
      },
    });
    expect(addRes.ok(), `add motion: ${addRes.status()} ${await addRes.text()}`).toBe(true);
    const newMotion = (await addRes.json()) as { id: string; is_visible: boolean };
    expect(newMotion.is_visible).toBe(false);

    const visRes = await api.patch(`/api/admin/motions/${newMotion.id}/visibility`, {
      data: { is_visible: true },
    });
    expect(visRes.ok(), `visibility patch: ${visRes.status()} ${await visRes.text()}`).toBe(true);

    await api.dispose();
  });

  // ── WF9.1: re-auth — ALL motions voted must be locked, motion 4 interactive ─
  test("WF9.1: re-auth — motions 1–3 locked (all selected lots voted on them), motion 4 interactive", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await page.goto("/");
    await goToAuthPage(page, WF9_BUILDING);
    await authenticateVoter(page, WF9_EMAIL, () => getTestOtp(api, WF9_EMAIL, wf9MeetingId));
    await api.dispose();

    // Must land on voting page (motion 4 is unvoted)
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(4, { timeout: 15000 });

    // Motions 1–3 must show "Already voted" badge (single lot — all selected lots have voted on them)
    await expect(motionCards.filter({ hasText: WF9_MOTION1 }).getByText("Already voted")).toBeVisible({ timeout: 10000 });
    await expect(motionCards.filter({ hasText: WF9_MOTION2 }).getByText("Already voted")).toBeVisible({ timeout: 10000 });
    await expect(motionCards.filter({ hasText: WF9_MOTION3 }).getByText("Already voted")).toBeVisible({ timeout: 10000 });

    // Motion 1 vote buttons must be disabled (read-only)
    const m1ForBtn = motionCards.filter({ hasText: WF9_MOTION1 }).getByRole("button", { name: "For" });
    await expect(m1ForBtn).toBeDisabled({ timeout: 10000 });
    // Motion 1's "For" button must be highlighted (pre-populated with original "yes" choice)
    await expect(m1ForBtn).toHaveAttribute("aria-pressed", "true");

    // Motion 2's "Against" button highlighted, disabled
    const m2NoBtn = motionCards.filter({ hasText: WF9_MOTION2 }).getByRole("button", { name: "Against" });
    await expect(m2NoBtn).toBeDisabled({ timeout: 10000 });
    await expect(m2NoBtn).toHaveAttribute("aria-pressed", "true");

    // Motion 3's "Abstain" button highlighted, disabled
    const m3AbstainBtn = motionCards.filter({ hasText: WF9_MOTION3 }).getByRole("button", { name: "Abstain" });
    await expect(m3AbstainBtn).toBeDisabled({ timeout: 10000 });
    await expect(m3AbstainBtn).toHaveAttribute("aria-pressed", "true");

    // Motion 4 must NOT show "Already voted" badge and must be interactive
    await expect(motionCards.filter({ hasText: WF9_MOTION4 }).getByText("Already voted")).not.toBeVisible();
    const m4ForBtn = motionCards.filter({ hasText: WF9_MOTION4 }).getByRole("button", { name: "For" });
    await expect(m4ForBtn).not.toBeDisabled();

    // Submit ballot button must be visible (one unvoted motion: motion 4)
    await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible({ timeout: 10000 });

    // Submit motion 4
    await m4ForBtn.click();
    await submitBallot(page);
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── WF9.2: re-auth again — all 4 motions now locked ──────────────────────
  test("WF9.2: after submitting motion 4, re-auth routes to confirmation (all 4 motions submitted)", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await page.goto("/");
    await goToAuthPage(page, WF9_BUILDING);
    await authenticateVoter(page, WF9_EMAIL, () => getTestOtp(api, WF9_EMAIL, wf9MeetingId));
    await api.dispose();

    // All 4 motions submitted → auth response has already_submitted=true → confirmation page
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WF10: Mixed selection warning (BUG-RV-05)
//
// When a multi-lot voter selects lots with different prior-vote coverage,
// a warning dialog must be shown before submitting.
// ═══════════════════════════════════════════════════════════════════════════════

const WF10_BUILDING = `WF10 Mixed Warning Building-${RUN_SUFFIX}`;
const WF10_LOT_A = "WF10-A";
const WF10_LOT_B = "WF10-B";
const WF10_EMAIL = `wf10-voter-${RUN_SUFFIX}@test.com`;
const WF10_MOTION1 = "WF10 Motion 1 — Budget";
const WF10_MOTION2 = "WF10 Motion 2 — Bylaws";

let wf10MeetingId = "";

test.describe("WF10: Mixed selection warning dialog (BUG-RV-05)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    try {
      await withRetry(async () => {
        const buildingId = await seedBuilding(api, WF10_BUILDING, `wf10-mgr-${RUN_SUFFIX}@test.com`);

        // Two lots with the same email
        await seedLotOwner(api, buildingId, {
          lotNumber: WF10_LOT_A,
          emails: [WF10_EMAIL],
          unitEntitlement: 10,
          financialPosition: "normal",
        });
        await seedLotOwner(api, buildingId, {
          lotNumber: WF10_LOT_B,
          emails: [WF10_EMAIL],
          unitEntitlement: 20,
          financialPosition: "normal",
        });

        wf10MeetingId = await createOpenMeeting(api, buildingId, `WF10 Meeting-${RUN_SUFFIX}`, [
          { title: WF10_MOTION1, description: "Approve the budget.", orderIndex: 0, motionType: "general" },
        ]);

        await clearBallots(api, wf10MeetingId);
      }, 6, 10000);  // 6 retries × 10s = up to 60s recovery time
    } finally {
      await api.dispose();
    }
  }, { timeout: 180000 });

  // ── Step 1: Lot A submits motion 1, Lot B does NOT ─────────────────────────
  test("WF10.0: Lot A submits motion 1 (Lot B deselected)", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    await goToAuthPage(page, WF10_BUILDING);
    await authenticateVoter(page, WF10_EMAIL, () => getTestOtp(api, WF10_EMAIL, wf10MeetingId));
    await api.dispose();
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });
    // Wait for the page to finish loading before interacting (resilience against transient
    // net::ERR_NETWORK_CHANGED errors that can cause checkboxes to not yet be in the DOM)
    await page.waitForLoadState("networkidle");

    // Deselect Lot B — only Lot A will be submitted.
    // Two instances of the checkbox exist: the mobile drawer (display:none on desktop, DOM-first)
    // and the sidebar (visible on desktop, DOM-last). Use .last() to target the visible sidebar
    // instance so Playwright can interact with it on the Desktop Chrome project viewport.
    const lotBCheckbox = page.locator(".voting-layout__sidebar").locator('.lot-selection__item', { hasText: `Lot ${WF10_LOT_B}` }).locator('input[type="checkbox"]');
    await expect(lotBCheckbox).toBeVisible({ timeout: 15000 });
    await lotBCheckbox.uncheck();

    // Vote on the motion for Lot A only
    const motionCard = page.locator(".motion-card").first();
    await expect(motionCard).toBeVisible({ timeout: 15000 });
    await motionCard.getByRole("button", { name: "For" }).click();

    await page.getByRole("button", { name: "Submit ballot" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Submit ballot" }).last().click();

    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── Step 2: admin reveals a 2nd motion ────────────────────────────────────
  test("WF10.setup: admin reveals motion 2", async () => {
    test.setTimeout(60000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // Idempotent: check whether Motion 2 already exists on this meeting (e.g. from
    // a previous retry that partially succeeded). If it already exists, just ensure
    // it is visible. If it does not exist, add it then make it visible.
    const meetingRes = await api.get(`/api/admin/general-meetings/${wf10MeetingId}`);
    expect(meetingRes.ok(), `get meeting: ${meetingRes.status()} ${await meetingRes.text()}`).toBe(true);
    const meetingDetail = (await meetingRes.json()) as { motions?: { id: string; title: string; is_visible: boolean }[] };
    const existingM2 = meetingDetail.motions?.find((m) => m.title === WF10_MOTION2);

    let motionId: string;
    if (existingM2) {
      // Motion 2 already exists — reuse its ID
      motionId = existingM2.id;
    } else {
      const addRes = await api.post(`/api/admin/general-meetings/${wf10MeetingId}/motions`, {
        data: {
          title: WF10_MOTION2,
          description: "Approve the bylaws.",
          motion_type: "general",
        },
      });
      expect(addRes.ok(), `add motion: ${addRes.status()} ${await addRes.text()}`).toBe(true);
      motionId = ((await addRes.json()) as { id: string }).id;
    }

    // Ensure the motion is visible (idempotent — PATCH to true is safe even if already true)
    const visRes = await api.patch(`/api/admin/motions/${motionId}/visibility`, {
      data: { is_visible: true },
    });
    expect(visRes.ok(), `visibility patch: ${visRes.status()} ${await visRes.text()}`).toBe(true);

    await api.dispose();
  });

  // ── WF10.1: voter re-authenticates — mixed warning shown ──────────────────
  test("WF10.1: voter re-authenticates with mixed lots — warning shown, Continue proceeds to submit", async ({ page }) => {
    test.setTimeout(120000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // ── Reset to the exact prerequisite state: LotA voted M1, LotB has not voted ──
    // This makes WF10.1 idempotent across retries. If a previous attempt of WF10.1
    // (or WF10.0) already submitted both lots, we clear ballots and re-seed LotA's
    // M1 vote so the mixed-selection precondition is always guaranteed.
    //
    // The backend records abstain for ALL visible motions not supplied in the submission
    // request. To avoid LotA inadvertently being recorded as having voted M2, we
    // temporarily hide M2, submit LotA's M1 vote, then re-show M2.
    //
    // Step 1: clear all ballots for this meeting
    await clearBallots(api, wf10MeetingId);

    // Step 2: fetch the meeting motions to find Motion 1 and Motion 2 IDs
    const meetingRes = await api.get(`/api/admin/general-meetings/${wf10MeetingId}`);
    expect(meetingRes.ok(), `get meeting: ${meetingRes.status()} ${await meetingRes.text()}`).toBe(true);
    const meetingDetail = (await meetingRes.json()) as {
      motions?: { id: string; title: string; is_visible: boolean }[];
    };
    const motion1 = meetingDetail.motions?.find((m) => m.title === WF10_MOTION1);
    expect(motion1, `Motion 1 ("${WF10_MOTION1}") not found on meeting`).toBeTruthy();
    const motion1Id = motion1!.id;
    const motion2 = meetingDetail.motions?.find((m) => m.title === WF10_MOTION2);
    expect(motion2, `Motion 2 ("${WF10_MOTION2}") not found on meeting`).toBeTruthy();
    const motion2Id = motion2!.id;

    // Step 3: temporarily hide Motion 2 so the backend does not record an abstain for it
    // when we submit LotA's M1 vote
    const hideRes = await api.patch(`/api/admin/motions/${motion2Id}/visibility`, {
      data: { is_visible: false },
    });
    expect(hideRes.ok(), `hide motion 2: ${hideRes.status()} ${await hideRes.text()}`).toBe(true);

    // Step 4: fetch lot owners to find Lot A's ID
    const buildingsRes = await api.get("/api/admin/buildings?limit=1000");
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    const wf10Building = buildings.find((b) => b.name === WF10_BUILDING);
    expect(wf10Building, `WF10 building not found`).toBeTruthy();
    const lotsRes = await api.get(`/api/admin/buildings/${wf10Building!.id}/lot-owners`);
    const lots = (await lotsRes.json()) as { id: string; lot_number: string }[];
    const lotA = lots.find((l) => l.lot_number === WF10_LOT_A);
    expect(lotA, `Lot A (${WF10_LOT_A}) not found`).toBeTruthy();

    // Step 5: submit LotA's "yes" vote on M1 via API (re-creates WF10.0's outcome)
    // With M2 hidden, only M1 is recorded — no abstain for M2
    await submitBallotViaApi(api, WF10_EMAIL, wf10MeetingId, [lotA!.id], [
      { motion_id: motion1Id, choice: "yes" },
    ]);

    // Step 6: re-show Motion 2 so the voter sees both motions on the voting page
    const showRes = await api.patch(`/api/admin/motions/${motion2Id}/visibility`, {
      data: { is_visible: true },
    });
    expect(showRes.ok(), `re-show motion 2: ${showRes.status()} ${await showRes.text()}`).toBe(true);

    await page.goto("/");
    await goToAuthPage(page, WF10_BUILDING);
    await authenticateVoter(page, WF10_EMAIL, () => getTestOtp(api, WF10_EMAIL, wf10MeetingId));
    await api.dispose();

    // Both lots are unsubmitted (Lot A has motion 1 voted but not motion 2; Lot B has nothing voted)
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Both motions should be visible and interactive (Lot B has not voted on motion 1)
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2, { timeout: 15000 });

    // LotA previously voted "yes" on Motion 1 — the UI pre-seeds choices[M1] = "yes" from
    // already_voted data. Clicking "For" when it is already selected would deselect it, so we
    // only click "For" on Motion 1 if it is not already in the pressed state.
    const m1ForBtn = motionCards.filter({ hasText: WF10_MOTION1 }).getByRole("button", { name: "For" });
    await expect(m1ForBtn).toBeVisible({ timeout: 10000 });
    const m1Pressed = await m1ForBtn.getAttribute("aria-pressed");
    if (m1Pressed !== "true") {
      await m1ForBtn.click();
    }
    // Vote "For" on Motion 2 (neither lot has voted on it)
    await motionCards.filter({ hasText: WF10_MOTION2 }).getByRole("button", { name: "For" }).click();

    // Click Submit ballot
    await page.getByRole("button", { name: "Submit ballot" }).click();

    // Mixed selection warning must appear (Lot A has voted on motion 1, Lot B has not)
    await expect(page.getByRole("heading", { name: "Mixed voting history" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/previously submitted votes will not be changed/)).toBeVisible();

    // Click Continue
    await page.getByRole("button", { name: "Continue" }).click();

    // SubmitDialog should now appear
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10000 });
    // The SubmitDialog appears (with confirmation or unanswered message)
    // Confirm submission
    await page.getByRole("button", { name: "Submit ballot" }).last().click();

    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
  });

  // ── WF10.2: mixed warning — voter goes back ────────────────────────────────
  // This test seeds its own independent data (WF10-C / WF10-D lots) so it is
  // not affected by WF10.1 having consumed all submission state for Lot A / Lot B.
  //
  // Setup (done inside the test via browser + API):
  //   1. Seed a new building + two lots (WF10-C, WF10-D) with the same email
  //   2. Voter authenticates, deselects Lot D, votes on motion 1 for Lot C only, submits
  //   3. Admin reveals motion 2 via API
  //   4. Voter re-authenticates — both lots selected, mixed state → warning dialog appears
  //   5. Click "Go back" — warning dismissed, still on voting page
  test("WF10.2: voter clicks Go back from warning — returns to voting page without submitting", async ({ page }) => {
    test.setTimeout(180000);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: ADMIN_AUTH_PATH,
    });

    // ── Seed independent data for WF10.2 ──────────────────────────────────
    const wf102Email = `wf10b-voter-${RUN_SUFFIX}@test.com`;
    const wf102LotC = "WF10-C";
    const wf102LotD = "WF10-D";
    const wf102Motion1 = "WF10B Motion 1 — Budget";
    const wf102Motion2 = "WF10B Motion 2 — Bylaws";
    const wf102Building = `WF10B Mixed Warning Building-${RUN_SUFFIX}`;

    const buildingId = await seedBuilding(api, wf102Building, `wf10b-mgr-${RUN_SUFFIX}@test.com`);

    await seedLotOwner(api, buildingId, {
      lotNumber: wf102LotC,
      emails: [wf102Email],
      unitEntitlement: 10,
      financialPosition: "normal",
    });
    await seedLotOwner(api, buildingId, {
      lotNumber: wf102LotD,
      emails: [wf102Email],
      unitEntitlement: 20,
      financialPosition: "normal",
    });

    const wf102MeetingId = await createOpenMeeting(api, buildingId, `WF10B Meeting-${RUN_SUFFIX}`, [
      { title: wf102Motion1, description: "Approve the budget.", orderIndex: 0, motionType: "general" },
    ]);

    await clearBallots(api, wf102MeetingId);

    // ── Step 1: authenticate and submit Lot C only (deselect Lot D) via browser ──
    await goToAuthPage(page, wf102Building);
    await authenticateVoter(page, wf102Email, () => getTestOtp(api, wf102Email, wf102MeetingId));
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Wait for motion cards to load BEFORE unchecking Lot D.
    // The VotingPage has a [motions, allLots] effect that re-seeds selectedIds whenever
    // motions load for the first time. If the uncheck happens before that effect runs,
    // the effect re-adds Lot D (it has no submitted ballot) and both lots get submitted.
    // Waiting for the motion card to be visible first ensures the re-seed has already run.
    const motionCardStep1 = page.locator(".motion-card").first();
    await expect(motionCardStep1).toBeVisible({ timeout: 15000 });

    // Deselect Lot D so only Lot C is submitted
    const lotDCheckbox = page.locator(".voting-layout__sidebar").locator('.lot-selection__item', { hasText: `Lot ${wf102LotD}` }).locator('input[type="checkbox"]');
    await expect(lotDCheckbox).toBeVisible({ timeout: 15000 });
    await lotDCheckbox.uncheck();

    // Vote on motion 1 for Lot C only and submit
    await motionCardStep1.getByRole("button", { name: "For" }).click();

    await page.getByRole("button", { name: "Submit ballot" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Submit ballot" }).last().click();

    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });

    // ── Step 2: admin reveals motion 2 via API ─────────────────────────────
    const addRes = await api.post(`/api/admin/general-meetings/${wf102MeetingId}/motions`, {
      data: { title: wf102Motion2, description: "Approve the bylaws.", motion_type: "general" },
    });
    expect(addRes.ok(), `add motion: ${addRes.status()} ${await addRes.text()}`).toBe(true);
    const newMotion = (await addRes.json()) as { id: string };

    const visRes = await api.patch(`/api/admin/motions/${newMotion.id}/visibility`, {
      data: { is_visible: true },
    });
    expect(visRes.ok(), `visibility patch: ${visRes.status()} ${await visRes.text()}`).toBe(true);

    // ── Step 3: voter re-authenticates — mixed state → warning shown ───────
    await page.goto("/");
    await goToAuthPage(page, wf102Building);
    await authenticateVoter(page, wf102Email, () => getTestOtp(api, wf102Email, wf102MeetingId));
    await api.dispose();

    // Both lots are selected; Lot C has voted on motion 1 but Lot D has not
    // → mixed state → voter lands on voting page
    await expect(page).toHaveURL(/vote\/.*\/voting/, { timeout: 20000 });

    // Vote on both motions — use name filters to avoid matching hidden mobile drawer duplicates
    const motionCards = page.locator(".motion-card");
    await expect(motionCards).toHaveCount(2, { timeout: 15000 });

    // Lot C previously voted "yes" on Motion 1 — the UI pre-seeds choices[M1] = "yes" from
    // already_voted data. Clicking "For" when it is already selected would deselect it, so we
    // only click "For" on Motion 1 if it is not already in the pressed state.
    const m1ForBtn = motionCards.filter({ hasText: wf102Motion1 }).getByRole("button", { name: "For" });
    await expect(m1ForBtn).toBeVisible({ timeout: 10000 });
    const m1Pressed = await m1ForBtn.getAttribute("aria-pressed");
    if (m1Pressed !== "true") {
      await m1ForBtn.click();
    }
    // Vote "For" on Motion 2 (neither lot has voted on it)
    await motionCards.filter({ hasText: wf102Motion2 }).getByRole("button", { name: "For" }).click();

    // Trigger mixed warning
    await page.getByRole("button", { name: "Submit ballot" }).click();
    await expect(page.getByRole("heading", { name: "Mixed voting history" })).toBeVisible({ timeout: 10000 });

    // ── Step 4: click Go back — warning dismissed, still on voting page ────
    await page.getByRole("button", { name: "Go back to lot selection" }).click();

    // Warning should be dismissed; still on voting page
    await expect(page.getByRole("heading", { name: "Mixed voting history" })).not.toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/vote\/.*\/voting/);
    // Submit ballot button still visible
    await expect(page.getByRole("button", { name: "Submit ballot" })).toBeVisible({ timeout: 5000 });
  });
});
