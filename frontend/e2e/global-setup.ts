/**
 * Playwright global setup — runs once before the entire test suite.
 *
 * 1. Authenticates as admin and persists the session cookie to
 *    e2e/.auth/admin.json so admin-scoped tests can reuse it.
 *
 * 2. Seeds the minimum data required by the voting-flow tests:
 *    - A building called "E2E Test Building"
 *    - A lot owner  lot=E2E-1  email=e2e-voter@test.com  entitlement=10
 *    - An open AGM with one motion attached to that building
 *
 *    All of this is idempotent — the setup checks what already exists
 *    before creating anything, so it is safe to run against a long-lived
 *    shared deployment.
 */

import { chromium, request as playwrightRequest, type FullConfig } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

export const E2E_BUILDING_NAME = "E2E Test Building";
export const E2E_LOT_NUMBER = "E2E-1";
export const E2E_LOT_EMAIL = "e2e-voter@test.com";
export const E2E_LOT_ENTITLEMENT = 10;
export const E2E_AGM_TITLE = "E2E Test AGM";

// A second building with its own open AGM, used exclusively by the
// admin-agms tests that interact with open AGMs (e.g. Close Voting dialog).
// Created AFTER the voting-test AGM so it appears first in the admin AGM
// list (sorted by created_at DESC) — ensuring admin tests target this AGM
// rather than the voting-test AGM.
export const E2E_ADMIN_BUILDING_NAME = "E2E Admin Test Building";

const BYPASS_TOKEN = process.env.VERCEL_BYPASS_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default async function globalSetup(_config: FullConfig) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

  // ── 1. Admin auth state ────────────────────────────────────────────────────
  const authDir = path.join(__dirname, ".auth");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Bypass Vercel Deployment Protection when running against a deployed URL.
  // Visiting this URL sets a _vercel_jwt cookie that allows all subsequent
  // same-origin requests through without Vercel's SSO wall.
  if (BYPASS_TOKEN) {
    await page.goto(
      `${baseURL}/?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${BYPASS_TOKEN}`
    );
  }

  // Save bypass cookie (only) as the "public" storageState — used by public
  // project tests (smoke, voting-flow) that don't need an admin session but
  // still need to bypass Vercel Deployment Protection on preview URLs.
  await context.storageState({ path: path.join(authDir, "public.json") });

  await page.goto("/admin/login");
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL(/\/admin\/buildings/, { timeout: 30000 });
  } catch {
    const url = page.url();
    const content = await page.content();
    throw new Error(
      `Admin login failed — stuck at ${url}\nPage content (first 500 chars):\n${content.slice(0, 500)}`
    );
  }
  await context.storageState({ path: path.join(authDir, "admin.json") });
  await browser.close();

  // ── 2. Seed voting test data via the API ───────────────────────────────────
  const api = await playwrightRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    storageState: path.join(authDir, "admin.json"),
    // 90s timeout to survive Lambda cold starts (default is 30s)
    timeout: 90000,
  });

  // Ensure E2E building exists
  const buildingsRes = await api.get("/api/admin/buildings");
  const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
  let building = buildings.find((b) => b.name === E2E_BUILDING_NAME);

  if (!building) {
    const created = await api.post("/api/admin/buildings", {
      data: { name: E2E_BUILDING_NAME, manager_email: "e2e-manager@test.com" },
    });
    building = (await created.json()) as { id: string; name: string };
  }

  // Ensure lot owner exists with the correct email.
  // The lot owner import endpoint uses a replace-all strategy that can delete
  // lot owners from "E2E Test Building" if an admin E2E test runs that import
  // against this building.  Always re-create if absent, and verify afterwards
  // so any silent API failure surfaces here rather than as a mysterious 401 in
  // the voting-flow tests.
  const lotOwnersRes = await api.get(`/api/admin/buildings/${building.id}/lot-owners`);
  const lotOwners = (await lotOwnersRes.json()) as { id: string; lot_number: string; emails: string[] }[];
  const existingLotOwner = lotOwners.find((l) => l.lot_number === E2E_LOT_NUMBER);
  if (!existingLotOwner) {
    const createRes = await api.post(`/api/admin/buildings/${building.id}/lot-owners`, {
      data: {
        lot_number: E2E_LOT_NUMBER,
        emails: [E2E_LOT_EMAIL],
        unit_entitlement: E2E_LOT_ENTITLEMENT,
      },
    });
    if (!createRes.ok()) {
      throw new Error(
        `Failed to create E2E lot owner — status ${createRes.status()}: ${await createRes.text()}`
      );
    }
  } else if (!existingLotOwner.emails?.includes(E2E_LOT_EMAIL)) {
    // Lot owner exists but is missing the required email — add it via the emails endpoint
    const addEmailRes = await api.post(`/api/admin/lot-owners/${existingLotOwner.id}/emails`, {
      data: { email: E2E_LOT_EMAIL },
    });
    if (!addEmailRes.ok()) {
      throw new Error(
        `Failed to add email to E2E lot owner — status ${addEmailRes.status()}: ${await addEmailRes.text()}`
      );
    }
  }

  // Final assertion: lot owner must exist with the correct email before tests run.
  const verifyRes = await api.get(`/api/admin/buildings/${building.id}/lot-owners`);
  const verifiedOwners = (await verifyRes.json()) as { id: string; lot_number: string; emails: string[] }[];
  const verified = verifiedOwners.find(
    (l) => l.lot_number === E2E_LOT_NUMBER && l.emails?.includes(E2E_LOT_EMAIL)
  );
  if (!verified) {
    throw new Error(
      `E2E lot owner ${E2E_LOT_NUMBER} / ${E2E_LOT_EMAIL} not found in ` +
      `"${E2E_BUILDING_NAME}" after seeding. ` +
      `Existing lot owners: ${JSON.stringify(verifiedOwners.map((l) => ({ lot: l.lot_number, emails: l.emails })))}`
    );
  }

  // Always create a fresh open AGM for each test run:
  // close any existing open E2E AGMs first (so the lot owner has no submitted
  // ballot on the new AGM), then create a new one. The just-closed AGM
  // satisfies the "AGM closed state" test which looks for any closed AGM.
  const agmsRes = await api.get("/api/admin/general-meetings");
  const agms = (await agmsRes.json()) as {
    id: string;
    title: string;
    status: string;
    building_id: string;
  }[];
  // Close any open or pending AGMs for this building before creating a fresh one.
  // Include "pending" because with the pending-status feature, AGMs whose
  // meeting_at is in the future now return status="pending" from the API.
  const openE2eAgms = agms.filter(
    (a) => a.building_id === building!.id && (a.status === "open" || a.status === "pending")
  );

  for (const agm of openE2eAgms) {
    await api.post(`/api/admin/general-meetings/${agm.id}/close`);
  }

  // Set meeting_at to 1 hour ago so the effective status is "open" (meeting has
  // started, voting still open). Using a future meeting_at would produce status
  // "pending" and the "Enter Voting" button would not be rendered.
  const meetingStarted = new Date();
  meetingStarted.setHours(meetingStarted.getHours() - 1);
  const closesAt = new Date();
  closesAt.setFullYear(closesAt.getFullYear() + 1);

  const createAgmRes = await api.post("/api/admin/general-meetings", {
    data: {
      building_id: building.id,
      title: E2E_AGM_TITLE,
      meeting_at: meetingStarted.toISOString(),
      voting_closes_at: closesAt.toISOString(),
      motions: [
        {
          title: "E2E Test Motion 1",
          description: "Do you approve this E2E test motion?",
          order_index: 1,
        },
      ],
    },
  });
  const newAgm = (await createAgmRes.json()) as { id: string };

  // Wipe any ballot submissions on the new AGM (safety net for retried test
  // runs: if a previous attempt submitted a ballot before the suite failed,
  // global-setup needs to clear it so the voting-flow test can re-vote
  // without hitting a 409 conflict).
  await api.delete(`/api/admin/general-meetings/${newAgm.id}/ballots`);

  // ── 3. Seed a dedicated "admin test" building with its own open AGM ─────────
  // Admin-agms E2E tests that exercise the Close Voting dialog look for the
  // FIRST open AGM in the list (sorted created_at DESC). By creating this AGM
  // AFTER the voting-test AGM, it becomes the newest and therefore the first
  // result — keeping admin tests away from the voting-test AGM.
  let adminBuilding = buildings.find((b) => b.name === E2E_ADMIN_BUILDING_NAME);
  if (!adminBuilding) {
    const created = await api.post("/api/admin/buildings", {
      data: { name: E2E_ADMIN_BUILDING_NAME, manager_email: "e2e-admin-mgr@test.com" },
    });
    adminBuilding = (await created.json()) as { id: string; name: string };
  }

  // Add a placeholder lot owner so the building has at least one voter
  const adminLotOwnersRes = await api.get(`/api/admin/buildings/${adminBuilding.id}/lot-owners`);
  const adminLotOwners = (await adminLotOwnersRes.json()) as { lot_number: string }[];
  if (!adminLotOwners.find((l) => l.lot_number === "ADMIN-1")) {
    await api.post(`/api/admin/buildings/${adminBuilding.id}/lot-owners`, {
      data: { lot_number: "ADMIN-1", emails: ["admin-voter@test.com"], unit_entitlement: 1 },
    });
  }

  // Close any existing open AGMs for the admin-test building, then create a fresh one
  const allAgmsRes = await api.get("/api/admin/general-meetings");
  const allAgms = (await allAgmsRes.json()) as { id: string; building_id: string; status: string }[];
  // Include "pending" in the filter — same reason as the voter-test AGM above.
  const openAdminAgms = allAgms.filter(
    (a) => a.building_id === adminBuilding!.id && (a.status === "open" || a.status === "pending")
  );
  for (const agm of openAdminAgms) {
    await api.post(`/api/admin/general-meetings/${agm.id}/close`);
  }

  // Set meeting_at to 2 hours ago so admin tests can find it as status="open".
  const adminMeetingStarted = new Date();
  adminMeetingStarted.setHours(adminMeetingStarted.getHours() - 2);
  const adminClosesAt = new Date();
  adminClosesAt.setFullYear(adminClosesAt.getFullYear() + 1);

  await api.post("/api/admin/general-meetings", {
    data: {
      building_id: adminBuilding.id,
      title: "E2E Admin Test AGM",
      meeting_at: adminMeetingStarted.toISOString(),
      voting_closes_at: adminClosesAt.toISOString(),
      motions: [
        {
          title: "Admin Test Motion 1",
          description: "Admin-only test motion — do not vote on this.",
          order_index: 1,
        },
      ],
    },
  });

  await api.dispose();
}
