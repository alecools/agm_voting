/**
 * Functional test: closed meeting voter journey.
 *
 * Tests the complete voter experience when a meeting is closed — not just
 * button visibility, but the full auth → confirmation flow for two cases:
 *
 * 1. Voter who submitted a ballot before the meeting was closed:
 *    auth → agm_status:"closed" → redirected directly to confirmation →
 *    their votes are shown, no submit button is present.
 *
 * 2. Voter who never submitted, accessing a closed AGM:
 *    auth → agm_status:"closed" → redirected to confirmation →
 *    confirmation shows "You did not submit a ballot for this meeting."
 *
 * Self-contained — seeds its own building, lot owners, AGM, and ballots via
 * the admin/voter API so it does not interfere with other E2E tests.
 *
 * Auth flow behaviour (confirmed from source):
 *   - POST /api/auth/verify returns agm_status:"closed" for closed meetings
 *   - AuthPage.onSuccess: if agm_status === "closed" || allSubmitted →
 *       navigate(`/vote/${meetingId}/confirmation`)
 *   - ConfirmationPage fetches GET /api/general-meeting/{id}/my-ballot
 *     (requires session cookie set by auth/verify)
 *   - If no ballot found → renders "You did not submit a ballot for this meeting."
 *   - If ballot found → renders "Ballot submitted" heading with recorded votes
 *
 * No submit button should be present on either confirmation path because
 * we arrive via /confirmation directly (not /voting).
 */

import { test, expect } from "./fixtures";
import { request as playwrightRequest } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILDING_NAME = "E2E Closed Meeting Test Building";
// Voter who will submit a ballot before the AGM is closed
const VOTED_LOT_NUMBER = "CLO-1";
const VOTED_LOT_EMAIL = "closed-voter@test.com";
const VOTED_LOT_ENTITLEMENT = 10;
// Voter who will never submit a ballot (accesses only after close)
const UNVOTED_LOT_NUMBER = "CLO-2";
const UNVOTED_LOT_EMAIL = "closed-novote@test.com";
const UNVOTED_LOT_ENTITLEMENT = 10;
const AGM_TITLE = "E2E Closed Meeting Test AGM";
const MOTION_TITLE = "E2E Closed Motion — Budget Approval";

let seededAgmId = "";
let seededBuildingId = "";
let seededVotedLotOwnerId = "";

test.describe("Closed meeting voter journey", () => {
  // Serial mode prevents parallel workers from each running their own beforeAll,
  // which would cause multiple concurrent Lambda cold starts and timeout races.
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

    const api = await playwrightRequest.newContext({
      baseURL,
      ignoreHTTPSErrors: true,
      storageState: path.join(__dirname, ".auth", "admin.json"),
    });

    // ── Building ──────────────────────────────────────────────────────────────
    const buildingsRes = await api.get("/api/admin/buildings");
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    let building = buildings.find((b) => b.name === BUILDING_NAME);
    if (!building) {
      const res = await api.post("/api/admin/buildings", {
        data: { name: BUILDING_NAME, manager_email: "closed-mgr@test.com" },
      });
      building = (await res.json()) as { id: string; name: string };
    }
    seededBuildingId = building.id;

    // ── Lot owners ────────────────────────────────────────────────────────────
    const lotOwnersRes = await api.get(`/api/admin/buildings/${seededBuildingId}/lot-owners`);
    const lotOwners = (await lotOwnersRes.json()) as {
      id: string;
      lot_number: string;
      emails: string[];
    }[];

    // Voter 1 — will vote before close
    let votedLo = lotOwners.find((l) => l.lot_number === VOTED_LOT_NUMBER);
    if (!votedLo) {
      const res = await api.post(`/api/admin/buildings/${seededBuildingId}/lot-owners`, {
        data: {
          lot_number: VOTED_LOT_NUMBER,
          emails: [VOTED_LOT_EMAIL],
          unit_entitlement: VOTED_LOT_ENTITLEMENT,
        },
      });
      votedLo = (await res.json()) as { id: string; lot_number: string; emails: string[] };
    } else if (!votedLo.emails?.includes(VOTED_LOT_EMAIL)) {
      await api.post(`/api/admin/lot-owners/${votedLo.id}/emails`, {
        data: { email: VOTED_LOT_EMAIL },
      });
    }
    seededVotedLotOwnerId = votedLo.id;

    // Voter 2 — will never vote
    const unvotedLo = lotOwners.find((l) => l.lot_number === UNVOTED_LOT_NUMBER);
    if (!unvotedLo) {
      await api.post(`/api/admin/buildings/${seededBuildingId}/lot-owners`, {
        data: {
          lot_number: UNVOTED_LOT_NUMBER,
          emails: [UNVOTED_LOT_EMAIL],
          unit_entitlement: UNVOTED_LOT_ENTITLEMENT,
        },
      });
    } else if (!unvotedLo.emails?.includes(UNVOTED_LOT_EMAIL)) {
      await api.post(`/api/admin/lot-owners/${unvotedLo.id}/emails`, {
        data: { email: UNVOTED_LOT_EMAIL },
      });
    }

    // ── AGM ───────────────────────────────────────────────────────────────────
    // Close any existing open/pending AGMs for this building
    const agmsRes = await api.get("/api/admin/general-meetings");
    const agms = (await agmsRes.json()) as {
      id: string;
      status: string;
      building_id: string;
    }[];
    const openAgms = agms.filter(
      (a) =>
        a.building_id === seededBuildingId && (a.status === "open" || a.status === "pending")
    );
    for (const agm of openAgms) {
      await api.post(`/api/admin/general-meetings/${agm.id}/close`);
    }

    // Create a fresh open AGM (meeting_at in the past so status is "open")
    const meetingStarted = new Date();
    meetingStarted.setHours(meetingStarted.getHours() - 1);
    const closesAt = new Date();
    closesAt.setFullYear(closesAt.getFullYear() + 1);

    const createRes = await api.post("/api/admin/general-meetings", {
      data: {
        building_id: seededBuildingId,
        title: AGM_TITLE,
        meeting_at: meetingStarted.toISOString(),
        voting_closes_at: closesAt.toISOString(),
        motions: [
          {
            title: MOTION_TITLE,
            description: "Do you approve the E2E closed-meeting test budget?",
            order_index: 1,
            motion_type: "general",
          },
        ],
      },
    });
    const newAgm = (await createRes.json()) as { id: string };
    seededAgmId = newAgm.id;

    // Clear any stale ballots so setup is idempotent
    await api.delete(`/api/admin/general-meetings/${seededAgmId}/ballots`);

    // ── Submit ballot for voter 1 via the voter API ───────────────────────────
    // Step 1: authenticate as voter 1 to obtain a session cookie
    const authRes = await api.post("/api/auth/verify", {
      data: {
        email: VOTED_LOT_EMAIL,
        building_id: seededBuildingId,
        general_meeting_id: seededAgmId,
      },
    });
    if (!authRes.ok()) {
      throw new Error(
        `Voter auth failed during setup — status ${authRes.status()}: ${await authRes.text()}`
      );
    }

    // Step 2: fetch motions so we know their IDs
    const motionsRes = await api.get(`/api/general-meeting/${seededAgmId}/motions`);
    const motions = (await motionsRes.json()) as { id: string; title: string }[];
    if (motions.length === 0) {
      throw new Error("No motions returned for seeded AGM — cannot submit ballot in setup");
    }

    // Step 3: submit the ballot (yes vote for voter 1)
    const submitRes = await api.post(`/api/general-meeting/${seededAgmId}/submit`, {
      data: { lot_owner_ids: [seededVotedLotOwnerId] },
    });
    if (!submitRes.ok()) {
      throw new Error(
        `Ballot submission failed during setup — status ${submitRes.status()}: ${await submitRes.text()}`
      );
    }

    // ── Close the AGM ─────────────────────────────────────────────────────────
    const closeRes = await api.post(`/api/admin/general-meetings/${seededAgmId}/close`);
    if (!closeRes.ok()) {
      throw new Error(
        `Failed to close AGM during setup — status ${closeRes.status()}: ${await closeRes.text()}`
      );
    }

    await api.dispose();
  }, { timeout: 60000 });

  test("full closed meeting journey: voter who voted is routed to confirmation with their ballot", async ({
    page,
  }) => {
    test.setTimeout(120000);

    await page.goto("/");

    // Select the building
    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    await select.selectOption({ label: BUILDING_NAME });

    // The closed AGM shows "View My Submission" button
    await expect(
      page.getByRole("button", { name: "View My Submission" }).first()
    ).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "View My Submission" }).first().click();

    // Auth page
    await expect(page.getByLabel("Lot number")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Lot number").fill(VOTED_LOT_NUMBER);
    await page.getByLabel("Email address").fill(VOTED_LOT_EMAIL);
    await page.getByRole("button", { name: "Continue" }).click();

    // Auth returns agm_status:"closed" — should be routed directly to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // Confirmation page — ballot was submitted, so we see the summary
    await expect(page.getByText("Ballot submitted")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Your votes", { exact: true })).toBeVisible();

    // The motion voted on must appear
    await expect(page.getByText(MOTION_TITLE)).toBeVisible();

    // No "Submit ballot" button — voting is closed
    await expect(page.getByRole("button", { name: "Submit ballot" })).not.toBeVisible();

    // No voting buttons (For / Against / Abstain) — we are on confirmation, not voting
    await expect(page.getByRole("button", { name: "For" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Against" })).not.toBeVisible();
  });

  test("voter who never submitted, closed AGM: confirmation shows no ballot message", async ({
    page,
  }) => {
    test.setTimeout(120000);

    await page.goto("/");

    const select = page.getByLabel("Select your building");
    await expect(select).toBeVisible();
    await select.selectOption({ label: BUILDING_NAME });

    // Closed AGM shows "View My Submission" button
    await expect(
      page.getByRole("button", { name: "View My Submission" }).first()
    ).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "View My Submission" }).first().click();

    // Auth page
    await expect(page.getByLabel("Lot number")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(BUILDING_NAME)).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Lot number").fill(UNVOTED_LOT_NUMBER);
    await page.getByLabel("Email address").fill(UNVOTED_LOT_EMAIL);
    await page.getByRole("button", { name: "Continue" }).click();

    // Auth returns agm_status:"closed" → navigates to confirmation
    await expect(page).toHaveURL(/vote\/.*\/confirmation/, { timeout: 20000 });

    // ConfirmationPage calls GET /api/general-meeting/{id}/my-ballot.
    // No ballot was submitted for this lot owner, so the API returns 404 and
    // the component renders the no-ballot message.
    await expect(
      page.getByText("You did not submit a ballot for this meeting.")
    ).toBeVisible({ timeout: 15000 });

    // No voting buttons — the meeting is closed and there is nothing to vote on
    await expect(page.getByRole("button", { name: "Submit ballot" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "For" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Against" })).not.toBeVisible();
  });
});
