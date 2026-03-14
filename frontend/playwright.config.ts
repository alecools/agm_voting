import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5173";
const isDeployed = !!process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry once on deployed targets (cold-start flakiness); twice in CI
  retries: process.env.CI ? 2 : isDeployed ? 1 : 0,
  // Limit parallelism on deployed targets to avoid hammering the Lambda
  workers: process.env.CI ? 1 : isDeployed ? 2 : undefined,
  reporter: "html",
  globalSetup: "./e2e/global-setup.ts",
  // Increase default expect/action timeout for deployed Lambda targets: API
  // calls can take up to 10s on cold start; the Playwright default of 5s is
  // too short and causes flaky failures on the first assertion after page load.
  timeout: isDeployed ? 60000 : 30000,
  expect: {
    timeout: isDeployed ? 10000 : 5000,
  },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    ignoreHTTPSErrors: true,
  },
  projects: [
    // Admin tests — reuse authenticated session created by globalSetup
    {
      name: "admin",
      testMatch: /e2e\/admin\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/admin.json",
      },
    },
    // Public / voting tests — use bypass cookie only (no admin session)
    {
      name: "public",
      testMatch: /e2e\/(?!admin\/).*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/public.json",
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
