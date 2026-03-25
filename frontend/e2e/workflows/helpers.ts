/**
 * Shared helper functions for workflow E2E specs.
 *
 * These helpers handle the repetitive API seeding and assertion patterns used
 * across all workflow specs. They are plain async functions (not Playwright
 * fixtures) so they can be called from `beforeAll` blocks.
 */

import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the admin auth storage state (relative to this file in e2e/workflows/)
export const ADMIN_AUTH_PATH = path.join(__dirname, "../.auth/admin.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LotOwnerSeed {
  lotNumber: string;
  emails: string[];
  unitEntitlement: number;
  financialPosition?: "normal" | "in_arrear";
}

export interface MotionSeed {
  title: string;
  description: string;
  orderIndex: number;
  motionType: "general" | "special";
}

export interface TallyCount {
  voter_count: number;
  entitlement_sum: number;
}

export interface MotionTally {
  yes: TallyCount;
  no: TallyCount;
  abstained: TallyCount;
  absent: TallyCount;
  not_eligible: TallyCount;
}

export interface MotionDetail {
  id: string;
  title: string;
  display_order: number;
  motion_type: string;
  tally: MotionTally;
  voter_lists: {
    yes: { lot_number: string; entitlement: number }[];
    no: { lot_number: string; entitlement: number }[];
    abstained: { lot_number: string; entitlement: number }[];
    absent: { lot_number: string; entitlement: number }[];
    not_eligible: { lot_number: string; entitlement: number }[];
  };
}

// ── Building helpers ──────────────────────────────────────────────────────────

/**
 * Create or find a building by name. Returns the building ID.
 */
export async function seedBuilding(
  api: APIRequestContext,
  name: string,
  managerEmail: string
): Promise<string> {
  const buildingsRes = await api.get(
    `/api/admin/buildings?name=${encodeURIComponent(name)}`
  );
  const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
  // name filter is a substring match — use exact-name guard as safety net
  let building = buildings.find((b) => b.name === name) ?? null;
  if (!building) {
    const res = await api.post("/api/admin/buildings", {
      data: { name, manager_email: managerEmail },
    });
    if (!res.ok()) {
      throw new Error(`Failed to create building "${name}" (${res.status()}): ${await res.text()}`);
    }
    building = (await res.json()) as { id: string; name: string };
  }
  return building.id;
}

// ── Lot owner helpers ─────────────────────────────────────────────────────────

/**
 * Create or find a lot owner, ensuring it has the required emails and
 * financial position. Returns the lot owner ID.
 */
export async function seedLotOwner(
  api: APIRequestContext,
  buildingId: string,
  seed: LotOwnerSeed
): Promise<string> {
  const lotOwnersRes = await api.get(`/api/admin/buildings/${buildingId}/lot-owners`);
  const lotOwners = (await lotOwnersRes.json()) as {
    id: string;
    lot_number: string;
    emails: string[];
    financial_position: string;
  }[];

  let lo = lotOwners.find((l) => l.lot_number === seed.lotNumber);
  if (!lo) {
    const res = await api.post(`/api/admin/buildings/${buildingId}/lot-owners`, {
      data: {
        lot_number: seed.lotNumber,
        emails: seed.emails,
        unit_entitlement: seed.unitEntitlement,
        financial_position: seed.financialPosition ?? "normal",
      },
    });
    if (!res.ok()) {
      throw new Error(
        `Failed to create lot owner "${seed.lotNumber}" (${res.status()}): ${await res.text()}`
      );
    }
    lo = (await res.json()) as {
      id: string;
      lot_number: string;
      emails: string[];
      financial_position: string;
    };
  } else {
    // Ensure all required emails are present
    for (const email of seed.emails) {
      if (!lo.emails?.includes(email)) {
        await api.post(`/api/admin/lot-owners/${lo.id}/emails`, {
          data: { email },
        });
      }
    }
    // Ensure correct financial position
    if (seed.financialPosition && lo.financial_position !== seed.financialPosition) {
      await api.patch(`/api/admin/lot-owners/${lo.id}`, {
        data: { financial_position: seed.financialPosition },
      });
    }
  }
  return lo.id;
}

// ── Proxy nomination helper ───────────────────────────────────────────────────

/**
 * Upload a proxy nominations CSV for a building.
 * CSV format: `Lot#,Proxy Email\nLOT_NUMBER,PROXY_EMAIL\n`
 */
export async function uploadProxyCsv(
  api: APIRequestContext,
  buildingId: string,
  csvContent: string
): Promise<void> {
  const res = await api.post(
    `/api/admin/buildings/${buildingId}/lot-owners/import-proxies`,
    {
      multipart: {
        file: {
          name: "proxies.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(csvContent),
        },
      },
    }
  );
  if (!res.ok()) {
    throw new Error(`Proxy import failed (${res.status()}): ${await res.text()}`);
  }
}

// ── Meeting helpers ───────────────────────────────────────────────────────────

/**
 * Close any open or pending meetings for a building, then create a fresh open
 * meeting with the given motions. Returns the meeting ID.
 *
 * Uses `meeting_at` 1 hour in the past so the effective status is "open".
 */
export async function createOpenMeeting(
  api: APIRequestContext,
  buildingId: string,
  title: string,
  motions: MotionSeed[]
): Promise<string> {
  // Close any existing open/pending meetings for this building.
  // Query by building_id (not name) so we catch meetings with different titles
  // that would otherwise block the new meeting from being created (the backend
  // enforces one open/pending meeting per building).
  const agmsRes = await api.get(
    `/api/admin/general-meetings?building_id=${encodeURIComponent(buildingId)}&limit=100`
  );
  const agms = (await agmsRes.json()) as {
    id: string;
    status: string;
    building_id: string;
  }[];
  const openAgms = agms.filter(
    (a) => a.status === "open" || a.status === "pending"
  );
  for (const agm of openAgms) {
    await api.post(`/api/admin/general-meetings/${agm.id}/close`);
  }

  const meetingStarted = new Date();
  meetingStarted.setHours(meetingStarted.getHours() - 1);
  const closesAt = new Date();
  closesAt.setFullYear(closesAt.getFullYear() + 1);

  const createRes = await api.post("/api/admin/general-meetings", {
    data: {
      building_id: buildingId,
      title,
      meeting_at: meetingStarted.toISOString(),
      voting_closes_at: closesAt.toISOString(),
      motions: motions.map((m) => ({
        title: m.title,
        description: m.description,
        display_order: m.orderIndex,
        motion_type: m.motionType,
      })),
    },
  });
  if (!createRes.ok()) {
    throw new Error(
      `Failed to create meeting "${title}" (${createRes.status()}): ${await createRes.text()}`
    );
  }
  const newAgm = (await createRes.json()) as { id: string };
  return newAgm.id;
}

/**
 * Create a pending meeting (meeting_at in the future) for a building.
 * Returns the meeting ID.
 *
 * NOTE: This helper closes any existing open/pending meetings before creating
 * the pending meeting. If you need to keep an open meeting alive alongside the
 * pending meeting (e.g. so the building still appears in the voter dropdown),
 * use `seedPendingMeeting` instead and seed the open meeting first.
 */
export async function createPendingMeeting(
  api: APIRequestContext,
  buildingId: string,
  title: string,
  motions: MotionSeed[]
): Promise<string> {
  // Close any existing open/pending meetings for this building.
  // Query by building_id (not name) so we catch meetings with different titles
  // that would otherwise block the new meeting from being created (the backend
  // enforces one open/pending meeting per building).
  const agmsRes = await api.get(
    `/api/admin/general-meetings?building_id=${encodeURIComponent(buildingId)}&limit=100`
  );
  const agms = (await agmsRes.json()) as {
    id: string;
    status: string;
    building_id: string;
  }[];
  const openAgms = agms.filter(
    (a) => a.status === "open" || a.status === "pending"
  );
  for (const agm of openAgms) {
    await api.post(`/api/admin/general-meetings/${agm.id}/close`);
  }

  const meetingAt = new Date();
  meetingAt.setHours(meetingAt.getHours() + 2); // 2 hours in the future
  const closesAt = new Date();
  closesAt.setFullYear(closesAt.getFullYear() + 1);

  const createRes = await api.post("/api/admin/general-meetings", {
    data: {
      building_id: buildingId,
      title,
      meeting_at: meetingAt.toISOString(),
      voting_closes_at: closesAt.toISOString(),
      motions: motions.map((m) => ({
        title: m.title,
        description: m.description,
        display_order: m.orderIndex,
        motion_type: m.motionType,
      })),
    },
  });
  if (!createRes.ok()) {
    throw new Error(
      `Failed to create pending meeting "${title}" (${createRes.status()}): ${await createRes.text()}`
    );
  }
  const newAgm = (await createRes.json()) as { id: string };
  return newAgm.id;
}

/**
 * Create a pending meeting (meeting_at in the future) WITHOUT closing any
 * existing meetings first. Use this when an open meeting must remain alive
 * alongside the pending meeting — e.g. so the building still passes the
 * GET /api/buildings filter (which requires meeting_at <= now).
 *
 * Callers are responsible for ensuring no conflicting state exists beforehand.
 */
export async function seedPendingMeeting(
  api: APIRequestContext,
  buildingId: string,
  title: string,
  motions: MotionSeed[]
): Promise<string> {
  const meetingAt = new Date();
  meetingAt.setHours(meetingAt.getHours() + 2); // 2 hours in the future
  const closesAt = new Date();
  closesAt.setFullYear(closesAt.getFullYear() + 1);

  const createRes = await api.post("/api/admin/general-meetings", {
    data: {
      building_id: buildingId,
      title,
      meeting_at: meetingAt.toISOString(),
      voting_closes_at: closesAt.toISOString(),
      motions: motions.map((m) => ({
        title: m.title,
        description: m.description,
        display_order: m.orderIndex,
        motion_type: m.motionType,
      })),
    },
  });
  if (!createRes.ok()) {
    throw new Error(
      `Failed to seed pending meeting "${title}" (${createRes.status()}): ${await createRes.text()}`
    );
  }
  const newAgm = (await createRes.json()) as { id: string };
  return newAgm.id;
}

/**
 * Close a meeting via the admin API. Asserts 200 OK.
 */
export async function closeMeeting(api: APIRequestContext, meetingId: string): Promise<void> {
  const res = await api.post(`/api/admin/general-meetings/${meetingId}/close`);
  if (!res.ok()) {
    throw new Error(
      `Failed to close meeting ${meetingId} (${res.status()}): ${await res.text()}`
    );
  }
}

/**
 * Delete a meeting via the admin API (204 No Content on success).
 * If the meeting is open, closes it first so the delete succeeds.
 * If the meeting does not exist (404) the call is silently ignored.
 */
export async function deleteMeeting(api: APIRequestContext, meetingId: string): Promise<void> {
  // Try to delete directly first
  let res = await api.delete(`/api/admin/general-meetings/${meetingId}`);
  if (res.status() === 404) {
    return; // already gone
  }
  if (res.status() === 409) {
    // Meeting is open — close it first, then retry the delete
    await closeMeeting(api, meetingId);
    res = await api.delete(`/api/admin/general-meetings/${meetingId}`);
  }
  if (!res.ok()) {
    throw new Error(
      `Failed to delete meeting ${meetingId} (${res.status()}): ${await res.text()}`
    );
  }
}

/**
 * Clear all ballots for a meeting (idempotent re-run safety).
 */
export async function clearBallots(api: APIRequestContext, meetingId: string): Promise<void> {
  await api.delete(`/api/admin/general-meetings/${meetingId}/ballots`);
}

// ── Tally helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch the meeting detail from the admin API and return the motion_details array.
 */
export async function getMeetingDetails(
  api: APIRequestContext,
  meetingId: string
): Promise<MotionDetail[]> {
  const res = await api.get(`/api/admin/general-meetings/${meetingId}`);
  if (!res.ok()) {
    throw new Error(
      `Failed to get meeting details for ${meetingId} (${res.status()}): ${await res.text()}`
    );
  }
  const data = (await res.json()) as { motions?: MotionDetail[] };
  return data.motions ?? [];
}

/**
 * Assert that a motion tally matches expected values.
 *
 * Pass partial expected values — only keys provided will be checked.
 * Missing keys default to { voter_count: 0, entitlement_sum: 0 }.
 */
export function assertTally(
  tally: MotionTally,
  expected: Partial<Record<keyof MotionTally, Partial<TallyCount>>>
): void {
  const categories: (keyof MotionTally)[] = ["yes", "no", "abstained", "absent", "not_eligible"];
  for (const cat of categories) {
    const exp = expected[cat] ?? { voter_count: 0, entitlement_sum: 0 };
    const actual = tally[cat];
    if (exp.voter_count !== undefined) {
      expect(
        actual.voter_count,
        `Tally[${cat}].voter_count`
      ).toBe(exp.voter_count);
    }
    if (exp.entitlement_sum !== undefined) {
      expect(
        actual.entitlement_sum,
        `Tally[${cat}].entitlement_sum`
      ).toBe(exp.entitlement_sum);
    }
  }
}

// ── Admin API context factory ─────────────────────────────────────────────────

/**
 * Create a new Playwright API request context authenticated as admin.
 * Remember to call `api.dispose()` when done.
 */
export async function makeAdminApi(
  baseURL: string
): Promise<APIRequestContext> {
  const { request: playwrightRequest } = await import("@playwright/test");
  return playwrightRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    storageState: ADMIN_AUTH_PATH,
  });
}

// ── Voter UI helpers ──────────────────────────────────────────────────────────

/**
 * Request an OTP for (email, meetingId) via the backend API with skip_email=true.
 * The OTP is generated and stored in the DB but no email is sent — use getTestOtp
 * to retrieve it afterwards.
 */
export async function requestOtp(
  api: APIRequestContext,
  email: string,
  meetingId: string
): Promise<void> {
  const res = await api.post("/api/auth/request-otp", {
    data: {
      email,
      general_meeting_id: meetingId,
      skip_email: true,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Failed to request OTP for ${email} (${res.status()}): ${await res.text()}`
    );
  }
}

/**
 * Retrieve the most recent unused OTP for (email, meetingId) from the test-only
 * backend endpoint. Requires the backend to be running with TESTING_MODE=true.
 */
export async function getTestOtp(
  api: APIRequestContext,
  email: string,
  meetingId: string
): Promise<string> {
  const res = await api.get(
    `/api/test/latest-otp?email=${encodeURIComponent(email)}&meeting_id=${meetingId}`
  );
  if (!res.ok()) {
    throw new Error(`Failed to get test OTP for ${email} (${res.status()}): ${await res.text()}`);
  }
  const data = (await res.json()) as { code: string };
  return data.code;
}

/**
 * Navigate to the home page, select a building, and click "Enter Voting"
 * to reach the auth form for that building.
 */
export async function goToAuthPage(page: Page, buildingName: string): Promise<void> {
  await page.evaluate(() => {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('agm_session_'))
        .forEach(k => localStorage.removeItem(k))
    } catch (_) {
      // page not yet on target origin — no session token to clear
    }
  })
  await page.goto("/");
  const select = page.getByLabel("Select your building");
  await expect(select).toBeVisible();
  await select.selectOption({ label: buildingName });
  await expect(page.getByRole("button", { name: "Enter Voting" }).first()).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Enter Voting" }).first().click();
  await expect(page.getByLabel("Email address")).toBeVisible({ timeout: 15000 });
}

/**
 * Fill and submit the auth form via the two-step OTP flow.
 *
 * Step 1: fill email, click "Send Verification Code".
 * Step 2: retrieve OTP via `getOtp` callback, fill code field, click "Verify".
 *
 * The `getOtp` callback is typically `() => getTestOtp(api, email, meetingId)`.
 * The test-only endpoint is guarded by TESTING_MODE=true on the backend.
 */
export async function authenticateVoter(
  page: Page,
  email: string,
  getOtp: () => Promise<string>
): Promise<void> {
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send Verification Code" }).click();
  await expect(page.getByLabel("Verification code")).toBeVisible({ timeout: 15000 });
  const code = await getOtp();
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
}

/**
 * Submit the ballot via the confirm dialog.
 */
export async function submitBallot(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Submit ballot" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Submit ballot" }).last().click();
}

/**
 * Submit a ballot for the given lots and motions via the backend API, bypassing the
 * browser UI. Useful for seeding pre-vote state in beforeAll / beforeEach blocks so
 * that serial tests are idempotent across retries.
 *
 * Flow:
 *   1. Request an OTP for (email, meetingId) with skip_email=true
 *   2. Retrieve the OTP from the test-only endpoint
 *   3. POST /api/auth/verify to get a session token
 *   4. POST /api/general-meeting/{meetingId}/submit with the session token
 *
 * @param api      Admin-authenticated APIRequestContext (used for OTP retrieval only)
 * @param email    Voter email address
 * @param meetingId  General meeting UUID
 * @param lotOwnerIds  Array of lot_owner_id UUIDs to submit on behalf of
 * @param votes    Array of { motion_id, choice } objects (choice: "yes" | "no" | "abstained")
 */
export async function submitBallotViaApi(
  api: APIRequestContext,
  email: string,
  meetingId: string,
  lotOwnerIds: string[],
  votes: { motion_id: string; choice: string }[]
): Promise<void> {
  // 1. Request OTP (no email sent)
  const otpReqRes = await api.post("/api/auth/request-otp", {
    data: { email, general_meeting_id: meetingId, skip_email: true },
  });
  if (!otpReqRes.ok()) {
    throw new Error(`submitBallotViaApi: OTP request failed (${otpReqRes.status()}): ${await otpReqRes.text()}`);
  }

  // 2. Retrieve OTP
  const otpRes = await api.get(
    `/api/test/latest-otp?email=${encodeURIComponent(email)}&meeting_id=${meetingId}`
  );
  if (!otpRes.ok()) {
    throw new Error(`submitBallotViaApi: OTP retrieval failed (${otpRes.status()}): ${await otpRes.text()}`);
  }
  const { code } = (await otpRes.json()) as { code: string };

  // 3. Verify OTP → get session token (unauthenticated context needed, but the admin context
  //    also works since /api/auth/verify is a public endpoint)
  const verifyRes = await api.post("/api/auth/verify", {
    data: { email, code, general_meeting_id: meetingId },
  });
  if (!verifyRes.ok()) {
    throw new Error(`submitBallotViaApi: verify failed (${verifyRes.status()}): ${await verifyRes.text()}`);
  }
  const { session_token } = (await verifyRes.json()) as { session_token: string };

  // 4. Submit ballot using Authorization header (bypasses cookie requirement)
  const submitRes = await api.post(`/api/general-meeting/${meetingId}/submit`, {
    headers: { Authorization: `Bearer ${session_token}` },
    data: { lot_owner_ids: lotOwnerIds, votes },
  });
  if (!submitRes.ok() && submitRes.status() !== 409) {
    // 409 = already submitted — acceptable in idempotent setup steps
    throw new Error(`submitBallotViaApi: submit failed (${submitRes.status()}): ${await submitRes.text()}`);
  }
}
