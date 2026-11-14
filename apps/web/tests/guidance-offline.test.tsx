import { Blob as NativeBlob } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuidanceApp from "../components/guidance-app";
import { fixture } from "./fixtures";
import {
  clearOfflinePack,
  OFFLINE_TTL,
  readOfflineLogoutIntent,
  readOfflineMap,
  restoreOfflinePack,
  saveOfflinePack,
} from "../lib/offline-store";
import * as offlineStorage from "../lib/offline-store";
import type { Guidance, Preferences, User } from "../lib/types";

vi.mock("../lib/offline-shell", () => ({
  registerOfflineShell: vi.fn(async () => true),
}));

const user: User = {
  sub: "offline-student",
  name: "検証学生",
  email: "qa@example.test",
};
let dataset: Guidance;
let profile: Preferences;
let identity: User;
let bookmarks: Set<string>;
let fetchMock: ReturnType<typeof vi.fn>;
let failures: Map<string, number | Error>;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const availability = () =>
  screen.getByRole("status", { name: "オフライン用データ" });
const account = () => screen.getByRole("button", { name: "ユーザーメニュー" });
const company = () =>
  screen.getByRole("heading", { name: dataset.companies[0].name });
const favorite = () =>
  within(company().closest("article")!).getByRole("button", {
    name: /気になるから解除|気になるに追加/,
  });
async function openMenu() {
  await userEvent.click(account());
  return screen.getByRole("menu", { name: "ユーザーメニュー" });
}
async function seed() {
  const pack = await saveOfflinePack({
    user,
    guidance: dataset,
    preferences: profile,
    bookmarks: ["AM-1"],
  });
  expect(pack).not.toBeNull();
  return pack!;
}
async function onlineReady() {
  const mounted = render(<GuidanceApp />);
  await screen.findByRole("button", { name: "ユーザーメニュー" });
  await waitFor(() =>
    expect(availability()).toHaveAttribute("data-state", "ready"),
  );
  return mounted;
}

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("Blob", NativeBlob);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/search/");
  dataset = fixture();
  profile = { department: "電子制御工学科", grade: 4, roster_number: 7 };
  identity = { ...user };
  bookmarks = new Set(["AM-1"]);
  failures = new Map();
  await clearOfflinePack();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const failure =
      failures.get(`${init?.method || "GET"} ${path}`) ?? failures.get(path);
    if (failure instanceof Error) throw failure;
    if (failure) return new Response(null, { status: failure });
    if (path === "/api/me") return json({ user: identity });
    if (path === "/api/guidance") return json(dataset);
    if (path === "/api/preferences") return json(profile);
    if (path === "/api/bookmarks") return json({ company_ids: [...bookmarks] });
    if (path.startsWith("/api/bookmarks/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      if (init?.method === "DELETE") bookmarks.delete(id);
      else bookmarks.add(id);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/home")
      return json({
        event_id: "synthetic-event",
        roster_configured: true,
        tasks: [],
      });
    if (path === "/auth/logout") return new Response(null, { status: 204 });
    if (path.endsWith("/url"))
      return json({
        url: `https://r2.example.test/maps/${path.split("/")[3]}?X-Amz-Signature=private`,
        expires_at: "2030-05-14T01:00:00Z",
      });
    if (url.hostname === "r2.example.test")
      return new Response("synthetic image bytes", {
        headers: { "Content-Type": "image/png" },
      });
    throw Error(`Unhandled request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("offline application lifecycle", () => {
  it("prepares the public shell and signed map bytes without persisting signed URLs", async () => {
    await onlineReady();
    const pack = await restoreOfflinePack(user.sub);
    expect(pack?.bookmarks).toEqual(["AM-1"]);
    expect(pack?.guidance.documents.every((item) => item.url === "")).toBe(
      true,
    );
    expect((await readOfflineMap(pack!.session, "floor-a"))?.type).toBe(
      "image/png",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("X-Amz-Signature=private"),
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
    expect(screen.getByRole("main")).toHaveAttribute("data-offline", "false");
  });

  it("restores a verified pack read-only after an offline reload while local navigation still works", async () => {
    await seed();
    failures.set("/api/me", new TypeError("network disconnected"));
    render(<GuidanceApp />);
    await screen.findByRole("heading", { name: dataset.companies[0].name });
    expect(availability()).toHaveTextContent(
      "オフライン・保存済みの情報を表示中",
    );
    expect(screen.getByRole("main")).toHaveAttribute("data-offline", "true");
    expect(favorite()).toBeDisabled();
    const menu = await openMenu();
    expect(
      within(menu).getByRole("menuitem", { name: "名簿番号の設定" }),
    ).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("link", { name: "配布資料の案内" }));
    expect(
      screen.getByRole("button", { name: "テストガイド原本" }),
    ).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses only the same verified scope when a private read loses transport", async () => {
    await seed();
    failures.set("/api/bookmarks", new TypeError("network disconnected"));
    render(<GuidanceApp />);
    await screen.findByRole("heading", { name: dataset.companies[0].name });
    expect(availability()).toHaveAttribute("data-offline", "true");
    expect(favorite()).toHaveAttribute("aria-pressed", "true");
    expect(favorite()).toBeDisabled();
    expect(await restoreOfflinePack(user.sub)).not.toBeNull();
  });

  it("lets any explicit401 win over a simultaneous transport failure", async () => {
    await seed();
    failures.set("/api/guidance", new TypeError("network disconnected"));
    failures.set("/api/bookmarks", 401);
    render(<GuidanceApp />);
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(await restoreOfflinePack()).toBeNull();
  });

  it.each(["account", "profile", "event"] as const)(
    "does not restore the previous %s scope after partial transport failure",
    async (changed) => {
      await seed();
      if (changed === "account")
        identity = { ...user, sub: "another-student", name: "別の学生" };
      if (changed === "profile") profile = { ...profile, roster_number: 8 };
      if (changed === "event") dataset.event.date = "2031-05-14";
      failures.set(
        changed === "event" ? "/api/bookmarks" : "/api/guidance",
        new TypeError("network disconnected"),
      );
      render(<GuidanceApp />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "保存済みの情報がありません",
      );
      expect(
        screen.queryByRole("button", { name: "ユーザーメニュー" }),
      ).not.toBeInTheDocument();
      expect(await restoreOfflinePack()).toBeNull();
      expect(localStorage.getItem("guidance-offline-reset")).not.toBeNull();
    },
  );

  it("removes the old account immediately and notifies other tabs while new private data is pending", async () => {
    await onlineReady();
    const previousName = dataset.companies[0].name;
    expect(localStorage.getItem("guidance-offline-reset")).toBeNull();
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: (response: Response) => void;
    identity = { ...user, sub: "another-student", name: "別の学生" };
    dataset = fixture();
    dataset.companies[0].name = "別アカウントの検証企業";
    fetchMock.mockImplementation((input, init) =>
      String(input).endsWith("/api/guidance")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.queryByText(previousName)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "ユーザーメニュー" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "ログイン状態を確認しています",
    );
    expect(localStorage.getItem("guidance-offline-reset")).not.toBeNull();
    expect(await restoreOfflinePack()).toBeNull();
    await act(async () => finish(json(dataset)));
    await screen.findByRole("heading", { name: dataset.companies[0].name });
    expect((await restoreOfflinePack())?.user.sub).toBe(identity.sub);
  });

  it("ignores an old identity response after a newer verified generation has finished", async () => {
    await onlineReady();
    const before = (await restoreOfflinePack())!;
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finishOld!: (response: Response) => void;
    let first = true;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/api/me") && first) {
        first = false;
        // Deliberately ignore AbortSignal to model a late server response.
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      }
      return original(input, init);
    });
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(finishOld).toBeTypeOf("function"));
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(async () =>
      expect((await restoreOfflinePack())?.session.generation).not.toBe(
        before.session.generation,
      ),
    );
    await waitFor(() =>
      expect(availability()).toHaveAttribute("data-state", "ready"),
    );
    const protectedPack = (await restoreOfflinePack())!;
    const resetBefore = localStorage.getItem("guidance-offline-reset");
    const cacheRead = vi.spyOn(offlineStorage, "restoreOfflinePack");
    await act(async () =>
      finishOld(json({ user: { ...user, sub: "stale-other-account" } })),
    );
    // A superseded identity must not even enter cache-validation/purge work.
    expect(cacheRead).not.toHaveBeenCalled();
    expect(company()).toBeInTheDocument();
    expect(localStorage.getItem("guidance-offline-reset")).toBe(resetBefore);
    expect((await restoreOfflinePack())?.session.generation).toBe(
      protectedPack.session.generation,
    );
  });

  it("restores a cached pack after the15-second fetch budget even while the device says online", async () => {
    await seed();
    let abortBudget: (() => void) | undefined;
    const nativeTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 15_000) abortBudget = callback as () => void;
      return nativeTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("timed out", "AbortError")),
            { once: true },
          );
        }),
    );
    render(<GuidanceApp />);
    await waitFor(() => expect(signal).toBeDefined());
    expect(navigator.onLine).toBe(true);
    act(() => abortBudget!());
    await screen.findByRole("heading", { name: dataset.companies[0].name });
    expect(favorite()).toBeDisabled();
    expect(availability()).toHaveAttribute("data-offline", "true");
  });

  it("keeps writes locked after reconnect until identity and all private data refresh successfully", async () => {
    await seed();
    failures.set("/api/me", new TypeError("offline"));
    render(<GuidanceApp />);
    await screen.findByRole("heading", { name: dataset.companies[0].name });
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: (response: Response) => void;
    failures.clear();
    fetchMock.mockImplementation((input, init) =>
      String(input).endsWith("/api/me")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(favorite()).toBeDisabled();
    bookmarks.clear();
    await act(async () => finish(json({ user: identity })));
    await waitFor(() => expect(favorite()).not.toBeDisabled());
    expect(favorite()).toHaveAttribute("aria-pressed", "false");
    expect(availability()).toHaveAttribute("data-offline", "false");
  });

  it("drops an unsettled optimistic interest when the connection is lost", async () => {
    await onlineReady();
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) =>
      String(input).includes("/api/bookmarks/")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    await userEvent.click(favorite());
    expect(favorite()).toHaveAttribute("aria-pressed", "false");
    act(() => window.dispatchEvent(new Event("offline")));
    expect(favorite()).toHaveAttribute("aria-pressed", "true");
    expect(favorite()).toBeDisabled();
    expect((await restoreOfflinePack())?.bookmarks).toEqual(["AM-1"]);
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(favorite()).toBeDisabled();
  });

  it("never persists another company’s pending optimistic bookmark", async () => {
    await onlineReady();
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    const settles = new Map<string, (response: Response) => void>();
    fetchMock.mockImplementation((input, init) => {
      if (String(input).includes("/api/bookmarks/") && init?.method)
        return new Promise<Response>((resolve) =>
          settles.set(
            new URL(String(input)).pathname.split("/").pop()!,
            resolve,
          ),
        );
      return original(input, init);
    });
    await userEvent.click(favorite());
    const second = screen
      .getByRole("heading", { name: dataset.companies[1].name })
      .closest("article")!;
    await userEvent.click(
      within(second).getByRole("button", { name: /気になるに追加/ }),
    );
    await act(async () =>
      settles.get("AM-1")!(new Response(null, { status: 204 })),
    );
    await waitFor(async () =>
      expect((await restoreOfflinePack())?.bookmarks).toEqual([]),
    );
    expect(
      within(second).getByRole("button", { name: /気になるから解除/ }),
    ).toHaveAttribute("aria-busy", "true");
    await act(async () =>
      settles.get("AM-2")!(new Response(null, { status: 204 })),
    );
    await waitFor(async () =>
      expect((await restoreOfflinePack())?.bookmarks).toEqual(["AM-2"]),
    );
  });

  it("keeps a failed logout tombstone across reload rather than silently trusting an old cookie", async () => {
    const view = await onlineReady();
    failures.set("/auth/logout", new TypeError("offline"));
    const menu = await openMenu();
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "ログアウト" }),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(await readOfflineLogoutIntent()).toBe(true);
    expect(await restoreOfflinePack()).toBeNull();
    view.unmount();
    const before = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/me"),
    ).length;
    render(<GuidanceApp />);
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/me")),
    ).toHaveLength(before);
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
  });

  it("expires already-mounted offline UI at the pack deadline", async () => {
    const instant = Date.UTC(2030, 4, 14);
    const now = vi.spyOn(Date, "now").mockReturnValue(instant);
    await seed();
    now.mockReturnValue(instant + OFFLINE_TTL - 400);
    failures.set("/api/me", new TypeError("offline"));
    render(<GuidanceApp />);
    await screen.findByRole("heading", { name: dataset.companies[0].name });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "保存済みの情報の有効期限が切れました",
    );
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(await restoreOfflinePack()).toBeNull();
  });

  it("clears another tab’s visible private state and fences its pending load", async () => {
    await onlineReady();
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((input, init) =>
      String(input).endsWith("/api/me")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await clearOfflinePack();
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "guidance-offline-reset",
          newValue: "another-tab",
        }),
      ),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    await act(async () => finish(json({ user: identity })));
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(await restoreOfflinePack()).toBeNull();
  });
});
