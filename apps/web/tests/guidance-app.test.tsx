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
import { fixture } from "./fixtures";
import type { Guidance } from "../lib/types";

let dataset: Guidance;
let saved: Set<string>;
let failures: Map<string, number | Error>;
let fetchMock: ReturnType<typeof vi.fn>;
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
  ).getByRole("button", { name: new RegExp(name) });
}
async function ready() {
  render(<GuidanceApp />);
  await screen.findByRole("heading", { name: "企業を探す" });
}
beforeEach(() => {
  dataset = fixture();
  saved = new Set();
  failures = new Map();
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const failure = failures.get(path);
    if (failure instanceof Error) throw failure;
    if (failure) return new Response("", { status: failure });
    if (path === "/api/me")
      return json({
        user: {
          sub: "test-user",
          email: "test@example.invalid",
          name: "テストユーザー",
        },
      });
    if (path === "/api/guidance") return json(dataset);
    if (path === "/api/bookmarks") return json({ company_ids: [...saved] });
    if (path.startsWith("/api/bookmarks/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      if (init?.method === "DELETE") saved.delete(id);
      else saved.add(id);
      return new Response(null, { status: 204 });
    }
    if (path === "/auth/logout") return new Response(null, { status: 204 });
    if (path.startsWith("/api/documents/"))
      return new Response("synthetic-file", {
        headers: {
          "Content-Type": path.endsWith("guide")
            ? "application/pdf"
            : "image/png",
        },
      });
    throw new Error(`Unhandled request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("authentication and failure handling", () => {
  it("shows only the sign-in shell when unauthenticated", async () => {
    failures.set("/api/me", 401);
    render(<GuidanceApp />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "ログイン状態を確認しています",
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries network and server failures without showing private content", async () => {
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
  it("clears the dataset after logout and preserves it on a failed logout", async () => {
    await ready();
    failures.set("/auth/logout", 503);
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ログアウトできませんでした",
    );
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    failures.delete("/auth/logout");
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/logout"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
  it("handles a transport error when logging out", async () => {
    await ready();
    failures.set("/auth/logout", new Error("通信エラー"));
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("通信エラー");
  });
});

describe("company discovery and persistent bookmarks", () => {
  it("filters by normalized search, session, industry, and resets empty results", async () => {
    await ready();
    const search = screen.getByRole("searchbox");
    await userEvent.type(search, "あおば");
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: dataset.companies[1].name }),
    ).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, "２");
    expect(
      screen.getByRole("heading", { name: dataset.companies[1].name }),
    ).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.click(screen.getByRole("radio", { name: /^午後の部$/ }));
    expect(
      screen.getByRole("heading", { name: dataset.companies[2].name }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: dataset.companies[0].name }),
    ).not.toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "業種で絞り込む" }),
      "機械",
    );
    expect(
      screen.getByRole("heading", { name: "条件に合う企業が見つかりません" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "条件をリセット" }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(3);
    const resetIndustry = screen.getByRole("combobox", {
      name: "業種で絞り込む",
    });
    expect(resetIndustry).toHaveValue("");
    expect(
      within(resetIndustry.closest("label")!).getByText("すべての業種", {
        selector: "span",
      }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /^午前の部$/ }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    await userEvent.click(screen.getByRole("radio", { name: /^すべて$/ }));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "業種で絞り込む" }),
      "建設",
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });
  it("supports keyboard-operated native Spindle session radios and interest checkboxes", async () => {
    await ready();
    const all = screen.getByRole("radio", { name: /^すべて$/ });
    const morning = screen.getByRole("radio", { name: /^午前の部$/ });
    expect(all).toBeChecked();
    all.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(morning).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(morning).toBeChecked();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    const interest = within(card(dataset.companies[0].name)).getByRole(
      "checkbox",
      { name: /見学リストに保存/ },
    );
    interest.focus();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(interest).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/bookmarks/AM-1"),
      expect.objectContaining({ method: "PUT" }),
    );
  });
  it("handles long industry and department labels without nested label elements", async () => {
    const longIndustry =
      "検証用の非常に長い産業分類・研究開発・ソフトウェア・環境設備・製造サービス".repeat(
        4,
      );
    const longDepartment =
      "検証用の非常に長い学科名称・複合技術システム工学科".repeat(4);
    dataset.companies[0].industries.push(longIndustry);
    dataset.assignments[0].department = longDepartment;
    await ready();
    const industry = screen.getByRole("combobox", { name: "業種で絞り込む" });
    expect(document.querySelector("label label")).toBeNull();
    expect(industry).toHaveStyle({
      width: "100%",
      maxWidth: "100%",
      minWidth: "0",
    });
    await userEvent.selectOptions(industry, longIndustry);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    await userEvent.click(nav("自分の見学リスト"));
    const department = screen.getByRole("combobox", { name: /^学科$/ });
    expect(document.querySelector("label label")).toBeNull();
    expect(department).toHaveStyle({
      width: "100%",
      maxWidth: "100%",
      minWidth: "0",
    });
    await userEvent.selectOptions(department, longDepartment);
    await userEvent.type(screen.getByRole("spinbutton"), "7");
    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    expect(
      screen.getByRole("button", { name: /ターム 1.*あおばテスト株式会社/ }),
    ).toBeInTheDocument();
    await userEvent.click(nav("スケジュール"));
    expect(document.querySelector("label label")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "スケジュールの学年" }),
    ).toHaveStyle({ width: "100%", maxWidth: "100%", minWidth: "0" });
  });
  it("loads saved company IDs and persists adding/removing bookmarks", async () => {
    saved.add("AM-1");
    await ready();
    const first = dataset.companies[0];
    await waitFor(() =>
      expect(
        within(card(first.name)).getByRole("checkbox", {
          name: `${first.name}を見学リストから削除`,
        }),
      ).toBeChecked(),
    );
    await userEvent.click(
      screen.getByRole("checkbox", { name: /^保存した企業$/ }),
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("checkbox", { name: /^保存した企業$/ }),
    );
    await userEvent.click(
      within(card(first.name)).getByRole("checkbox", {
        name: `${first.name}を見学リストから削除`,
      }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/bookmarks/AM-1"),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    await userEvent.click(
      within(card(first.name)).getByRole("checkbox", {
        name: `${first.name}を見学リストに保存`,
      }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/bookmarks/AM-1"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await userEvent.click(nav("自分の見学リスト"));
    expect(
      screen.getByRole("heading", { name: first.name }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(card(first.name)).getByRole("checkbox", {
        name: `${first.name}を見学リストから削除`,
      }),
    );
    await screen.findByRole("heading", {
      name: "気になる企業を保存しましょう",
    });
    await userEvent.click(
      within(screen.getByRole("main")).getByRole("button", {
        name: "企業を探す",
      }),
    );
    await screen.findByRole("heading", {
      name: "企業を探す",
    });
  });
  it("opens an accessible company detail, saves from it, closes and navigates to its map", async () => {
    await ready();
    const first = dataset.companies[0];
    await userEvent.click(
      within(card(first.name)).getByRole("button", { name: first.name }),
    );
    let dialog = screen.getByRole("dialog", { name: first.name });
    expect(within(dialog).getByText("会場ブース番号")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: `${first.name}を見学リストに保存`,
      }),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("checkbox", {
          name: `${first.name}を見学リストから削除`,
        }),
      ).toBeChecked(),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "詳細を閉じる" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(
      within(card(first.name)).getByRole("button", { name: first.name }),
    );
    dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { bubbles: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(
      within(card(first.name)).getByRole("button", { name: first.name }),
    );
    dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(
      within(card(first.name)).getByRole("button", { name: first.name }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "マップを確認",
      }),
    );
    await screen.findByRole("heading", { name: "会場マップ" });
    await screen.findByRole("img", { name: "テスト会場配置" });
  });
  it("hides company detail when the page becomes hidden", async () => {
    await ready();
    await userEvent.click(
      within(card(dataset.companies[0].name)).getByRole("button", {
        name: dataset.companies[0].name,
      }),
    );
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("clears private content when a bookmark request finds an expired session", async () => {
    saved.add("PM-1");
    await ready();
    failures.set("/api/bookmarks/AM-1", 401);
    await userEvent.click(
      within(card(dataset.companies[0].name)).getByRole("checkbox", {
        name: /見学リストに保存/,
      }),
    );
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.getByRole("alert")).toHaveTextContent("ログインの有効期限");
    expect(
      screen.queryByText(dataset.companies[0].name),
    ).not.toBeInTheDocument();
  });
  it("does not duplicate a bookmark write while one is pending", async () => {
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
    const button = within(card(dataset.companies[0].name)).getByRole(
      "checkbox",
      {
        name: /見学リストに保存/,
      },
    );
    fireEvent.click(button);
    fireEvent.click(button);
    expect(
      fetchMock.mock.calls.filter((args) =>
        String(args[0]).endsWith("/api/bookmarks/AM-1"),
      ),
    ).toHaveLength(1);
    await act(async () => finish());
    expect(button).toBeChecked();
  });
  it("reports a failed bookmark without pretending it was saved", async () => {
    await ready();
    const first = dataset.companies[0];
    failures.set("/api/bookmarks/AM-1", 503);
    await userEvent.click(
      within(card(first.name)).getByRole("checkbox", {
        name: `${first.name}を見学リストに保存`,
      }),
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      within(card(first.name)).getByRole("checkbox", {
        name: `${first.name}を見学リストに保存`,
      }),
    ).not.toBeChecked();
  });
});

describe("schedules and assigned visits", () => {
  it("switches required visit markers for each grade", async () => {
    await ready();
    await userEvent.click(nav("スケジュール"));
    expect(screen.getAllByText("検証用のお知らせ").length).toBeGreaterThan(0);
    const grade = screen.getByRole("combobox", { name: "スケジュールの学年" });
    expect(screen.getAllByText("指定企業")).toHaveLength(1);
    await userEvent.selectOptions(grade, "3");
    expect(screen.getAllByText("指定企業")).toHaveLength(2);
    await userEvent.selectOptions(grade, "5");
    expect(screen.queryByText("指定企業")).not.toBeInTheDocument();
    expect(screen.getAllByText("自由見学")).toHaveLength(2);
    expect(screen.getAllByText("09:10").length).toBeGreaterThan(0);
  });
  it("looks up assignments, shows a missing entry, and opens the assigned company", async () => {
    await ready();
    await userEvent.click(nav("自分の見学リスト"));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /^学科$/ }),
      "テスト工学科",
    );
    const number = screen.getByRole("spinbutton");
    await userEvent.type(number, "7");
    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    expect(screen.getByText("テスト工学科 · 4年 · 7番")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /資料で確認してください/ }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: /ターム 1.*あおばテスト株式会社/ }),
    );
    expect(
      screen.getByRole("dialog", { name: dataset.companies[0].name }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "詳細を閉じる" }));
    await userEvent.clear(number);
    await userEvent.type(number, "99");
    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "指定企業の登録が見つかりません",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /^学年$/ }),
      "3",
    );
    await userEvent.clear(number);
    await userEvent.type(number, "8");
    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    expect(
      screen.getByRole("button", { name: /いろはテスト製作所/ }),
    ).toBeInTheDocument();
  });
});

describe("protected maps and documents", () => {
  it("opens map from banner, zooms, changes floor, and opens the PDF as an authenticated blob", async () => {
    const tab = {
      opener: {},
      location: { href: "about:blank" },
      close: vi.fn(),
    };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "会場マップを見る" }),
    );
    const image = await screen.findByRole("img", { name: "テスト会場配置" });
    await userEvent.click(screen.getByRole("button", { name: "マップを拡大" }));
    expect(image).toHaveStyle({ width: "125%" });
    await userEvent.click(screen.getByRole("button", { name: "マップを縮小" }));
    expect(image).toHaveStyle({ width: "100%" });
    await userEvent.click(screen.getByRole("button", { name: "マップを縮小" }));
    await userEvent.click(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    );
    expect(image).toHaveStyle({ width: "100%" });
    await userEvent.click(screen.getByRole("button", { name: "テスト休憩室" }));
    await screen.findByRole("img", { name: "テスト休憩室" });
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: /テストガイド原本/ }),
    );
    await waitFor(() => expect(tab.location.href).toBe("blob:test-document"));
    expect(tab.opener).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/documents/guide"),
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });
  it("retries a failed map and reports PDF failures or popup blocking", async () => {
    failures.set("/api/documents/floor-a", 500);
    await ready();
    await userEvent.click(nav("会場マップ"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "資料を開けませんでした",
    );
    failures.clear();
    await userEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await screen.findByRole("img", { name: "テスト会場配置" });
    vi.spyOn(window, "open").mockReturnValue(null);
    await userEvent.click(
      screen.getByRole("button", { name: /テストガイド原本/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ポップアップを許可",
    );
    const close = vi.fn();
    vi.mocked(window.open).mockReturnValue({
      opener: {},
      location: { href: "" },
      close,
    } as unknown as Window);
    failures.set("/api/documents/guide", 401);
    await userEvent.click(
      screen.getByRole("button", { name: /テストガイド原本/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ログインの有効期限",
    );
    expect(close).toHaveBeenCalled();
  });
  it("clears protected maps when their session expires", async () => {
    failures.set("/api/documents/floor-a", 401);
    await ready();
    await userEvent.click(nav("会場マップ"));
    await screen.findByRole("button", { name: "Tasklyでログイン" });
    expect(screen.getByRole("alert")).toHaveTextContent("ログインの有効期限");
    expect(
      screen.queryByRole("img", { name: "テスト会場配置" }),
    ).not.toBeInTheDocument();
  });
  it("shows an empty map state and document page metadata", async () => {
    dataset.documents = [{ ...dataset.documents[2], source_page: 6 }];
    await ready();
    await userEvent.click(nav("会場マップ"));
    expect(
      screen.getByRole("heading", { name: "マップを準備しています" }),
    ).toBeInTheDocument();
    expect(screen.getByText("配布ガイドブック · 6 ページ")).toBeInTheDocument();
    await userEvent.click(
      within(
        screen.getByRole("navigation", { name: "モバイルナビゲーション" }),
      ).getByRole("tab", { name: /^企業$/ }),
    );
    await screen.findByRole("heading", {
      name: "企業を探す",
    });
  });
  it("supports missing dates and unnamed accounts without throwing", async () => {
    dataset.event.date = "未定";
    fetchMock.mockImplementationOnce(async () =>
      json({ user: { sub: "test", email: "test@example.invalid", name: "" } }),
    );
    await ready();
    expect(screen.getByText("Taskly ユーザー")).toBeInTheDocument();
    expect(screen.getAllByText("未定")).toHaveLength(2);
  });
});
