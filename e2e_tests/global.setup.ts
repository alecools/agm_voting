/**
 * Playwright project-dependency setup entry point.
 *
 * This file wraps global-setup.ts so it can be run as a Playwright project
 * (via --project=setup) rather than via globalSetup in playwright.config.ts.
 *
 * - Local dev: depends on this project via `dependencies: ['setup']` — runs automatically
 * - CI: the setup job runs `--project=setup`, then test shard jobs run with CI=true
 *   which sets `dependencies: []` (setup already ran, auth artifacts are downloaded)
 */
import { test as setup } from "@playwright/test";
import runGlobalSetup from "./global-setup";

setup("seed test data and save auth state", async () => {
  // global-setup.ts reads baseURL from process.env.PLAYWRIGHT_BASE_URL (not from FullConfig)
  await runGlobalSetup({} as Parameters<typeof runGlobalSetup>[0]);
});
