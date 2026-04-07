import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5173";
const isDeployed = !!process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "../e2e_tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : isDeployed ? 1 : 0,
  workers: process.env.CI ? 1 : isDeployed ? 4 : undefined,
  // In CI shard jobs: emit blob reports for later merging; locally: HTML only
  reporter: process.env.CI ? [["blob"], ["list"]] : [["html"]],
  timeout: isDeployed ? 180000 : 30000,
  expect: {
    timeout: isDeployed ? 10000 : 5000,
  },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    ignoreHTTPSErrors: true,
  },
  projects: [
    // ── Setup project ─────────────────────────────────────────────────────────
    // Seeds data and saves auth state to e2e_tests/.auth/.
    // - Local dev: referenced via `dependencies: ['setup']` on each test project
    // - CI: run as a dedicated setup job before shard jobs start
    {
      name: "setup",
      testMatch: "**/global.setup.ts",
    },

    // ── Admin tests ───────────────────────────────────────────────────────────
    // All tests under e2e_tests/admin/. Use the admin-authenticated session.
    // In CI the setup job runs first; locally, 'setup' runs automatically.
    {
      name: "admin",
      testMatch: /e2e_tests\/admin\/.*\.spec\.ts/,
      dependencies: process.env.CI ? [] : ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "../e2e_tests/.auth/admin.json",
      },
    },

    // ── Public: voter edge cases + smoke + core voting flow ───────────────────
    // Lighter voter-focused tests. No admin session needed.
    {
      name: "public-voter",
      testMatch: [
        /e2e_tests\/voter\/.*\.spec\.ts/,
        /e2e_tests\/smoke\.spec\.ts/,
        /e2e_tests\/voting-flow\.spec\.ts/,
      ],
      dependencies: process.env.CI ? [] : ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "../e2e_tests/.auth/public.json",
      },
    },

    // ── Public: workflows + multi-lot + proxy + public summary ────────────────
    // Heavier end-to-end workflow tests. No admin session needed.
    {
      name: "public-workflow",
      testMatch: [
        /e2e_tests\/workflows\/.*\.spec\.ts/,
        /e2e_tests\/multi-lot-voting\.spec\.ts/,
        /e2e_tests\/proxy-voting\.spec\.ts/,
        /e2e_tests\/public-summary\.spec\.ts/,
      ],
      dependencies: process.env.CI ? [] : ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "../e2e_tests/.auth/public.json",
      },
    },
  ],
  // Only spin up the local dev server when not testing against a deployed URL
  webServer: isDeployed
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
      },
});
