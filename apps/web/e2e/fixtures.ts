import { test as base, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const test = base.extend<{ browserCoverage: void }>({
  browserCoverage: [
    async ({ page, browserName }, use, info) => {
      if (browserName !== "chromium") {
        info.annotations.push({
          type: "coverage",
          description: "WebKit execution is reported separately; V8 source coverage measures Chromium only.",
        });
        await use();
        return;
      }
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      await use();
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
