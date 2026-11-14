import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [
    ["list"],
    ["json", { outputFile: "coverage/e2e/results.json" }],
    ["html", { outputFolder: "coverage/e2e/playwright-report", open: "never" }],
  ],
  globalTeardown: "./e2e/coverage.mjs",
  projects: [
    {
      name: "chromium",
      testIgnore: /(?:ios-pdf|offline-webkit)\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], browserName: "chromium" },
    },
    {
      name: "mobile-webkit",
      testMatch: /(?:ios-pdf|offline-webkit)\.spec\.ts$/,
      use: { ...devices["iPhone 15"], browserName: "webkit" },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:3300",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
