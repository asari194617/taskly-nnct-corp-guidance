import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GuidanceApp from "../components/guidance-app";
import { fixture } from "./fixtures";

const data = fixture();
function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
  vi.setSystemTime(new Date("2030-05-14T09:01:00+09:00"));
  window.history.replaceState(null, "", "/search/");
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/me")
        return json({
          user: {
            sub: "live-test",
            email: "live@example.invalid",
            name: "時刻テスト",
          },
        });
      if (path === "/api/guidance") return json(data);
      if (path === "/api/bookmarks") return json({ company_ids: [] });
      if (path === "/api/preferences")
        return json({
          roster_number: 7,
          department: "電子制御工学科",
          grade: 4,
        });
      if (path.endsWith("/url"))
        return json({
          url: "https://synthetic.example.invalid/map.png",
          expires_at: "2030-05-14T23:59:59+09:00",
        });
      throw Error(`Unhandled synthetic request ${path}`);
    }),
  );
});
async function ready() {
  let mounted!: ReturnType<typeof render>;
  await act(async () => {
    mounted = render(<GuidanceApp />);
  });
  expect(
    screen.getByRole("button", { name: "ユーザーメニュー" }),
  ).toBeInTheDocument();
  return mounted;
}
function nav(name: string) {
  return within(
    screen.getByRole("navigation", { name: "メインナビゲーション" }),
  ).getByRole("link", { name });
}
async function refreshAt(instant: string, event = "visibilitychange") {
  await act(async () => {
    vi.setSystemTime(new Date(instant));
    (event === "visibilitychange" ? document : window).dispatchEvent(
      new Event(event),
    );
  });
}
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("live event-day guidance", () => {
  it.each([
    ["2030-05-13T09:01:00+09:00", "すべて", 4],
    ["2030-05-14T09:01:00+09:00", "午前の部", 2],
    ["2030-05-14T11:59:59+09:00", "午前の部", 2],
    ["2030-05-14T12:00:00+09:00", "午後の部", 2],
    ["2030-05-14T13:01:00+09:00", "午後の部", 2],
    ["2030-05-15T09:01:00+09:00", "すべて", 4],
  ] as const)(
    "defaults the search at %s to %s",
    async (instant, label, count) => {
      vi.setSystemTime(new Date(instant));
      await ready();
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
      expect(screen.getAllByRole("article")).toHaveLength(count);
      expect(new URL(window.location.href).searchParams.has("session")).toBe(
        false,
      );
    },
  );
  it("updates an automatic search at noon without appending history or a session query", async () => {
    vi.setSystemTime(new Date("2030-05-14T11:59:59+09:00"));
    await ready();
    const historyLength = window.history.length;
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("radio", { name: "午後の部" })).toBeChecked();
    expect(
      screen.getByRole("heading", { name: data.companies[2].name }),
    ).toBeInTheDocument();
    expect(window.history.length).toBe(historyLength);
    expect(window.location.search).toBe("");
  });
  it.each(["AM", "PM", "all"] as const)(
    "honors an explicit %s URL across clock changes and navigation",
    async (session) => {
      window.history.replaceState(null, "", `/search/?session=${session}`);
      await ready();
      const label =
        session === "AM"
          ? "午前の部"
          : session === "PM"
            ? "午後の部"
            : "すべて";
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
      await refreshAt("2030-05-14T13:01:00+09:00");
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
      await click(nav("スケジュール"));
      await click(
        within(screen.getByRole("banner")).getByRole("link", {
          name: "配布資料の案内",
        }),
      );
      await click(nav("探す"));
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
      expect(new URL(window.location.href).searchParams.get("session")).toBe(
        session,
      );
    },
  );
  it("keeps a manual all selection after noon, reload, and browser history restoration", async () => {
    const mounted = await ready();
    await click(screen.getByRole("radio", { name: "すべて" }));
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(new URL(window.location.href).searchParams.get("session")).toBe(
      "all",
    );
    await refreshAt("2030-05-14T13:01:00+09:00", "focus");
    expect(screen.getByRole("radio", { name: "すべて" })).toBeChecked();
    await act(async () => {
      window.history.replaceState(null, "", "/search/?session=AM");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("radio", { name: "午前の部" })).toBeChecked();
    await act(async () => {
      window.history.replaceState(null, "", "/search/?session=all");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    mounted.unmount();
    await ready();
    expect(screen.getByRole("radio", { name: "すべて" })).toBeChecked();
  });
  it("chooses the automatic map session while keeping explicit morning links authoritative", async () => {
    vi.setSystemTime(new Date("2030-05-14T13:01:00+09:00"));
    window.history.replaceState(null, "", "/map/");
    const mounted = await ready();
    expect(screen.getByRole("radio", { name: "午後の部" })).toBeChecked();
    expect(
      screen.getByRole("button", {
        name: `午後 ブース 1 ${data.companies[2].name}`,
      }),
    ).toBeInTheDocument();
    mounted.unmount();
    window.history.replaceState(null, "", "/map/?session=AM&focus=AM-1");
    await ready();
    expect(screen.getByRole("radio", { name: "午前の部" })).toBeChecked();
    expect(
      screen.getByRole("button", {
        name: `午前 ブース 1 ${data.companies[0].name}`,
      }),
    ).toHaveAttribute("data-selected", "true");
  });
  it.each([
    [
      "2030-05-14T13:01:00+09:00",
      "/map/?company=AM-1&focus=AM-1",
      "午前の部",
      0,
      true,
    ],
    ["2030-05-14T09:01:00+09:00", "/map/?focus=PM-1", "午後の部", 2, false],
  ] as const)(
    "keeps a shared map target visible at %s despite an opposite automatic default",
    async (instant, path, label, index, hasPanel) => {
      vi.setSystemTime(new Date(instant));
      window.history.replaceState(null, "", path);
      await ready();
      expect(screen.getByRole("radio", { name: label })).toBeChecked();
      const prefix = index === 0 ? "午前" : "午後";
      expect(
        screen.getByRole("button", {
          name: `${prefix} ブース 1 ${data.companies[index].name}`,
        }),
      ).toHaveAttribute("data-selected", "true");
      if (hasPanel)
        expect(
          screen.getByRole("region", { name: data.companies[index].name }),
        ).toBeInTheDocument();
      else
        expect(
          screen.queryByRole("region", { name: data.companies[index].name }),
        ).not.toBeInTheDocument();
      expect(new URL(window.location.href).searchParams.has("session")).toBe(
        false,
      );
    },
  );
  it("moves the current schedule indicator from a term through a break to the next term", async () => {
    window.history.replaceState(null, "", "/schedule/");
    await ready();
    const status = screen.getByRole("status", { name: "現在のスケジュール" });
    expect(status).toHaveTextContent("現在時刻 09:01");
    expect(document.querySelector('[aria-current="time"]')).toHaveTextContent(
      "検証ターム1",
    );
    await refreshAt("2030-05-14T09:05:00+09:00");
    expect(document.querySelector('[aria-current="time"]')).toBeNull();
    expect(status).toHaveTextContent("次は 09:10");
    expect(document.querySelector('[data-state="next"]')).toHaveTextContent(
      "検証ターム2",
    );
    await refreshAt("2030-05-14T09:10:00+09:00", "pageshow");
    expect(document.querySelector('[aria-current="time"]')).toHaveTextContent(
      "検証ターム2",
    );
    expect(screen.getByText("現在", { exact: true })).toBeInTheDocument();
    await refreshAt("2030-05-14T13:35:00+09:00");
    expect(document.querySelector('[aria-current="time"]')).toBeNull();
    expect(status).toHaveTextContent("終了");
    await refreshAt("2030-05-15T00:00:00+09:00");
    expect(
      screen.queryByRole("status", { name: "現在のスケジュール" }),
    ).not.toBeInTheDocument();
  });
});
