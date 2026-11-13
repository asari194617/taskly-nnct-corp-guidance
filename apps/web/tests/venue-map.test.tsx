import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VenueMap from "../components/venue-map";
import { APIError, documentURL } from "../lib/api";
import type { Company, Document } from "../lib/types";

vi.mock("../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, documentURL: vi.fn() };
});

const companies: Company[] = [
  {
    id: "AM-1",
    name: "架空あおば",
    session: "AM",
    booth: 1,
    industries: [],
    source_page: 1,
  },
  {
    id: "AM-2",
    name: "架空いろは",
    session: "AM",
    booth: 2,
    industries: [],
    source_page: 1,
  },
  {
    id: "PM-1",
    name: "架空みらい",
    session: "PM",
    booth: 1,
    industries: [],
    source_page: 2,
  },
];
const documents: (Document & {
  booths?: {
    booth: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
})[] = [
  {
    id: "arena",
    title: "検証1階マップ",
    kind: "map",
    mime_type: "image/png",
    file_name: "arena.png",
    source_page: 1,
    url: "/api/documents/arena",
    booths: [
      { booth: 1, x: 0.1, y: 0.2, width: 0.2, height: 0.15 },
      { booth: 2, x: 0.4, y: 0.2, width: 0.2, height: 0.15 },
      { booth: 3, x: 0.7, y: 0.2, width: 0.2, height: 0.15 },
      { booth: 4, x: -0.2, y: 0.2, width: 0.2, height: 0.15 },
    ],
  },
  {
    id: "lunch",
    title: "検証2階マップ",
    kind: "map",
    mime_type: "image/png",
    file_name: "lunch.png",
    source_page: 2,
    url: "/api/documents/lunch",
  },
  {
    id: "guide",
    title: "検証用PDF",
    kind: "guidebook",
    mime_type: "application/pdf",
    file_name: "guide.pdf",
    source_page: 1,
    url: "/api/documents/guide",
  },
];

function props() {
  return {
    documents,
    companies,
    session: "AM" as const,
    onSelectCompany: vi.fn(),
    onSessionChange: vi.fn(),
    onExpired: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(documentURL).mockReset();
  vi.mocked(documentURL).mockImplementation(async (id) => ({
    url: `https://api.example.test/documents/${id}?token=synthetic`,
    expires_at: "2030-05-14T10:00:00Z",
  }));
});

describe("interactive private venue map", () => {
  it("loads a signed image and opens the correct session's company from its booth", async () => {
    const options = props();
    render(<VenueMap {...options} />);
    const image = await screen.findByRole("img", { name: "検証1階マップ" });
    expect(image).toHaveAttribute(
      "src",
      "https://api.example.test/documents/arena?token=synthetic",
    );
    expect(documentURL).toHaveBeenCalledWith("arena", expect.any(AbortSignal));
    const booth = screen.getByRole("button", {
      name: "午前 ブース 1 架空あおば",
    });
    expect(booth).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "20%",
      height: "15%",
    });
    await userEvent.click(booth);
    expect(options.onSelectCompany).toHaveBeenCalledWith(companies[0]);
    expect(
      screen.getByRole("button", { name: "午前 ブース 3 出展なし" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /ブース 4/ }),
    ).not.toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("marks selected, assigned and saved companies without confusing AM and PM booths", async () => {
    const options = props();
    const view = render(
      <VenueMap
        {...options}
        selectedCompanyId="AM-1"
        assignedCompanyIds={new Set(["AM-1"])}
        savedCompanyIds={new Set(["AM-2"])}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    const selected = screen.getByRole("button", {
      name: "午前 ブース 1 架空あおば",
    });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(selected).toHaveAttribute("data-assigned", "true");
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toHaveAttribute("data-saved", "true");
    expect(screen.getByRole("status")).toHaveTextContent("ブース 1");
    await userEvent.click(screen.getByRole("radio", { name: "午後の部" }));
    expect(options.onSessionChange).toHaveBeenCalledWith("PM");
    view.rerender(
      <VenueMap {...options} session="PM" selectedCompanyId="AM-1" />,
    );
    expect(
      screen.getByRole("button", { name: "午後 ブース 1 架空みらい" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("ブース 1　架空あおば")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "午後 ブース 1 架空みらい" }),
    );
    expect(options.onSelectCompany).toHaveBeenLastCalledWith(companies[2]);
  });

  it("hosts a nonmodal company pane while preserving selected and assigned state and zoom", async () => {
    const options = props();
    const panel = (
      <section className="map-company-panel" aria-label="検証企業情報">
        <button>企業情報を閉じる</button>
      </section>
    );
    const view = render(
      <VenueMap
        {...options}
        selectedCompanyId="AM-1"
        assignedCompanyIds={new Set(["AM-1"])}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    await userEvent.click(screen.getByRole("button", { name: "マップを拡大" }));
    const zoom = screen.getByRole("button", {
      name: "拡大率を100パーセントに戻す",
    });
    expect(zoom).toHaveTextContent("125%");
    view.rerender(
      <VenueMap
        {...options}
        selectedCompanyId="AM-1"
        assignedCompanyIds={new Set(["AM-1"])}
        detailPanelOpen
        detailPanel={panel}
      />,
    );
    const map = screen.getByRole("region", { name: "会場マップ" });
    expect(map).toHaveAttribute("data-detail-open", "true");
    expect(
      screen.getByRole("region", { name: "検証企業情報" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const selected = screen.getByRole("button", {
      name: "午前 ブース 1 架空あおば",
    });
    expect(selected).toHaveAttribute("data-selected", "true");
    expect(selected).toHaveAttribute("data-assigned", "true");
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(zoom).toHaveTextContent("125%");
    await userEvent.click(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    );
    expect(options.onSelectCompany).toHaveBeenCalledWith(companies[1]);
    view.rerender(<VenueMap {...options} selectedCompanyId="AM-1" />);
    expect(map).not.toHaveAttribute("data-detail-open");
    expect(screen.getByRole("status")).toHaveTextContent("ブース 1");
    expect(zoom).toHaveTextContent("125%");
  });

  it("keeps embedded maps independent from fullscreen company-pane controls", async () => {
    render(
      <VenueMap
        {...props()}
        mode="embedded"
        selectedCompanyId="AM-1"
        detailPanelOpen
        detailPanel={<section aria-label="表示しない情報" />}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    expect(
      screen.getByRole("region", { name: "企業のブース位置" }),
    ).not.toHaveAttribute("data-detail-open");
    expect(
      screen.queryByRole("region", { name: "表示しない情報" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ブース 1");
  });

  it.each(["right", "bottom"] as const)(
    "reveals a booth behind the actual %s pane without changing zoom",
    async (position) => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1200);
      vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(800);
      const rectangle = (
        left: number,
        top: number,
        width: number,
        height: number,
      ) => ({
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      });
      let selectedBounds =
        position === "right"
          ? rectangle(900, 150, 20, 20)
          : rectangle(200, 700, 20, 20);
      let panelBounds =
        position === "right"
          ? rectangle(824, 72, 360, 528)
          : rectangle(0, 480, 1200, 320);
      let panelResize: () => void = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private callback: () => void) {}
          observe(element: Element) {
            if (element.classList.contains("map-company-panel"))
              panelResize = this.callback;
          }
          disconnect() {}
        },
      );
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
          if (this.classList.contains("venue-map-viewport"))
            return rectangle(0, 0, 1200, 800);
          if (this.classList.contains("map-company-panel")) return panelBounds;
          return selectedBounds;
        },
      );
      const options = props(),
        docs = [{ ...documents[0], image_width: 1000, image_height: 1000 }];
      const view = render(
        <VenueMap {...options} documents={docs} selectedCompanyId="AM-1" />,
      );
      await screen.findByRole("img", { name: "検証1階マップ" });
      const area = screen.getByRole("region", { name: "操作できる会場マップ" });
      const before = { left: area.scrollLeft, top: area.scrollTop };
      view.rerender(
        <VenueMap
          {...options}
          documents={docs}
          selectedCompanyId="AM-1"
          detailPanelOpen
          detailPanel={
            <section className="map-company-panel" aria-label="検証企業情報" />
          }
        />,
      );
      expect(area.scrollLeft).toBe(
        before.left + (position === "right" ? 112 : 0),
      );
      expect(area.scrollTop).toBe(
        before.top + (position === "bottom" ? 256 : 0),
      );
      const revealed = { left: area.scrollLeft, top: area.scrollTop };
      selectedBounds =
        position === "right"
          ? rectangle(788, 150, 20, 20)
          : rectangle(200, 444, 20, 20);
      act(() => panelResize());
      expect(area.scrollLeft).toBe(revealed.left);
      expect(area.scrollTop).toBe(revealed.top);
      // A pure resize that still leaves the booth visible must not move the map.
      panelBounds =
        position === "right"
          ? rectangle(850, 72, 300, 528)
          : rectangle(0, 500, 1200, 300);
      act(() => panelResize());
      expect(area.scrollLeft).toBe(revealed.left);
      expect(area.scrollTop).toBe(revealed.top);
      expect(
        screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
      ).toHaveTextContent("100%");
    },
  );

  it("supports zoom boundaries and resets the view to the selected company's floor", async () => {
    const options = props();
    const view = render(<VenueMap {...options} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    const zoomIn = screen.getByRole("button", { name: "マップを拡大" });
    const zoomOut = screen.getByRole("button", { name: "マップを縮小" });
    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);
    expect(zoomOut).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("50%");
    for (let index = 0; index < 30; index++) fireEvent.click(zoomIn);
    expect(zoomIn).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("800%");
    fireEvent.click(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    );
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("100%");
    await userEvent.click(
      screen.getByRole("button", { name: "検証2階マップ" }),
    );
    await screen.findByRole("img", { name: "検証2階マップ" });
    expect(
      screen.queryByRole("button", { name: /ブース 1 架空/ }),
    ).not.toBeInTheDocument();
    view.rerender(<VenueMap {...options} selectedCompanyId="AM-2" />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("retries failed signing/image loading and invalidates an expired identity", async () => {
    const options = props();
    vi.mocked(documentURL).mockRejectedValueOnce(
      new Error("署名を発行できません"),
    );
    render(<VenueMap {...options} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "署名を発行できません",
    );
    await userEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    const image = await screen.findByRole("img", { name: "検証1階マップ" });
    fireEvent.error(image);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "再読み込みしてください",
    );
    vi.mocked(documentURL).mockRejectedValueOnce(new APIError(401, "expired"));
    await userEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    await waitFor(() => expect(options.onExpired).toHaveBeenCalledOnce());
  });

  it("never changes zoom when selecting a booth, opening details or changing floors", async () => {
    const options = props();
    const precise = [
      {
        ...documents[0],
        image_width: 1000,
        image_height: 1000,
        booths: [
          { booth: 1, x: 0.1, y: 0.2, width: 0.02, height: 0.02 },
          { booth: 2, x: 0.4, y: 0.2, width: 0.02, height: 0.02 },
        ],
      },
      documents[1],
    ];
    const view = render(
      <VenueMap {...options} documents={precise} selectedCompanyId="AM-1" />,
    );
    const image = await screen.findByRole("img", { name: "検証1階マップ" });
    expect(image).toHaveAttribute("width", "1000");
    expect(image).toHaveAttribute("height", "1000");
    const reset = screen.getByRole("button", {
      name: "拡大率を100パーセントに戻す",
    });
    expect(reset).toHaveTextContent("100%");
    await userEvent.click(screen.getByRole("button", { name: "マップを拡大" }));
    expect(reset).toHaveTextContent("125%");
    view.rerender(
      <VenueMap {...options} documents={precise} selectedCompanyId="AM-2" />,
    );
    expect(reset).toHaveTextContent("125%");
    await userEvent.click(
      screen.getByRole("button", { name: "検証2階マップ" }),
    );
    await screen.findByRole("img", { name: "検証2階マップ" });
    expect(reset).toHaveTextContent("125%");
    view.rerender(
      <VenueMap {...options} documents={precise} selectedCompanyId="AM-1" />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    expect(reset).toHaveTextContent("125%");
  });

  it("provides a fullscreen canvas or compact embedded map without duplicate page controls", async () => {
    const options = props();
    const view = render(
      <VenueMap
        {...options}
        navigation={<a href="/">一覧</a>}
        topRight={<button>アカウント</button>}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    expect(screen.getByRole("region", { name: "会場マップ" })).toHaveAttribute(
      "data-mode",
      "fullscreen",
    );
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    expect(screen.getByRole("link", { name: "一覧" })).toHaveAttribute(
      "href",
      "/",
    );
    view.unmount();
    expect(document.body.style.overflow).toBe("");
    render(<VenueMap {...options} mode="embedded" selectedCompanyId="AM-1" />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    expect(
      screen.getByRole("region", { name: "企業のブース位置" }),
    ).toHaveAttribute("data-mode", "embedded");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "絞り込み" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "マップを拡大" })).toBeEnabled();
    expect(document.body.style.overflow).toBe("");
  });

  it("ignores an aborted map request and handles missing floor metadata", async () => {
    let reject: (reason: unknown) => void = () => {};
    vi.mocked(documentURL).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const options = props();
    const view = render(<VenueMap {...options} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "マップを読み込んでいます",
    );
    view.unmount();
    await act(async () => reject(new APIError(401, "cancelled")));
    expect(options.onExpired).not.toHaveBeenCalled();
    render(
      <VenueMap {...options} documents={[]} selectedCompanyId="missing" />,
    );
    expect(
      screen.getByText("マップはまだ登録されていません。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "配布資料" }),
    ).not.toBeInTheDocument();
  });
  it("combines selected industries with OR and other conditions with AND", async () => {
    const options = props();
    render(
      <VenueMap
        {...options}
        companies={companies.map((item, index) => ({
          ...item,
          industries: [index === 0 ? "製造" : "情報"],
        }))}
        savedCompanyIds={new Set(["AM-2"])}
        assignedCompanyIds={new Set(["AM-1"])}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    const toggle = screen.getByRole("button", { name: "絞り込み" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("group", { name: "業種" }),
    ).not.toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("checkbox", { name: "製造" }));
    expect(
      screen.getByRole("button", { name: "午前 ブース 1 架空あおば" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "情報" }));
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "製造" }));
    expect(
      screen.getByRole("button", { name: "午前 ブース 1 架空あおば" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "気になるのみ" }),
    );
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "指定企業のみ" }),
    );
    expect(
      screen.getByRole("button", { name: "表示中の一覧（0社）" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "表示中の一覧（0社）" }),
    );
    expect(
      screen.getByText("条件に合う企業がありません。"),
    ).toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "条件を解除" }));
    expect(
      screen.getByRole("button", { name: "表示中の一覧（2社）" }),
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "マップの企業名" }),
      "あおば",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "表示中の一覧（1社）" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "企業詳細 架空あおば" }),
    );
    expect(options.onSelectCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: "AM-1" }),
    );
  });

  it("reports controlled filters to the URL owner without overriding its current values", async () => {
    const change = vi.fn(),
      options = props();
    const view = render(
      <VenueMap
        {...options}
        search="あおば"
        industries={[]}
        onlySaved={false}
        onlyAssigned={false}
        onFiltersChange={change}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    await userEvent.click(screen.getByRole("button", { name: "絞り込み" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "マップの企業名" }),
      { target: { value: "いろは" } },
    );
    expect(change).toHaveBeenLastCalledWith({ q: "いろは" });
    expect(
      screen.getByRole("searchbox", { name: "マップの企業名" }),
    ).toHaveValue("あおば");
    view.rerender(
      <VenueMap
        {...options}
        search="いろは"
        industries={[]}
        onlySaved={false}
        onlyAssigned={false}
        onFiltersChange={change}
      />,
    );
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeEnabled();
  });

  it("fits and centers the drawing while retaining pan room at 100 percent", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(320);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(480);
    render(
      <VenueMap
        {...props()}
        documents={[{ ...documents[0], image_width: 1000, image_height: 1000 }]}
      />,
    );
    const image = await screen.findByRole("img", { name: "検証1階マップ" });
    const map = screen.getByRole("region", { name: "操作できる会場マップ" });
    expect(image.parentElement?.parentElement).toHaveStyle({
      width: "320px",
      padding: "240px 160px",
    });
    expect(map.scrollLeft).toBe(160);
    expect(map.scrollTop).toBe(160);
    fireEvent(
      map,
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: -Math.log(2) / 0.005,
        ctrlKey: true,
        clientX: 80,
        clientY: 100,
      }),
    );
    expect(map.scrollLeft).toBe(240);
    expect(map.scrollTop).toBe(180);
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("200%");
    fireEvent.keyDown(map, { key: "0" });
    expect(map.scrollLeft).toBe(160);
    expect(map.scrollTop).toBe(160);
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("100%");
    await userEvent.click(screen.getByRole("button", { name: "マップを縮小" }));
    await userEvent.click(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    );
    expect(map.scrollLeft).toBe(160);
    expect(map.scrollTop).toBe(160);
  });

  it("offers one booth tab stop and arrow navigation without trapping users before controls", async () => {
    render(<VenueMap {...props()} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    const first = screen.getByRole("button", {
      name: "午前 ブース 1 架空あおば",
    });
    const second = screen.getByRole("button", {
      name: "午前 ブース 2 架空いろは",
    });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(first).toHaveFocus();
    expect(
      screen
        .getByRole("searchbox", { name: "マップの企業名" })
        .compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("only pans a selected booth when fully offscreen and never zooms during selection", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(320);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.classList.contains("venue-map-viewport"))
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 320,
            bottom: 300,
            width: 320,
            height: 300,
            toJSON: () => ({}),
          };
        if (this.getAttribute("data-booth") === "1")
          return {
            x: 50,
            y: 50,
            left: 50,
            top: 50,
            right: 70,
            bottom: 70,
            width: 20,
            height: 20,
            toJSON: () => ({}),
          };
        return {
          x: 400,
          y: 400,
          left: 400,
          top: 400,
          right: 420,
          bottom: 420,
          width: 20,
          height: 20,
          toJSON: () => ({}),
        };
      },
    );
    const options = props();
    const view = render(<VenueMap {...options} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    const area = screen.getByRole("region", { name: "操作できる会場マップ" });
    area.scrollLeft = 100;
    area.scrollTop = 100;
    view.rerender(<VenueMap {...options} selectedCompanyId="AM-1" />);
    expect(area.scrollLeft).toBe(100);
    expect(area.scrollTop).toBe(100);
    view.rerender(<VenueMap {...options} selectedCompanyId="AM-2" />);
    expect(area.scrollLeft).toBe(216);
    expect(area.scrollTop).toBe(236);
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("100%");
    view.rerender(
      <VenueMap {...options} selectedCompanyId="AM-2" mode="embedded" />,
    );
    const image = screen.getByRole("img", { name: "検証1階マップ" });
    fireEvent.load(image);
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("100%");
  });

  it("pans by pointer and keyboard, suppresses drag clicks, and permits the next intentional tap", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const options = props();
    render(<VenueMap {...options} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    const map = screen.getByRole("region", { name: "操作できる会場マップ" });
    const booth = screen.getByRole("button", {
      name: "午前 ブース 1 架空あおば",
    });
    map.scrollLeft = 100;
    map.scrollTop = 100;
    fireEvent.pointerMove(map, { clientX: 10, clientY: 10 });
    fireEvent.pointerDown(booth, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(map, { clientX: 98, clientY: 98 });
    expect(map.scrollLeft).toBe(100);
    fireEvent.pointerMove(map, { clientX: 60, clientY: 70 });
    expect(map.scrollLeft).toBe(140);
    expect(map.scrollTop).toBe(130);
    fireEvent.pointerUp(map, { clientX: 60, clientY: 70 });
    fireEvent.click(booth, { detail: 1 });
    expect(options.onSelectCompany).not.toHaveBeenCalled();
    fireEvent.keyDown(map, { key: "ArrowRight" });
    fireEvent.keyDown(map, { key: "ArrowDown" });
    expect(map.scrollLeft).toBe(220);
    expect(map.scrollTop).toBe(210);
    fireEvent.keyDown(map, { key: "ArrowLeft" });
    fireEvent.keyDown(map, { key: "ArrowUp" });
    fireEvent.keyDown(map, { key: "+" });
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("125%");
    fireEvent.keyDown(map, { key: "-" });
    fireEvent.keyDown(map, { key: "0" });
    fireEvent.keyDown(map, { key: "Enter" });
    fireEvent.keyDown(booth, { key: "+" });
    fireEvent.pointerDown(booth, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(booth, { clientX: 100, clientY: 100 });
    fireEvent.click(booth, { detail: 1 });
    expect(options.onSelectCompany).toHaveBeenCalledOnce();
  });

  it("anchors modified-wheel zoom at the pointer and leaves ordinary scrolling uncancelled", async () => {
    render(<VenueMap {...props()} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    const map = screen.getByRole("region", { name: "操作できる会場マップ" });
    map.scrollLeft = 100;
    map.scrollTop = 50;
    const ordinary = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 20,
    });
    fireEvent(map, ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    const zoom = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -Math.log(2) / 0.005,
      ctrlKey: true,
      clientX: 50,
      clientY: 25,
    });
    fireEvent(map, zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("200%");
    expect(map.scrollLeft).toBe(250);
    expect(map.scrollTop).toBe(125);
  });

  it("supports a two-touch pinch and never opens a booth as the gesture ends", async () => {
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(
        type: string,
        options: MouseEventInit & {
          pointerId?: number;
          pointerType?: string;
        } = {},
      ) {
        super(type, options);
        this.pointerId = options.pointerId ?? 0;
        this.pointerType = options.pointerType ?? "mouse";
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const options = props();
    render(<VenueMap {...options} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    const map = screen.getByRole("region", { name: "操作できる会場マップ" });
    const booth = screen.getByRole("button", {
      name: "午前 ブース 1 架空あおば",
    });
    fireEvent.pointerDown(map, {
      pointerId: 1,
      pointerType: "mouse",
      button: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerDown(booth, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 50,
      clientY: 50,
    });
    fireEvent.pointerDown(map, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 150,
      clientY: 50,
    });
    fireEvent.pointerMove(map, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 250,
      clientY: 50,
    });
    expect(
      screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
    ).toHaveTextContent("200%");
    expect(map.scrollLeft).toBe(50);
    expect(map.scrollTop).toBe(50);
    fireEvent.pointerUp(map, { pointerId: 2, pointerType: "touch" });
    fireEvent.pointerMove(map, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 40,
      clientY: 40,
    });
    fireEvent.pointerCancel(map, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(booth, { detail: 1 });
    expect(options.onSelectCompany).not.toHaveBeenCalled();
    fireEvent.click(booth, { detail: 0 });
    expect(options.onSelectCompany).toHaveBeenCalledOnce();
  });
});
