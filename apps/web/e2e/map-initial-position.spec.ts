import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const API = "http://127.0.0.1:3371";
const UI = "http://127.0.0.1:3300";
const objectImage =
  /^http:\/\/127\.0\.0\.1:3373\/synthetic-guidance-documents\/floor-[ab]\.png(?:\?|$)/;

async function login(page: Page) {
  await page.goto("/map/?session=AM");
  await page
    .getByRole("button", { name: "Tasklyでログイン", exact: true })
    .click();
  await page.getByLabel("検証アカウント").selectOption("map");
  await page
    .getByRole("button", { name: "検証用アカウントで続ける", exact: true })
    .click();
  await page.waitForURL((url) => url.origin === UI);
  const preferences = await (
    await page.request.get(`${API}/api/preferences`)
  ).json();
  if (preferences.roster_number === null) {
    const dialog = page.getByRole("dialog", {
      name: "名簿番号の設定",
      exact: true,
    });
    await dialog
      .getByRole("spinbutton", { name: "名簿番号", exact: true })
      .fill("7");
    await dialog.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "会場マップ", level: 1 }),
  ).toBeVisible();
}

async function drawingGeometry(viewport: Locator) {
  return viewport.evaluate((element) => {
    const image = element.querySelector("img");
    if (!image?.complete || !image.naturalWidth) return null;
    const imageBounds = image.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const content = {
      left: bounds.left + element.clientLeft,
      top: bounds.top + element.clientTop,
      width: element.clientWidth,
      height: element.clientHeight,
    };
    return {
      centerX:
        imageBounds.left +
        imageBounds.width / 2 -
        (content.left + content.width / 2),
      centerY:
        imageBounds.top +
        imageBounds.height / 2 -
        (content.top + content.height / 2),
      fits:
        imageBounds.left >= content.left - 2 &&
        imageBounds.right <= content.left + content.width + 2 &&
        imageBounds.top >= content.top - 2 &&
        imageBounds.bottom <= content.top + content.height + 2,
      aspect: imageBounds.width / imageBounds.height,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
  });
}

async function expectCentered(viewport: Locator) {
  await expect
    .poll(async () => {
      const geometry = await drawingGeometry(viewport);
      return Boolean(
        geometry &&
          Math.abs(geometry.centerX) <= 2 &&
          Math.abs(geometry.centerY) <= 2 &&
          geometry.fits,
      );
    })
    .toBe(true);
  const geometry = await drawingGeometry(viewport);
  expect(geometry?.naturalWidth).toBe(100);
  expect(geometry?.naturalHeight).toBe(100);
  expect(geometry?.aspect).toBeCloseTo(1, 2);
}

async function settlePaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const size of [
  { width: 1900, height: 950 },
  { width: 390, height: 844 },
]) {
  test.describe(`Known map dimensions at ${size.width}×${size.height}`, () => {
    test.use({
      viewport: size,
      isMobile: size.width < 640,
      hasTouch: size.width < 640,
    });

    test("delayed drawing centers at 100%, respects panning, and restores centered cached floors and visible deep links", async ({
      page,
      context,
      browserName,
    }, info) => {
      test.setTimeout(60_000);
      // Only delay real SigV4 object requests. Authentication, Go metadata,
      // image bytes and signature validation all remain the real E2E services.
      // WebKit may bypass routing once a native worker controls the document;
      // its server-supplied metadata and native asynchronous image load remain.
      let delayed = 0;
      if (browserName === "chromium") {
        await page.route(objectImage, async (route) => {
          delayed++;
          await new Promise((resolve) => setTimeout(resolve, 150));
          await route.continue();
        });
      }
      await login(page);
      const metadata = await (
        await page.request.get(`${API}/api/guidance`)
      ).json();
      const maps = metadata.documents.filter(
        (document: { kind: string }) => document.kind === "map",
      );
      expect(maps).toHaveLength(2);
      for (const document of maps) {
        expect(document.image_width).toBe(100);
        expect(document.image_height).toBe(100);
      }
      const map = page.locator('.venue-map[data-mode="fullscreen"]');
      const viewport = map.getByRole("region", {
        name: "操作できる会場マップ",
        exact: true,
      });
      const reset = map.getByRole("button", {
        name: "マップの表示をリセット",
        exact: true,
      });
      const first = map.getByRole("img", {
        name: "検証1階マップ",
        exact: true,
      });
      await expect(first).toBeVisible();
      await expect(reset).toHaveAccessibleDescription(
        "現在の倍率 100パーセント",
      );
      // No reset, scrollIntoView or selected-company effect precedes this check.
      await expectCentered(viewport);
      if (browserName === "chromium") expect(delayed).toBeGreaterThan(0);

      await viewport.focus();
      const beforePan = await viewport.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      }));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      const panned = await viewport.evaluate((element) => ({
        left: element.scrollLeft,
        top: element.scrollTop,
      }));
      expect(panned.left).toBeGreaterThan(beforePan.left + 20);
      expect(panned.top).toBeGreaterThan(beforePan.top + 20);
      // A repeated image completion notification must retain the user's view.
      await first.dispatchEvent("load");
      await settlePaint(page);
      expect(
        await viewport.evaluate((element) => element.scrollLeft),
      ).toBeCloseTo(panned.left, 1);
      expect(
        await viewport.evaluate((element) => element.scrollTop),
      ).toBeCloseTo(panned.top, 1);
      await reset.click();
      await expectCentered(viewport);

      const previousSource = await first.getAttribute("src");
      await map
        .getByRole("button", { name: "検証2階マップ", exact: true })
        .click();
      const second = map.getByRole("img", {
        name: "検証2階マップ",
        exact: true,
      });
      await expect(second).toBeVisible();
      await expect(second).not.toHaveAttribute("src", previousSource ?? "");
      await expectCentered(viewport);
      await map
        .getByRole("button", { name: "検証1階マップ", exact: true })
        .click();
      await expect(first).toBeVisible();
      await expectCentered(viewport);
      await expect(
        page.getByRole("status", { name: "オフライン用データ", exact: true }),
      ).toHaveAttribute("data-state", "ready");
      await page.waitForFunction(() =>
        Boolean(navigator.serviceWorker.controller),
      );
      await page.screenshot({ path: info.outputPath("initial-online.png") });

      try {
        await context.setOffline(true);
        await page.reload();
        await expect(
          page.getByRole("status", { name: "オフライン用データ", exact: true }),
        ).toHaveAttribute("data-offline", "true");
        await expect(first).toBeVisible();
        await expect(reset).toHaveAccessibleDescription(
          "現在の倍率 100パーセント",
        );
        await expectCentered(viewport);
        await page.goto("/map/?session=AM&focus=AM-1");
        await expect(first).toBeVisible();
        await expect(reset).toHaveAccessibleDescription(
          "現在の倍率 100パーセント",
        );
        const selected = map.getByRole("button", {
          name: "午前 ブース 1 架空あおばソフト",
          exact: true,
        });
        await expect(selected).toHaveAttribute("data-selected", "true");
        await expect(selected).toBeInViewport({ ratio: 1 });
        expect(
          await selected.evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const top = document.elementFromPoint(
              bounds.left + bounds.width / 2,
              bounds.top + bounds.height / 2,
            );
            return Boolean(top && button.contains(top));
          }),
        ).toBe(true);
        await expect(
          page.getByRole("region", { name: "架空あおばソフト", exact: true }),
        ).toHaveCount(0);
        await page.screenshot({
          path: info.outputPath("initial-cached-focus.png"),
        });
      } finally {
        await context.setOffline(false);
      }
    });
  });
}
