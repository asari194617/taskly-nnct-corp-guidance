import { test as base, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const test = base.extend<{
  browserCoverage: undefined;
  firstVisitTour: boolean;
}>({
  firstVisitTour: [false, { option: true }],
  storageState: async ({ baseURL, firstVisitTour }, use) => {
    await use(
      firstVisitTour || !baseURL
        ? undefined
        : {
            cookies: [],
            origins: [
              {
                origin: new URL(baseURL).origin,
                localStorage: [
                  { name: "guidance-first-visit-tour-v2", value: "1" },
                ],
              },
            ],
          },
    );
  },
  browserCoverage: [
    async ({ page, browserName }, use, info) => {
      if (browserName !== "chromium") {
        info.annotations.push({
          type: "coverage",
          description:
            "WebKit execution is reported separately; V8 source coverage measures Chromium only.",
        });
        await use(undefined);
        return;
      }
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use(undefined);
      const coverage = await page.coverage.stopJSCoverage();
      const root = resolve("coverage/e2e/raw");
      await mkdir(root, { recursive: true });
      await writeFile(
        resolve(root, `${info.workerIndex}-${info.testId}.json`),
        JSON.stringify(coverage),
      );
    },
    { auto: true },
  ],
});
export { expect };
