import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { largeFixture } from "../tests/fixtures";

const API = "http://127.0.0.1:3371";
const ISSUER = "http://127.0.0.1:3372";
const OBJECTS = "http://127.0.0.1:3373";
const BUCKET = "synthetic-guidance-documents";
const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "メインナビゲーション" })
    .getByRole("link", { name, exact: false });
const documentLink = (page: Page) =>
  page
    .getByRole("banner")
    .getByRole("link", { name: "配布資料の案内", exact: true });
const rosterDialog = (page: Page) =>
  page.getByRole("dialog", { name: "名簿番号の設定" });

async function openAccount(page: Page) {
  const menu = page.getByRole("menu", {
    name: "ユーザーメニュー",
    exact: true,
  });
  if (!(await menu.isVisible()))
    await page
      .getByRole("button", { name: "ユーザーメニュー", exact: true })
      .click();
  await expect(menu).toBeVisible();
  return menu;
}
async function accountAction(page: Page, name: string) {
  const menu = await openAccount(page);
  await menu.getByRole("menuitem", { name, exact: true }).click();
}
async function expectAccountNumber(page: Page, number: number) {
  const menu = await openAccount(page);
  await expect(menu).toContainText(new RegExp(`Ec4.*${number}番`));
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
}
async function chooseRoster(page: Page, number: number) {
  const dialog = rosterDialog(page);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("spinbutton", { name: "名簿番号" })
    .fill(String(number));
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function login(page: Page, subject: string, path = "/", setup = true) {
  await page.goto(path);
  await page.getByRole("button", { name: "Tasklyでログイン" }).click();
  await expect(
    page.getByRole("heading", { name: "検証用ログイン" }),
  ).toBeVisible();
  await page.getByLabel("検証アカウント").selectOption(subject);
  await page.getByRole("button", { name: "検証用アカウントで続ける" }).click();
  await page.waitForURL((url) => url.origin === "http://127.0.0.1:3300");
  const response = await page.request.get(`${API}/api/preferences`);
  expect(response.status()).toBe(200);
  const preference = await response.json();
  if (preference.roster_number === null) {
    await expect(rosterDialog(page)).toBeVisible();
    if (setup) await chooseRoster(page, 7);
  }
  if (setup)
    await expect(
      page.getByRole("button", { name: "ユーザーメニュー", exact: true }),
    ).toBeVisible();
}
async function assertCompanyCount(page: Page, count: number) {
  await expect(page.locator(".company-card")).toHaveCount(count);
}
async function verifyLongIndustryFits(page: Page) {
  const group = await industries(page);
  const longIndustry = group.getByRole("checkbox", { name: /^架空の研究開発/ });
  await checkbox(longIndustry, true);
  await assertCompanyCount(page, 1);
  await expect
    .poll(() => page.locator("body").evaluate((body) => body.scrollWidth))
    .toBeLessThanOrEqual(page.viewportSize()!.width);
  await checkbox(
    group.getByRole("checkbox", { name: "研究", exact: true }),
    true,
  );
  // OR matching must not duplicate a company matching both selected industries.
  await assertCompanyCount(page, 1);
  await group.getByRole("button", { name: "業種を解除", exact: true }).click();
  await assertCompanyCount(page, 4);
}
async function checkbox(input: Locator, checked: boolean) {
  if ((await input.isChecked()) !== checked) await input.locator("..").click();
  if (checked) await expect(input).toBeChecked();
  else await expect(input).not.toBeChecked();
}
async function industries(page: Page) {
  const group = page.getByRole("group", { name: "業種", exact: true });
  if (!(await group.isVisible()))
    await page.locator("summary").filter({ hasText: /^業種/ }).first().click();
  await expect(group).toBeVisible();
  return group;
}

test("Taskly branding, social metadata and legacy URLs are usable before login", async ({
  page,
}) => {
  await page.goto("/index.html?view=map&focus=AM-1#booth");
  await expect(
    page.getByRole("button", { name: "Tasklyでログイン" }),
  ).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/map/");
  expect(new URL(page.url()).searchParams.has("view")).toBe(false);
  expect(new URL(page.url()).searchParams.get("focus")).toBe("AM-1");
  expect(new URL(page.url()).hash).toBe("#booth");
  const brand = page.getByRole("link", {
    name: "Taskly 企業ガイダンス ホーム",
  });
  const logo = brand.getByRole("img", { name: "Taskly", exact: true });
  await expect(logo).toHaveAttribute("src", "/taskly-logo.svg");
  await expect
    .poll(() =>
      logo.evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const site = "https://nnct-corp-guidance-2026.taskly.iy0306.com/";
  const image = "https://cdn.taskly.iy0306.com/assets/thumbnail-dark.webp";
  for (const [property, content] of Object.entries({
    "og:type": "website",
    "og:site_name": "Taskly",
    "og:title": "企業ガイダンス | Taskly",
    "og:description":
      "企業情報、見学スケジュール、指定企業、会場マップを確認できます。",
    "og:url": site,
    "og:locale": "ja_JP",
    "og:image": image,
    "og:image:type": "image/webp",
  }))
    await expect(page.locator(`meta[property="${property}"]`)).toHaveAttribute(
      "content",
      content,
    );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    image,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    site,
  );
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "https://cdn.taskly.iy0306.com/assets/favicon.webp",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "https://cdn.taskly.iy0306.com/assets/apple-touch-icon.png",
  );
  await expect(page.locator("body")).not.toContainText(
    "企業との出会いを、もっと身近に。",
  );
  await page.setViewportSize({ width: 320, height: 844 });
  const logoBox = (await logo.boundingBox())!;
  const labelBox = (await brand
    .getByText("企業ガイダンス", { exact: true })
    .boundingBox())!;
  expect(logoBox.x + logoBox.width).toBeLessThan(labelBox.x);
  expect(
    Math.abs(logoBox.y + logoBox.height / 2 - labelBox.y - labelBox.height / 2),
  ).toBeLessThan(3);
  expect(
    await page.locator("body").evaluate((body) => body.scrollWidth),
  ).toBeLessThanOrEqual(320);
  for (const path of [
    "/",
    "/search/",
    "/favorites/",
    "/schedule/",
    "/documents/",
    "/map/",
  ]) {
    // The static server has no SPA fallback: these succeed only when Next
    // really exported every page, including paths visited directly on reload.
    expect((await page.request.get(path)).status()).toBe(200);
  }
});

test("First Ec4 roster setup validates, personalizes, persists and can be changed", async ({
  page,
}) => {
  await login(page, "onboarding", "/", false);
  const dialog = rosterDialog(page);
  await expect(dialog).toContainText("Ec4");
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("spinbutton", { name: "名簿番号" }).fill("99");
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(
    (await (await page.request.get(`${API}/api/preferences`)).json())
      .roster_number,
  ).toBeNull();
  await chooseRoster(page, 7);
  await expectAccountNumber(page, 7);
  await nav(page, "気になる").click();
  await expect(
    page.getByRole("heading", { name: "指定企業", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText("架空あおばソフト");
  await expect(page.locator("body")).not.toContainText("架空ホール");
  await page.reload();
  await expect(rosterDialog(page)).not.toBeVisible();
  await expectAccountNumber(page, 7);
  await accountAction(page, "名簿番号の設定");
  await expect(
    dialog.getByRole("spinbutton", { name: "名簿番号" }),
  ).toHaveValue("7");
  await chooseRoster(page, 8);
  expect(
    (await (await page.request.get(`${API}/api/preferences`)).json())
      .roster_number,
  ).toBe(8);
  await page.reload();
  await expectAccountNumber(page, 8);
  expect(new URL(page.url()).searchParams.has("roster_number")).toBe(false);
});

test("Search filters and saved companies survive reload through real MySQL", async ({
  page,
}) => {
  await login(page, "alice", "/search/");
  expect(new URL(page.url()).pathname).toBe("/search/");
  await assertCompanyCount(page, 4);
  await verifyLongIndustryFits(page);
  let group = await industries(page);
  await checkbox(
    group.getByRole("checkbox", { name: "情報処理", exact: true }),
    true,
  );
  await checkbox(
    group.getByRole("checkbox", { name: "機械", exact: true }),
    true,
  );
  await assertCompanyCount(page, 2);
  expect(new Set(new URL(page.url()).searchParams.getAll("industry"))).toEqual(
    new Set(["情報処理", "機械"]),
  );
  await page.reload();
  await assertCompanyCount(page, 2);
  group = await industries(page);
  await expect(
    group.getByRole("checkbox", { name: "情報処理", exact: true }),
  ).toBeChecked();
  await expect(
    group.getByRole("checkbox", { name: "機械", exact: true }),
  ).toBeChecked();
  await group.getByRole("button", { name: "業種を解除", exact: true }).click();
  await page.getByRole("searchbox").fill("あおば");
  await assertCompanyCount(page, 1);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("あおば");
  await page
    .getByRole("button", {
      name: "架空あおばソフトを気になるに追加",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "架空あおばソフトを気になるから解除",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await assertCompanyCount(page, 1);
  await expect(page.getByRole("searchbox")).toHaveValue("あおば");
  await expect(
    page.getByRole("button", {
      name: "架空あおばソフトを気になるから解除",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("searchbox").fill("");
  await page.getByLabel("気になるのみ", { exact: true }).locator("..").click();
  await assertCompanyCount(page, 1);
  await page.getByLabel("気になるのみ", { exact: true }).locator("..").click();
  await page.getByRole("radio", { name: "午後の部", exact: true }).click();
  await assertCompanyCount(page, 2);
  group = await industries(page);
  await checkbox(
    group.getByRole("checkbox", { name: "建設", exact: true }),
    true,
  );
  await assertCompanyCount(page, 1);
  await page.getByRole("searchbox").fill("存在しないキーワード");
  await expect(
    page.getByRole("heading", { name: "条件に合う企業が見つかりません" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "条件をリセット" }).click();
  await assertCompanyCount(page, 4);
});

test("Shared company URLs restore through OAuth and browser back/forward", async ({
  page,
}) => {
  await login(page, "routing", "/search/?company=AM-1&session=AM");
  const dialog = page.getByRole("dialog", {
    name: "架空あおばソフト",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("company")).toBe("AM-1");
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(dialog).not.toBeVisible();
  expect(new URL(page.url()).searchParams.has("company")).toBe(false);
  await page
    .locator(".company-card")
    .filter({ hasText: "架空あおばソフト" })
    .getByRole("link", { name: "詳細を見る", exact: true })
    .click();
  await dialog.locator("summary").filter({ hasText: "会場マップ" }).click();
  await dialog
    .getByRole("link", { name: "マップページを開く", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/map/");
  const full = page.locator('.venue-map[data-mode="fullscreen"]');
  await expect(
    full.getByRole("button", {
      name: "午前 ブース 1 架空あおばソフト",
      exact: true,
    }),
  ).toHaveAttribute("data-selected", "true");
  await expect(
    full.getByRole("button", {
      name: "拡大率を100パーセントに戻す",
      exact: true,
    }),
  ).toHaveText("100%");
  await page.getByRole("link", { name: /一覧/ }).first().click();
  await assertCompanyCount(page, 4);
  await nav(page, "スケジュール").click();
  await expect(
    page.getByRole("heading", { name: "スケジュール", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/schedule/");
  await page.goBack();
  await assertCompanyCount(page, 4);
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "スケジュール", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "見学前の準備", exact: true }),
  ).toHaveCount(0);
  await documentLink(page).click();
  await expect(
    page.getByRole("heading", { name: "配布資料の案内", level: 1 }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/documents/");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "配布資料の案内", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "見学前の準備", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "質問するとき", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: "検証用の筆記具" }),
  ).toBeVisible();
});

test("Fullscreen maps keep blue selection and a non-modal company panel while map controls remain interactive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "map", "/map/?session=AM&focus=AM-1");
  const full = page.locator('.venue-map[data-mode="fullscreen"]');
  const viewport = full.getByRole("region", {
    name: "操作できる会場マップ",
    exact: true,
  });
  const zoom = full.getByRole("button", {
    name: "拡大率を100パーセントに戻す",
    exact: true,
  });
  const first = full.getByRole("button", {
    name: "午前 ブース 1 架空あおばソフト",
    exact: true,
  });
  const second = full.getByRole("button", {
    name: "午前 ブース 2 架空いろは機械",
    exact: true,
  });
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(zoom).toHaveText("100%");
  await expect(first).toHaveAttribute("data-assigned", "true");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await first.hover();
    const selectedStyle = await first.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        border: style.borderColor,
        outline: style.outlineColor,
        shadow: style.boxShadow,
        background: style.backgroundColor,
      };
    });
    expect(selectedStyle.border).toBe("rgb(0, 145, 255)");
    expect(selectedStyle.outline).toBe("rgb(0, 145, 255)");
    expect(selectedStyle.shadow).toContain("rgb(0, 145, 255)");
    expect(selectedStyle.background).toBe("rgba(0, 0, 0, 0)");
    await second.hover();
    expect(
      await second.evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
  }
  await page.emulateMedia({ colorScheme: "light" });
  const image = full.getByRole("img", { name: "検証1階マップ", exact: true });
  expect(await image.evaluate((node) => getComputedStyle(node).opacity)).toBe(
    "1",
  );
  await expect(full.locator(".venue-map-search-icon svg")).toBeVisible();
  await expect(
    full.getByRole("searchbox", { name: "マップの企業名", exact: true }),
  ).toBeVisible();
  const zoomInBounds = (await full
    .getByRole("button", { name: "マップを拡大", exact: true })
    .boundingBox())!;
  expect(zoomInBounds.width).toBeLessThanOrEqual(40);
  expect(zoomInBounds.height).toBeLessThanOrEqual(40);
  const area = (await viewport.boundingBox())!;
  expect(area.x).toBe(0);
  const header = page.getByRole("banner");
  await expect(header).toBeVisible();
  await expect(nav(page, "マップ")).toHaveAttribute("aria-current", "page");
  const headerBounds = (await header.boundingBox())!;
  expect(area.y).toBeCloseTo(headerBounds.y + headerBounds.height, 0);
  expect(area.width).toBe(page.viewportSize()!.width);
  expect(area.y + area.height).toBeCloseTo(page.viewportSize()!.height, 0);
  for (let step = 0; step < 3; step++)
    await full
      .getByRole("button", { name: "マップを拡大", exact: true })
      .click();
  await expect(zoom).toHaveText("175%");
  await first.click();
  let panel = page.getByRole("region", {
    name: "架空あおばソフト",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(first).toBeFocused();
  const side = (await panel.boundingBox())!;
  expect(side.x).toBeGreaterThan(1440 / 2);
  expect(side.x + side.width).toBeLessThanOrEqual(1440);
  expect(new URL(page.url()).searchParams.get("company")).toBe("AM-1");
  await full.getByRole("button", { name: "マップを拡大", exact: true }).click();
  await expect(zoom).toHaveText("200%");
  await expect(panel).toBeVisible();
  await full.getByRole("button", { name: "マップを縮小", exact: true }).click();
  await openAccount(page);
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await second.focus();
  await page.keyboard.press("Enter");
  panel = page.getByRole("region", { name: "架空いろは機械", exact: true });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "架空いろは機械", exact: true }),
  ).toBeFocused();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect(
      await first.evaluate((node) => getComputedStyle(node).boxShadow),
    ).toContain("rgb(35, 123, 49)");
    expect(
      await second.evaluate((node) => getComputedStyle(node).outlineColor),
    ).toBe("rgb(0, 145, 255)");
  }
  await page.emulateMedia({ colorScheme: "light" });
  expect(new URL(page.url()).searchParams.get("focus")).toBe("AM-2");
  await expect(zoom).toHaveText("175%");
  await panel
    .getByRole("heading", { name: "架空いろは機械", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(second).toBeFocused();
  await first.focus();
  await page.keyboard.press("Enter");
  panel = page.getByRole("region", { name: "架空あおばソフト", exact: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const bottom = (await panel.boundingBox())!;
  expect(bottom.x).toBeGreaterThanOrEqual(0);
  expect(bottom.x + bottom.width).toBeLessThanOrEqual(390);
  expect(bottom.y).toBeGreaterThan(844 * 0.4);
  const mobileNavigation = page.getByRole("navigation", {
    name: "モバイルナビゲーション",
  });
  await expect(mobileNavigation).toBeVisible();
  await expect(
    mobileNavigation.getByRole("link", { name: "マップ", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const navigationBounds = (await mobileNavigation.boundingBox())!;
  const mobileMap = (await viewport.boundingBox())!;
  const mobileHeader = (await header.boundingBox())!;
  expect(mobileMap.y).toBeCloseTo(mobileHeader.y + mobileHeader.height, 0);
  expect(mobileMap.y + mobileMap.height).toBeCloseTo(navigationBounds.y, 0);
  expect(bottom.y + bottom.height).toBeLessThanOrEqual(navigationBounds.y);
  expect(bottom.y + bottom.height).toBeGreaterThan(navigationBounds.y - 20);
  await full.getByRole("button", { name: "マップを拡大", exact: true }).click();
  await expect(zoom).toHaveText("200%");
  await expect(panel).toBeVisible();
  await full.getByRole("button", { name: "マップを縮小", exact: true }).click();
  await page.setViewportSize({ width: 844, height: 390 });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const mapBounds = (await viewport.boundingBox())!;
    const landscapeHeader = (await header.boundingBox())!;
    const landscapeNav = (await mobileNavigation.boundingBox())!;
    const landscapePanel = (await panel.boundingBox())!;
    expect(mapBounds.y).toBeCloseTo(
      landscapeHeader.y + landscapeHeader.height,
      0,
    );
    expect(mapBounds.y + mapBounds.height).toBeCloseTo(landscapeNav.y, 0);
    expect(landscapePanel.y).toBeGreaterThanOrEqual(mapBounds.y);
    expect(landscapePanel.y + landscapePanel.height).toBeLessThanOrEqual(
      landscapeNav.y,
    );
    for (const name of [
      "マップを拡大",
      "拡大率を100パーセントに戻す",
      "マップを縮小",
      "検証1階マップ",
      "検証2階マップ",
    ]) {
      const control = full.getByRole("button", { name, exact: true });
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(mapBounds.x);
      expect(bounds.y).toBeGreaterThanOrEqual(mapBounds.y);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        mapBounds.x + mapBounds.width,
      );
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(landscapePanel.y);
      expect(
        await control.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      ).toBe(true);
    }
    await full
      .getByRole("button", { name: "マップを拡大", exact: true })
      .click();
    await expect(zoom).toHaveText("200%");
    await full
      .getByRole("button", { name: "マップを縮小", exact: true })
      .click();
    await expect(zoom).toHaveText("175%");
    await expect(panel).toBeVisible();
  }
  await page.emulateMedia({ colorScheme: "light" });
  await panel
    .getByRole("button", { name: "企業情報を閉じる", exact: true })
    .click();
  await full.getByRole("button", { name: /^表示中の一覧/ }).click();
  const landscapeResults = full.getByRole("region", {
    name: "表示中の一覧",
    exact: true,
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const sheetBounds = (await landscapeResults.boundingBox())!;
    const mapBounds = (await viewport.boundingBox())!;
    expect(sheetBounds.y).toBeGreaterThanOrEqual(mapBounds.y);
    expect(sheetBounds.y + sheetBounds.height).toBeLessThanOrEqual(
      mapBounds.y + mapBounds.height,
    );
    for (const control of [
      landscapeResults.getByRole("button", {
        name: "企業詳細 架空あおばソフト",
        exact: true,
      }),
      landscapeResults.getByRole("button", { name: "閉じる", exact: true }),
    ]) {
      await expect(control).toBeVisible();
      const bounds = (await control.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(sheetBounds.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(
        sheetBounds.y + sheetBounds.height,
      );
      expect(
        await control.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      ).toBe(true);
    }
    await test.info().attach(`landscape-map-results-${colorScheme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await full
    .getByRole("button", { name: "検証2階マップ", exact: true })
    .click();
  await expect(
    full.getByRole("img", { name: "検証2階マップ", exact: true }),
  ).toBeVisible();
  await expect(landscapeResults).toBeVisible();
  await full
    .getByRole("button", { name: "検証1階マップ", exact: true })
    .click();
  await landscapeResults
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  await expect(landscapeResults).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(zoom).toHaveText("175%");
  await full.getByRole("button", { name: /^表示中の一覧/ }).click();
  const results = full.getByRole("region", {
    name: "表示中の一覧",
    exact: true,
  });
  await expect(results).toBeVisible();
  const floorControls = full.locator(".venue-map-floors");
  const floorsBounds = (await floorControls.boundingBox())!;
  const resultBounds = (await results.boundingBox())!;
  const intersects =
    floorsBounds.x < resultBounds.x + resultBounds.width &&
    floorsBounds.x + floorsBounds.width > resultBounds.x &&
    floorsBounds.y < resultBounds.y + resultBounds.height &&
    floorsBounds.y + floorsBounds.height > resultBounds.y;
  expect(intersects).toBe(false);
  expect(floorsBounds.x + floorsBounds.width).toBeGreaterThan(1440 - 40);
  expect(
    await floorControls
      .getByRole("button")
      .first()
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
  ).toBe(true);
  await results
    .getByRole("button", { name: "企業詳細 架空いろは機械", exact: true })
    .click();
  const secondDialog = page.getByRole("region", {
    name: "架空いろは機械",
    exact: true,
  });
  await expect(secondDialog).toBeVisible();
  await secondDialog
    .getByRole("button", { name: "企業情報を閉じる", exact: true })
    .click();
  await expect(zoom).toHaveText("175%");
  await full.getByRole("button", { name: "絞り込み", exact: true }).click();
  const industry = full.getByRole("group", { name: "業種", exact: true });
  await checkbox(
    industry.getByRole("checkbox", { name: "情報処理", exact: true }),
    true,
  );
  await checkbox(
    industry.getByRole("checkbox", { name: "機械", exact: true }),
    true,
  );
  await expect(first).toBeEnabled();

  await expect(second).toBeEnabled();
  await checkbox(
    industry.getByRole("checkbox", { name: "情報処理", exact: true }),
    false,
  );
  await expect(first).toBeDisabled();
  await expect(second).toBeEnabled();
  await checkbox(
    industry.getByRole("checkbox", { name: "機械", exact: true }),
    false,
  );
  await page.getByLabel("マップの企業名", { exact: true }).fill("いろは");
  await expect(first).toHaveAttribute("data-match", "false");
  await second.click();
  await expect(
    page.getByRole("region", { name: "架空いろは機械", exact: true }),
  ).toBeVisible();
  await secondDialog
    .getByRole("button", { name: "企業情報を閉じる", exact: true })
    .click();
  await expect(zoom).toHaveText("175%");
  await page.getByLabel("マップの企業名", { exact: true }).fill("");
  await full.getByRole("button", { name: "絞り込み", exact: true }).click();
  await full.getByRole("radio", { name: "午後の部", exact: true }).click();
  await full
    .getByRole("button", { name: "午後 ブース 1 架空みらい建設", exact: true })
    .click();
  await page
    .getByRole("region", { name: "架空みらい建設", exact: true })
    .getByRole("button", { name: "企業情報を閉じる", exact: true })
    .click();
  await expect(zoom).toHaveText("175%");
  const booth = full.getByRole("button", {
    name: "午後 ブース 1 架空みらい建設",
    exact: true,
  });
  await booth.scrollIntoViewIfNeeded();
  const boothBounds = (await booth.boundingBox())!;
  const viewportBounds = (await viewport.boundingBox())!;
  const startX = Math.max(
    viewportBounds.x + 130,
    Math.min(
      boothBounds.x + boothBounds.width / 2,
      viewportBounds.x + viewportBounds.width - 30,
    ),
  );
  const startY = Math.max(
    viewportBounds.y + 130,
    Math.min(
      boothBounds.y + boothBounds.height / 2,
      viewportBounds.y + viewportBounds.height - 100,
    ),
  );
  const before = await viewport.evaluate((node) => node.scrollLeft);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 100, startY, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(before);
  const client = await page.context().newCDPSession(page);
  const center = {
    x: viewportBounds.x + viewportBounds.width / 2,
    y: viewportBounds.y + viewportBounds.height / 2,
  };
  const zoomBeforePinch = await zoom.textContent();
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: center.x - 35, y: center.y },
      { id: 2, x: center.x + 35, y: center.y },
    ],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 1, x: center.x - 70, y: center.y },
      { id: 2, x: center.x + 70, y: center.y },
    ],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await client.detach();
  await expect(zoom).not.toHaveText(zoomBeforePinch!);
  await full
    .getByRole("button", { name: "検証2階マップ", exact: true })
    .click();
  await expect(
    full.getByRole("img", { name: "検証2階マップ", exact: true }),
  ).toBeVisible();
  await expect(full.locator(".venue-map-booth")).toHaveCount(0);
  await page.getByRole("link", { name: /一覧/ }).first().click();
  await expect(
    page.getByRole("heading", { name: "一覧", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("Private R2 presigned PDFs work without cookies and expire independently of login", async ({
  page,
  request,
}) => {
  await login(page, "documents", "/documents/");
  const popupPromise = page.waitForEvent("popup");
  // A headless browser can download a PDF instead of committing a viewer page.
  const navigationPromise = page.context().waitForEvent("request", {
    predicate: (navigation) => {
      const url = new URL(navigation.url());
      return (
        navigation.isNavigationRequest() &&
        url.origin === OBJECTS &&
        url.pathname === `/${BUCKET}/guide.pdf`
      );
    },
  });
  await page
    .getByRole("button", { name: "検証用ガイドPDF", exact: true })
    .click();
  const [popup, navigation] = await Promise.all([
    popupPromise,
    navigationPromise,
  ]);
  expect(navigation.frame()).toBe(popup.mainFrame());
  expect(navigation.resourceType()).toBe("document");
  const signed = new URL(navigation.url());
  expect(signed.origin).toBe(OBJECTS);
  expect(signed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  expect(Number(signed.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(0);
  expect(Number(signed.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
    300,
  );
  expect((await request.storageState()).cookies).toEqual([]);
  const document = await request.get(signed.href);
  expect(document.status()).toBe(200);
  expect(document.headers()["content-type"]).toBe("application/pdf");
  expect(document.headers()["cache-control"]).toBe("no-store");
  expect((await document.body()).toString().startsWith("%PDF-1.4")).toBe(true);
  const range = await request.get(signed.href, {
    headers: { Range: "bytes=0-3" },
  });
  expect(range.status()).toBe(206);
  expect((await range.body()).toString()).toBe("%PDF");
  const tampered = new URL(signed);
  tampered.searchParams.set("X-Amz-Signature", "0".repeat(64));
  expect((await request.get(tampered.href)).status()).toBe(403);
  const wrongDocument = new URL(signed);
  wrongDocument.pathname = `/${BUCKET}/floor-a.png`;
  expect((await request.get(wrongDocument.href)).status()).toBe(403);
  expect(
    (await request.get(new URL(signed.pathname, signed.origin).href)).status(),
  ).toBe(403);
  if (!popup.isClosed()) await popup.close();
  await accountAction(page, "ログアウト");
  await expect(
    page.getByRole("button", { name: "Tasklyでログイン" }),
  ).toBeVisible();
  // R2 validates its signature, not the user's current session. Already-issued
  // links remain bearer capabilities until their bounded expiry; new issuance fails.
  expect((await request.get(signed.href)).status()).toBe(200);
  expect(
    (await page.request.get(`${API}/api/documents/guide/url`)).status(),
  ).toBe(401);
});

test("Saved companies and roster preferences remain isolated by identity", async ({
  page,
}) => {
  await login(page, "bob", "/search/");
  await page.getByLabel("気になるのみ", { exact: true }).locator("..").click();
  await expect(
    page.getByRole("heading", { name: "条件に合う企業が見つかりません" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`${API}/api/preferences`)).json())
      .roster_number,
  ).toBe(7);
  await page.getByRole("button", { name: "条件をリセット" }).click();
  await page
    .getByRole("button", {
      name: "架空あおばソフトを気になるに追加",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "架空あおばソフトを気になるから解除",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", {
      name: "架空あおばソフトを気になるから解除",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "架空あおばソフトを気になるに追加",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
});

test("Identity outages fail closed, then revoked sessions offer reauthentication", async ({
  page,
  request,
}) => {
  await login(page, "outage");
  await request.post(`${ISSUER}/__test/outage?enabled=1`);
  try {
    await page.reload();
    await expect(
      page.getByRole("button", { name: "もう一度接続する" }),
    ).toBeVisible();
    await assertCompanyCount(page, 0);
  } finally {
    await request.post(`${ISSUER}/__test/outage?enabled=0`);
  }
  await page.getByRole("button", { name: "もう一度接続する" }).click();
  await assertCompanyCount(page, 4);
  await request.post(`${ISSUER}/__test/revoke?subject=outage`);
  await page
    .getByRole("button", {
      name: "架空いろは機械を気になるに追加",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Tasklyでログイン" }),
  ).toBeVisible();
  await assertCompanyCount(page, 0);
  await login(page, "outage");
  await assertCompanyCount(page, 4);
});

test("Small screens use fixed icon links while large-screen navigation stays in the header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "mobile");
  const mobile = page.getByRole("navigation", {
    name: "モバイルナビゲーション",
  });
  await expect(mobile).toBeVisible();
  expect(
    (await page.getByRole("banner").boundingBox())!.height,
  ).toBeLessThanOrEqual(60);
  const current = mobile.getByRole("link", { name: "一覧", exact: true });
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(current.locator("svg")).toHaveAttribute("data-filled", "true");
  expect(
    await current
      .locator("svg")
      .evaluate((node) =>
        [...node.querySelectorAll("path,circle,rect")].some(
          (shape) => getComputedStyle(shape).fill !== "none",
        ),
      ),
  ).toBe(true);
  expect(
    await current.evaluate((node) => {
      const style = getComputedStyle(node.closest("li")!, "::before");
      return (
        style.content !== "none" &&
        style.display !== "none" &&
        parseFloat(style.height) > 0
      );
    }),
  ).toBe(false);
  expect(
    await mobile
      .getByRole("link", { name: "探す", exact: true })
      .locator("svg")
      .getAttribute("data-filled"),
  ).not.toBe("true");
  expect(await mobile.evaluate((node) => getComputedStyle(node).position)).toBe(
    "fixed",
  );
  for (const [label, path] of Object.entries({
    一覧: "/",
    探す: "/search/",
    予定: "/schedule/",
    マップ: "/map/",
    気になる: "/favorites/",
  })) {
    const link = mobile.getByRole("link", { name: label, exact: true });
    expect(
      new URL((await link.getAttribute("href")) || "", "http://127.0.0.1:3300")
        .pathname,
    ).toBe(path);
    expect(
      new URL(
        (await link.getAttribute("href")) || "",
        "http://127.0.0.1:3300",
      ).searchParams.has("view"),
    ).toBe(false);
    await expect(link.locator("svg").first()).toBeVisible();
  }
  await mobile.getByRole("link", { name: "探す", exact: true }).click();
  await expect(
    mobile.getByRole("link", { name: "探す", exact: true }).locator("svg"),
  ).toHaveAttribute("data-filled", "true");
  expect(
    await mobile
      .getByRole("link", { name: "一覧", exact: true })
      .locator("svg")
      .getAttribute("data-filled"),
  ).not.toBe("true");
  await verifyLongIndustryFits(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(() => page.locator("body").evaluate((body) => body.scrollWidth))
    .toBeLessThanOrEqual(320);
  await mobile.getByRole("link", { name: "マップ", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "検証1階マップ", exact: true }),
  ).toBeVisible();
  const canvas = page
    .locator('.venue-map[data-mode="fullscreen"]')
    .getByRole("region", { name: "操作できる会場マップ", exact: true });
  const bounds = (await canvas.boundingBox())!;
  expect(bounds.width).toBe(320);
  const mapHeader = (await page.getByRole("banner").boundingBox())!;
  const mapNavigation = (await mobile.boundingBox())!;
  expect(bounds.y).toBeCloseTo(mapHeader.y + mapHeader.height, 0);
  expect(bounds.y + bounds.height).toBeCloseTo(mapNavigation.y, 0);
  await expect(mobile).toBeVisible();
  await mobile.getByRole("link", { name: "一覧", exact: true }).click();
  await mobile.getByRole("link", { name: "気になる", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "指定企業", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(mobile).not.toBeVisible();
  const desktop = page.getByRole("navigation", {
    name: "メインナビゲーション",
  });
  await expect(desktop).toBeVisible();
  expect(
    (await page.getByRole("banner").boundingBox())!.height,
  ).toBeLessThanOrEqual(64);
  const selected = desktop.getByRole("link", {
    name: "気になる",
    exact: false,
  });
  await expect(selected).toHaveAttribute("aria-current", "page");
  expect(
    await selected.evaluate((node) =>
      parseFloat(getComputedStyle(node.closest("li")!).borderBottomWidth),
    ),
  ).toBe(0);
  expect(
    await desktop.evaluate((node) => Boolean(node.closest("header"))),
  ).toBe(true);
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "掲載情報は配布資料をもとにしています。",
  );
});

function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const values = color
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    if (!values || values.length !== 3)
      throw Error(`Unsupported computed color: ${color}`);
    const linear = values.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("The directory starts with companies and follows readable system color themes", async ({
  page,
}, info) => {
  await login(page, "presentation");
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    let lightBackground = "";
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(
        page.getByRole("heading", { name: "一覧", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await assertCompanyCount(page, 4);
      const card = page.locator(".company-card").first();
      const bounds = (await card.boundingBox())!;
      expect(bounds.y).toBeLessThan(350);
      expect(bounds.y + bounds.height).toBeLessThan(viewport.height - 70);
      const colors = await page.locator("html").evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(
        contrastRatio(colors.color, colors.background),
      ).toBeGreaterThanOrEqual(4.5);
      if (colorScheme === "light") lightBackground = colors.background;
      else expect(colors.background).not.toBe(lightBackground);
      const surface = await card.evaluate((node) => {
        const style = getComputedStyle(node);
        const title = getComputedStyle(node.querySelector("h2 a")!);
        return { color: title.color, background: style.backgroundColor };
      });
      expect(
        contrastRatio(surface.color, surface.background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await page.locator("body").evaluate((node) => node.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
      const screenshot = info.outputPath(
        `directory-${viewport.width}-${colorScheme}.png`,
      );
      await page.screenshot({ path: screenshot });
      await info.attach(`Directory ${viewport.width}px ${colorScheme}`, {
        path: screenshot,
        contentType: "image/png",
      });
    }
  }
});

test("Account actions, interest labels and document guidance are available without crowding the header", async ({
  page,
}) => {
  await login(page, "menu");
  const trigger = page.getByRole("button", {
    name: "ユーザーメニュー",
    exact: true,
  });
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(
    page.getByRole("menuitem", { name: "ログアウト", exact: true }),
  ).toHaveCount(0);
  const guideLink = documentLink(page);
  await expect(guideLink).toHaveAttribute("href", "/documents/");
  await expect(guideLink.locator("svg")).toBeVisible();
  const guideBounds = (await guideLink.boundingBox())!;
  const triggerBounds = (await trigger.boundingBox())!;
  expect(guideBounds.x + guideBounds.width).toBeLessThanOrEqual(
    triggerBounds.x,
  );
  expect(
    (await page.getByRole("banner").boundingBox())!.height,
  ).toBeLessThanOrEqual(64);
  expect(triggerBounds.width).toBeLessThanOrEqual(44);
  expect(triggerBounds.height).toBeLessThanOrEqual(44);
  const icon = (await trigger.locator("svg").boundingBox())!;
  expect(icon.width).toBeLessThanOrEqual(24);
  const brand = page.getByRole("link", {
    name: "Taskly 企業ガイダンス ホーム",
  });
  const caption = (await brand
    .getByText("企業ガイダンス", { exact: true })
    .boundingBox())!;
  expect(
    Math.abs(
      caption.y +
        caption.height / 2 -
        triggerBounds.y -
        triggerBounds.height / 2,
    ),
  ).toBeLessThanOrEqual(3);
  const menu = await openAccount(page);
  await expect(menu).toContainText("検証ユーザー menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(
    menu.getByRole("menuitem", { name: "配布資料の案内", exact: true }),
  ).toHaveCount(0);
  const roster = menu.getByRole("menuitem", {
    name: "名簿番号の設定",
    exact: true,
  });
  const logout = menu.getByRole("menuitem", {
    name: "ログアウト",
    exact: true,
  });
  await page.keyboard.press("End");
  await expect(logout).toBeFocused();
  await page.keyboard.press("Home");
  await expect(roster).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(logout).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await openAccount(page);
  await page.getByRole("heading", { name: "一覧", exact: true }).click();
  await expect(menu).not.toBeVisible();
  await documentLink(page).click();
  await expect(
    page.getByRole("heading", { name: "配布資料の案内", level: 1 }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/documents/");
  await expect(documentLink(page)).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "一覧", exact: true }),
  ).toBeVisible();
  await nav(page, "気になる").click();
  await expect(
    page.getByRole("heading", { name: "気になる", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("見学リスト");
  await expect(page.locator("body")).not.toContainText(
    "保存した企業は、同じTasklyアカウントで確認できます。",
  );
});

test("Long company names align left without underlines and schedule markers align with titles", async ({
  page,
}) => {
  await login(page, "presentation");
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const title = page.getByRole("link", {
      name: "架空よつば研究・環境設備・情報技術・共同研究開発センター株式会社",
      exact: true,
    });
    await title.scrollIntoViewIfNeeded();
    const metrics = await title.evaluate((node) => {
      const style = getComputedStyle(node);
      const range = document.createRange();
      range.selectNodeContents(node);
      return {
        align: style.textAlign,
        lines: range.getClientRects().length,
        decoration: style.textDecorationLine,
      };
    });
    expect(["left", "start"]).toContain(metrics.align);
    expect(metrics.lines).toBeGreaterThan(1);
    expect(metrics.decoration).toBe("none");
    const normalColor = await title.evaluate(
      (node) => getComputedStyle(node).color,
    );
    await title.hover();
    expect(
      await title.evaluate((node) => getComputedStyle(node).textDecorationLine),
    ).toBe("none");
    await expect
      .poll(() => title.evaluate((node) => getComputedStyle(node).color))
      .not.toBe(normalColor);
    const details = title
      .locator("xpath=ancestor::article")
      .getByRole("link", { name: "詳細を見る", exact: true });
    expect(
      await details.evaluate(
        (node) => getComputedStyle(node).textDecorationLine,
      ),
    ).toBe("none");
    await details.hover();
    expect(
      await details.evaluate(
        (node) => getComputedStyle(node).textDecorationLine,
      ),
    ).toBe("none");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await nav(page, "スケジュール").click();
  const rows = page.locator(".timeline-item");
  for (let index = 0; index < 3; index++) {
    const row = rows.nth(index);
    const dot = (await row.locator(".timeline-track > span").boundingBox())!;
    const heading = (await row
      .getByRole("heading", { level: 2 })
      .boundingBox())!;
    expect(
      Math.abs(dot.y + dot.height / 2 - heading.y - heading.height / 2),
    ).toBeLessThanOrEqual(2);
  }
});

test("A month-long session rotates short-lived access credentials and still revokes on logout", async ({
  page,
  request,
}) => {
  expect(
    (
      await request.post(`${ISSUER}/__test/short-token?subject=refresh`)
    ).status(),
  ).toBe(200);
  await login(page, "refresh");
  const cookie = (await page.context().cookies(API)).find(
    (value) => value.name === "guidance_session",
  );
  expect(cookie).toBeTruthy();
  const remainingDays = (cookie!.expires - Date.now() / 1000) / 86400;
  expect(remainingDays).toBeGreaterThan(29.99);
  expect(remainingDays).toBeLessThanOrEqual(30);
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`${ISSUER}/__test/refresh-count?subject=refresh`)
          ).json()
        ).count,
    )
    .toBeGreaterThan(0);
  // The issuer's initial credential expires after two seconds. A refresh must
  // preserve this browser's longer session rather than reusing the old access.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${API}/api/me`);
        return response.status() === 200
          ? Date.now() / 1000 - (cookie!.expires - 30 * 86400)
          : -1;
      },
      { timeout: 7000, intervals: [500] },
    )
    .toBeGreaterThan(2);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "一覧", exact: true }),
  ).toBeVisible();
  await accountAction(page, "ログアウト");
  await expect(
    page.getByRole("button", { name: "Tasklyでログイン", exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`${API}/api/me`)).status()).toBe(401);
  expect(
    (await page.context().cookies(API)).some(
      (value) => value.name === "guidance_session",
    ),
  ).toBe(false);
  expect(
    (
      await (
        await request.get(`${ISSUER}/__test/active-families?subject=refresh`)
      ).json()
    ).count,
  ).toBe(0);
});

test("A large synthetic catalog renders incrementally on real scrolling without resetting an open detail", async ({
  page,
}) => {
  // This case isolates the rendering cost with synthetic data. All other
  // E2E cases continue through the real Go API and MySQL catalog unchanged.
  const catalog = largeFixture();
  await page.route("**/api/guidance", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(catalog),
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "presentation");
  await assertCompanyCount(page, 24);
  const first = page.getByRole("link", {
    name: catalog.companies[0].name,
    exact: true,
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await assertCompanyCount(page, 48);
  await first.click();
  const dialog = page.getByRole("dialog", {
    name: catalog.companies[0].name,
    exact: true,
  });
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await assertCompanyCount(page, 48);
  for (const expected of [72, 96, 120, 125]) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await assertCompanyCount(page, expected);
  }
  await expect(
    page.getByRole("button", { name: "もっと見る", exact: true }),
  ).toHaveCount(0);
  await nav(page, "探す").click();
  await assertCompanyCount(page, 24);
  const search = page.getByRole("searchbox", {
    name: "企業名・業種・ブース番号で検索",
  });
  await search.fill("検証企業 0001");
  await assertCompanyCount(page, 1);
  await expect(
    page.getByRole("button", { name: "もっと見る", exact: true }),
  ).toHaveCount(0);
  await search.fill("");
  await assertCompanyCount(page, 24);
});

test("Interests appear first and an unsaved card remains undoable until a real reload", async ({
  page,
}) => {
  await login(page, "bob");
  for (const id of ["AM-1", "AM-2", "PM-1", "PM-2"])
    expect(
      (
        await page.request.delete(`${API}/api/bookmarks/${id}`, {
          headers: { Origin: "http://127.0.0.1:3300" },
        })
      ).status(),
    ).toBe(204);
  await page.reload();
  await page
    .getByRole("button", {
      name: "架空いろは機械を気になるに追加",
      exact: true,
    })
    .click();
  await nav(page, "気になる").click();
  const kept = page
    .locator(".company-card")
    .filter({ hasText: "架空いろは機械" });
  await expect(kept).toBeVisible();
  const assigned = page.getByRole("heading", { name: "指定企業", exact: true });
  expect((await kept.boundingBox())!.y).toBeLessThan(
    (await assigned.boundingBox())!.y,
  );
  await kept
    .getByRole("button", {
      name: "架空いろは機械を気になるから解除",
      exact: true,
    })
    .click();
  await expect(kept).toBeVisible();
  await expect(
    kept.getByRole("button", {
      name: "架空いろは機械を気になるに追加",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    (await (await page.request.get(`${API}/api/bookmarks`)).json()).company_ids,
  ).not.toContain("AM-2");
  await kept
    .getByRole("button", {
      name: "架空いろは機械を気になるに追加",
      exact: true,
    })
    .click();
  await expect(
    kept.getByRole("button", {
      name: "架空いろは機械を気になるから解除",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(kept).toBeVisible();
  await expect(
    kept.getByRole("button", {
      name: "架空いろは機械を気になるから解除",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await kept
    .getByRole("button", {
      name: "架空いろは機械を気になるから解除",
      exact: true,
    })
    .click();
  await nav(page, "一覧").click();
  await nav(page, "気になる").click();
  await expect(
    kept.getByRole("button", {
      name: "架空いろは機械を気になるに追加",
      exact: true,
    }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "気になる", exact: true }),
  ).toBeVisible();
  await expect(kept).toHaveCount(0);
});

test("Logout and another account do not inherit retained interest cards", async ({
  page,
}) => {
  await login(page, "bob");
  const add = page.getByRole("button", {
    name: "架空いろは機械を気になるに追加",
    exact: true,
  });
  if (!(await add.count()))
    await page
      .getByRole("button", {
        name: "架空いろは機械を気になるから解除",
        exact: true,
      })
      .click();
  await add.click();
  await nav(page, "気になる").click();
  const kept = page
    .locator(".company-card")
    .filter({ hasText: "架空いろは機械" });
  await kept
    .getByRole("button", {
      name: "架空いろは機械を気になるから解除",
      exact: true,
    })
    .click();
  await expect(kept).toBeVisible();
  await accountAction(page, "ログアウト");
  await expect(
    page.getByRole("button", { name: "Tasklyでログイン", exact: true }),
  ).toBeVisible();
  await expect(kept).toHaveCount(0);
  await login(page, "alice", "/favorites/");
  expect(
    (await (await page.request.get(`${API}/api/bookmarks`)).json()).company_ids,
  ).not.toContain("AM-2");
  await expect(kept).toHaveCount(0);
});
