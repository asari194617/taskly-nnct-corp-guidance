import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list'], ['json', { outputFile: 'coverage/e2e/results.json' }], ['html', { outputFolder: 'coverage/e2e/playwright-report', open: 'never' }]],
  globalTeardown: './e2e/coverage.mjs',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3300', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
