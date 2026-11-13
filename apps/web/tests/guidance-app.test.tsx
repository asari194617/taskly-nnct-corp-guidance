import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuidanceApp from "../components/guidance-app";
import { fixture, largeFixture } from "./fixtures";

const documentNavigation = vi.hoisted(() => ({ assign: vi.fn() }));
vi.mock("../lib/document-navigation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/document-navigation")>();
  return {
    ...actual,
    navigateDocument: (url: string, page?: number) =>
      actual.navigateDocument(url, page, { assign: documentNavigation.assign }),
  };
});
import type { Guidance } from "../lib/types";

let dataset: Guidance;
let saved: Set<string>;
let rosterNumber: number | null;
let userName: string;
let userSub: string;
let failures: Map<string, number | Error>;
let fetchMock: ReturnType<typeof vi.fn>;
const preferences = () => ({
  roster_number: rosterNumber,
  department: "電子制御工学科",
  grade: 4,
});
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function card(name: string) {
  return screen.getByRole("heading", { name, level: 2 }).closest("article")!;
}
function nav(name: string) {
  return within(
    screen.getByRole("navigation", { name: "メインナビゲーション" }),
  ).getByRole("link", { name: new RegExp(name) });
}
function documentLink() {
  return within(screen.getByRole("banner")).getByRole("link", {
    name: "配布資料の案内",
  });
}
function companyLink(name: string) {
  return within(card(name)).getByRole("link", { name });
}
async function ready() {
  const mounted = render(<GuidanceApp />);
  await screen.findByRole("button", { name: "ユーザーメニュー" });
  return mounted;
}
async function openAccount() {
  if (!screen.queryByRole("menu", { name: "ユーザーメニュー" })) {
    await userEvent.click(
      screen.getByRole("button", { name: "ユーザーメニュー" }),
    );
  }
  return screen.getByRole("menu", { name: "ユーザーメニュー" });
}
async function accountAction(name: string) {
  const menu = await openAccount();
  await userEvent.click(within(menu).getByRole("menuitem", { name }));
}
async function expectAccountNumber(number: number) {
  const menu = await openAccount();
  expect(menu).toHaveTextContent(new RegExp(`Ec4.*${number}番`));
  await userEvent.keyboard("{Escape}");
}
async function expandDetailMap(dialog: HTMLElement) {
  const details = dialog.querySelector("details")!;
  if (!details.open)
    await userEvent.click(
      within(dialog).getByText("会場マップ", { selector: "summary" }),
    );
  return within(dialog).findByRole("link", { name: "マップページを開く" });
}
async function expandIndustries() {
  if (!screen.queryByRole("group", { name: "業種" })) {
    await userEvent.click(
      screen.getByRole("button", { name: /^業種(?: · \d+件)?$/ }),
    );
  }
  return screen.getByRole("group", { name: "業種" });
}

function locationURL() {
  return new URL(window.location.href);
}
function popTo(path: string) {
  act(() => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
function installNextHistoryBridge(initialURL: string, flag: "__NA" | "_N") {
  const nativeReplace = window.history.replaceState.bind(window.history);
  nativeReplace(
    { [flag]: true, __PRIVATE_NEXTJS_INTERNALS_TREE: "fixture" },
    "",
    initialURL,
  );
  let canonicalURL = window.location.href;
  vi.spyOn(window.history, "replaceState").mockImplementation(
    (data, unused, url) => {
      // Next distinguishes application writes from its own internal history writes.
      // Application writes synchronize the router, then inherit framework metadata.
      const internal = data && (data.__NA || data._N);
      if (!internal)
        canonicalURL = new URL(
          url == null ? window.location.href : String(url),
          window.location.href,
        ).href;
      const previous = window.history.state;
      nativeReplace(
        internal
          ? data
          : {
              ...data,
              ...(previous?.__NA ? { __NA: previous.__NA } : {}),
              ...(previous?.__PRIVATE_NEXTJS_INTERNALS_TREE
                ? {
                    __PRIVATE_NEXTJS_INTERNALS_TREE:
                      previous.__PRIVATE_NEXTJS_INTERNALS_TREE,
                  }
                : {}),
            },
        unused,
        url,
      );
    },
  );
  return {
    commitFrameworkURL: () =>
      nativeReplace(window.history.state, "", canonicalURL),
  };
}

function holdBookmarkWrites(ids: string[]) {
  const original = fetchMock.getMockImplementation()! as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  const pending = new Map<
    string,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >();
  const promises = new Map<string, Promise<Response>>();
  for (const id of ids) {
    promises.set(
      id,
      new Promise<Response>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      }),
    );
  }
  fetchMock.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const id = path.startsWith("/api/bookmarks/")
      ? decodeURIComponent(path.split("/").pop()!)
      : "";
    const response = promises.get(id);
    if (!response) return original(input, init);
    promises.delete(id);
    // Model the identity that accepted the request, even if the UI signs out
    // and the fixture's current account changes before the response arrives.
    const accountSaved = saved;
    const result = await response;
    if (result.ok) {
      if (init?.method === "DELETE") accountSaved.delete(id);
      else accountSaved.add(id);
    }
    return result;
  });
  return {
    finish: (id: string, status = 204) =>
      pending.get(id)!.resolve(new Response(null, { status })),
    fail: (id: string, error = new Error("検証用の通信エラー")) =>
      pending.get(id)!.reject(error),
  };
}
beforeEach(() => {
  documentNavigation.assign.mockReset();
  // Company workflows start on their dedicated page; Home routing is explicit below.
  window.history.replaceState(null, "", "/search/");
  window.sessionStorage.clear();
  dataset = fixture();
  saved = new Set();
  rosterNumber = 7;
  userName = "テストユーザー";
  userSub = "test-user";
  failures = new Map();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const failure =
      failures.get(`${init?.method || "GET"} ${path}`) ?? failures.get(path);
    if (failure instanceof Error) throw failure;
    if (failure) return new Response("", { status: failure });
    if (path === "/api/me")
      return json({
        user: {
          sub: userSub,
          email: "test@example.invalid",
          name: userName,
        },
      });
    if (path === "/api/guidance") return json(dataset);
    if (path === "/api/home")
      return json({
        event_id: "synthetic-event",
        roster_configured: rosterNumber !== null,
        tasks: [],
      });
    if (path === "/api/preferences") {
      if (init?.method === "PUT") {
        const number = JSON.parse(String(init.body)).roster_number;
        if (
          !dataset.assignments.some(
            (row) =>
              row.department === "電子制御工学科" &&
              row.grade === 4 &&
              row.number === number,
          )
        )
          return json({ error: "invalid_roster" }, 422);
        rosterNumber = number;
      }
      return json(preferences());
    }
    if (path === "/api/bookmarks") return json({ company_ids: [...saved] });
    if (path.startsWith("/api/bookmarks/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      if (init?.method === "DELETE") saved.delete(id);
      else saved.add(id);
      return new Response(null, { status: 204 });
    }
    if (path === "/auth/logout") return new Response(null, { status: 204 });
    if (/^\/api\/documents\/[^/]+\/url$/.test(path)) {
      const id = path.split("/")[3];
      return json({
        url: `https://synthetic-r2.example.invalid/private-guide/${id}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic`,
        expires_at: "2030-01-01T00:05:00Z",
      });
    }
    throw new Error(`Unhandled request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("authentication and private content", () => {
  it("shows only Taskly sign-in and branding before authentication", async () => {
    failures.set("/api/me", 401);
    render(<GuidanceApp />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "ログイン状態を確認しています",
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    const brand = screen.getByRole("link", {
      name: "Taskly 企業ガイダンス ホーム",
    });
    expect(within(brand).getByRole("img", { name: "Taskly" })).toHaveAttribute(
      "src",
      "/taskly-logo.svg",
    );
    expect(within(brand).getByText("企業ガイダンス")).toBeInTheDocument();
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries unavailable connections without exposing the dataset", async () => {
    failures.set("/api/me", new Error("offline"));
    render(<GuidanceApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "接続できませんでした",
    );
    failures.set("/api/me", 503);
    await userEvent.click(
      screen.getByRole("button", { name: "もう一度接続する" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "情報を取得できませんでした",
    );
    failures.clear();
    await userEvent.click(
      screen.getByRole("button", { name: "もう一度接続する" }),
    );
    await screen.findByRole("heading", { name: dataset.companies[0].name });
  });
  it("fails closed if preferences cannot be loaded", async () => {
    failures.set("/api/preferences", 503);
    render(<GuidanceApp />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: dataset.companies[0].name }),
    ).not.toBeInTheDocument();
  });
  it("preserves the page on failed logout, then clears all private state on success", async () => {
    await ready();
    failures.set("/auth/logout", 503);
    await accountAction("ログアウト");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ログアウトできませんでした",
    );
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    failures.delete("/auth/logout");
    await accountAction("ログアウト");
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/logout"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
  it("reports logout transport failures", async () => {
    await ready();
    failures.set("/auth/logout", new Error("通信エラー"));
    await accountAction("ログアウト");
    expect(await screen.findByRole("alert")).toHaveTextContent("通信エラー");
  });
  it("uses the account fallback label without requiring an event date", async () => {
    userName = "";
    dataset.event.date = "未定";
    await ready();
    await openAccount();
    expect(screen.getByText("Taskly ユーザー")).toBeInTheDocument();
    expect(screen.queryByText("未定")).not.toBeInTheDocument();
  });
});

describe("account menu", () => {
  it("keeps account actions behind the avatar and supports keyboard navigation and dismissal", async () => {
    await ready();
    const trigger = screen.getByRole("button", { name: "ユーザーメニュー" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("menuitem", { name: "ログアウト" }),
    ).not.toBeInTheDocument();
    const menu = await openAccount();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(menu).toHaveTextContent(userName);
    expect(menu).toHaveTextContent(/Ec4.*7番/);
    const roster = within(menu).getByRole("menuitem", {
      name: "名簿番号の設定",
    });
    const logout = within(menu).getByRole("menuitem", { name: "ログアウト" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(
      within(menu).queryByRole("menuitem", { name: "配布資料の案内" }),
    ).not.toBeInTheDocument();
    await userEvent.keyboard("{End}");
    expect(logout).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(roster).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(logout).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(roster).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await openAccount();
    await userEvent.click(screen.getByRole("heading", { name: "探す" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/auth/logout"),
      ),
    ).toBe(false);
  });
  it("opens the first or last item from the trigger keys and closes on Tab or a second click", async () => {
    await ready();
    const trigger = screen.getByRole("button", { name: "ユーザーメニュー" });
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "ログアウト" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("menuitem", { name: "名簿番号の設定" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await openAccount();
    await userEvent.click(trigger);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("lets a keyboard-only user open the guide page from its header icon", async () => {
    await ready();
    const link = documentLink();
    const trigger = screen.getByRole("button", { name: "ユーザーメニュー" });
    expect(link).toHaveAttribute("href", "/documents/");
    expect(link.querySelector("svg")).not.toBeNull();
    expect(
      link.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    link.focus();
    await userEvent.keyboard("{Enter}");
    expect(locationURL().pathname).toBe("/documents/");
    expect(
      screen.getByRole("heading", { name: "配布資料の案内", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("disables account actions while logout is pending and clears private state after completion", async () => {
    await ready();
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: () => void;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/auth/logout"))
        return new Promise<Response>((resolve) => {
          finish = () => resolve(new Response(null, { status: 204 }));
        });
      return original(input, init);
    });
    await accountAction("ログアウト");
    expect(
      screen.getByRole("button", { name: "ユーザーメニュー" }),
    ).toBeDisabled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await act(async () => finish());
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
  });
  it("keeps roster settings in the menu and guide navigation in the header", async () => {
    await ready();
    await accountAction("名簿番号の設定");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "名簿番号" })).toHaveValue(7);
    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await userEvent.click(documentLink());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(locationURL().pathname).toBe("/documents/");
    expect(
      screen.getByRole("heading", { name: "配布資料の案内", level: 1 }),
    ).toBeInTheDocument();
  });
  it("uses one interest label for saved companies without an account-persistence explanation", async () => {
    saved.add("AM-1");
    await ready();
    await userEvent.click(nav("気になる"));
    expect(
      screen.getByRole("heading", { name: "気になる", level: 1 }),
    ).toBeInTheDocument();
    expect(
      within(card(dataset.companies[0].name)).getByRole("button", {
        name: /気になるから解除$/,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(document.body).not.toHaveTextContent("見学リスト");
    expect(document.body).not.toHaveTextContent(
      "保存した企業は、同じTasklyアカウントで確認できます。",
    );
  });
});

describe("Ec4 first-visit preferences", () => {
  it("asks only for a roster number, saves it per account and personalizes the plan", async () => {
    rosterNumber = null;
    await ready();
    const dialog = await screen.findByRole("dialog", {
      name: "名簿番号の設定",
    });
    expect(within(dialog).getByText(/Ec4/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.type(
      within(dialog).getByRole("spinbutton", { name: "名簿番号" }),
      "7",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存する" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "名簿番号の設定" }),
      ).not.toBeInTheDocument(),
    );
    expect(rosterNumber).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/preferences"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ roster_number: 7 }),
      }),
    );
    await expectAccountNumber(7);
    expect(locationURL().search).not.toMatch(/roster|number|名簿/);
    await userEvent.click(nav("気になる"));
    expect(
      screen.getByRole("heading", { name: "指定企業" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /あおばテスト株式会社/ }),
    ).toBeInTheDocument();
  });
  it("allows postponing first setup and reopening it from the header", async () => {
    rosterNumber = null;
    await ready();
    let dialog = await screen.findByRole("dialog", { name: "名簿番号の設定" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "あとで" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    await accountAction("名簿番号の設定");
    dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    fireEvent(dialog, new Event("cancel", { bubbles: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
  });
  it("does not ask again when the stored account preference is present", async () => {
    await ready();
    expect(
      screen.queryByRole("dialog", { name: "名簿番号の設定" }),
    ).not.toBeInTheDocument();
    await accountAction("名簿番号の設定");
    const dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    expect(
      within(dialog).getByRole("spinbutton", { name: "名簿番号" }),
    ).toHaveValue(7);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "キャンセル" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps invalid numbers in the modal until a valid number is saved", async () => {
    await ready();
    await accountAction("名簿番号の設定");
    const dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    const number = within(dialog).getByRole("spinbutton", { name: "名簿番号" });
    await userEvent.clear(number);
    await userEvent.type(number, "99");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存する" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "名簿番号を確認してください",
    );
    expect(rosterNumber).toBe(7);
    await userEvent.clear(number);
    await userEvent.type(number, "8");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存する" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(rosterNumber).toBe(8);
    await expectAccountNumber(8);
    await userEvent.click(nav("気になる"));
    const assignments = screen.getByRole("region", { name: "指定企業" });
    expect(within(assignments).getAllByRole("link")[0]).toHaveTextContent(
      dataset.companies[1].name,
    );
  });
  it("offers number setup from an empty personal plan while browsing stays available", async () => {
    rosterNumber = null;
    await ready();
    const onboarding = await screen.findByRole("dialog", {
      name: "名簿番号の設定",
    });
    await userEvent.click(
      within(onboarding).getByRole("button", {
        name: "あとで",
      }),
    );
    await userEvent.click(nav("気になる"));
    const assignments = screen.getByRole("region", { name: "指定企業" });
    await userEvent.click(
      within(assignments).getByRole("button", { name: "名簿番号を設定" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "名簿番号の設定" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "あとで" }));
    await userEvent.click(screen.getByRole("button", { name: "探す" }));
    expect(screen.getByRole("heading", { name: "探す" })).toBeInTheDocument();
    expect(locationURL().pathname).toBe("/search/");
  });
  it("reports when a saved number no longer has an assignment", async () => {
    dataset.assignments = [];
    window.history.replaceState(null, "", "/favorites/");
    await ready();
    expect(screen.getByRole("status")).toHaveTextContent(
      "指定企業が見つかりません",
    );
    expect(
      screen.getByRole("heading", { name: "まだ追加されていません" }),
    ).toBeInTheDocument();
  });
  it("handles a save transport failure and does not discard the previous preference", async () => {
    await ready();
    await accountAction("名簿番号の設定");
    failures.set("PUT /api/preferences", new Error("設定を保存できません"));
    const dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存する" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "設定を保存できません",
    );
    expect(rosterNumber).toBe(7);
  });
  it("returns to sign-in when the preference save discovers an expired session", async () => {
    await ready();
    await accountAction("名簿番号の設定");
    failures.set("PUT /api/preferences", 401);
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "保存する",
      }),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
  });
});

describe("shareable routes and venue navigation", () => {
  it("places real navigation links in the header and mobile menu icons next to their labels", async () => {
    await ready();
    const desktop = screen.getByRole("navigation", {
      name: "メインナビゲーション",
    });
    expect(desktop.closest("header")).not.toBeNull();
    expect(nav("会場マップ")).toHaveAttribute("href", "/map/");
    const mobile = screen.getByRole("navigation", {
      name: "モバイルナビゲーション",
    });
    for (const link of within(mobile).getAllByRole("link"))
      expect(link.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(dataset.event.venue)).not.toBeInTheDocument();
    expect(screen.queryByText(dataset.event.title)).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "掲載情報は配布資料をもとにしています。変更は学校からの案内をご確認ください。",
      ),
    ).not.toBeInTheDocument();
  });
  it("opens Home at the root and keeps company search on its own shareable page", async () => {
    window.history.replaceState(null, "", "/");
    await ready();
    expect(
      screen.getByRole("heading", { level: 1, name: "ホーム" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "やること" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "参加時間帯" }),
    ).not.toBeInTheDocument();
    expect(nav("ホーム")).toHaveAttribute("href", "/");
    expect(nav("ホーム")).toHaveAttribute("aria-current", "page");
    const search = nav("探す");
    expect(search).toHaveAttribute("href", "/search/");
    await userEvent.click(search);
    expect(locationURL().pathname).toBe("/search/");
    expect(
      screen.getByRole("heading", { level: 1, name: "探す" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(
      dataset.companies.length,
    );
    await userEvent.click(nav("ホーム"));
    expect(locationURL().pathname).toBe("/");
    expect(locationURL().searchParams.has("view")).toBe(false);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "ホーム" }),
    ).toBeInTheDocument();
  });
  it("keeps Home available when the search filters have no matching companies", async () => {
    window.history.replaceState(
      null,
      "",
      "/search/?q=存在しない検証会社&session=PM&saved=1",
    );
    await ready();
    expect(
      screen.getByRole("heading", { name: "条件に合う企業が見つかりません" }),
    ).toBeInTheDocument();
    await userEvent.click(nav("ホーム"));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "ホーム" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "おすすめ" }),
    ).toBeInTheDocument();
  });
  it("keeps company browsing available when Home tasks cannot be loaded", async () => {
    window.history.replaceState(null, "", "/");
    failures.set("/api/home", 503);
    await ready();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "やることを取得できませんでした",
    );
    await userEvent.click(nav("探す"));
    expect(
      screen.getByRole("heading", { name: "探す", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(
      dataset.companies.length,
    );
    expect(
      screen.queryByRole("button", { name: "Tasklyでログイン" }),
    ).not.toBeInTheDocument();
  });
  it("expires the guidance session when Home discovers a revoked login", async () => {
    window.history.replaceState(null, "", "/");
    failures.set("/api/home", 401);
    render(<GuidanceApp />);
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      screen.queryByRole("heading", { name: "ホーム" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps refreshed Home tasks for the new roster when an old poll finishes late", async () => {
    window.history.replaceState(null, "", "/");
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let reads = 0;
    let finishOldPoll!: (response: Response) => void;
    const responseFor = (number: number) => ({
      event_id: "synthetic-event",
      roster_configured: true,
      tasks: [
        {
          id: "assigned-visit-1",
          kind: "assigned_visit",
          title: `検証名簿${number}番の指定企業`,
          completed: false,
          completion_disabled: false,
          taskly_url: "https://taskly.example.test/tasks/assigned-visit-1",
          company_id: number === 7 ? "AM-1" : "AM-2",
          term: 1,
        },
      ],
    });
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname !== "/api/home")
        return original(input, init);
      reads++;
      if (reads === 2)
        return new Promise<Response>((resolve) => {
          finishOldPoll = resolve;
        });
      return json(responseFor(rosterNumber!));
    });
    await ready();
    await screen.findByRole("checkbox", { name: "検証名簿7番の指定企業" });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(reads).toBe(2));
    await accountAction("名簿番号の設定");
    const dialog = await screen.findByRole("dialog", {
      name: "名簿番号の設定",
    });
    const number = within(dialog).getByRole("spinbutton", { name: "名簿番号" });
    await userEvent.clear(number);
    await userEvent.type(number, "8");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "保存する" }),
    );
    await screen.findByRole("checkbox", { name: "検証名簿8番の指定企業" });
    await act(async () => finishOldPoll(json(responseFor(7))));
    expect(
      screen.getByRole("checkbox", { name: "検証名簿8番の指定企業" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "検証名簿7番の指定企業" }),
    ).not.toBeInTheDocument();
    await expectAccountNumber(8);
  });
  it("shares an optimistic interest from a Home recommendation with its company detail", async () => {
    window.history.replaceState(null, "", "/");
    const company = {
      ...dataset.companies[0],
      id: "AM-3",
      name: "未指定の検証ソフト",
      booth: 3,
    };
    dataset.companies.push(company);
    await ready();
    const requests = holdBookmarkWrites([company.id]);
    const save = screen.getByRole("button", {
      name: `${company.name}を気になるに追加`,
    });
    fireEvent.click(save);
    expect(save).toHaveAttribute("aria-pressed", "true");
    expect(save).toBeDisabled();
    expect(nav("気になる")).toHaveTextContent("1");
    await userEvent.click(screen.getByRole("link", { name: company.name }));
    const dialog = await screen.findByRole("dialog", { name: company.name });
    const sameInterest = within(dialog).getByRole("button", {
      name: `${company.name}を気になるから解除`,
    });
    expect(sameInterest).toHaveAttribute("aria-pressed", "true");
    expect(sameInterest).toBeDisabled();
    await act(async () => requests.finish(company.id));
    await waitFor(() => expect(sameInterest).toBeEnabled());
    expect(saved.has(company.id)).toBe(true);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "閉じる" }),
    );
    expect(
      screen.getByRole("heading", { name: "ホーム", level: 1 }),
    ).toBeInTheDocument();
  });
  it.each(["__NA", "_N"] as const)(
    "keeps typed search parameters when the framework commits after a favorite update (%s)",
    async (flag) => {
      const framework = installNextHistoryBridge("/search/", flag);
      await ready();
      const input = screen.getByRole("searchbox");
      await userEvent.type(input, "機械");
      expect(locationURL().searchParams.get("q")).toBe("機械");
      const company = dataset.companies[1];
      await userEvent.click(
        within(card(company.name)).getByRole("button", {
          name: `${company.name}を気になるに追加`,
        }),
      );
      await waitFor(() => expect(saved.has(company.id)).toBe(true));
      act(() => framework.commitFrameworkURL());
      expect(locationURL().pathname).toBe("/search/");
      expect(locationURL().searchParams.get("q")).toBe("機械");
      expect(input).toHaveValue("機械");
      expect(window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE).toBe(
        "fixture",
      );
    },
  );
  it.each(["__NA", "_N"] as const)(
    "keeps legacy URL normalization when the framework commits after a favorite update (%s)",
    async (flag) => {
      const framework = installNextHistoryBridge(
        "/index.html?view=companies&q=機械#results",
        flag,
      );
      await ready();
      expect(locationURL().pathname).toBe("/search/");
      const company = dataset.companies[1];
      await userEvent.click(
        within(card(company.name)).getByRole("button", {
          name: `${company.name}を気になるに追加`,
        }),
      );
      await waitFor(() => expect(saved.has(company.id)).toBe(true));
      act(() => framework.commitFrameworkURL());
      expect(locationURL().pathname).toBe("/search/");
      expect(locationURL().searchParams.get("q")).toBe("機械");
      expect(locationURL().searchParams.has("view")).toBe(false);
      expect(locationURL().hash).toBe("#results");
      expect(screen.getByRole("searchbox")).toHaveValue("機械");
    },
  );
  it("opens a shared company detail after authentication without requiring prior navigation", async () => {
    window.history.replaceState(null, "", "/?view=companies&company=AM-1");
    await ready();
    expect(
      await screen.findByRole("dialog", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    expect(locationURL().searchParams.get("company")).toBe("AM-1");
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(locationURL().searchParams.has("company")).toBe(false);
  });
  it("normalizes a legacy index link into the favorites page while retaining its fragment", async () => {
    window.history.replaceState(null, "", "/index.html?view=plan#saved");
    await ready();
    expect(locationURL().pathname).toBe("/favorites/");
    expect(locationURL().searchParams.has("view")).toBe(false);
    expect(locationURL().hash).toBe("#saved");
    expect(
      screen.getByRole("heading", { name: "気になる" }),
    ).toBeInTheDocument();
  });
  it("updates query routes and responds to browser back/forward state changes", async () => {
    await ready();
    await userEvent.click(nav("スケジュール"));
    expect(locationURL().pathname).toBe("/schedule/");
    expect(
      screen.getByRole("heading", { name: "スケジュール" }),
    ).toBeInTheDocument();
    popTo("/favorites/");
    expect(
      screen.getByRole("heading", { name: "気になる" }),
    ).toBeInTheDocument();
    popTo("/?company=PM-1");
    expect(
      screen.getByRole("dialog", { name: dataset.companies[2].name }),
    ).toBeInTheDocument();
  });
  it("ignores unrecognized routes and missing companies instead of exposing a broken modal", async () => {
    window.history.replaceState(
      null,
      "",
      "/?view=unknown&company=not-present&session=invalid",
    );
    await ready();
    expect(screen.getByRole("heading", { name: "ホーム" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(locationURL().searchParams.has("company")).toBe(false);
  });
  it("restores the saved company link after returning from Taskly login", async () => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.setItem(
      "guidance-return-route",
      "/index.html?view=map&company=PM-1&session=PM#booth",
    );
    await ready();
    expect(locationURL().pathname).toBe("/map/");
    expect(locationURL().searchParams.has("view")).toBe(false);
    expect(locationURL().searchParams.get("company")).toBe("PM-1");
    expect(locationURL().hash).toBe("#booth");
    expect(
      screen.getByRole("region", { name: dataset.companies[2].name }),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem("guidance-return-route")).toBeNull();
  });
  it.each([
    "https://other.example.invalid/?view=map",
    "/unrelated?view=plan",
    "http://[",
  ])(
    "discards an unsafe or malformed saved login destination: %s",
    async (destination) => {
      window.history.replaceState(null, "", "/");
      window.sessionStorage.setItem("guidance-return-route", destination);
      await ready();
      expect(locationURL().pathname).toBe("/");
      expect(locationURL().search).toBe("");
      expect(
        screen.getByRole("heading", { name: "ホーム" }),
      ).toBeInTheDocument();
    },
  );
  it("still opens a directly requested page when session storage is unavailable", async () => {
    window.history.replaceState(null, "", "/schedule/");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    await ready();
    expect(locationURL().pathname).toBe("/schedule/");
    expect(
      screen.getByRole("heading", { name: "スケジュール" }),
    ).toBeInTheDocument();
  });

  it("keeps a directly requested route ahead of an old saved login destination", async () => {
    window.history.replaceState(null, "", "/schedule/");
    window.sessionStorage.setItem("guidance-return-route", "/favorites/");
    await ready();
    expect(locationURL().pathname).toBe("/schedule/");
    expect(
      screen.getByRole("heading", { name: "スケジュール" }),
    ).toBeInTheDocument();
  });
  it("consumes a stale login destination on a direct visit so a later home visit stays home", async () => {
    window.history.replaceState(null, "", "/search/?q=機械");
    window.sessionStorage.setItem(
      "guidance-return-route",
      "/map/?focus=AM-1&session=AM",
    );
    const directPage = render(<GuidanceApp />);
    await screen.findByRole("button", { name: "ユーザーメニュー" });
    expect(locationURL().pathname).toBe("/search/");
    expect(locationURL().searchParams.get("q")).toBe("機械");
    expect(screen.getByRole("searchbox")).toHaveValue("機械");
    expect(window.sessionStorage.getItem("guidance-return-route")).toBeNull();

    directPage.unmount();
    window.history.replaceState(null, "", "/");
    await ready();
    expect(locationURL().pathname).toBe("/");
    expect(locationURL().search).toBe("");
    expect(
      screen.getByRole("heading", { name: "ホーム", level: 1 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "操作できる会場マップ" }),
    ).not.toBeInTheDocument();
  });
  it("does not intercept a link whose click was already handled", async () => {
    await ready();
    const link = nav("スケジュール");
    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    await userEvent.click(link);
    expect(locationURL().pathname).toBe("/search/");
    expect(locationURL().searchParams.has("view")).toBe(false);
    expect(screen.getByRole("heading", { name: "探す" })).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/schedule/");
  });
  it("keeps map filters, booth selection and session changes in shareable query routes", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/map/?saved=1");
    await ready();
    const first = await screen.findByRole("button", {
      name: "午前 ブース 1 あおばテスト株式会社",
    });
    const second = screen.getByRole("button", {
      name: "午前 ブース 2 いろはテスト製作所",
    });
    expect(first).toBeEnabled();
    expect(second).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^絞り込み/ }));
    await userEvent.click(
      screen.getByRole("checkbox", { name: "指定企業のみ" }),
    );
    expect(locationURL().searchParams.get("assigned")).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "条件を解除" }));
    expect(locationURL().searchParams.has("saved")).toBe(false);
    expect(locationURL().searchParams.has("assigned")).toBe(false);
    expect(second).toBeEnabled();
    await userEvent.click(
      within(
        screen.getByRole("region", { name: "マップの絞り込み" }),
      ).getByRole("button", { name: "閉じる" }),
    );
    await userEvent.click(second);
    expect(
      screen.getByRole("region", { name: dataset.companies[1].name }),
    ).toBeInTheDocument();
    expect(locationURL().searchParams.get("company")).toBe("AM-2");
    expect(locationURL().searchParams.get("focus")).toBe("AM-2");
    await userEvent.click(
      screen.getByRole("button", { name: "企業情報を閉じる" }),
    );
    await userEvent.click(screen.getByRole("radio", { name: "午後の部" }));
    expect(locationURL().searchParams.get("session")).toBe("PM");
    expect(locationURL().searchParams.has("focus")).toBe(false);
    expect(locationURL().searchParams.has("company")).toBe(false);
    expect(
      await screen.findByRole("button", {
        name: "午後 ブース 2 よつばテスト研究所",
      }),
    ).toBeEnabled();
  });
  it("clears stale filters when opening a chosen company on the map", async () => {
    window.history.replaceState(
      null,
      "",
      "/search/?company=AM-1&q=一致しない企業&industry=存在しない業種&saved=1&assigned=1",
    );
    await ready();
    const company = dataset.companies[0];
    const dialog = await screen.findByRole("dialog", { name: company.name });
    const link = await expandDetailMap(dialog);
    const target = new URL(link.getAttribute("href")!, window.location.origin);
    for (const key of ["q", "industry", "saved", "assigned"])
      expect(target.searchParams.has(key)).toBe(false);
    expect(target.searchParams.get("focus")).toBe(company.id);
    await userEvent.click(link);
    for (const key of ["q", "industry", "saved", "assigned"])
      expect(locationURL().searchParams.has(key)).toBe(false);
    expect(locationURL().searchParams.get("focus")).toBe(company.id);
    expect(locationURL().searchParams.get("session")).toBe(company.session);
    expect(
      await screen.findByRole("button", {
        name: "午前 ブース 1 あおばテスト株式会社",
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "午前 ブース 1 あおばテスト株式会社",
      }),
    ).toHaveAttribute("data-selected", "true");
  });
  it("loads a highlighted embedded map only when its detail accordion is expanded", async () => {
    await ready();
    const first = dataset.companies[0];
    await userEvent.click(companyLink(first.name));
    const dialog = screen.getByRole("dialog", { name: first.name });
    expect(
      within(dialog).queryByRole("button", { name: "詳細を閉じる" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "閉じる" }),
    ).toHaveTextContent("閉じる");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/api/documents/"),
      ),
    ).toBe(false);
    const mapLink = await expandDetailMap(dialog);
    expect(mapLink).toHaveAttribute("href", "/map/?focus=AM-1&session=AM");
    const selected = await within(dialog).findByRole("button", {
      name: "午前 ブース 1 あおばテスト株式会社",
    });
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/api/documents/floor-a/url"),
      ),
    ).toBe(true);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "閉じる" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(locationURL().searchParams.has("company")).toBe(false);
  });

  it("keeps normal header and mobile navigation available on the map", async () => {
    window.history.replaceState(null, "", "/map/?session=AM");
    await ready();
    const header = screen.getByRole("banner");
    expect(
      within(header).getByRole("link", {
        name: "Taskly 企業ガイダンス ホーム",
      }),
    ).toBeInTheDocument();
    expect(
      within(header).getByRole("navigation", { name: "メインナビゲーション" }),
    ).toBeInTheDocument();
    expect(
      within(header).getByRole("button", { name: "ユーザーメニュー" }),
    ).toBeInTheDocument();
    const mobile = screen.getByRole("navigation", {
      name: "モバイルナビゲーション",
    });
    expect(
      within(mobile).getByRole("link", { name: "マップ" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(mobile)
        .getByRole("link", { name: "マップ" })
        .querySelector("svg[data-filled=true]"),
    ).not.toBeNull();
    expect(document.querySelector(".venue-map-navigation")).toBeNull();
    const search = await screen.findByRole("searchbox", {
      name: "マップの企業名",
    });
    expect(
      search
        .closest(".venue-map-search-input")
        ?.querySelector(".venue-map-search-icon[aria-hidden=true] svg"),
    ).not.toBeNull();
  });
  it("keeps the map interactive while a non-modal company panel changes its selection", async () => {
    window.history.replaceState(
      null,
      "",
      "/map/?company=AM-1&focus=AM-1&session=AM",
    );
    await ready();
    const first = dataset.companies[0],
      second = dataset.companies[1];
    const panel = await screen.findByRole("region", { name: first.name });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(panel).not.toHaveAttribute("aria-modal");
    const zoom = screen.getByRole("button", {
      name: "マップの表示をリセット",
    });
    await userEvent.click(screen.getByRole("button", { name: "マップを拡大" }));
    expect(zoom).toHaveAccessibleDescription("現在の倍率 125パーセント");
    const secondBooth = screen.getByRole("button", {
      name: `午前 ブース 2 ${second.name}`,
    });
    await userEvent.click(secondBooth);
    const updated = screen.getByRole("region", { name: second.name });
    expect(updated).toBe(panel);
    expect(locationURL().searchParams.get("company")).toBe(second.id);
    expect(locationURL().searchParams.get("focus")).toBe(second.id);
    expect(zoom).toHaveAccessibleDescription("現在の倍率 125パーセント");
    await userEvent.click(
      within(updated).getByRole("button", { name: "企業情報を閉じる" }),
    );
    expect(
      screen.queryByRole("region", { name: second.name }),
    ).not.toBeInTheDocument();
    expect(locationURL().searchParams.has("company")).toBe(false);
    expect(locationURL().searchParams.get("focus")).toBe(second.id);
    expect(secondBooth).toHaveAttribute("data-selected", "true");
    expect(
      screen.getByRole("button", { name: `午前 ブース 1 ${first.name}` }),
    ).toHaveAttribute("aria-pressed", "false");
  });
  it("closes only the panel's Escape context and restores the keyboard map trigger", async () => {
    window.history.replaceState(null, "", "/map/?session=AM");
    await ready();
    const company = dataset.companies[0];
    const booth = await screen.findByRole("button", {
      name: `午前 ブース 1 ${company.name}`,
    });
    booth.focus();
    await userEvent.keyboard("{Enter}");
    const panel = screen.getByRole("region", { name: company.name });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const zoom = screen.getByRole("button", { name: "マップを拡大" });
    fireEvent.keyDown(zoom, { key: "Escape" });
    expect(panel).toBeInTheDocument();
    within(panel).getByRole("heading", { name: company.name }).focus();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: company.name }),
    ).not.toBeInTheDocument();
    expect(booth).toHaveFocus();
  });
  it("returns to the map viewport when its original booth has been filtered out", async () => {
    window.history.replaceState(null, "", "/map/?session=AM");
    await ready();
    const company = dataset.companies[0];
    const booth = await screen.findByRole("button", {
      name: `午前 ブース 1 ${company.name}`,
    });
    booth.focus();
    await userEvent.keyboard("{Enter}");
    const panel = screen.getByRole("region", { name: company.name });
    await userEvent.type(
      screen.getByRole("searchbox", { name: "マップの企業名" }),
      dataset.companies[1].name,
    );
    expect(booth).toBeDisabled();
    await userEvent.click(
      within(panel).getByRole("button", { name: "企業情報を閉じる" }),
    );
    expect(
      screen.getByRole("region", { name: "操作できる会場マップ" }),
    ).toHaveFocus();
  });
  it("returns to sign-in if opening the embedded map finds an expired login", async () => {
    await ready();
    const first = dataset.companies[0];
    await userEvent.click(companyLink(first.name));
    failures.set("/api/documents/floor-a/url", 401);
    await userEvent.click(
      within(screen.getByRole("dialog", { name: first.name })).getByText(
        "会場マップ",
        { selector: "summary" },
      ),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(first.name)).not.toBeInTheDocument();
  });

  it("keeps company and map focus reproducible through actual links", async () => {
    await ready();
    const first = dataset.companies[0];
    expect(companyLink(first.name)).toHaveAttribute(
      "href",
      expect.stringContaining("company=AM-1"),
    );
    await userEvent.click(companyLink(first.name));
    expect(locationURL().searchParams.get("company")).toBe("AM-1");
    const dialog = screen.getByRole("dialog", { name: first.name });
    await userEvent.click(await expandDetailMap(dialog));
    await screen.findByRole("heading", { name: "会場マップ" });
    expect(locationURL().pathname).toBe("/map/");
    expect(locationURL().searchParams.get("focus")).toBe("AM-1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("structured guide notices", () => {
  it("opens guide sections on their own shareable page without adding them to the schedule", async () => {
    dataset.notice_sections = [
      {
        id: "preparation",
        title: "検証用の準備",
        blocks: [
          { type: "paragraph", text: "持参品の確認 <script>" },
          { type: "list", items: ["検証ノート", "検証ペン"] },
        ],
      },
      {
        id: "movement",
        title: "検証用の移動",
        blocks: [{ type: "paragraph", text: "検証経路で移動する" }],
      },
    ];
    window.history.replaceState(null, "", "/schedule/");
    await ready();
    expect(
      screen.queryByRole("heading", { name: "検証用の準備" }),
    ).not.toBeInTheDocument();
    const link = documentLink();
    expect(link).toHaveAttribute("href", "/documents/");
    await userEvent.click(link);
    expect(locationURL().pathname).toBe("/documents/");
    expect(
      screen.getByRole("heading", { level: 1, name: "配布資料の案内" }),
    ).toBeInTheDocument();
    const first = screen
      .getByRole("heading", { name: "検証用の準備" })
      .closest("section")!;
    expect(
      within(first).getByText("持参品の確認 <script>"),
    ).toBeInTheDocument();
    expect(
      within(first)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["検証ノート", "検証ペン"]);
    expect(
      screen.getByRole("heading", { name: "検証用の移動" }),
    ).toBeInTheDocument();
    expect(screen.getByText("検証経路で移動する")).toBeInTheDocument();
    expect(screen.queryByText(dataset.notices[0])).not.toBeInTheDocument();
    expect(first.querySelector("script")).toBeNull();
    popTo("/schedule/");
    expect(
      screen.queryByRole("heading", { name: "検証用の準備" }),
    ).not.toBeInTheDocument();
  });
  it("supports direct guide visits and legacy notice text without structured sections", async () => {
    dataset.notice_sections = [];
    window.history.replaceState(null, "", "/documents/");
    await ready();
    expect(
      screen.getByRole("heading", { name: "配布資料の案内", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(dataset.notices[0])).toBeInTheDocument();
  });
});

describe("guide PDF access", () => {
  const signedGuide =
    "https://synthetic-r2.example.invalid/private-guide/guide?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic";
  it.each(["blocked", "throws"] as const)(
    "navigates the current tab to the issued signed URL even if popups are %s",
    async (popup) => {
      window.history.replaceState(null, "", "/documents/");
      const open = vi.spyOn(window, "open").mockImplementation(() => {
        if (popup === "throws") throw new Error("Synthetic popup policy");
        return null;
      });
      await ready();
      await userEvent.click(
        screen.getByRole("button", { name: "テストガイド原本" }),
      );
      await waitFor(() =>
        expect(documentNavigation.assign).toHaveBeenCalledWith(signedGuide),
      );
      expect(open).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/documents/guide/url"),
        ),
      ).toBe(true);
    },
  );
  it.each([503, new Error("検証用通信エラー")])(
    "reports failed signing and enables an actual retry (%s)",
    async (failure) => {
      window.history.replaceState(null, "", "/documents/");
      failures.set("/api/documents/guide/url", failure);
      await ready();
      const button = screen.getByRole("button", { name: "テストガイド原本" });
      await userEvent.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "資料を開けませんでした",
      );
      expect(documentNavigation.assign).not.toHaveBeenCalled();
      expect(button).toBeEnabled();
      failures.delete("/api/documents/guide/url");
      await userEvent.click(button);
      await waitFor(() =>
        expect(documentNavigation.assign).toHaveBeenCalledWith(signedGuide),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it("recovers if the browser rejects navigation after signing", async () => {
    window.history.replaceState(null, "", "/documents/");
    documentNavigation.assign.mockImplementationOnce(() => {
      throw new Error("Synthetic navigation policy");
    });
    await ready();
    const button = screen.getByRole("button", { name: "テストガイド原本" });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "資料を開けませんでした",
    );
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() =>
      expect(documentNavigation.assign).toHaveBeenCalledTimes(2),
    );
    expect(documentNavigation.assign).toHaveBeenLastCalledWith(signedGuide);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("disables all document controls and deduplicates signing until the current request settles", async () => {
    window.history.replaceState(null, "", "/documents/");
    dataset.documents.push({
      ...dataset.documents.find((item) => item.id === "guide")!,
      id: "second-guide",
      title: "検証用の別資料",
    });
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(async (input, init) =>
      new URL(String(input)).pathname === "/api/documents/guide/url"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(input, init),
    );
    await ready();
    const first = screen.getByRole("button", { name: "テストガイド原本" });
    const second = screen.getByRole("button", { name: "検証用の別資料" });
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        /\/api\/documents\/[^/]+\/url$/.test(new URL(String(url)).pathname),
      ),
    ).toHaveLength(1);
    expect(documentNavigation.assign).not.toHaveBeenCalled();
    await act(async () =>
      finish(json({ url: signedGuide, expires_at: "2030-01-01T00:05:00Z" })),
    );
    expect(documentNavigation.assign).toHaveBeenCalledOnce();
    expect(first).toBeEnabled();
    expect(second).toBeEnabled();
  });
  it("aborts signing on logout and never navigates to a late signed URL", async () => {
    window.history.replaceState(null, "", "/documents/");
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname !== "/api/documents/guide/url")
        return original(input, init);
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "テストガイド原本" }));
    await accountAction("ログアウト");
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(requestSignal?.aborted).toBe(true);
    await act(async () =>
      finish(json({ url: signedGuide, expires_at: "2030-01-01T00:05:00Z" })),
    );
    expect(documentNavigation.assign).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Tasklyでログイン" }),
    ).toBeInTheDocument();
  });
  it("clears private information if signed URL issuance discovers an expired login", async () => {
    window.history.replaceState(null, "", "/documents/");
    failures.set("/api/documents/guide/url", 401);
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "テストガイド原本" }),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(documentNavigation.assign).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "配布資料の案内" }),
    ).not.toBeInTheDocument();
  });
  it("shows an empty guide page without inventing documents or notices", async () => {
    window.history.replaceState(null, "", "/documents/");
    dataset.documents = [];
    dataset.notice_sections = [];
    dataset.notices = [];
    await ready();
    expect(
      screen.getByRole("heading", { name: "配布資料の案内はありません" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "PDF資料" }),
    ).not.toBeInTheDocument();
  });
});

describe("company filtering and persistent bookmarks", () => {
  it("selects multiple industries with OR semantics and keeps choices reproducible", async () => {
    window.history.replaceState(null, "", "/search/");
    await ready();
    const industries = await expandIndustries();
    await userEvent.click(
      within(industries).getByRole("button", { name: "ソフトウェア" }),
    );
    await userEvent.click(
      within(industries).getByRole("button", { name: "機械" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: dataset.companies[1].name }),
    ).toBeInTheDocument();
    expect(locationURL().searchParams.getAll("industry")).toEqual([
      "ソフトウェア",
      "機械",
    ]);
    await userEvent.click(
      within(industries).getByRole("button", { name: "ソフトウェア" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(locationURL().searchParams.getAll("industry")).toEqual(["機械"]);
    popTo("/search/?industry=通信&industry=研究");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(
      within(industries).getByRole("button", { name: "通信" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(industries).getByRole("button", { name: "機械" }),
    ).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByRole("button", { name: "業種を解除" }));
    expect(locationURL().searchParams.getAll("industry")).toEqual([]);
    expect(screen.getAllByRole("article")).toHaveLength(
      dataset.companies.length,
    );
  });

  it("restores shared search filters, handles NFKC search and resets empty results", async () => {
    window.history.replaceState(null, "", "/search/?q=２&session=AM");
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: dataset.companies[1].name }),
    ).toBeInTheDocument();
    const search = screen.getByRole("searchbox");
    await userEvent.clear(search);
    await userEvent.type(search, "あおば");
    expect(locationURL().searchParams.get("q")).toBe("あおば");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.click(screen.getByRole("radio", { name: /^午後の部$/ }));
    expect(locationURL().searchParams.get("session")).toBe("PM");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    await userEvent.click(
      within(await expandIndustries()).getByRole("button", { name: "機械" }),
    );
    expect(
      screen.getByRole("heading", { name: "条件に合う企業が見つかりません" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "条件をリセット" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(locationURL().searchParams.getAll("industry")).toEqual([]);
    expect(
      within(await expandIndustries()).getByRole("button", { name: "機械" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(locationURL().searchParams.has("q")).toBe(false);
  });
  it("supports native Spindle keyboard session radios and reversible interest buttons", async () => {
    window.history.replaceState(null, "", "/search/");
    await ready();
    const all = screen.getByRole("radio", { name: /^すべて$/ });
    const morning = screen.getByRole("radio", { name: /^午前の部$/ });
    all.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(morning).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(morning).toBeChecked();
    const interest = within(card(dataset.companies[0].name)).getByRole(
      "button",
      { name: /気になるに追加/ },
    );
    interest.focus();
    await userEvent.keyboard(" ");
    await waitFor(() =>
      expect(interest).toHaveAttribute("aria-pressed", "true"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/bookmarks/AM-1"),
      expect.objectContaining({ method: "PUT" }),
    );
  });
  it("handles long industry labels without invalid nested labels", async () => {
    const longIndustry =
      "検証用の非常に長い産業分類・研究開発・環境設備・製造サービス".repeat(4);
    dataset.companies[0].industries.push(longIndustry);
    window.history.replaceState(null, "", "/search/");
    await ready();
    expect(document.querySelector("label label")).toBeNull();
    const industry = within(await expandIndustries()).getByRole("button", {
      name: longIndustry,
    });
    await userEvent.click(industry);
    expect(industry).toHaveFocus();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
  });
  it("marks assigned companies from Ec4 preferences", async () => {
    await ready();
    expect(
      within(card(dataset.companies[0].name)).getByText("指定"),
    ).toBeInTheDocument();
    popTo("/schedule/");
    expect(
      screen.getByRole("heading", { name: "スケジュール" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "スケジュールの学年" }),
    ).not.toBeInTheDocument();
  });
  it("loads stored bookmarks, writes changes and shares saved-state routes", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/search/?saved=1");
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const onlySaved = screen.getByRole("checkbox", { name: /^気になるのみ$/ });
    expect(onlySaved).toBeChecked();
    await userEvent.click(onlySaved);
    const first = dataset.companies[0];
    await userEvent.click(
      within(card(first.name)).getByRole("button", {
        name: `${first.name}を気になるから解除`,
      }),
    );
    await waitFor(() => expect(saved.has("AM-1")).toBe(false));
    await userEvent.click(
      within(card(first.name)).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    );
    await waitFor(() => expect(saved.has("AM-1")).toBe(true));
    await userEvent.click(nav("気になる"));
    expect(screen.getAllByText(first.name).length).toBeGreaterThan(0);
  });
  it.each([
    ["dialog", "/?company=AM-1"],
    ["region", "/map/?company=AM-1&focus=AM-1&session=AM"],
  ] as const)(
    "groups the favorite with the company identity in its %s",
    async (role, path) => {
      window.history.replaceState(null, "", path);
      await ready();
      const company = dataset.companies[0];
      const details = await screen.findByRole(role, { name: company.name });
      const identity = within(details).getByRole("group", {
        name: company.name,
      });
      expect(
        within(identity).getByRole("heading", { name: company.name }),
      ).toBeInTheDocument();
      expect(
        within(identity).getByText(company.industries[0]),
      ).toBeInTheDocument();
      expect(
        within(identity).queryByText("ブース", { exact: true }),
      ).not.toBeInTheDocument();
      expect(
        within(details).getByText("ブース", { exact: true }),
      ).toBeInTheDocument();
      await userEvent.click(
        within(identity).getByRole("button", {
          name: `${company.name}を気になるに追加`,
        }),
      );
      await waitFor(() => expect(saved.has(company.id)).toBe(true));
      expect(
        within(identity).getByRole("button", {
          name: `${company.name}を気になるから解除`,
        }),
      ).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(
        within(identity).getByRole("button", {
          name: `${company.name}を気になるから解除`,
        }),
      );
      await waitFor(() => expect(saved.has(company.id)).toBe(false));
      expect(
        within(identity).getByRole("button", {
          name: `${company.name}を気になるに追加`,
        }),
      ).toHaveAttribute("aria-pressed", "false");
    },
  );

  it("saves from a linked detail and closes the modal using its close controls", async () => {
    await ready();
    const first = dataset.companies[0];
    await userEvent.click(companyLink(first.name));
    let dialog = screen.getByRole("dialog", { name: first.name });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    );
    await waitFor(() => expect(saved.has(first.id)).toBe(true));
    fireEvent(dialog, new Event("cancel", { bubbles: true }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await userEvent.click(companyLink(first.name));
    dialog = screen.getByRole("dialog", { name: first.name });
    fireEvent.click(dialog);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("keeps a failed favorite change visible inside the fullscreen map's company panel", async () => {
    window.history.replaceState(null, "", "/map/?company=AM-1&session=AM");
    await ready();
    const company = dataset.companies[0];
    const dialog = screen.getByRole("region", { name: company.name });
    failures.set("/api/bookmarks/AM-1", 503);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: `${company.name}を気になるに追加`,
      }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "情報を取得できませんでした",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      within(dialog).getByRole("button", {
        name: `${company.name}を気になるに追加`,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(saved.has(company.id)).toBe(false);
  });

  it("clears private content when a bookmark request discovers a revoked login", async () => {
    await ready();
    failures.set("/api/bookmarks/AM-1", 401);
    await userEvent.click(
      within(card(dataset.companies[0].name)).getByRole("button", {
        name: /気になるに追加/,
      }),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.getByRole("alert")).toHaveTextContent("ログインの有効期限");
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
  });
  it("does not send duplicate bookmark writes while a write is pending", async () => {
    await ready();
    const original = fetchMock.getMockImplementation()! as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    let finish!: () => void;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/bookmarks/AM-1"))
        return new Promise<Response>((resolve) => {
          finish = () => resolve(new Response(null, { status: 204 }));
        });
      return original(input, init);
    });
    const input = within(card(dataset.companies[0].name)).getByRole("button", {
      name: /気になるに追加/,
    });
    fireEvent.click(input);
    fireEvent.click(input);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/bookmarks/AM-1"),
      ),
    ).toHaveLength(1);
    await act(async () => finish());
    expect(input).toHaveAttribute("aria-pressed", "true");
  });
  it("reports failed writes without falsely checking the company", async () => {
    await ready();
    failures.set("/api/bookmarks/AM-1", 503);
    const first = dataset.companies[0];
    await userEvent.click(
      within(card(first.name)).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      within(card(first.name)).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });
});

describe("optimistic interest changes", () => {
  it("updates the card, navigation count and newly opened detail before the API replies", async () => {
    await ready();
    const first = dataset.companies[0];
    const writes = holdBookmarkWrites([first.id]);
    const button = within(card(first.name)).getByRole("button", {
      name: `${first.name}を気になるに追加`,
    });
    fireEvent.click(button);
    expect(saved.has(first.id)).toBe(false);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    expect(document.querySelector(".saved-count")).toHaveTextContent("1");
    await userEvent.click(companyLink(first.name));
    const dialog = await screen.findByRole("dialog", { name: first.name });
    const detailButton = within(dialog).getByRole("button", {
      name: `${first.name}を気になるから解除`,
    });
    expect(detailButton).toHaveAttribute("aria-pressed", "true");
    expect(detailButton).toHaveAttribute("aria-busy", "true");
    expect(detailButton).toBeDisabled();
    await userEvent.click(detailButton);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith(`/api/bookmarks/${first.id}`),
      ),
    ).toHaveLength(1);
    await act(async () => writes.finish(first.id));
    expect(detailButton).toBeEnabled();
    expect(detailButton).not.toHaveAttribute("aria-busy", "true");
    expect(saved.has(first.id)).toBe(true);
  });

  it("immediately unchecks a retained favorite and rolls it back on a failed response", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/favorites/");
    await ready();
    const first = dataset.companies[0];
    const originalCard = card(first.name);
    const writes = holdBookmarkWrites([first.id]);
    const button = within(originalCard).getByRole("button", {
      name: `${first.name}を気になるから解除`,
    });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toBeDisabled();
    expect(card(first.name)).toBe(originalCard);
    expect(document.querySelector(".saved-count")).toBeNull();
    expect(saved.has(first.id)).toBe(true);
    await act(async () => writes.finish(first.id, 503));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toBeEnabled();
    expect(card(first.name)).toBe(originalCard);
    expect(document.querySelector(".saved-count")).toHaveTextContent("1");
  });

  it("keeps concurrent company changes independent and removes only a failed new retained card", async () => {
    await ready();
    const [first, second] = dataset.companies;
    const writes = holdBookmarkWrites([first.id, second.id]);
    fireEvent.click(
      within(card(first.name)).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    );
    const secondButton = within(card(second.name)).getByRole("button", {
      name: `${second.name}を気になるに追加`,
    });
    expect(secondButton).toBeEnabled();
    fireEvent.click(secondButton);
    expect(secondButton).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".saved-count")).toHaveTextContent("2");
    await userEvent.click(nav("気になる"));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    await act(async () => writes.finish(second.id));
    expect(
      within(card(second.name)).getByRole("button", {
        name: `${second.name}を気になるから解除`,
      }),
    ).toBeEnabled();
    await act(async () => writes.fail(first.id));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "検証用の通信エラー",
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(card(second.name)).toBeInTheDocument();
    expect(
      within(card(second.name)).getByRole("button", {
        name: `${second.name}を気になるから解除`,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".saved-count")).toHaveTextContent("1");
    expect(saved.has(first.id)).toBe(false);
    expect(saved.has(second.id)).toBe(true);
  });

  it("applies and rolls back the map's saved-only filter while its request is pending", async () => {
    window.history.replaceState(null, "", "/map/?company=AM-1&saved=1");
    await ready();
    const first = dataset.companies[0];
    const panel = await screen.findByRole("region", { name: first.name });
    const booth = await screen.findByRole("button", {
      name: `午前 ブース 1 ${first.name}`,
    });
    expect(booth).toBeDisabled();
    const writes = holdBookmarkWrites([first.id]);
    fireEvent.click(
      within(panel).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    );
    expect(booth).toBeEnabled();
    expect(booth).toHaveAttribute("data-saved", "true");
    expect(saved.has(first.id)).toBe(false);
    await act(async () => writes.finish(first.id, 503));
    expect(await within(panel).findByRole("alert")).toBeInTheDocument();
    expect(booth).toBeDisabled();
    expect(booth).not.toHaveAttribute("data-saved");
  });

  it("releases only the completed company's pending button when the map pane switches companies", async () => {
    window.history.replaceState(null, "", "/map/?company=AM-1&session=AM");
    await ready();
    const [first, second] = dataset.companies;
    const panel = await screen.findByRole("region", { name: first.name });
    const writes = holdBookmarkWrites([first.id, second.id]);
    fireEvent.click(
      within(panel).getByRole("button", {
        name: `${first.name}を気になるに追加`,
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: `午前 ブース 2 ${second.name}`,
      }),
    );
    const updated = screen.getByRole("region", { name: second.name });
    expect(updated).toBe(panel);
    const secondButton = within(updated).getByRole("button", {
      name: `${second.name}を気になるに追加`,
    });
    expect(secondButton).toBeEnabled();
    fireEvent.click(secondButton);
    expect(secondButton).toHaveAttribute("aria-pressed", "true");
    expect(secondButton).toBeDisabled();
    await act(async () => writes.finish(first.id));
    expect(secondButton).toBeDisabled();
    expect(secondButton).toHaveAttribute("aria-busy", "true");
    await act(async () => writes.finish(second.id, 503));
    expect(await within(updated).findByRole("alert")).toBeInTheDocument();
    expect(secondButton).toBeEnabled();
    expect(secondButton).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", {
        name: `午前 ブース 1 ${first.name}`,
      }),
    ).toHaveAttribute("data-saved", "true");
  });

  it.each([503, 401])(
    "ignores another late failure (%s) after a concurrent request expires the session",
    async (status) => {
      await ready();
      const [first, second] = dataset.companies;
      const writes = holdBookmarkWrites([first.id, second.id]);
      for (const company of [first, second])
        fireEvent.click(
          within(card(company.name)).getByRole("button", {
            name: `${company.name}を気になるに追加`,
          }),
        );
      await act(async () => writes.finish(second.id, 401));
      await screen.findByRole("button", { name: "Tasklyでログイン" });
      await act(async () => writes.finish(first.id, status));
      expect(screen.getByRole("alert")).toHaveTextContent("ログインの有効期限");
      expect(screen.getByRole("alert")).not.toHaveTextContent(
        "情報を取得できませんでした",
      );
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
    },
  );
});

describe("incremental catalog integration", () => {
  it("keeps the loaded favorite cards visible when one interest is removed", async () => {
    dataset = largeFixture();
    saved = new Set(dataset.companies.map((company) => company.id));
    window.history.replaceState(null, "", "/favorites/");
    vi.stubGlobal("IntersectionObserver", undefined);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(screen.getAllByRole("article")).toHaveLength(48);
    const name = dataset.companies[0].name;
    await userEvent.click(
      within(card(name)).getByRole("button", {
        name: `${name}を気になるから解除`,
      }),
    );
    await waitFor(() => expect(saved.has(dataset.companies[0].id)).toBe(false));
    expect(screen.getAllByRole("article")).toHaveLength(48);
    expect(screen.getByRole("status")).toHaveTextContent("48 / 125社");
    expect(
      within(card(name)).getByRole("button", {
        name: `${name}を気になるに追加`,
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("preserves revealed cards around details and starts a fresh page for new search or industry conditions", async () => {
    dataset = largeFixture();
    vi.stubGlobal("IntersectionObserver", undefined);
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(24);
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(screen.getAllByRole("article")).toHaveLength(48);
    await userEvent.click(companyLink(dataset.companies[0].name));
    const dialog = screen.getByRole("dialog", {
      name: dataset.companies[0].name,
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "閉じる" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(48);
    await userEvent.click(nav("ホーム"));
    await userEvent.click(nav("探す"));
    expect(screen.getAllByRole("article")).toHaveLength(24);
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(screen.getAllByRole("article")).toHaveLength(48);
    const search = screen.getByRole("searchbox");
    await userEvent.type(search, "検証企業 0001");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.clear(search);
    expect(screen.getAllByRole("article")).toHaveLength(24);
    const group = await expandIndustries();
    await userEvent.click(within(group).getByRole("button", { name: "機械" }));
    expect(screen.getAllByRole("article")).toHaveLength(24);
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(screen.getAllByRole("article")).toHaveLength(48);
    await userEvent.click(
      within(group).getByRole("button", { name: "ソフトウェア" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(24);
  });
});

describe("personal-plan sections", () => {
  it("keeps interest and assignment headings outside company cards at the same heading level", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/favorites/");
    await ready();
    const interests = screen.getByRole("heading", {
      name: "気になる 1",
      level: 2,
    });
    const assigned = screen.getByRole("heading", {
      name: "指定企業",
      level: 2,
    });
    expect(interests.closest("article")).toBeNull();
    expect(assigned.closest("article")).toBeNull();
    expect(
      interests.compareDocumentPosition(assigned) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const assignments = screen.getByRole("region", { name: "指定企業" });
    expect(assignments).not.toContainElement(assigned);
    expect(within(assignments).queryByRole("article")).not.toBeInTheDocument();
    expect(within(assignments).getAllByRole("link")).toHaveLength(
      dataset.assignments[0].visits.length,
    );
    expect(
      within(assignments)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(
      dataset.assignments[0].visits.map(
        (visit) =>
          dataset.companies.find((company) => company.id === visit.company_id)!
            .name,
      ),
    );
    expect(
      within(interests.closest("section")!).getAllByRole("article"),
    ).toHaveLength(1);
  });
});

describe("retained interest cards", () => {
  it("shows interests before assigned companies and keeps an unsaved card until actual reload", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/favorites/");
    const mounted = await ready();
    const company = dataset.companies[0];
    const originalCard = card(company.name);
    const assigned = screen.getByRole("heading", { name: "指定企業" });
    expect(
      originalCard.compareDocumentPosition(assigned) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await userEvent.click(
      within(originalCard).getByRole("button", {
        name: `${company.name}を気になるから解除`,
      }),
    );
    await waitFor(() => expect(saved.has(company.id)).toBe(false));
    expect(card(company.name)).toBe(originalCard);
    expect(
      within(originalCard).getByRole("button", {
        name: `${company.name}を気になるに追加`,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".saved-count")).toBeNull();
    await userEvent.click(nav("ホーム"));
    await userEvent.click(nav("気になる"));
    expect(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるに追加`,
      }),
    ).toHaveAttribute("aria-pressed", "false");
    mounted.unmount();
    await ready();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(saved.has(company.id)).toBe(false);
  });
  it("can undo an unsave and persists the restored interest across reload", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/favorites/");
    const mounted = await ready();
    const company = dataset.companies[0];
    await userEvent.click(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるから解除`,
      }),
    );
    await userEvent.click(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるに追加`,
      }),
    );
    await waitFor(() => expect(saved.has(company.id)).toBe(true));
    mounted.unmount();
    await ready();
    expect(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるから解除`,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });
  it("does not retain another account's unsaved cards after logout and a new identity loads", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/favorites/");
    const mounted = await ready();
    const company = dataset.companies[0];
    await userEvent.click(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるから解除`,
      }),
    );
    expect(card(company.name)).toBeInTheDocument();
    await accountAction("ログアウト");
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    userSub = "different-user";
    userName = "別の検証ユーザー";
    saved = new Set();
    mounted.unmount();
    await ready();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
  it("keeps a failed unsave selected instead of presenting it as removed", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/favorites/");
    await ready();
    const company = dataset.companies[0];
    failures.set("DELETE /api/bookmarks/AM-1", 503);
    await userEvent.click(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるから解除`,
      }),
    );
    await screen.findByRole("alert");
    expect(saved.has(company.id)).toBe(true);
    expect(
      within(card(company.name)).getByRole("button", {
        name: `${company.name}を気になるから解除`,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });
  it.each([204, 503, 401])(
    "ignores a late bookmark response (%s) after logout",
    async (status) => {
      await ready();
      const original = fetchMock.getMockImplementation()! as (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => Promise<Response>;
      let finish!: () => void;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input).endsWith("/api/bookmarks/AM-1"))
          return new Promise<Response>((resolve) => {
            finish = () => resolve(new Response(null, { status }));
          });
        return original(input, init);
      });
      fireEvent.click(
        within(card(dataset.companies[0].name)).getByRole("button", {
          name: /気になるに追加/,
        }),
      );
      await accountAction("ログアウト");
      await screen.findByRole("button", { name: "Tasklyでログイン" });
      await act(async () => finish());
      expect(
        screen.getByRole("button", { name: "Tasklyでログイン" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it("does not retain a favorite whose initial save failed", async () => {
    await ready();
    failures.set("PUT /api/bookmarks/AM-1", 503);
    await userEvent.click(
      within(card(dataset.companies[0].name)).getByRole("button", {
        name: /気になるに追加/,
      }),
    );
    await screen.findByRole("alert");
    await userEvent.click(nav("気になる"));
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "気になる 0" }),
    ).toBeInTheDocument();
  });
});
