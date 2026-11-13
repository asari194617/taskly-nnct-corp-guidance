import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const API = "http://127.0.0.1:3371";
const ISSUER = "http://127.0.0.1:3372";
const nav = (page: Page, name: string) => page
  .getByRole("navigation", { name: "メインナビゲーション" })
  .getByRole("link", { name, exact: false });
const rosterDialog = (page: Page) => page.getByRole("dialog", { name: "名簿番号の設定" });

async function chooseRoster(page: Page, number: number) {
  const dialog = rosterDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "名簿番号" }).fill(String(number));
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function login(page: Page, subject: string, path = "/", setup = true) {
  await page.goto(path);
  await page.getByRole("button", { name: "Tasklyでログイン" }).click();
  await expect(page.getByRole("heading", { name: "検証用ログイン" })).toBeVisible();
  await page.getByLabel("検証アカウント").selectOption(subject);
  await page.getByRole("button", { name: "検証用アカウントで続ける" }).click();
  await page.waitForURL(url => url.origin === "http://127.0.0.1:3300");
  const response = await page.request.get(`${API}/api/preferences`);
  expect(response.status()).toBe(200);
  const preference = await response.json();
  if (preference.roster_number === null) {
    await expect(rosterDialog(page)).toBeVisible();
    if (setup) await chooseRoster(page, 7);
  }
  if (setup) await expect(page.getByRole("button", { name: "ログアウト", exact: true })).toBeVisible();
}
async function assertCompanyCount(page: Page, count: number) {
  await expect(page.locator(".company-card")).toHaveCount(count);
}
async function verifyLongIndustryFits(page: Page) {
  const select = page.getByLabel("業種で絞り込む");
  const longIndustry = (await select.locator("option").allTextContents()).find(value => value.length > 40);
  expect(longIndustry).toBeTruthy();
  await select.selectOption(longIndustry!);
  await assertCompanyCount(page, 1);
  await expect.poll(() => page.locator("body").evaluate(body => body.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await select.selectOption("");
  await assertCompanyCount(page, 4);
}

test("Taskly branding, social metadata and legacy URLs are usable before login", async ({ page }) => {
  await page.goto("/index.html?view=map&focus=AM-1#booth");
  await expect(page.getByRole("button", { name: "Tasklyでログイン" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  expect(new URL(page.url()).searchParams.get("focus")).toBe("AM-1");
  expect(new URL(page.url()).hash).toBe("#booth");
  const brand = page.getByRole("link", { name: "Taskly 企業ガイダンス ホーム" });
  const logo = brand.getByRole("img", { name: "Taskly", exact: true });
  await expect(logo).toHaveAttribute("src", "/taskly-logo.svg");
  await expect.poll(() => logo.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const site = "https://nnct-corp-guidance-2026.taskly.iy0306.com/";
  const image = "https://cdn.taskly.iy0306.com/assets/thumbnail-dark.webp";
  for (const [property, content] of Object.entries({
    "og:type": "website", "og:site_name": "Taskly", "og:title": "企業ガイダンス | Taskly",
    "og:description": "企業情報、見学スケジュール、指定企業、会場マップを確認できます。",
    "og:url": site, "og:locale": "ja_JP", "og:image": image, "og:image:type": "image/webp",
  })) await expect(page.locator(`meta[property="${property}"]`)).toHaveAttribute("content", content);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", image);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", site);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "https://cdn.taskly.iy0306.com/assets/favicon.webp");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "https://cdn.taskly.iy0306.com/assets/apple-touch-icon.png");
  await expect(page.locator("body")).not.toContainText("企業との出会いを、もっと身近に。");
  await page.setViewportSize({ width: 320, height: 844 });
  const logoBox = (await logo.boundingBox())!;
  const labelBox = (await brand.getByText("企業ガイダンス", { exact: true }).boundingBox())!;
  expect(logoBox.x + logoBox.width).toBeLessThan(labelBox.x);
  expect(Math.abs(logoBox.y + logoBox.height / 2 - labelBox.y - labelBox.height / 2)).toBeLessThan(3);
  expect(await page.locator("body").evaluate(body => body.scrollWidth)).toBeLessThanOrEqual(320);
});

test("First Ec4 roster setup validates, personalizes, persists and can be changed", async ({ page }) => {
  await login(page, "onboarding", "/", false);
  const dialog = rosterDialog(page);
  await expect(dialog).toContainText("Ec4");
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("spinbutton", { name: "名簿番号" }).fill("99");
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect((await (await page.request.get(`${API}/api/preferences`)).json()).roster_number).toBeNull();
  await chooseRoster(page, 7);
  await expect(page.locator("header").getByRole("button", { name: "名簿番号を変更" })).toContainText("7番");
  await nav(page, "自分の見学リスト").click();
  await expect(page.getByRole("heading", { name: "指定企業", exact: true })).toBeVisible();
  await expect(page.locator("body")).toContainText("架空あおばソフト");
  await expect(page.locator("body")).not.toContainText("架空ホール");
  await page.reload();
  await expect(rosterDialog(page)).not.toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "名簿番号を変更" })).toContainText("7番");
  await page.locator("header").getByRole("button", { name: "名簿番号を変更" }).click();
  await expect(dialog.getByRole("spinbutton", { name: "名簿番号" })).toHaveValue("7");
  await chooseRoster(page, 8);
  expect((await (await page.request.get(`${API}/api/preferences`)).json()).roster_number).toBe(8);
  await page.reload();
  await expect(page.locator("header").getByRole("button", { name: "名簿番号を変更" })).toContainText("8番");
  expect(new URL(page.url()).searchParams.has("roster_number")).toBe(false);
});

test("Search filters and saved companies survive reload through real MySQL", async ({ page }) => {
  await login(page, "alice", "/?view=search");
  await assertCompanyCount(page, 4);
  await verifyLongIndustryFits(page);
  await page.getByRole("searchbox").fill("あおば");
  await assertCompanyCount(page, 1);
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("あおば");
  await page.getByLabel("架空あおばソフトを見学リストに保存", { exact: true }).locator("..").click();
  await expect(page.getByLabel("架空あおばソフトを見学リストから削除", { exact: true })).toBeChecked();
  await page.reload();
  await assertCompanyCount(page, 1);
  await expect(page.getByRole("searchbox")).toHaveValue("あおば");
  await expect(page.getByLabel("架空あおばソフトを見学リストから削除", { exact: true })).toBeChecked();
  await page.getByRole("searchbox").fill("");
  await page.getByLabel("保存した企業", { exact: true }).locator("..").click();
  await assertCompanyCount(page, 1);
  await page.getByLabel("保存した企業", { exact: true }).locator("..").click();
  await page.getByRole("radio", { name: "午後の部", exact: true }).click();
  await assertCompanyCount(page, 2);
  await page.getByLabel("業種で絞り込む").selectOption("建設");
  await assertCompanyCount(page, 1);
  await page.getByRole("searchbox").fill("存在しないキーワード");
  await expect(page.getByRole("heading", { name: "条件に合う企業が見つかりません" })).toBeVisible();
  await page.getByRole("button", { name: "条件をリセット" }).click();
  await assertCompanyCount(page, 4);
});

test("Shared company URLs restore through OAuth and browser back/forward", async ({ page }) => {
  await login(page, "routing", "/?view=map&company=AM-1&session=AM");
  const dialog = page.getByRole("dialog", { name: "架空あおばソフト", exact: true });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("company")).toBe("AM-1");
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "詳細を閉じる" }).click();
  await expect(dialog).not.toBeVisible();
  expect(new URL(page.url()).searchParams.has("company")).toBe(false);
  await nav(page, "企業一覧").click();
  await assertCompanyCount(page, 4);
  await nav(page, "スケジュール").click();
  await expect(page.getByRole("heading", { name: "スケジュール", exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("schedule");
  await page.goBack();
  await assertCompanyCount(page, 4);
  await page.goForward();
  await expect(page.getByRole("heading", { name: "スケジュール", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByText("配布資料の案内", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "見学前の準備", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "質問するとき", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "検証用の筆記具" })).toBeVisible();
});

test("Map booths open shareable company details and detail links highlight the booth", async ({ page }) => {
  await login(page, "map", "/?view=map&session=AM&focus=AM-1");
  const first = page.getByRole("button", { name: "午前 ブース 1 架空あおばソフト", exact: true });
  await expect(first).toHaveAttribute("data-selected", "true");
  await first.click();
  const dialog = page.getByRole("dialog", { name: "架空あおばソフト", exact: true });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("company")).toBe("AM-1");
  await dialog.getByRole("link", { name: /マップを確認|地図/ }).click();
  await expect(dialog).not.toBeVisible();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  expect(new URL(page.url()).searchParams.get("focus")).toBe("AM-1");
  await page.getByRole("button", { name: "絞り込み", exact: true }).click();
  await page.getByLabel("マップの企業名", { exact: true }).fill("いろは");
  await expect(first).toBeDisabled();
  await expect(first).toHaveAttribute("data-match", "false");
  await page.getByRole("button", { name: "午前 ブース 2 架空いろは機械", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "架空いろは機械", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  await page.getByLabel("マップの企業名", { exact: true }).fill("");
  await page.getByRole("radio", { name: "午後の部", exact: true }).click();
  await page.getByRole("button", { name: "午後 ブース 1 架空みらい建設", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "架空みらい建設", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  await page.getByRole("button", { name: "拡大率を100パーセントに戻す" }).click();
  await page.getByRole("button", { name: "マップを拡大", exact: true }).click();
  await expect(page.getByRole("button", { name: "拡大率を100パーセントに戻す" })).toHaveText("125%");
  await page.getByRole("button", { name: "マップを縮小", exact: true }).click();
  const viewport = page.getByRole("region", { name: "操作できる会場マップ", exact: true });
  for (let step = 0; step < 4; step++) await page.getByRole("button", { name: "マップを拡大", exact: true }).click();
  const booth = page.getByRole("button", { name: "午後 ブース 1 架空みらい建設", exact: true });
  await booth.scrollIntoViewIfNeeded();
  const boothBounds = (await booth.boundingBox())!;
  const viewportBounds = (await viewport.boundingBox())!;
  const startX = Math.max(viewportBounds.x + 20, Math.min(boothBounds.x + boothBounds.width / 2, viewportBounds.x + viewportBounds.width - 20));
  const startY = Math.max(viewportBounds.y + 20, Math.min(boothBounds.y + boothBounds.height / 2, viewportBounds.y + viewportBounds.height - 20));
  const before = await viewport.evaluate(node => node.scrollLeft);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 100, startY, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => viewport.evaluate(node => node.scrollLeft)).toBeGreaterThan(before);
  const client = await page.context().newCDPSession(page);
  const center = { x: viewportBounds.x + viewportBounds.width / 2, y: viewportBounds.y + viewportBounds.height / 2 };
  const zoomBeforePinch = await page.getByRole("button", { name: "拡大率を100パーセントに戻す" }).textContent();
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { id: 1, x: center.x - 35, y: center.y }, { id: 2, x: center.x + 35, y: center.y },
  ] });
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
    { id: 1, x: center.x - 70, y: center.y }, { id: 2, x: center.x + 70, y: center.y },
  ] });
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
  await expect(page.getByRole("button", { name: "拡大率を100パーセントに戻す" })).not.toHaveText(zoomBeforePinch!);
  await page.getByRole("button", { name: "検証2階マップ", exact: true }).click();
  await expect(page.getByRole("img", { name: "検証2階マップ", exact: true })).toBeVisible();
  await expect(page.locator(".venue-map-booth")).toHaveCount(0);
});

test("Signed PDFs open directly without cookies and expire on logout", async ({ page, request }) => {
  await login(page, "documents", "/?view=map");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "検証用ガイドPDF", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL(url => url.origin === API && url.pathname === "/documents/guide");
  const signed = popup.url();
  expect(new URL(signed).searchParams.get("token")).toBeTruthy();
  expect(signed.startsWith("blob:")).toBe(false);
  const document = await request.get(signed);
  expect(document.status()).toBe(200);
  expect(document.headers()["content-type"]).toBe("application/pdf");
  expect(document.headers()["cache-control"]).toBe("no-store");
  expect((await document.body()).toString().startsWith("%PDF-1.4")).toBe(true);
  const tampered = new URL(signed);
  tampered.searchParams.set("token", `${tampered.searchParams.get("token")}!`);
  expect((await request.get(tampered.href)).status()).toBe(403);
  const wrongDocument = new URL(signed);
  wrongDocument.pathname = "/documents/floor-a";
  expect((await request.get(wrongDocument.href)).status()).toBe(403);
  await popup.close();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tasklyでログイン" })).toBeVisible();
  expect((await request.get(signed)).status()).toBe(403);
  expect((await request.get(`${API}/api/documents/guide/url`)).status()).toBe(401);
});

test("Saved companies and roster preferences remain isolated by identity", async ({ page }) => {
  await login(page, "bob", "/?view=search");
  await page.getByLabel("保存した企業", { exact: true }).locator("..").click();
  await expect(page.getByRole("heading", { name: "条件に合う企業が見つかりません" })).toBeVisible();
  expect((await (await page.request.get(`${API}/api/preferences`)).json()).roster_number).toBe(7);
  await page.getByRole("button", { name: "条件をリセット" }).click();
  await page.getByLabel("架空あおばソフトを見学リストに保存", { exact: true }).locator("..").click();
  await expect(page.getByLabel("架空あおばソフトを見学リストから削除", { exact: true })).toBeChecked();
  await page.getByLabel("架空あおばソフトを見学リストから削除", { exact: true }).locator("..").click();
  await expect(page.getByLabel("架空あおばソフトを見学リストに保存", { exact: true })).not.toBeChecked();
});

test("Identity outages fail closed, then revoked sessions offer reauthentication", async ({ page, request }) => {
  await login(page, "outage");
  await request.post(`${ISSUER}/__test/outage?enabled=1`);
  try {
    await page.reload();
    await expect(page.getByRole("button", { name: "もう一度接続する" })).toBeVisible();
    await assertCompanyCount(page, 0);
  } finally { await request.post(`${ISSUER}/__test/outage?enabled=0`); }
  await page.getByRole("button", { name: "もう一度接続する" }).click();
  await assertCompanyCount(page, 4);
  await request.post(`${ISSUER}/__test/revoke?subject=outage`);
  await page.getByLabel("架空いろは機械を見学リストに保存", { exact: true }).locator("..").click();
  await expect(page.getByRole("button", { name: "Tasklyでログイン" })).toBeVisible();
  await assertCompanyCount(page, 0);
  await login(page, "outage");
  await assertCompanyCount(page, 4);
});

test("Small screens use fixed icon links while large-screen navigation stays in the header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "mobile");
  const mobile = page.getByRole("navigation", { name: "モバイルナビゲーション" });
  await expect(mobile).toBeVisible();
  expect(await mobile.evaluate(node => getComputedStyle(node).position)).toBe("fixed");
  for (const label of ["企業", "検索", "予定", "マップ", "見学リスト"]) {
    const link = mobile.getByRole("link", { name: label, exact: true });
    await expect(link).toHaveAttribute("href", label === "企業" ? /^\/(?:\?|$)/ : /view=/);
    await expect(link.locator("svg").first()).toBeVisible();
  }
  await mobile.getByRole("link", { name: "検索", exact: true }).click();
  await verifyLongIndustryFits(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.locator("body").evaluate(body => body.scrollWidth)).toBeLessThanOrEqual(320);
  await mobile.getByRole("link", { name: "マップ", exact: true }).click();
  await expect(page.getByRole("img", { name: "検証1階マップ", exact: true })).toBeVisible();
  await mobile.getByRole("link", { name: "見学リスト", exact: true }).click();
  await expect(page.getByRole("heading", { name: "指定企業", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(mobile).not.toBeVisible();
  const desktop = page.getByRole("navigation", { name: "メインナビゲーション" });
  await expect(desktop).toBeVisible();
  expect(await desktop.evaluate(node => Boolean(node.closest("header")))).toBe(true);
  await expect(page.locator("aside")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("掲載情報は配布資料をもとにしています。");
});


function contrastRatio(foreground: string, background: string) {
  const luminance = (color: string) => {
    const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!values || values.length !== 3) throw Error(`Unsupported computed color: ${color}`);
    const linear = values.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

test("The directory starts with companies and follows readable system color themes", async ({ page }, info) => {
  await login(page, "presentation");
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    let lightBackground = "";
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.getByRole("heading", { name: "企業一覧", exact: true })).toBeVisible();
      await expect(page.getByRole("searchbox")).toHaveCount(0);
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await assertCompanyCount(page, 4);
      const card = page.locator(".company-card").first();
      const bounds = (await card.boundingBox())!;
      expect(bounds.y).toBeLessThan(350);
      expect(bounds.y + bounds.height).toBeLessThan(viewport.height - 70);
      const colors = await page.locator("html").evaluate(node => {
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(contrastRatio(colors.color, colors.background)).toBeGreaterThanOrEqual(4.5);
      if (colorScheme === "light") lightBackground = colors.background;
      else expect(colors.background).not.toBe(lightBackground);
      const surface = await card.evaluate(node => {
        const style = getComputedStyle(node);
        const title = getComputedStyle(node.querySelector("h2 a")!);
        return { color: title.color, background: style.backgroundColor };
      });
      expect(contrastRatio(surface.color, surface.background)).toBeGreaterThanOrEqual(4.5);
      expect(await page.locator("body").evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      const screenshot = info.outputPath(`directory-${viewport.width}-${colorScheme}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach(`Directory ${viewport.width}px ${colorScheme}`, { path: screenshot, contentType: "image/png" });
    }
  }
});
