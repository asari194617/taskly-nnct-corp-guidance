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
import HomeDashboard, {
  type HomeDashboardProps,
} from "../components/home-dashboard";
import { getEventTimeState } from "../lib/event-time";
import { defaultRoute } from "../lib/route-state";
import type { HomeTask, HomeTasksResponse } from "../lib/types";
import { fixture } from "./fixtures";

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

function task(
  id: string,
  kind: HomeTask["kind"],
  title: string,
  overrides: Partial<HomeTask> = {},
): HomeTask {
  return {
    id,
    kind,
    title,
    completed: false,
    completion_disabled: false,
    taskly_url: `https://taskly.example.invalid/tasks/${encodeURIComponent(id)}`,
    ...overrides,
  };
}
function taskSnapshot(): HomeTasksResponse {
  const data = fixture();
  return {
    event_id: "synthetic-event",
    roster_configured: true,
    tasks: [
      ...data.assignments[0].visits.map((visit) =>
        task(
          `assigned:${visit.term}`,
          "assigned_visit",
          `指定企業ターム${visit.term}`,
          { company_id: visit.company_id, term: visit.term },
        ),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        task(
          `survey:${index + 1}`,
          "visit_survey",
          `ターム${index + 1} 見学アンケート`,
          {
            term: index + 1,
            url: `https://forms.example.invalid/visit/${index + 1}`,
          },
        ),
      ),
      task("overall", "overall_survey", "全体アンケート", {
        url: "https://forms.example.invalid/overall",
      }),
      task("sheet", "sheet_submission", "見学シート提出", {
        document_id: "guide",
        page: 25,
      }),
    ],
  };
}
function options(): HomeDashboardProps {
  const data = fixture();
  return {
    data,
    preferences: { department: "電子制御工学科", grade: 4, roster_number: 7 },
    assignment: data.assignments[0],
    savedIDs: new Set(),
    route: { ...defaultRoute, view: "home" },
    eventTime: getEventTimeState(
      data.event.date,
      data.schedule,
      Date.parse("2030-05-14T09:12:00+09:00"),
    ),
    onRouteChange: vi.fn(),
    onSelectCompany: vi.fn(),
    onSaveCompany: vi.fn().mockResolvedValue(undefined),
    onConfigure: vi.fn(),
    onExpired: vi.fn(),
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
let snapshot: HomeTasksResponse;
let failures: Map<string, number | Error>;
type FetchStub = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchStub>>;
const signedURL =
  "https://synthetic-r2.example.invalid/private/guide.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic";
beforeEach(() => {
  documentNavigation.assign.mockReset();
  snapshot = taskSnapshot();
  failures = new Map();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fetchMock = vi.fn<FetchStub>(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const failure =
        failures.get(`${init?.method || "GET"} ${path}`) ?? failures.get(path);
      if (failure instanceof Error) throw failure;
      if (failure) return json({ error: "synthetic_failure" }, failure);
      if (path === "/api/home") return json(snapshot);
      if (path.startsWith("/api/home/tasks/") && init?.method === "PUT") {
        const id = decodeURIComponent(path.slice("/api/home/tasks/".length));
        const completed = JSON.parse(String(init.body)).completed;
        const current = snapshot.tasks.find((row) => row.id === id)!;
        const updated = { ...current, completed };
        snapshot.tasks = snapshot.tasks.map((row) =>
          row.id === id ? updated : row,
        );
        return json(updated);
      }
      if (path === "/api/documents/guide/url")
        return json({ url: signedURL, expires_at: "2030-05-14T00:17:00Z" });
      throw new Error(`Unexpected request ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});
async function ready(props = options()) {
  const mounted = render(<HomeDashboard {...props} />);
  await screen.findByLabelText(/14件中|10件中|0件中|1件中/);
  return { ...mounted, props };
}
function writes() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
}

describe("Taskly-backed guidance home", () => {
  it("groups four assigned visits, eight term surveys, the overall survey and the sheet into fourteen explicit tasks", async () => {
    await ready();
    const assignments = screen.getByRole("region", { name: "指定企業の見学" });
    expect(within(assignments).getAllByRole("checkbox")).toHaveLength(4);
    expect(
      within(assignments).queryByRole("link", { name: "Taskly" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Taskly" })).toHaveLength(1);
    const surveys = screen.getByRole("region", { name: "見学アンケート" });
    const surveyHeading = within(surveys).getByRole("heading", {
      name: /見学アンケート.*0\/8/,
      level: 3,
    });
    const expand = within(surveyHeading).getByRole("button", {
      name: /見学アンケート/,
    });
    expect(
      within(assignments).getByRole("heading", {
        name: "指定企業の見学",
        level: 3,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "全体アンケート", level: 3 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "見学シート提出", level: 3 }),
    ).toBeInTheDocument();
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(within(surveys).queryByRole("checkbox")).not.toBeInTheDocument();
    expand.focus();
    await userEvent.keyboard("{Enter}");
    expect(within(surveys).getAllByRole("checkbox")).toHaveLength(8);
    expect(screen.getAllByRole("checkbox")).toHaveLength(14);
    expect(screen.getByLabelText("14件中0件完了")).toHaveTextContent("0/14");
    expect(
      screen.getByRole("checkbox", { name: "全体アンケート" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "見学シート提出" }),
    ).not.toBeChecked();
    await userEvent.keyboard(" ");
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(within(surveys).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("opens the current survey without falsely recording it as answered", async () => {
    await ready();
    const surveys = screen.getByRole("region", { name: "見学アンケート" });
    const current = within(surveys).getByRole("link", {
      name: "ターム 2 の回答",
    });
    expect(current).toHaveAttribute(
      "href",
      "https://forms.example.invalid/visit/2",
    );
    expect(current).toHaveAttribute("target", "_blank");
    expect(current).toHaveAttribute("rel", "noopener noreferrer");
    await userEvent.click(current);
    expect(writes()).toHaveLength(0);
    await userEvent.click(
      within(surveys).getByRole("button", { name: /見学アンケート/ }),
    );
    const checkbox = within(surveys).getByRole("checkbox", {
      name: "ターム2 見学アンケート",
    });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/home/tasks/survey%3A2"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ completed: true }),
      }),
    );
    expect(screen.getByLabelText("14件中1件完了")).toHaveTextContent("1/14");
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
  });

  it("offers the most recently ended term's survey between visits", async () => {
    const props = options();
    props.eventTime = getEventTimeState(
      props.data.event.date,
      props.data.schedule,
      Date.parse("2030-05-14T09:07:00+09:00"),
    );
    await ready(props);
    expect(
      screen.getByRole("link", { name: "ターム 1 の回答" }),
    ).toHaveAttribute("href", "https://forms.example.invalid/visit/1");
  });

  it("falls back to the next incomplete questionnaire outside the event day", async () => {
    snapshot.tasks.find((row) => row.id === "survey:1")!.completed = true;
    const props = options();
    props.eventTime = getEventTimeState(
      props.data.event.date,
      props.data.schedule,
      Date.parse("2030-05-13T09:00:00+09:00"),
    );
    await ready(props);
    const surveys = screen.getByRole("region", { name: "見学アンケート" });
    expect(
      within(surveys).getByRole("link", { name: "回答する" }),
    ).toHaveAttribute("href", "https://forms.example.invalid/visit/2");
  });

  it("keeps ten nonassignment tasks available before a roster number is configured", async () => {
    snapshot.roster_configured = false;
    snapshot.tasks = snapshot.tasks.filter(
      (row) => row.kind !== "assigned_visit",
    );
    const props = options();
    props.preferences.roster_number = null;
    props.assignment = undefined;
    await ready(props);
    expect(
      screen.queryByRole("region", { name: "指定企業の見学" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("10件中0件完了")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "名簿番号を設定" }),
    );
    expect(props.onConfigure).toHaveBeenCalledOnce();
    await userEvent.click(
      screen.getByRole("button", { name: /見学アンケート/ }),
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(10);
  });

  it("lets assigned-company and booth links open details or a focused map without completing a visit", async () => {
    const { props } = await ready();
    const assigned = screen.getByRole("region", { name: "指定企業の見学" });
    const company = props.data.companies[0];
    await userEvent.click(
      within(assigned).getByRole("link", { name: company.name }),
    );
    expect(props.onSelectCompany).toHaveBeenCalledWith(company);
    const row = within(assigned)
      .getByRole("checkbox", { name: "指定企業ターム1" })
      .closest("li")!;
    const map = within(row).getByRole("link", { name: "ブース 1" });
    expect(map).toHaveAttribute("href", "/map/?focus=AM-1&session=AM");
    await userEvent.click(map);
    expect(props.onRouteChange).toHaveBeenCalledWith(
      expect.objectContaining({
        view: "map",
        focus: company.id,
        company: "",
        session: "AM",
        sessionExplicit: true,
        q: "",
        industries: [],
        saved: false,
        assigned: false,
      }),
    );
    const taskly = screen.getByRole("link", { name: "Taskly" });
    expect(taskly).toHaveAttribute("href", snapshot.tasks[0].taskly_url);
    expect(taskly).toHaveAttribute("target", "_blank");
    expect(taskly).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(taskly);
    expect(writes()).toHaveLength(0);
  });

  it("uses the first available Taskly URL and omits the link when none exists", async () => {
    snapshot.tasks[0].taskly_url = "";
    const firstAvailable = snapshot.tasks[1].taskly_url;
    const mounted = await ready();
    expect(screen.getByRole("link", { name: "Taskly" })).toHaveAttribute(
      "href",
      firstAvailable,
    );
    mounted.unmount();
    snapshot.tasks = snapshot.tasks.map((task) => ({
      ...task,
      taskly_url: "",
    }));
    await ready();
    expect(
      screen.queryByRole("link", { name: "Taskly" }),
    ).not.toBeInTheDocument();
  });

  it.each(["blocked", "throws"] as const)(
    "opens sheet page25 in the current tab with its signature preserved when popups are %s",
    async (popup) => {
      const open = vi.spyOn(window, "open").mockImplementation(() => {
        if (popup === "throws") throw new Error("Synthetic popup policy");
        return null;
      });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "資料を見る" }));
      await waitFor(() =>
        expect(documentNavigation.assign).toHaveBeenCalledWith(
          `${signedURL}#page=25`,
        ),
      );
      expect(open).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(
        screen.getByRole("checkbox", { name: "見学シート提出" }),
      ).not.toBeChecked();
      expect(writes()).toHaveLength(0);
    },
  );
  it.each([503, new Error("検証用ネットワーク切断")])(
    "reports failed sheet signing and allows retry without completing the task (%s)",
    async (failure) => {
      failures.set("/api/documents/guide/url", failure);
      await ready();
      const button = screen.getByRole("button", { name: "資料を見る" });
      await userEvent.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "資料を開けませんでした",
      );
      expect(documentNavigation.assign).not.toHaveBeenCalled();
      expect(button).toBeEnabled();
      failures.delete("/api/documents/guide/url");
      await userEvent.click(button);
      await waitFor(() =>
        expect(documentNavigation.assign).toHaveBeenCalledWith(
          `${signedURL}#page=25`,
        ),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: "見学シート提出" }),
      ).not.toBeChecked();
      expect(writes()).toHaveLength(0);
    },
  );
  it("recovers from denied sheet navigation without checking submission", async () => {
    documentNavigation.assign.mockImplementationOnce(() => {
      throw new Error("Synthetic navigation policy");
    });
    await ready();
    const button = screen.getByRole("button", { name: "資料を見る" });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "資料を開けませんでした",
    );
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() =>
      expect(documentNavigation.assign).toHaveBeenCalledTimes(2),
    );
    expect(documentNavigation.assign).toHaveBeenLastCalledWith(
      `${signedURL}#page=25`,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "見学シート提出" }),
    ).not.toBeChecked();
    expect(writes()).toHaveLength(0);
  });
  it("reports expired authentication while opening a sheet without navigating", async () => {
    failures.set("/api/documents/guide/url", 401);
    const { props } = await ready();
    await userEvent.click(screen.getByRole("button", { name: "資料を見る" }));
    await waitFor(() => expect(props.onExpired).toHaveBeenCalledOnce());
    expect(documentNavigation.assign).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("shows unavailable Taskly state without inventing local tasks and recovers on retry", async () => {
    failures.set("/api/home", 503);
    const props = options();
    render(<HomeDashboard {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "やることを取得できませんでした",
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    failures.delete("/api/home");
    await userEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(await screen.findByLabelText("14件中0件完了")).toBeInTheDocument();
  });

  it("renders an authoritative empty task list without generating synthetic completion rows", async () => {
    snapshot.tasks = [];
    await ready();
    expect(screen.getByText("やることはありません")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it("respects Taskly completion restrictions and allows undoing a prior completion", async () => {
    snapshot.tasks.find((row) => row.id === "overall")!.completion_disabled =
      true;
    Object.assign(
      snapshot.tasks.find((row) => row.id === "sheet")!,
      { completion_disabled: true, completed: true },
    );
    await ready();
    expect(
      screen.getByRole("checkbox", { name: "全体アンケート" }),
    ).toBeDisabled();
    const completed = screen.getByRole("checkbox", { name: "見学シート提出" });
    expect(completed).toBeEnabled();
    await userEvent.click(completed);
    await waitFor(() => expect(completed).not.toBeChecked());
    expect(completed).toBeDisabled();
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/home/tasks/sheet"),
      expect.objectContaining({ body: JSON.stringify({ completed: false }) }),
    );
  });

  it("renders explainable recommendation cards and keeps their identity stable while favorites change", async () => {
    const props = options();
    props.data.companies.push({
      ...props.data.companies[0],
      id: "AM-3",
      booth: 3,
      name: "追加の検証ソフト企業",
    });
    const view = await ready(props);
    const recommendation = screen.getByRole("region", { name: "おすすめ" });
    const title = within(recommendation).getByRole("link", {
      name: "追加の検証ソフト企業",
    });
    expect(
      within(recommendation).getByRole("list", { name: "おすすめの理由" }),
    ).toHaveTextContent("電子制御に関連する業種");
    await userEvent.click(title);
    expect(props.onSelectCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: "AM-3" }),
    );
    await userEvent.click(
      within(recommendation).getByRole("button", {
        name: "追加の検証ソフト企業を気になるに追加",
      }),
    );
    expect(props.onSaveCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: "AM-3" }),
    );
    view.rerender(<HomeDashboard {...props} savedIDs={new Set(["AM-3"])} />);
    expect(
      within(recommendation).getByRole("link", {
        name: "追加の検証ソフト企業",
      }),
    ).toBe(title);
    expect(
      within(recommendation).getByRole("list", { name: "おすすめの理由" }),
    ).toHaveTextContent("気になる企業");
    expect(
      within(recommendation).getByRole("button", {
        name: "追加の検証ソフト企業を気になるから解除",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      within(recommendation).getByRole("link", { name: "探す" }),
    );
    expect(props.onRouteChange).toHaveBeenCalledWith({
      view: "search",
      company: "",
    });
    expect(writes()).toHaveLength(0);
  });

  it("preserves native link behavior when another handler already claimed the click", async () => {
    const { props } = await ready();
    const assigned = screen.getByRole("region", { name: "指定企業の見学" });
    const link = within(assigned).getByRole("link", {
      name: props.data.companies[0].name,
    });
    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(link);
    expect(props.onSelectCompany).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });
});
