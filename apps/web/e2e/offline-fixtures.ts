import { expect } from "./fixtures";
import type { Page } from "@playwright/test";

export const UI = "http://127.0.0.1:3300";
export const API = "http://127.0.0.1:3371";
export const ISSUER = "http://127.0.0.1:3372";
export const OBJECTS = "http://127.0.0.1:3373";
export const OFFLINE_DATABASE = "taskly-guidance-offline";

export type StoredOffline = {
  schema: number;
  dataset: string;
  pack: {
    session: { scope: string; generation: string; expiresAt: number };
    user: { sub: string };
    preferences: { department: string; grade: number; roster_number: number | null };
    bookmarks: string[];
    savedAt: number;
    guidance: { documents: { id: string; url: string }[] };
    home?: { data: { tasks: { id: string; completed: boolean }[] }; savedAt: number };
  };
};
export type OfflineSnapshot = {
  active: StoredOffline | null;
  maps: { id: string; scope: string; dataset: string; savedAt: number; expiresAt: number; isArrayBuffer: boolean; size: number; type: string; serialized: string }[];
};

// Inspect the browser's real IndexedDB. Aborting accidental upgrades prevents a
// test from creating an empty database before the application initializes it.
export async function readOfflineSnapshot(page: Page): Promise<OfflineSnapshot> {
  return page.evaluate(database => new Promise(resolve => {
    const request = indexedDB.open(database);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => resolve({ active: null, maps: [] });
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("state") || !db.objectStoreNames.contains("maps")) {
        db.close(); resolve({ active: null, maps: [] }); return;
      }
      const transaction = db.transaction(["state", "maps"], "readonly");
      const active = transaction.objectStore("state").get("active");
      const maps = transaction.objectStore("maps").getAll();
      transaction.oncomplete = () => {
        const snapshot = {
          active: active.result || null,
          maps: maps.result.map((value: { id: string; scope: string; dataset: string; savedAt: number; expiresAt: number; bytes: ArrayBuffer; mimeType: string }) => ({
            id: value.id, scope: value.scope, dataset: value.dataset,
            savedAt: value.savedAt, expiresAt: value.expiresAt,
            isArrayBuffer: value.bytes instanceof ArrayBuffer, size: value.bytes?.byteLength || 0, type: value.mimeType || "",
            // Image bytes are excluded by JSON.stringify, but every persisted
            // metadata field remains visible to the capability-leak assertion.
            serialized: JSON.stringify(value),
          })),
        };
        db.close(); resolve(snapshot);
      };
      transaction.onerror = transaction.onabort = () => { db.close(); resolve({ active: null, maps: [] }); };
    };
  }), OFFLINE_DATABASE) as Promise<OfflineSnapshot>;
}

export async function changeOfflineStorage(page: Page, action: "expire" | "drop-maps" | "drop-all" | "wrong-scope" | "wrong-dataset") {
  await page.evaluate(({ database, action }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(database);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["state", "maps"], "readwrite");
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error); };
      if (action === "drop-all") {
        transaction.objectStore("state").clear(); transaction.objectStore("maps").clear();
      } else if (action === "drop-maps") transaction.objectStore("maps").clear();
      else {
        const state = transaction.objectStore("state");
        const active = state.get("active");
        active.onsuccess = () => {
          if (!active.result) { transaction.abort(); return; }
          if (action === "expire") active.result.pack.session.expiresAt = Date.now() - 1;
          else if (action === "wrong-scope") active.result.pack.session.scope = "another-account-and-profile";
          else active.result.dataset = "another-dataset";
          state.put(active.result, "active");
        };
      }
    };
  }), { database: OFFLINE_DATABASE, action });
}

export async function accountAction(page: Page, name: string) {
  await page.getByRole("button", { name: "ユーザーメニュー", exact: true }).click();
  const menu = page.getByRole("menu", { name: "ユーザーメニュー", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name, exact: true }).click();
}

export async function chooseRoster(page: Page, number: number) {
  const dialog = page.getByRole("dialog", { name: "名簿番号の設定" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "名簿番号", exact: true }).fill(String(number));
  await dialog.getByRole("button", { name: "保存する", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

export async function loginOfflineUser(page: Page, subject = "home-other", number = 7) {
  await page.goto("/");
  await page.getByRole("button", { name: "Tasklyでログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "検証用ログイン" })).toBeVisible();
  await page.getByLabel("検証アカウント").selectOption(subject);
  await page.getByRole("button", { name: "検証用アカウントで続ける", exact: true }).click();
  await page.waitForURL(url => url.origin === UI);
  const preferences = await (await page.request.get(`${API}/api/preferences`)).json();
  if (preferences.roster_number === null) await chooseRoster(page, number);
  else if (preferences.roster_number !== number) {
    await accountAction(page, "名簿番号の設定"); await chooseRoster(page, number);
  }
  await expect(page.getByRole("heading", { name: "ホーム", level: 1 })).toBeVisible();
}

export async function waitForOfflinePack(page: Page, roster = 7) {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
  await expect.poll(async () => {
    const { active, maps } = await readOfflineSnapshot(page);
    return active?.pack.preferences.roster_number === roster &&
      Boolean(active.pack.home?.data.tasks.length) && maps.length === 2 &&
      maps.every(map => map.isArrayBuffer && map.type === "image/png" && map.size > 0 &&
        map.scope === active.pack.session.scope && map.dataset === active.dataset);
  }).toBe(true);
  await expect(page.getByRole("status", { name: "オフライン用データ", exact: true })).toHaveAttribute("data-state", "ready");
  return (await readOfflineSnapshot(page)).active!;
}

export async function expectNoPrivateStorageURLs(page: Page) {
  const snapshot = await readOfflineSnapshot(page);
  expect(snapshot.active).not.toBeNull();
  expect(JSON.stringify(snapshot)).not.toMatch(/X-Amz-|[?&]token=|access_token|refresh_token|Authorization/i);
  expect(snapshot.active!.pack.guidance.documents.every(document => document.url === "")).toBe(true);
  const cachedURLs = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name =>
    (await (await caches.open(name)).keys()).map(request => request.url),
  ))).flat());
  expect(cachedURLs.length).toBeGreaterThan(0);
  for (const cached of cachedURLs) {
    const url = new URL(cached);
    expect(url.origin).toBe(UI);
    expect(url.search).toBe("");
    expect(url.pathname).not.toMatch(/^\/(api|auth)\//);
  }
}

export async function resetInterests(page: Page, ids: string[]) {
  const response = await page.request.get(`${API}/api/bookmarks`);
  expect(response.status()).toBe(200);
  const before: string[] = (await response.json()).company_ids;
  for (const id of before.filter(id => !ids.includes(id)))
    expect((await page.request.delete(`${API}/api/bookmarks/${encodeURIComponent(id)}`, { headers: { Origin: UI } })).status()).toBe(204);
  for (const id of ids.filter(id => !before.includes(id)))
    expect((await page.request.put(`${API}/api/bookmarks/${encodeURIComponent(id)}`, { headers: { Origin: UI } })).status()).toBe(204);
  await page.reload();
}

export async function expectOfflineHome(page: Page) {
  await expect(page.getByRole("heading", { name: "ホーム", level: 1 })).toBeVisible();
  await expect(page.getByRole("status", { name: "オフライン用データ", exact: true })).toHaveAttribute("data-offline", "true");
  const task = page.locator('.home-task-row[data-task-id="assigned-visit-1"]').getByRole("checkbox");
  await expect(task).toBeVisible();
  await expect(task).toBeDisabled();
  await expect(page.locator('.home-task-row[data-task-id="sheet-submission"]').getByRole("button", { name: "資料を見る", exact: true })).toBeDisabled();
  await expect(page.locator('a[href^="https://forms.example.test/"]')).toHaveCount(0);
  return task;
}

export async function expectMissingOfflinePack(page: Page) {
  await expect(page.getByText("保存済みの情報がありません。接続してからもう一度お試しください。", { exact: true })).toBeVisible();
  await expect(page.locator(".home-task-row,.company-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "ホーム", level: 1 })).toHaveCount(0);
}

export async function expectOfflineMap(page: Page) {
  await page.goto("/map/?session=AM&focus=AM-1");
  const map = page.locator('.venue-map[data-mode="fullscreen"]');
  const image = map.getByRole("img", { name: "検証1階マップ", exact: true });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(100);
  const booth = map.getByRole("button", { name: "午前 ブース 1 架空あおばソフト", exact: true });
  await expect(booth).toBeEnabled();
  await expect(booth).toHaveAttribute("data-selected", "true");
}
