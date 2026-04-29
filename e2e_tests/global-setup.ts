/**
 * Playwright global setup — runs once before the entire test suite.
 *
 * 1. Authenticates as admin and persists the session cookie to
 *    e2e/.auth/admin.json so admin-scoped tests can reuse it.
 *
 * 2. Seeds the minimum data required by the voting-flow tests:
 *    - A building called "E2E Test Building-<suffix>"
 *    - A lot owner  lot=E2E-1  email=e2e-voter@test.com  entitlement=10
 *    - An open AGM with one motion attached to that building
 *
 *    All of this is idempotent — the setup checks what already exists
 *    before creating anything, so it is safe to run against a long-lived
 *    shared deployment.
 *
 * 3. Derives a branch-name suffix and writes it to e2e/.run-suffix so
 *    per-spec beforeAll blocks can read it and namespace their seeded
 *    entity names, preventing cross-branch DB contamination on the shared
 *    preview deployment.
 */

import { chromium, request as playwrightRequest, type FullConfig } from "@playwright/test";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In CI, use GITHUB_WORKSPACE to get an absolute path to e2e_tests/ regardless
// of how Playwright's TypeScript transform resolves import.meta.url.
// Locally, fall back to __dirname (which is the e2e_tests/ directory).
const E2E_TESTS_DIR = process.env.GITHUB_WORKSPACE
  ? path.join(process.env.GITHUB_WORKSPACE, "e2e_tests")
  : __dirname;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin";

// ── Branch-name suffix ─────────────────────────────────────────────────────
// Derive a short suffix from the current branch name so every branch run
// seeds its own isolated namespace in the shared Neon DB.  We take the last
// 20 characters of the normalised branch slug — the most specific part.
function getBranchSuffix(): string {
  const branch =
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    (() => {
      try {
        return execSync("git branch --show-current", { encoding: "utf-8" }).trim();
      } catch {
        return "";
      }
    })() ||
    "local";

  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-20);
}

export const RUN_SUFFIX = getBranchSuffix();

// Write suffix to a file so worker processes (which don't run globalSetup)
// can read it without re-computing the branch name.
fs.writeFileSync(path.join(E2E_TESTS_DIR, ".run-suffix"), RUN_SUFFIX);

export const E2E_BUILDING_NAME = `E2E Test Building-${RUN_SUFFIX}`;
export const E2E_LOT_NUMBER = "E2E-1";
export const E2E_LOT_EMAIL = "e2e-voter@test.com";
export const E2E_LOT_ENTITLEMENT = 10;
export const E2E_AGM_TITLE = `E2E Test AGM-${RUN_SUFFIX}`;

// A second building with its own open AGM, used exclusively by the
// admin-agms tests that interact with open AGMs (e.g. Close Voting dialog).
// Created AFTER the voting-test AGM so it appears first in the admin AGM
// list (sorted by created_at DESC) — ensuring admin tests target this AGM
// rather than the voting-test AGM.
export const E2E_ADMIN_BUILDING_NAME = `E2E Admin Test Building-${RUN_SUFFIX}`;

const BYPASS_TOKEN = process.env.VERCEL_BYPASS_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default async function globalSetup(_config: FullConfig) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

  // ── 1. Admin auth state ────────────────────────────────────────────────────
  const authDir = path.join(E2E_TESTS_DIR, ".auth");
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  // ── Pre-warm the Lambda before any browser navigation ─────────────────────
  // POST to the admin login endpoint and retry until it returns HTTP 200.
  // This guarantees the auth Lambda instance handling the request is warm
  // before the browser login attempt — avoiding 30-60s cold-start timeouts
  // on the subsequent page.goto("/admin/login") navigation.
  //
  // Retry logic:
  //   - 5xx response → cold start in progress, wait 10s and retry
  //   - 4xx response (e.g. 401 wrong credentials) → throw immediately
  //   - 200 → Lambda warm, proceed
  //   - Loop runs for up to 3 minutes (18 attempts × 10s)
  if (BYPASS_TOKEN) {
    const loginUrl = `${baseURL}/api/admin/auth/login`;
    const healthUrl = `${baseURL}/api/health`;
    const maxAttempts = 18; // up to 3 minutes

    // Warm up login endpoint and health endpoint in parallel with a 100ms stagger
    // to avoid hammering the same Lambda instance simultaneously.
    const warmupLogin = async (): Promise<void> => {
      let warmedUp = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let res: Response | undefined;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          try {
            res = await fetch(loginUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-vercel-protection-bypass": BYPASS_TOKEN,
              },
              body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }
        } catch {
          // Network error or timeout — treat as cold start, retry
          if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        if (res.ok) {
          warmedUp = true;
          break;
        }
        if (res.status >= 400 && res.status < 500) {
          throw new Error(
            `Lambda warmup login returned ${res.status} — credentials problem, not a cold start. ` +
            `Check ADMIN_USERNAME / ADMIN_PASSWORD env vars.`
          );
        }
        // 5xx — Lambda still cold, wait and retry
        if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 10000));
      }
      if (!warmedUp) console.warn(`Lambda warmup (login) did not confirm ready after ${maxAttempts} attempts — proceeding anyway`);
    };

    const warmupHealth = async (): Promise<void> => {
      // 100ms stagger to avoid hitting the same Lambda instance as login warmup
      await new Promise((r) => setTimeout(r, 100));
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          let res: Response | undefined;
          try {
            res = await fetch(healthUrl, {
              headers: BYPASS_TOKEN ? { "x-vercel-protection-bypass": BYPASS_TOKEN } : {},
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }
          if (res && res.ok) {
            break;
          }
        } catch {}
        if (attempt < maxAttempts - 1) await new Promise((r) => setTimeout(r, 10000));
      }
    };

    await Promise.all([warmupLogin(), warmupHealth()]);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  // 120s navigation timeout: Lambda cold starts are migration-free; only app
  // startup is needed now that migrations run in the Vercel build step.
  // Increased from 60s to handle remaining cold starts after parallel warmup.
  context.setDefaultNavigationTimeout(120000);
  const page = await context.newPage();

  // Bypass Vercel Deployment Protection when running against a deployed URL.
  // Visiting this URL sets a _vercel_jwt cookie that allows all subsequent
  // same-origin requests through without Vercel's SSO wall.
  // Use waitUntil:'commit' so we only wait for the first byte (cookie gets set
  // immediately), not the full page load — critical for cold Vercel deployments.
  if (BYPASS_TOKEN) {
    const bypassUrl = `${baseURL}/?x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass=${BYPASS_TOKEN}`;
    let bypassOk = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await page.goto(bypassUrl, { waitUntil: "commit", timeout: 30000 });
        bypassOk = true;
        break;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 10000));
      }
    }
    if (!bypassOk) throw new Error("Failed to set Vercel bypass cookie after 5 attempts");
  }

  // Save bypass cookie (only) as the "public" storageState — used by public
  // project tests (smoke, voting-flow) that don't need an admin session but
  // still need to bypass Vercel Deployment Protection on preview URLs.
  await context.storageState({ path: path.join(authDir, "public.json") });

  await page.goto("/admin/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username").fill(ADMIN_USERNAME);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForURL(/\/admin\/buildings/, { timeout: 120000 });
  } catch {
    const url = page.url();
    const content = await page.content();
    throw new Error(
      `Admin login failed — stuck at ${url}\nPage content (first 500 chars):\n${content.slice(0, 500)}`
    );
  }
  await context.storageState({ path: path.join(authDir, "admin.json") });
  await browser.close();

  // ── 2 & 3. Seed voting-test and admin-test data ────────────────────────────
  const api = await playwrightRequest.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    storageState: path.join(authDir, "admin.json"),
    // 60s: get_db retries for up to ~55s under pool pressure; 30s default is too short
    timeout: 60000,
    // CSRF middleware requires X-Requested-With on all state-changing requests.
    // Playwright APIRequestContext does not set this header automatically.
    extraHTTPHeaders: { "X-Requested-With": "XMLHttpRequest" },
  });

  // Warm up the Lambda: retry GET /api/admin/buildings until it returns 200
  // and returns valid JSON. Vercel Serverless functions can spin up multiple
  // Lambda instances concurrently — a warmup against one endpoint does not
  // guarantee other endpoints on other instances are ready. We therefore retry
  // each seeding step individually using a shared helper.
  const retryGet = async (url: string, maxAttempts = 10): Promise<Awaited<ReturnType<typeof api.get>>> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await api.get(url, { timeout: 15000 });
        if (r.ok()) return r;
        // Non-2xx — wait and retry (handles cold-start 500s)
        lastErr = new Error(`HTTP ${r.status()} from ${url}: ${await r.text()}`);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`${url} did not return 200 after ${maxAttempts} attempts. Last error: ${lastErr}`);
  };

  // ── Task A: voting-test building ────────────────────────────────────────────
  async function seedVotingBuilding() {
    const buildingsRes = await retryGet(
      `/api/admin/buildings?name=${encodeURIComponent(E2E_BUILDING_NAME)}`
    );
    const buildings = (await buildingsRes.json()) as { id: string; name: string }[];
    // name filter is a substring match — use exact-name guard as safety net
    let building = buildings.find((b) => b.name === E2E_BUILDING_NAME) ?? null;

    if (!building) {
      const created = await api.post("/api/admin/buildings", {
        data: { name: E2E_BUILDING_NAME, manager_email: "e2e-manager@test.com" },
        timeout: 60000,
      });
      building = (await created.json()) as { id: string; name: string };
    }

    // Ensure lot owner exists with the correct email.
    // The lot owner import endpoint uses a replace-all strategy that can delete
    // lot owners from "E2E Test Building" if an admin E2E test runs that import
    // against this building.  Always re-create if absent, and verify afterwards
    // so any silent API failure surfaces here rather than as a mysterious 401 in
    // the voting-flow tests.
    const lotOwnersRes = await retryGet(`/api/admin/buildings/${building.id}/lot-owners`);
    const lotOwners = (await lotOwnersRes.json()) as { id: string; lot_number: string; emails: string[] }[];
    const existingLotOwner = lotOwners.find((l) => l.lot_number === E2E_LOT_NUMBER);
    if (!existingLotOwner) {
      const createRes = await api.post(`/api/admin/buildings/${building.id}/lot-owners`, {
        data: {
          lot_number: E2E_LOT_NUMBER,
          emails: [E2E_LOT_EMAIL],
          unit_entitlement: E2E_LOT_ENTITLEMENT,
        },
        timeout: 60000,
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
        timeout: 60000,
      });
      if (!addEmailRes.ok()) {
        throw new Error(
          `Failed to add email to E2E lot owner — status ${addEmailRes.status()}: ${await addEmailRes.text()}`
        );
      }
    }

    // Final assertion: lot owner must exist with the correct email before tests run.
    const verifyRes = await retryGet(`/api/admin/buildings/${building.id}/lot-owners`);
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
    const agmsRes = await retryGet(
      `/api/admin/general-meetings?name=${encodeURIComponent(E2E_AGM_TITLE)}`
    );
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
      await api.post(`/api/admin/general-meetings/${agm.id}/close`, { timeout: 60000 });
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
            display_order: 1,
          },
        ],
      },
      timeout: 60000,
    });
    const newAgm = (await createAgmRes.json()) as { id: string };

    // Wipe any ballot submissions on the new AGM (safety net for retried test
    // runs: if a previous attempt submitted a ballot before the suite failed,
    // global-setup needs to clear it so the voting-flow test can re-vote
    // without hitting a 409 conflict).
    await api.delete(`/api/admin/general-meetings/${newAgm.id}/ballots`, { timeout: 60000 });
  }

  // ── Task B: admin-test building ─────────────────────────────────────────────
  // Admin-agms E2E tests that exercise the Close Voting dialog look for the
  // FIRST open AGM in the list (sorted created_at DESC). By creating this AGM
  // AFTER the voting-test AGM, it becomes the newest and therefore the first
  // result — keeping admin tests away from the voting-test AGM.
  async function seedAdminBuilding() {
    const adminBuildingsRes = await retryGet(
      `/api/admin/buildings?name=${encodeURIComponent(E2E_ADMIN_BUILDING_NAME)}`
    );
    const adminBuildings = (await adminBuildingsRes.json()) as { id: string; name: string }[];
    // name filter is a substring match — use exact-name guard as safety net
    let adminBuilding = adminBuildings.find((b) => b.name === E2E_ADMIN_BUILDING_NAME) ?? null;
    if (!adminBuilding) {
      const created = await api.post("/api/admin/buildings", {
        data: { name: E2E_ADMIN_BUILDING_NAME, manager_email: "e2e-admin-mgr@test.com" },
        timeout: 60000,
      });
      adminBuilding = (await created.json()) as { id: string; name: string };
    }

    // Add a placeholder lot owner so the building has at least one voter
    const adminLotOwnersRes = await retryGet(`/api/admin/buildings/${adminBuilding.id}/lot-owners`);
    const adminLotOwners = (await adminLotOwnersRes.json()) as { lot_number: string }[];
    if (!adminLotOwners.find((l) => l.lot_number === "ADMIN-1")) {
      await api.post(`/api/admin/buildings/${adminBuilding.id}/lot-owners`, {
        data: { lot_number: "ADMIN-1", emails: ["admin-voter@test.com"], unit_entitlement: 1 },
        timeout: 60000,
      });
    }

    // Close any existing open AGMs for the admin-test building, then create a fresh one
    const adminAgmTitle = `E2E Admin Test AGM-${RUN_SUFFIX}`;
    const allAgmsRes = await retryGet(
      `/api/admin/general-meetings?name=${encodeURIComponent(adminAgmTitle)}`
    );
    const allAgms = (await allAgmsRes.json()) as { id: string; building_id: string; status: string }[];
    // Include "pending" in the filter — same reason as the voter-test AGM above.
    const openAdminAgms = allAgms.filter(
      (a) => a.building_id === adminBuilding!.id && (a.status === "open" || a.status === "pending")
    );
    for (const agm of openAdminAgms) {
      await api.post(`/api/admin/general-meetings/${agm.id}/close`, { timeout: 60000 });
    }

    // Set meeting_at to 2 hours ago so admin tests can find it as status="open".
    const adminMeetingStarted = new Date();
    adminMeetingStarted.setHours(adminMeetingStarted.getHours() - 2);
    const adminClosesAt = new Date();
    adminClosesAt.setFullYear(adminClosesAt.getFullYear() + 1);

    await api.post("/api/admin/general-meetings", {
      data: {
        building_id: adminBuilding.id,
        title: adminAgmTitle,
        meeting_at: adminMeetingStarted.toISOString(),
        voting_closes_at: adminClosesAt.toISOString(),
        motions: [
          {
            title: "Admin Test Motion 1",
            description: "Admin-only test motion — do not vote on this.",
            display_order: 1,
          },
        ],
      },
      timeout: 60000,
    });
  }

  // Warm up the Lambda before seeding (safety net — Phase 1 warmup may have
  // targeted a different Lambda instance than the one handling API requests).
  console.log('[global-setup] Verifying Lambda readiness before seeding...');
  const warmupMaxAttempts = 10;
  const warmupDelay = 5000;
  for (let i = 0; i < warmupMaxAttempts; i++) {
    try {
      const res = await api.get(`${baseURL}/api/health`, { timeout: 15000 });
      if (res.ok()) {
        console.log('[global-setup] Lambda ready');
        break;
      }
    } catch {}
    if (i < warmupMaxAttempts - 1) {
      await new Promise(r => setTimeout(r, warmupDelay));
    }
  }

  // Seed voting building and admin building in parallel — they create independent
  // buildings with no shared state. Both complete before any test worker starts.
  // Note: the sort-order concern (admin AGM newest → first in list) is addressed
  // by the serial guard added to the "Admin General Meetings" describe block, which
  // prevents parallel workers from racing on the same shared open AGM.
  await Promise.all([seedVotingBuilding(), seedAdminBuilding()]);

  await api.dispose();
}
