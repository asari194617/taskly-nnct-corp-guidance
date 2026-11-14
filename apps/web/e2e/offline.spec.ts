import { test, expect } from "./fixtures";
import {
  API, ISSUER, OBJECTS, UI, accountAction, changeOfflineStorage, chooseRoster,
  expectNoPrivateStorageURLs, expectOfflineHome, expectOfflineMap, expectMissingOfflinePack, loginOfflineUser,
  readOfflineSnapshot, resetInterests, waitForOfflinePack,
} from "./offline-fixtures";

test.describe("Native service worker and private IndexedDB snapshots", () => {
  test.setTimeout(60_000);

  test("real offline reloads and direct routes retain read-only data and map bytes after R2 signatures expire", async ({ page, context, request }) => {
    const imageRequest = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === OBJECTS && url.pathname.endsWith("/floor-a.png") && response.status() === 200;
    });
    await loginOfflineUser(page);
    await resetInterests(page, ["AM-1"]);
    const prepared = await waitForOfflinePack(page);
    expect(prepared.pack.session.expiresAt - prepared.pack.savedAt).toBe(24 * 60 * 60 * 1000);
    await expectNoPrivateStorageURLs(page);
    const signed = (await imageRequest).url();
    expect(new URL(signed).searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect((await request.get(signed)).status()).toBe(200);
    const writes: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).origin === API && ["POST", "PUT", "DELETE", "PATCH"].includes(request.method()))
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    try {
      expect((await request.post(`${OBJECTS}/__test/clock`, { data: { offset_ms: 301_000 } })).status()).toBe(200);
      expect((await request.get(signed)).status(), "the actual object-store verifier has expired this signature").toBe(403);
      await context.setOffline(true);
      await page.reload();
      await expectOfflineHome(page);
      await page.goto("/search/?q=あおば&session=all");
      await expect(page.getByRole("heading", { name: "探す", level: 1 })).toBeVisible();
      await expect(page.locator(".company-card")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "架空あおばソフトを気になるから解除", exact: true })).toBeDisabled();
      await page.getByRole("searchbox").fill("いろは");
      await expect(page.locator(".company-card")).toHaveCount(1);
      await expect(page.locator(".company-card")).toContainText("架空いろは機械");
      expect(new URL(page.url()).searchParams.get("q")).toBe("いろは");
      await page.goto("/search/?company=AM-2&session=all");
      const details = page.getByRole("dialog", { name: "架空いろは機械", exact: true });
      await expect(details).toBeVisible();
      await expect(details.getByRole("button", { name: "架空いろは機械を気になるに追加", exact: true })).toBeDisabled();
      await page.goto("/favorites/?session=all");
      await expect(page.getByRole("heading", { name: "気になる", level: 1 })).toBeVisible();
      await expect(page.getByRole("region", { name: "指定企業", exact: true }).locator(".assignment-visit").first()).toContainText("架空あおばソフト");
      await expect(page.getByRole("button", { name: "名簿番号を変更", exact: true })).toBeDisabled();
      await page.goto("/schedule/?session=all");
      await expect(page.getByRole("heading", { name: "スケジュール", level: 1 })).toBeVisible();
      await expect(page.locator(".timeline-item")).toHaveCount(8);
      await page.goto("/documents/");
      await expect(page.getByRole("heading", { name: "配布資料の案内", level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "検証用ガイドPDF", exact: true })).toBeDisabled();
      await expectOfflineMap(page);
      await expectNoPrivateStorageURLs(page);
      expect((await readOfflineSnapshot(page)).active!.pack.session.scope).toBe(prepared.pack.session.scope);
      expect(writes).toEqual([]);
    } finally {
      expect((await request.post(`${OBJECTS}/__test/clock`, { data: { offset_ms: 0 } })).status()).toBe(200);
      await context.setOffline(false);
    }
  });

  test("reconnecting revalidates identity and refreshes canonical interests and Taskly tasks without replaying offline writes", async ({ page, context, request }) => {
    const fixture = await (await request.get("http://127.0.0.1:3374/__test/fixture")).json();
    const taskID = fixture.bindings["assigned-visit-1"];
    const taskly = async (completed: boolean) => {
      const operation = completed ? "completeTask" : "uncompleteTask";
      const response = await request.post("http://127.0.0.1:3374/graphql/", {
        headers: { Authorization: `Bearer ${fixture.sessions["home-other"]}` },
        data: { query: `mutation { ${operation}(id:${taskID}) }` },
      });
      expect(response.status()).toBe(200);
      const result = await response.json();
      expect(result.errors).toBeUndefined();
      expect(result.data[operation]).toBe(true);
    };
    await taskly(false);
    try {
      await loginOfflineUser(page);
      await resetInterests(page, []);
      const prepared = await waitForOfflinePack(page);
      const task = page.locator('.home-task-row[data-task-id="assigned-visit-1"]').getByRole("checkbox");
      await expect(task).not.toBeChecked();
      const writes: string[] = [];
      page.on("request", request => {
        if (new URL(request.url()).origin === API && ["POST", "PUT", "DELETE", "PATCH"].includes(request.method())) writes.push(request.method());
      });
      await context.setOffline(true);
      await page.reload();
      await expectOfflineHome(page);
      // These are explicit writes from another client, outside the offline browser.
      expect((await page.request.put(`${API}/api/bookmarks/AM-2`, { headers: { Origin: UI } })).status()).toBe(204);
      await taskly(true);
      await expect(task).not.toBeChecked();
      const verified = page.waitForResponse(response => response.url() === `${API}/api/me` && response.status() === 200);
      await context.setOffline(false);
      await verified;
      await expect(task).toBeEnabled();
      await expect(task).toBeChecked();
      await waitForOfflinePack(page);
      await expect.poll(async () => (await readOfflineSnapshot(page)).active?.pack.bookmarks).toEqual(["AM-2"]);
      expect((await readOfflineSnapshot(page)).active!.pack.session.generation).not.toBe(prepared.pack.session.generation);
      expect(writes).toEqual([]);
      await page.goto("/favorites/?session=all");
      await expect(page.getByRole("region", { name: /^気になる/ }).locator(".company-card")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "架空いろは機械を気になるから解除", exact: true })).toBeEnabled();
    } finally {
      await context.setOffline(false);
      await taskly(false);
    }
  });

  test("profile changes replace the pack and logout prevents another identity inheriting it", async ({ page, context }) => {
    await loginOfflineUser(page);
    await resetInterests(page, ["AM-1"]);
    const original = await waitForOfflinePack(page);
    await accountAction(page, "名簿番号の設定");
    await chooseRoster(page, 8);
    const changed = await waitForOfflinePack(page, 8);
    expect(changed.pack.session.scope).not.toBe(original.pack.session.scope);
    expect(changed.pack.session.generation).not.toBe(original.pack.session.generation);
    await context.setOffline(true);
    await page.goto("/favorites/?session=all");
    await expect(page.getByRole("region", { name: "指定企業", exact: true }).locator(".assignment-visit").first()).toContainText("架空いろは機械");
    await context.setOffline(false);
    await expect(page.getByRole("button", { name: "名簿番号を変更", exact: true })).toBeEnabled();
    await accountAction(page, "ログアウト");
    await expect(page.getByRole("button", { name: "Tasklyでログイン", exact: true })).toBeVisible();
    await expect.poll(() => readOfflineSnapshot(page)).toEqual({ active: null, maps: [] });
    await context.setOffline(true);
    await page.goto("/");
    await expectMissingOfflinePack(page);
    await context.setOffline(false);
    await loginOfflineUser(page, "menu", 9);
    const other = await waitForOfflinePack(page, 9);
    expect(other.pack.user.sub).not.toBe(original.pack.user.sub);
    expect(other.pack.session.scope).not.toBe(original.pack.session.scope);
    expect(other.pack.bookmarks).not.toContain("AM-1");
    await context.setOffline(true);
    await page.reload();
    await expectOfflineHome(page);
    expect((await readOfflineSnapshot(page)).active!.pack.user.sub).toBe(other.pack.user.sub);
  });

  test("an authoritative 401 purges private data before any offline fallback", async ({ page, context, request }) => {
    await loginOfflineUser(page);
    await waitForOfflinePack(page);
    expect((await request.post(`${ISSUER}/__test/revoke?subject=home-other`)).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("button", { name: "Tasklyでログイン", exact: true })).toBeVisible();
    await expect.poll(() => readOfflineSnapshot(page)).toEqual({ active: null, maps: [] });
    await context.setOffline(true);
    await page.reload();
    await expectMissingOfflinePack(page);
  });

  for (const invalid of ["expire", "wrong-scope", "wrong-dataset"] as const) {
    test(`native IndexedDB rejects and purges ${invalid} snapshots after an offline reload`, async ({ page, context }) => {
      await loginOfflineUser(page);
      const prepared = await waitForOfflinePack(page);
      if (invalid === "expire") {
        // Advance only the page's real expiry check; the independent worker's
        // public shell remains available, so this exercises private-pack TTL.
        await page.clock.setFixedTime(new Date(prepared.pack.session.expiresAt + 1));
      } else await changeOfflineStorage(page, invalid);
      await context.setOffline(true);
      await page.reload();
      await expectMissingOfflinePack(page);
      await expect.poll(() => readOfflineSnapshot(page)).toEqual({ active: null, maps: [] });
    });
  }

  test("missing map bytes and an unprepared private pack have explicit offline fallbacks", async ({ page, context }) => {
    await loginOfflineUser(page);
    await waitForOfflinePack(page);
    await changeOfflineStorage(page, "drop-maps");
    await context.setOffline(true);
    await page.goto("/map/?session=AM");
    await expect(page.getByRole("status", { name: "オフライン用データ", exact: true })).toHaveAttribute("data-offline", "true");
    await expect(page.locator('.venue-map[data-mode="fullscreen"] img')).toHaveCount(0);
    await expect(page.getByText("この地図は保存されていません。接続して取得してください。", { exact: true })).toBeVisible();
    await changeOfflineStorage(page, "drop-all");
    await page.goto("/search/?q=あおば&session=all");
    await expectMissingOfflinePack(page);
    await expect(page.getByRole("searchbox")).toHaveCount(0);
  });

  test("a native offline tab drops the previous account's private UI when another tab signs in", async ({ page, context }) => {
    await loginOfflineUser(page);
    const original = await waitForOfflinePack(page);
    const network = await context.newCDPSession(page);
    const other = await context.newPage();
    try {
      // Per-page native network isolation leaves the second tab online while
      // this tab genuinely restores its old snapshot through the worker.
      await network.send("Network.enable");
      await network.send("Network.emulateNetworkConditions", {
        offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await page.reload();
      await expectOfflineHome(page);
      await other.goto(`${API}/auth/start`);
      await expect(other.getByRole("heading", { name: "検証用ログイン", exact: true })).toBeVisible();
      await other.getByLabel("検証アカウント").selectOption("menu");
      await other.getByRole("button", { name: "検証用アカウントで続ける", exact: true }).click();
      await other.waitForURL(url => url.origin === UI);
      const preferences = await (await other.request.get(`${API}/api/preferences`)).json();
      if (preferences.roster_number === null) await chooseRoster(other, 8);
      else if (preferences.roster_number !== 8) {
        await accountAction(other, "名簿番号の設定");
        await chooseRoster(other, 8);
      }
      const replacement = await waitForOfflinePack(other, 8);
      expect(replacement.pack.user.sub).not.toBe(original.pack.user.sub);
      await expect(page.getByText("アカウントまたは名簿設定が変更されました。接続してログインし直してください。", { exact: true })).toBeVisible();
      await expect(page.locator(".home-task-row,.home-recommendation,.company-card")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "ホーム", level: 1 })).toHaveCount(0);
      expect((await readOfflineSnapshot(page)).active!.pack.user.sub).toBe(replacement.pack.user.sub);
    } finally {
      await network.send("Network.emulateNetworkConditions", {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });
      await network.detach();
      await other.close();
    }
  });
});
