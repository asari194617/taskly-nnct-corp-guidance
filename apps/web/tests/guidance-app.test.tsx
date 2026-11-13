import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuidanceApp from "../components/guidance-app";
import { fixture } from "./fixtures";
import type { Guidance } from "../lib/types";

let dataset: Guidance;
let saved: Set<string>;
let rosterNumber: number | null;
let userName: string;
let failures: Map<string, number | Error>;
let fetchMock: ReturnType<typeof vi.fn>;
const preferences = () => ({ roster_number: rosterNumber, department: "電子制御工学科", grade: 4 });
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
function card(name: string) {
  return screen.getByRole("heading", { name, level: 2 }).closest("article")!;
}
function nav(name: string) {
  return within(screen.getByRole("navigation", { name: "メインナビゲーション" })).getByRole("link", { name: new RegExp(name) });
}
function companyLink(name: string) {
  return within(card(name)).getByRole("link", { name });
}
async function ready() {
  render(<GuidanceApp />);
  await screen.findByRole("button", { name: "ログアウト" });
}
function locationURL() { return new URL(window.location.href); }
function popTo(path: string) {
  act(() => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  dataset = fixture();
  saved = new Set();
  rosterNumber = 7;
  userName = "テストユーザー";
  failures = new Map();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const failure = failures.get(`${init?.method || "GET"} ${path}`) ?? failures.get(path);
    if (failure instanceof Error) throw failure;
    if (failure) return new Response("", { status: failure });
    if (path === "/api/me") return json({ user: { sub: "test-user", email: "test@example.invalid", name: userName } });
    if (path === "/api/guidance") return json(dataset);
    if (path === "/api/preferences") {
      if (init?.method === "PUT") {
        const number = JSON.parse(String(init.body)).roster_number;
        if (!dataset.assignments.some((row) => row.department === "電子制御工学科" && row.grade === 4 && row.number === number)) return json({ error: "invalid_roster" }, 422);
        rosterNumber = number;
      }
      return json(preferences());
    }
    if (path === "/api/bookmarks") return json({ company_ids: [...saved] });
    if (path.startsWith("/api/bookmarks/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      if (init?.method === "DELETE") saved.delete(id); else saved.add(id);
      return new Response(null, { status: 204 });
    }
    if (path === "/auth/logout") return new Response(null, { status: 204 });
    if (/^\/api\/documents\/[^/]+\/url$/.test(path)) {
      const id = path.split("/")[3];
      return json({ url: `https://signed.example.test/documents/${id}?token=synthetic`, expires_at: "2030-01-01T00:05:00Z" });
    }
    throw new Error(`Unhandled request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("authentication and private content", () => {
  it("shows only Taskly sign-in and branding before authentication", async () => {
    failures.set("/api/me", 401);
    render(<GuidanceApp />);
    expect(screen.getByRole("status")).toHaveTextContent("ログイン状態を確認しています");
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    const brand = screen.getByRole("link", { name: "Taskly 企業ガイダンス ホーム" });
    expect(within(brand).getByRole("img", { name: "Taskly" })).toHaveAttribute("src", "/taskly-logo.svg");
    expect(within(brand).getByText("企業ガイダンス")).toBeInTheDocument();
    expect(screen.queryByText(dataset.companies[0].name)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries unavailable connections without exposing the dataset", async () => {
    failures.set("/api/me", new Error("offline"));
    render(<GuidanceApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent("接続できませんでした");
    failures.set("/api/me", 503);
    await userEvent.click(screen.getByRole("button", { name: "もう一度接続する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("情報を取得できませんでした");
    failures.clear();
    await userEvent.click(screen.getByRole("button", { name: "もう一度接続する" }));
    await screen.findByRole("heading", { name: dataset.companies[0].name });
  });
  it("fails closed if preferences cannot be loaded", async () => {
    failures.set("/api/preferences", 503);
    render(<GuidanceApp />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: dataset.companies[0].name })).not.toBeInTheDocument();
  });
  it("preserves the page on failed logout, then clears all private state on success", async () => {
    await ready();
    failures.set("/auth/logout", 503);
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ログアウトできませんでした");
    expect(screen.getByRole("heading", { name: dataset.companies[0].name })).toBeInTheDocument();
    failures.delete("/auth/logout");
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.queryByText(dataset.companies[0].name)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/auth/logout"), expect.objectContaining({ method: "POST", credentials: "include" }));
  });
  it("reports logout transport failures", async () => {
    await ready();
    failures.set("/auth/logout", new Error("通信エラー"));
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("通信エラー");
  });
  it("uses the account fallback label without requiring an event date", async () => {
    userName = "";
    dataset.event.date = "未定";
    await ready();
    expect(screen.getByText("Taskly ユーザー")).toBeInTheDocument();
    expect(screen.queryByText("未定")).not.toBeInTheDocument();
  });
});

describe("Ec4 first-visit preferences", () => {
  it("asks only for a roster number, saves it per account and personalizes the plan", async () => {
    rosterNumber = null;
    await ready();
    const dialog = await screen.findByRole("dialog", { name: "名簿番号の設定" });
    expect(within(dialog).getByText(/Ec4/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("spinbutton", { name: "名簿番号" }), "7");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "名簿番号の設定" })).not.toBeInTheDocument());
    expect(rosterNumber).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/preferences"), expect.objectContaining({ method: "PUT", body: JSON.stringify({ roster_number: 7 }) }));
    expect(screen.getByRole("button", { name: "名簿番号を変更" })).toHaveTextContent("7番");
    expect(locationURL().search).not.toMatch(/roster|number|名簿/);
    await userEvent.click(nav("自分の見学リスト"));
    expect(screen.getByRole("heading", { name: "指定企業" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /あおばテスト株式会社/ })).toBeInTheDocument();
  });
  it("allows postponing first setup and reopening it from the header", async () => {
    rosterNumber = null;
    await ready();
    let dialog = await screen.findByRole("dialog", { name: "名簿番号の設定" });
    await userEvent.click(within(dialog).getByRole("button", { name: "あとで" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: dataset.companies[0].name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "名簿番号を設定" }));
    dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    fireEvent(dialog, new Event("cancel", { bubbles: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
  it("does not ask again when the stored account preference is present", async () => {
    await ready();
    expect(screen.queryByRole("dialog", { name: "名簿番号の設定" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "名簿番号を変更" }));
    const dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    expect(within(dialog).getByRole("spinbutton", { name: "名簿番号" })).toHaveValue(7);
    await userEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps invalid numbers in the modal until a valid number is saved", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "名簿番号を変更" }));
    const dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    const number = within(dialog).getByRole("spinbutton", { name: "名簿番号" });
    await userEvent.clear(number);
    await userEvent.type(number, "99");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("名簿番号を確認してください");
    expect(rosterNumber).toBe(7);
    await userEvent.clear(number);
    await userEvent.type(number, "8");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(rosterNumber).toBe(8);
    expect(screen.getByRole("button", { name: "名簿番号を変更" })).toHaveTextContent("8番");
    await userEvent.click(nav("自分の見学リスト"));
    const assignments = screen.getByRole("heading", { name: "指定企業" }).closest("section")!;
    expect(within(assignments).getAllByRole("link")[0]).toHaveTextContent(dataset.companies[1].name);
  });
  it("offers number setup from an empty personal plan while browsing stays available", async () => {
    rosterNumber = null;
    await ready();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "あとで" }));
    await userEvent.click(nav("自分の見学リスト"));
    const assignments = screen.getByRole("heading", { name: "指定企業" }).closest("section")!;
    await userEvent.click(within(assignments).getByRole("button", { name: "名簿番号を設定" }));
    expect(screen.getByRole("dialog", { name: "名簿番号の設定" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "あとで" }));
    await userEvent.click(screen.getByRole("button", { name: "企業を探す" }));
    expect(screen.getByRole("heading", { name: "企業一覧" })).toBeInTheDocument();
  });
  it("reports when a saved number no longer has an assignment", async () => {
    dataset.assignments = [];
    window.history.replaceState(null, "", "/?view=plan");
    await ready();
    expect(screen.getByRole("status")).toHaveTextContent("指定企業が見つかりません");
    expect(screen.getByRole("heading", { name: "保存した企業はありません" })).toBeInTheDocument();
  });
  it("handles a save transport failure and does not discard the previous preference", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "名簿番号を変更" }));
    failures.set("PUT /api/preferences", new Error("設定を保存できません"));
    const dialog = screen.getByRole("dialog", { name: "名簿番号の設定" });
    await userEvent.click(within(dialog).getByRole("button", { name: "保存する" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("設定を保存できません");
    expect(rosterNumber).toBe(7);
  });
  it("returns to sign-in when the preference save discovers an expired session", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "名簿番号を変更" }));
    failures.set("PUT /api/preferences", 401);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存する" }));
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(dataset.companies[0].name)).not.toBeInTheDocument();
  });
});

describe("shareable routes and venue navigation", () => {
  it("places real navigation links in the header and mobile menu icons next to their labels", async () => {
    await ready();
    const desktop = screen.getByRole("navigation", { name: "メインナビゲーション" });
    expect(desktop.closest("header")).not.toBeNull();
    expect(nav("会場マップ")).toHaveAttribute("href", expect.stringContaining("view=map"));
    const mobile = screen.getByRole("navigation", { name: "モバイルナビゲーション" });
    for (const link of within(mobile).getAllByRole("link")) expect(link.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText(dataset.event.venue)).not.toBeInTheDocument();
    expect(screen.queryByText(dataset.event.title)).not.toBeInTheDocument();
    expect(screen.queryByText("掲載情報は配布資料をもとにしています。変更は学校からの案内をご確認ください。")).not.toBeInTheDocument();
  });
  it("shows the company list first and exposes search through a separate shareable page", async () => {
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "企業一覧" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(dataset.companies.length);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "参加時間帯" })).not.toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "企業一覧" }).parentElement!;
    const search = within(heading).getByRole("link", { name: "企業を探す" });
    expect(search).toHaveAttribute("href", "/?view=search");
    await userEvent.click(search);
    expect(locationURL().searchParams.get("view")).toBe("search");
    expect(screen.getByRole("heading", { level: 1, name: "企業を探す" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    await userEvent.click(nav("企業一覧"));
    expect(locationURL().searchParams.has("view")).toBe(false);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
  it("does not hide list entries behind filters that are only visible on the search page", async () => {
    window.history.replaceState(null, "", "/?view=search&q=存在しない検証会社&session=PM&saved=1");
    await ready();
    expect(screen.getByRole("heading", { name: "条件に合う企業が見つかりません" })).toBeInTheDocument();
    await userEvent.click(nav("企業一覧"));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(dataset.companies.length);
    expect(screen.getByRole("heading", { level: 1, name: "企業一覧" })).toBeInTheDocument();
  });
  it("opens a shared company detail after authentication without requiring prior navigation", async () => {
    window.history.replaceState(null, "", "/?view=companies&company=AM-1");
    await ready();
    expect(await screen.findByRole("dialog", { name: dataset.companies[0].name })).toBeInTheDocument();
    expect(locationURL().searchParams.get("company")).toBe("AM-1");
    await userEvent.click(screen.getByRole("button", { name: "詳細を閉じる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(locationURL().searchParams.has("company")).toBe(false);
  });
  it("normalizes the legacy index path while retaining view and fragment", async () => {
    window.history.replaceState(null, "", "/index.html?view=plan#saved");
    await ready();
    expect(locationURL().pathname).toBe("/");
    expect(locationURL().searchParams.get("view")).toBe("plan");
    expect(locationURL().hash).toBe("#saved");
    expect(screen.getByRole("heading", { name: "自分の見学リスト" })).toBeInTheDocument();
  });
  it("updates query routes and responds to browser back/forward state changes", async () => {
    await ready();
    await userEvent.click(nav("スケジュール"));
    expect(locationURL().searchParams.get("view")).toBe("schedule");
    expect(screen.getByRole("heading", { name: "スケジュール" })).toBeInTheDocument();
    popTo("/?view=plan");
    expect(screen.getByRole("heading", { name: "自分の見学リスト" })).toBeInTheDocument();
    popTo("/?view=companies&company=PM-1");
    expect(screen.getByRole("dialog", { name: dataset.companies[2].name })).toBeInTheDocument();
  });
  it("ignores unrecognized routes and missing companies instead of exposing a broken modal", async () => {
    window.history.replaceState(null, "", "/?view=unknown&company=not-present&session=invalid");
    await ready();
    expect(screen.getByRole("heading", { name: "企業一覧" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "企業一覧へ戻る" }));
    expect(locationURL().searchParams.has("company")).toBe(false);
  });
  it("restores the saved company link after returning from Taskly login", async () => {
    window.sessionStorage.setItem("guidance-return-route", "/index.html?view=map&company=PM-1&session=PM#booth");
    await ready();
    expect(locationURL().pathname).toBe("/");
    expect(locationURL().searchParams.get("view")).toBe("map");
    expect(locationURL().searchParams.get("company")).toBe("PM-1");
    expect(locationURL().hash).toBe("#booth");
    expect(screen.getByRole("dialog", { name: dataset.companies[2].name })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("guidance-return-route")).toBeNull();
  });
  it.each(["https://other.example.invalid/?view=map", "/unrelated?view=plan", "http://["])(
    "discards an unsafe or malformed saved login destination: %s", async (destination) => {
      window.sessionStorage.setItem("guidance-return-route", destination);
      await ready();
      expect(locationURL().pathname).toBe("/");
      expect(locationURL().search).toBe("");
      expect(screen.getByRole("heading", { name: "企業一覧" })).toBeInTheDocument();
    },
  );
  it("keeps a directly requested route ahead of an old saved login destination", async () => {
    window.history.replaceState(null, "", "/?view=schedule");
    window.sessionStorage.setItem("guidance-return-route", "/?view=plan");
    await ready();
    expect(locationURL().searchParams.get("view")).toBe("schedule");
    expect(screen.getByRole("heading", { name: "スケジュール" })).toBeInTheDocument();
  });
  it("does not intercept a link whose click was already handled", async () => {
    await ready();
    const link = nav("スケジュール");
    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await userEvent.click(link);
    expect(locationURL().searchParams.has("view")).toBe(false);
    expect(screen.getByRole("heading", { name: "企業一覧" })).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/?view=schedule");
  });
  it("keeps map filters, booth selection and session changes in shareable query routes", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/?view=map&saved=1");
    await ready();
    const first = await screen.findByRole("button", { name: "午前 ブース 1 あおばテスト株式会社" });
    const second = screen.getByRole("button", { name: "午前 ブース 2 いろはテスト製作所" });
    expect(first).toBeEnabled();
    expect(second).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^絞り込み/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "指定企業のみ" }));
    expect(locationURL().searchParams.get("assigned")).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "解除" }));
    expect(locationURL().searchParams.has("saved")).toBe(false);
    expect(locationURL().searchParams.has("assigned")).toBe(false);
    expect(second).toBeEnabled();
    await userEvent.click(second);
    expect(screen.getByRole("dialog", { name: dataset.companies[1].name })).toBeInTheDocument();
    expect(locationURL().searchParams.get("company")).toBe("AM-2");
    expect(locationURL().searchParams.get("focus")).toBe("AM-2");
    await userEvent.click(screen.getByRole("button", { name: "詳細を閉じる" }));
    await userEvent.click(screen.getByRole("radio", { name: "午後の部" }));
    expect(locationURL().searchParams.get("session")).toBe("PM");
    expect(locationURL().searchParams.has("focus")).toBe(false);
    expect(locationURL().searchParams.has("company")).toBe(false);
    expect(await screen.findByRole("button", { name: "午後 ブース 2 よつばテスト研究所" })).toBeEnabled();
  });
  it("clears stale filters when opening a chosen company on the map", async () => {
    window.history.replaceState(null, "", "/?q=一致しない企業&industry=存在しない業種&saved=1&assigned=1");
    await ready();
    const company = dataset.companies[0];
    await userEvent.click(companyLink(company.name));
    const link = within(screen.getByRole("dialog", { name: company.name })).getByRole("link", { name: "マップを確認" });
    const target = new URL(link.getAttribute("href")!, window.location.origin);
    for (const key of ["q", "industry", "saved", "assigned"]) expect(target.searchParams.has(key)).toBe(false);
    expect(target.searchParams.get("focus")).toBe(company.id);
    await userEvent.click(link);
    for (const key of ["q", "industry", "saved", "assigned"]) expect(locationURL().searchParams.has(key)).toBe(false);
    expect(locationURL().searchParams.get("focus")).toBe(company.id);
    expect(locationURL().searchParams.get("session")).toBe(company.session);
    expect(await screen.findByRole("button", { name: "午前 ブース 1 あおばテスト株式会社" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "午前 ブース 1 あおばテスト株式会社" })).toHaveAttribute("data-selected", "true");
  });
  it("keeps company and map focus reproducible through actual links", async () => {
    await ready();
    const first = dataset.companies[0];
    expect(companyLink(first.name)).toHaveAttribute("href", expect.stringContaining("company=AM-1"));
    await userEvent.click(companyLink(first.name));
    expect(locationURL().searchParams.get("company")).toBe("AM-1");
    const dialog = screen.getByRole("dialog", { name: first.name });
    await userEvent.click(within(dialog).getByRole("link", { name: "マップを確認" }));
    await screen.findByRole("heading", { name: "会場マップ" });
    expect(locationURL().searchParams.get("view")).toBe("map");
    expect(locationURL().searchParams.get("focus")).toBe("AM-1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("structured guide notices", () => {
  it("preserves section headings, paragraphs and lists inside the optional guide disclosure", async () => {
    dataset.notice_sections = [
      { id: "preparation", title: "検証用の準備", blocks: [
        { type: "paragraph", text: "持参品の確認 <script>" },
        { type: "list", items: ["検証ノート", "検証ペン"] },
      ] },
      { id: "movement", title: "検証用の移動", blocks: [{ type: "paragraph", text: "検証経路で移動する" }] },
    ];
    window.history.replaceState(null, "", "/?view=schedule");
    await ready();
    const disclosure = screen.getByText("配布資料の案内").closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("配布資料の案内"));
    expect(disclosure).toHaveAttribute("open");
    const first = within(disclosure).getByRole("heading", { name: "検証用の準備" }).closest("section")!;
    expect(within(first).getByText("持参品の確認 <script>")).toBeInTheDocument();
    expect(within(first).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["検証ノート", "検証ペン"]);
    expect(within(disclosure).getByRole("heading", { name: "検証用の移動" })).toBeInTheDocument();
    expect(within(disclosure).getByText("検証経路で移動する")).toBeInTheDocument();
    expect(within(disclosure).queryByText(dataset.notices[0])).not.toBeInTheDocument();
    expect(disclosure.querySelector("script")).toBeNull();
  });
  it("keeps older guide notices readable when no structured sections were supplied", async () => {
    dataset.notice_sections = [];
    window.history.replaceState(null, "", "/?view=schedule");
    await ready();
    const disclosure = screen.getByText("配布資料の案内").closest("details")!;
    await userEvent.click(screen.getByText("配布資料の案内"));
    expect(within(disclosure).getByText(dataset.notices[0])).toBeInTheDocument();
  });
});

describe("company filtering and persistent bookmarks", () => {
  it("restores shared search filters, handles NFKC search and resets empty results", async () => {
    window.history.replaceState(null, "", "/?view=search&q=２&session=AM");
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: dataset.companies[1].name })).toBeInTheDocument();
    const search = screen.getByRole("searchbox");
    await userEvent.clear(search);
    await userEvent.type(search, "あおば");
    expect(locationURL().searchParams.get("q")).toBe("あおば");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.clear(search);
    await userEvent.click(screen.getByRole("radio", { name: /^午後の部$/ }));
    expect(locationURL().searchParams.get("session")).toBe("PM");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "業種で絞り込む" }), "機械");
    expect(screen.getByRole("heading", { name: "条件に合う企業が見つかりません" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "条件をリセット" }));
    expect(screen.getAllByRole("article")).toHaveLength(4);
    const industry = screen.getByRole("combobox", { name: "業種で絞り込む" });
    expect(industry).toHaveValue("");
    expect(within(industry.closest("label")!).getByText("すべての業種", { selector: "span" })).toBeInTheDocument();
    expect(locationURL().searchParams.has("q")).toBe(false);
  });
  it("supports native Spindle keyboard session radios and interest checkboxes", async () => {
    window.history.replaceState(null, "", "/?view=search");
    await ready();
    const all = screen.getByRole("radio", { name: /^すべて$/ });
    const morning = screen.getByRole("radio", { name: /^午前の部$/ });
    all.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(morning).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(morning).toBeChecked();
    const interest = within(card(dataset.companies[0].name)).getByRole("checkbox", { name: /見学リストに保存/ });
    interest.focus();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(interest).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/bookmarks/AM-1"), expect.objectContaining({ method: "PUT" }));
  });
  it("handles long industry labels without invalid nested labels", async () => {
    const longIndustry = "検証用の非常に長い産業分類・研究開発・環境設備・製造サービス".repeat(4);
    dataset.companies[0].industries.push(longIndustry);
    window.history.replaceState(null, "", "/?view=search");
    await ready();
    expect(document.querySelector("label label")).toBeNull();
    const industry = screen.getByRole("combobox", { name: "業種で絞り込む" });
    await userEvent.selectOptions(industry, longIndustry);
    expect(industry).toHaveFocus();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: dataset.companies[0].name })).toBeInTheDocument();
  });
  it("marks assigned companies from Ec4 preferences", async () => {
    await ready();
    expect(within(card(dataset.companies[0].name)).getByText("指定")).toBeInTheDocument();
    popTo("/?view=schedule");
    expect(screen.getByRole("heading", { name: "スケジュール" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "スケジュールの学年" })).not.toBeInTheDocument();
  });
  it("loads stored bookmarks, writes changes and shares saved-state routes", async () => {
    saved.add("AM-1");
    window.history.replaceState(null, "", "/?view=search&saved=1");
    await ready();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    const onlySaved = screen.getByRole("checkbox", { name: /^保存した企業$/ });
    expect(onlySaved).toBeChecked();
    await userEvent.click(onlySaved);
    const first = dataset.companies[0];
    await userEvent.click(within(card(first.name)).getByRole("checkbox", { name: `${first.name}を見学リストから削除` }));
    await waitFor(() => expect(saved.has("AM-1")).toBe(false));
    await userEvent.click(within(card(first.name)).getByRole("checkbox", { name: `${first.name}を見学リストに保存` }));
    await waitFor(() => expect(saved.has("AM-1")).toBe(true));
    await userEvent.click(nav("自分の見学リスト"));
    expect(screen.getAllByText(first.name).length).toBeGreaterThan(0);
  });
  it("saves from a linked detail and closes the modal using its close controls", async () => {
    await ready();
    const first = dataset.companies[0];
    await userEvent.click(companyLink(first.name));
    let dialog = screen.getByRole("dialog", { name: first.name });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: `${first.name}を見学リストに保存` }));
    await waitFor(() => expect(saved.has(first.id)).toBe(true));
    fireEvent(dialog, new Event("cancel", { bubbles: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(companyLink(first.name));
    dialog = screen.getByRole("dialog", { name: first.name });
    fireEvent.click(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("clears private content when a bookmark request discovers a revoked login", async () => {
    await ready();
    failures.set("/api/bookmarks/AM-1", 401);
    await userEvent.click(within(card(dataset.companies[0].name)).getByRole("checkbox", { name: /見学リストに保存/ }));
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.getByRole("alert")).toHaveTextContent("ログインの有効期限");
    expect(screen.queryByText(dataset.companies[0].name)).not.toBeInTheDocument();
  });
  it("does not send duplicate bookmark writes while a write is pending", async () => {
    await ready();
    const original = fetchMock.getMockImplementation()! as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let finish!: () => void;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/bookmarks/AM-1")) return new Promise<Response>((resolve) => { finish = () => resolve(new Response(null, { status: 204 })); });
      return original(input, init);
    });
    const input = within(card(dataset.companies[0].name)).getByRole("checkbox", { name: /見学リストに保存/ });
    fireEvent.click(input);
    fireEvent.click(input);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/bookmarks/AM-1"))).toHaveLength(1);
    await act(async () => finish());
    expect(input).toBeChecked();
  });
  it("reports failed writes without falsely checking the company", async () => {
    await ready();
    failures.set("/api/bookmarks/AM-1", 503);
    const first = dataset.companies[0];
    await userEvent.click(within(card(first.name)).getByRole("checkbox", { name: `${first.name}を見学リストに保存` }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(within(card(first.name)).getByRole("checkbox", { name: `${first.name}を見学リストに保存` })).not.toBeChecked();
  });
});
