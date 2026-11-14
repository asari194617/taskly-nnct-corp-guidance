import { requireValue } from "./required";
import { Blob as NativeBlob } from "node:buffer";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOfflinePack,
  deleteOfflineHome,
  OFFLINE_TTL,
  readOfflineHome,
  readOfflineLogoutIntent,
  readOfflineMap,
  restoreOfflinePack,
  saveOfflineHome,
  saveOfflineMap,
  saveOfflinePack,
  setOfflineLogoutIntent,
  updateOfflineBookmarks,
} from "../lib/offline-store";
import type { OfflinePack } from "../lib/offline-store";
import type { HomeTasksResponse } from "../lib/types";
import { guidance } from "./fixtures";

const instant = Date.UTC(2030, 4, 14, 0);
let now = instant;
let factory: IDBFactory;
function input() {
  return {
    user: { sub: "test-account-a", name: "検証学生", email: "qa@example.test" },
    preferences: { department: "電子制御工学科", grade: 4, roster_number: 7 },
    guidance: structuredClone(guidance),
    bookmarks: ["AM-1"],
  };
}
const tasks: HomeTasksResponse = {
  event_id: "synthetic-event",
  roster_configured: true,
  tasks: [
    {
      id: "task-1",
      kind: "assigned_visit",
      title: "検証企業を見学",
      completed: true,
      completion_disabled: false,
      company_id: "AM-1",
      term: 1,
      taskly_url: "https://taskly.example.test/?token=private",
      url: "https://form.example.test/?token=private",
    },
  ],
};
async function seed() {
  const pack = await saveOfflinePack(input());
  expect(pack).not.toBeNull();
  return requireValue(pack);
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("taskly-guidance-offline", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function inspect() {
  const db = await database();
  return new Promise<{
    active: { schema: number; dataset: string; pack: OfflinePack } | undefined;
    maps: unknown[];
  }>((resolve, reject) => {
    const tx = db.transaction(["state", "maps"], "readonly");
    const active = tx.objectStore("state").get("active");
    const maps = tx.objectStore("maps").getAll();
    tx.oncomplete = () => {
      db.close();
      resolve({ active: active.result, maps: maps.result });
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
async function corrupt(
  change: (record: {
    schema: number;
    dataset: string;
    pack: OfflinePack;
  }) => void,
) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    const request = store.get("active");
    request.onsuccess = () => {
      change(request.result);
      store.put(request.result, "active");
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}
beforeEach(() => {
  now = instant;
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  // Node's structuredClone and fake-indexeddb both preserve the native Blob.
  vi.stubGlobal("Blob", NativeBlob);
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe("verified offline snapshots in IndexedDB", () => {
  it("restores typed catalog/profile/bookmarks and strips credentials and signed URLs", async () => {
    const values = input();
    Object.assign(values.user, { access_token: "not-persisted" });
    values.guidance.documents[0].url =
      "https://r2.example.test/map?X-Amz-Signature=private";
    const pack = await saveOfflinePack(values);
    expect(pack?.session.expiresAt).toBe(instant + OFFLINE_TTL);
    const restored = await restoreOfflinePack(values.user.sub);
    expect(restored?.user).toEqual(
      values.user && {
        sub: values.user.sub,
        name: values.user.name,
        email: values.user.email,
      },
    );
    expect(
      restored?.guidance.documents.every((document) => document.url === ""),
    ).toBe(true);
    expect(restored?.guidance.assignments).toEqual(values.guidance.assignments);
    expect(restored?.guidance.notice_sections).toEqual(
      values.guidance.notice_sections,
    );
    expect(restored?.bookmarks).toEqual(["AM-1"]);
    const stored = JSON.stringify((await inspect()).active);
    expect(stored).not.toContain("X-Amz");
    expect(stored).not.toContain("not-persisted");
  });

  it("persists confirmed home state without form or Taskly navigation URLs", async () => {
    const pack = await seed();
    now += 500;
    await saveOfflineHome(pack.session, tasks);
    const snapshot = await readOfflineHome(pack.session);
    expect(snapshot?.savedAt).toBe(now);
    expect(snapshot?.data.tasks[0]).toMatchObject({
      completed: true,
      taskly_url: "",
    });
    expect(snapshot?.data.tasks[0]).not.toHaveProperty("url");
    expect(JSON.stringify((await inspect()).active)).not.toContain(
      "token=private",
    );
  });

  it("preserves a confirmed logical survey relationship without bridge or transport metadata", async () => {
    const pack = await seed();
    const linked: HomeTasksResponse = {
      ...tasks,
      tasks: [
        {
          ...tasks.tasks[0],
          id: "assigned-visit-1",
          auto_completed_by: "visit-survey-1",
        },
        { ...tasks.tasks[0], id: "visit-survey-1", kind: "visit_survey" },
      ],
    };
    Object.assign(linked.tasks[0], {
      auto_assignment_scope: "private-bridge-scope",
      related_tasks: [{ private_token: "private-transport-token" }],
    });
    await saveOfflineHome(pack.session, linked);
    expect(
      (await readOfflineHome(pack.session))?.data.tasks[0].auto_completed_by,
    ).toBe("visit-survey-1");
    expect(
      (await restoreOfflinePack())?.home?.data.tasks[0].auto_completed_by,
    ).toBe("visit-survey-1");
    const stored = JSON.stringify((await inspect()).active);
    expect(stored).not.toContain("private-bridge-scope");
    expect(stored).not.toContain("private-transport-token");
    expect(stored).not.toContain("related_tasks");
    delete linked.tasks[0].auto_completed_by;
    await saveOfflineHome(pack.session, linked);
    expect(
      (await readOfflineHome(pack.session))?.data.tasks[0].auto_completed_by,
    ).toBeUndefined();
  });

  it.each([
    "unmatched",
    "wrong-term",
    "ambiguous",
    "wrong-kind",
    "incomplete",
    "disabled",
    "survey-incomplete",
    "survey-disabled",
    "missing-term",
    "invalid-term",
    "unsafe-id",
    "non-string-hint",
  ])("discards an invalid cached relationship hint: %s", async (invalid) => {
    const pack = await seed();
    const linked: HomeTasksResponse = {
      ...tasks,
      tasks: [
        {
          ...tasks.tasks[0],
          id: "assigned-visit-1",
          auto_completed_by: "visit-survey-1",
        },
        { ...tasks.tasks[0], id: "visit-survey-1", kind: "visit_survey" },
      ],
    };
    const assigned = linked.tasks[0],
      survey = linked.tasks[1];
    if (invalid === "unmatched")
      assigned.auto_completed_by = "visit-survey-other";
    if (invalid === "wrong-term") survey.term = 2;
    if (invalid === "ambiguous")
      linked.tasks.push({ ...survey, id: "visit-survey-duplicate" });
    if (invalid === "wrong-kind") assigned.kind = "sheet_submission";
    if (invalid === "incomplete") assigned.completed = false;
    if (invalid === "disabled") assigned.completion_disabled = true;
    if (invalid === "survey-incomplete") survey.completed = false;
    if (invalid === "survey-disabled") survey.completion_disabled = true;
    if (invalid === "missing-term") delete assigned.term;
    if (invalid === "invalid-term") assigned.term = 1.5;
    if (invalid === "unsafe-id")
      assigned.auto_completed_by = "https://private.example.test/?token=secret";
    if (invalid === "non-string-hint")
      Object.assign(assigned, {
        auto_completed_by: { token: "private-transport-token" },
      });
    await saveOfflineHome(pack.session, linked);
    const snapshot = await readOfflineHome(pack.session);
    expect(snapshot?.data.tasks).toHaveLength(linked.tasks.length);
    expect(snapshot?.data.tasks[0].auto_completed_by).toBeUndefined();
    expect(snapshot?.data.tasks[1]).toMatchObject({
      completed: survey.completed,
      completion_disabled: survey.completion_disabled,
    });
  });

  it("stores actual image bytes and refuses unknown documents or non-image data", async () => {
    const pack = await seed();
    const image = new Blob(["synthetic-map"], { type: "image/png" });
    await saveOfflineMap(pack.session, "floor-a", image);
    const restored = await readOfflineMap(pack.session, "floor-a");
    expect(await restored?.text()).toBe("synthetic-map");
    expect(restored?.type).toBe("image/png");
    await saveOfflineMap(pack.session, "unknown-map", image);
    await saveOfflineMap(
      pack.session,
      "floor-b",
      new Blob(["private"], { type: "application/pdf" }),
    );
    await saveOfflineMap(
      pack.session,
      "floor-b",
      new Blob([], { type: "image/png" }),
    );
    expect((await inspect()).maps).toHaveLength(1);
  });

  it("persists portable ArrayBuffer bytes when native IndexedDB Blob cloning fails", async () => {
    const pack = await seed();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (
        value &&
        typeof value === "object" &&
        "blob" in value &&
        value.blob instanceof Blob
      )
        throw new DOMException(
          "Error preparing Blob/File data to be stored in object store",
          "UnknownError",
        );
      return put.call(this, value, key);
    });
    await saveOfflineMap(
      pack.session,
      "floor-a",
      new Blob(["portable-map"], { type: "image/png" }),
    );
    const maps = (await inspect()).maps as {
      bytes: ArrayBuffer;
      mimeType: string;
      blob?: Blob;
    }[];
    expect(maps).toHaveLength(1);
    expect(Object.prototype.toString.call(maps[0].bytes)).toBe(
      "[object ArrayBuffer]",
    );
    expect(maps[0].bytes.byteLength).toBe(12);
    expect(maps[0].mimeType).toBe("image/png");
    expect(maps[0]).not.toHaveProperty("blob");
    const restored = await readOfflineMap(pack.session, "floor-a");
    expect(restored).toBeInstanceOf(Blob);
    expect(await requireValue(restored).text()).toBe("portable-map");
  });

  it("finishes asynchronous byte extraction before opening its IndexedDB transaction", async () => {
    const pack = await seed();
    const blob = new Blob(["map"], { type: "image/png" });
    let resolve!: (value: ArrayBuffer) => void;
    vi.spyOn(blob, "arrayBuffer").mockImplementation(
      () =>
        new Promise((ok) => {
          resolve = ok;
        }),
    );
    const open = vi.spyOn(factory, "open");
    const pending = saveOfflineMap(pack.session, "floor-a", blob);
    expect(open).not.toHaveBeenCalled();
    resolve(new TextEncoder().encode("map").buffer);
    await pending;
    expect(open).toHaveBeenCalled();
    expect(await (await readOfflineMap(pack.session, "floor-a"))?.text()).toBe(
      "map",
    );
  });

  it("does not resurrect map bytes if logout occurs during Blob extraction", async () => {
    const pack = await seed();
    const blob = new Blob(["old"], { type: "image/png" });
    let resolve!: (value: ArrayBuffer) => void;
    vi.spyOn(blob, "arrayBuffer").mockImplementation(
      () =>
        new Promise((ok) => {
          resolve = ok;
        }),
    );
    const pending = saveOfflineMap(pack.session, "floor-a", blob);
    await clearOfflinePack();
    const current = await seed();
    resolve(new TextEncoder().encode("old").buffer);
    await pending;
    expect(await readOfflineMap(current.session, "floor-a")).toBeNull();
    expect((await inspect()).maps).toEqual([]);
  });

  it("rejects an old generation if a full refresh finishes during Blob extraction", async () => {
    const pack = await seed();
    const blob = new Blob(["old"], { type: "image/png" });
    let resolve!: (value: ArrayBuffer) => void;
    vi.spyOn(blob, "arrayBuffer").mockImplementation(
      () =>
        new Promise((ok) => {
          resolve = ok;
        }),
    );
    const pending = saveOfflineMap(pack.session, "floor-a", blob);
    const current = requireValue(await saveOfflinePack(input()));
    resolve(new TextEncoder().encode("old").buffer);
    await pending;
    expect(await readOfflineMap(current.session, "floor-a")).toBeNull();
  });

  it("keeps the verified pack if Blob extraction fails", async () => {
    const pack = await seed();
    const blob = new Blob(["map"], { type: "image/png" });
    vi.spyOn(blob, "arrayBuffer").mockRejectedValue(
      new Error("Blob read failed"),
    );
    await expect(
      saveOfflineMap(pack.session, "floor-a", blob),
    ).resolves.toBeUndefined();
    expect((await restoreOfflinePack())?.session).toEqual(pack.session);
    expect((await inspect()).maps).toEqual([]);
  });

  it("rejects incomplete extracted image bytes", async () => {
    const pack = await seed();
    const blob = new Blob(["map"], { type: "image/png" });
    vi.spyOn(blob, "arrayBuffer").mockResolvedValue(new ArrayBuffer(1));
    await saveOfflineMap(pack.session, "floor-a", blob);
    expect(await readOfflineMap(pack.session, "floor-a")).toBeNull();
  });

  it.each(["empty-bytes", "oversized-bytes", "wrong-mime", "legacy-blob"])(
    "removes an unreadable %s map without losing the verified pack",
    async (change) => {
      const pack = await seed();
      await saveOfflineMap(
        pack.session,
        "floor-a",
        new Blob(["map"], { type: "image/png" }),
      );
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("maps", "readwrite");
        const store = tx.objectStore("maps");
        const request = store.get("floor-a");
        request.onsuccess = () => {
          const value = request.result;
          if (change === "empty-bytes") value.bytes = new ArrayBuffer(0);
          if (change === "oversized-bytes")
            value.bytes = new ArrayBuffer(20 * 1024 * 1024 + 1);
          if (change === "wrong-mime") value.mimeType = "application/pdf";
          if (change === "legacy-blob") {
            delete value.bytes;
            value.blob = new Blob(["old"], { type: "image/png" });
          }
          store.put(value);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      });
      expect(await readOfflineMap(pack.session, "floor-a")).toBeNull();
      expect((await inspect()).maps).toEqual([]);
      expect((await restoreOfflinePack())?.session).toEqual(pack.session);
    },
  );

  it("does not extend full-pack expiry when home, bookmarks, or map bytes change", async () => {
    const pack = await seed();
    now += OFFLINE_TTL - 1000;
    await saveOfflineHome(pack.session, tasks);
    await updateOfflineBookmarks(pack.session, ["PM-1"]);
    await saveOfflineMap(
      pack.session,
      "floor-a",
      new Blob(["map"], { type: "image/png" }),
    );
    expect((await restoreOfflinePack())?.session.expiresAt).toBe(
      pack.session.expiresAt,
    );
    expect((await restoreOfflinePack())?.bookmarks).toEqual(["PM-1"]);
    now = pack.session.expiresAt;
    expect(await restoreOfflinePack()).toBeNull();
    expect(await readOfflineHome(pack.session)).toBeNull();
    expect(await readOfflineMap(pack.session, "floor-a")).toBeNull();
    expect(await inspect()).toEqual({ active: undefined, maps: [] });
  });

  it("rotates generations and rejects stale writes while reusing compatible cached bytes", async () => {
    const first = await seed();
    await saveOfflineHome(first.session, tasks);
    await saveOfflineMap(
      first.session,
      "floor-a",
      new Blob(["first-map"], { type: "image/png" }),
    );
    now += 1000;
    const next = await saveOfflinePack(input());
    expect(next?.session.generation).not.toBe(first.session.generation);
    expect(next?.home?.data.tasks[0].completed).toBe(true);
    await saveOfflineHome(first.session, { ...tasks, tasks: [] });
    await updateOfflineBookmarks(first.session, ["stale"]);
    await saveOfflineMap(
      first.session,
      "floor-a",
      new Blob(["stale-map"], { type: "image/png" }),
    );
    expect(await readOfflineHome(first.session)).toBeNull();
    expect(await readOfflineMap(first.session, "floor-a")).toBeNull();
    expect((await restoreOfflinePack())?.bookmarks).toEqual(["AM-1"]);
    expect(
      await (
        await readOfflineMap(requireValue(next).session, "floor-a")
      )?.text(),
    ).toBe("first-map");
    // A fresh full pack cannot silently renew the old image or home snapshot.
    now = first.session.expiresAt + 1;
    expect(await restoreOfflinePack()).not.toBeNull();
    expect(
      await readOfflineMap(requireValue(next).session, "floor-a"),
    ).toBeNull();
    expect(await readOfflineHome(requireValue(next).session)).toBeNull();
  });

  it.each(["account", "roster", "event", "map-geometry"])(
    "purges old home and map bytes when %s changes",
    async (change) => {
      const first = await seed();
      await saveOfflineHome(first.session, tasks);
      await saveOfflineMap(
        first.session,
        "floor-a",
        new Blob(["old-map"], { type: "image/png" }),
      );
      const values = input();
      if (change === "account") values.user.sub = "another-account";
      if (change === "roster") values.preferences.roster_number = 8;
      if (change === "event") values.guidance.event.date = "2031-05-14";
      if (change === "map-geometry")
        requireValue(values.guidance.documents[0].booths)[0].x = 0.2;
      const next = await saveOfflinePack(values);
      expect(next?.home).toBeUndefined();
      expect(
        await readOfflineMap(requireValue(next).session, "floor-a"),
      ).toBeNull();
      expect((await inspect()).maps).toEqual([]);
    },
  );

  it("purges a different verified account before allowing any fallback", async () => {
    const pack = await seed();
    await saveOfflineMap(
      pack.session,
      "floor-a",
      new Blob(["old"], { type: "image/png" }),
    );
    expect(await restoreOfflinePack("another-account")).toBeNull();
    expect(await inspect()).toEqual({ active: undefined, maps: [] });
  });

  it("fences a pending full save synchronously when logout clears the cache", async () => {
    const pending = saveOfflinePack(input());
    const cleared = clearOfflinePack();
    expect(await pending).toBeNull();
    await cleared;
    expect(await restoreOfflinePack()).toBeNull();
    const next = await seed();
    const oldWrite = saveOfflineHome(next.session, tasks);
    await clearOfflinePack();
    await oldWrite;
    expect(await restoreOfflinePack()).toBeNull();
  });

  it("persists logout intent across private-data clears until an explicit unblock", async () => {
    const pack = await seed();
    await saveOfflineMap(
      pack.session,
      "floor-a",
      new Blob(["private-map"], { type: "image/png" }),
    );
    const oldSave = saveOfflinePack(input());
    await setOfflineLogoutIntent(true);
    expect(await oldSave).toBeNull();
    expect(await readOfflineLogoutIntent()).toBe(true);
    await clearOfflinePack();
    expect(await readOfflineLogoutIntent()).toBe(true);
    expect(await restoreOfflinePack()).toBeNull();
    expect(await saveOfflinePack(input())).toBeNull();
    expect(await inspect()).toEqual({ active: undefined, maps: [] });
    await setOfflineLogoutIntent(false);
    expect(await readOfflineLogoutIntent()).toBe(false);
    expect(await saveOfflinePack(input())).not.toBeNull();
  });

  it("invalidates only the matching home generation after a permission denial", async () => {
    const first = await seed();
    await saveOfflineHome(first.session, tasks);
    const next = requireValue(await saveOfflinePack(input()));
    await deleteOfflineHome(first.session);
    expect(await readOfflineHome(next.session)).not.toBeNull();
    await deleteOfflineHome(next.session);
    expect(await readOfflineHome(next.session)).toBeNull();
    expect((await restoreOfflinePack())?.bookmarks).toEqual(["AM-1"]);
    expect((await restoreOfflinePack())?.session.expiresAt).toBe(
      next.session.expiresAt,
    );
  });

  it("honors the caller's auth-generation guard at the actual commit", async () => {
    let current = true;
    const pending = saveOfflinePack(input(), () => current);
    current = false;
    expect(await pending).toBeNull();
    expect(await restoreOfflinePack()).toBeNull();
  });

  it.each(["schema", "scope", "dataset", "nested-data", "future-time"])(
    "rejects and purges a corrupt %s snapshot",
    async (change) => {
      const pack = await seed();
      await saveOfflineMap(
        pack.session,
        "floor-a",
        new Blob(["map"], { type: "image/png" }),
      );
      await corrupt((record) => {
        if (change === "schema") record.schema = 200;
        if (change === "scope") record.pack.session.scope = "someone-else";
        if (change === "dataset") record.dataset = "wrong-geometry";
        if (change === "nested-data")
          (
            record.pack.guidance.assignments[0] as unknown as { visits: string }
          ).visits = "invalid";
        if (change === "future-time") {
          record.pack.savedAt += OFFLINE_TTL;
          record.pack.session.expiresAt += OFFLINE_TTL;
        }
      });
      expect(await restoreOfflinePack()).toBeNull();
      expect(await inspect()).toEqual({ active: undefined, maps: [] });
    },
  );

  it("allows a newly verified full snapshot to replace an expired snapshot in one attempt", async () => {
    const first = await seed();
    now = first.session.expiresAt + 100;
    const next = await saveOfflinePack(input());
    expect(next?.savedAt).toBe(now);
    expect((await restoreOfflinePack())?.session.generation).toBe(
      next?.session.generation,
    );
  });

  it("ignores invalid incoming data without corrupting the current verified snapshot", async () => {
    const pack = await seed();
    const invalid = input();
    (invalid.guidance as unknown as { companies: null }).companies = null;
    expect(await saveOfflinePack(invalid)).toBeNull();
    await saveOfflineHome(pack.session, {
      ...tasks,
      roster_configured: "invalid" as unknown as boolean,
    });
    await updateOfflineBookmarks(pack.session, [null as unknown as string]);
    expect((await restoreOfflinePack())?.bookmarks).toEqual(["AM-1"]);
    expect(await readOfflineHome(pack.session)).toBeNull();
  });

  it("degrades gracefully if IndexedDB is absent, denied, or runs out of storage", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(await restoreOfflinePack()).toBeNull();
    expect(await saveOfflinePack(input())).toBeNull();
    await expect(clearOfflinePack()).resolves.toBeUndefined();
    vi.stubGlobal("indexedDB", factory);
    const open = vi.spyOn(factory, "open").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    expect(await saveOfflinePack(input())).toBeNull();
    open.mockRestore();
    const put = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(() => {
        throw new DOMException("Full", "QuotaExceededError");
      });
    expect(await saveOfflinePack(input())).toBeNull();
    put.mockRestore();
    expect(await restoreOfflinePack()).toBeNull();
    expect(await saveOfflinePack(input())).not.toBeNull();
  });
});
