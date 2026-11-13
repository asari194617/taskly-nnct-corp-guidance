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

  it("zooms a newly selected small booth to a usable size and preserves later manual zoom", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(320);
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
    await waitFor(() => expect(reset).toHaveTextContent("700%"));
    await userEvent.click(screen.getByRole("button", { name: "マップを縮小" }));
    expect(reset).toHaveTextContent("675%");
    view.rerender(
      <VenueMap
        {...options}
        documents={precise}
        selectedCompanyId="AM-1"
        savedCompanyIds={new Set(["AM-1"])}
      />,
    );
    expect(reset).toHaveTextContent("675%");
    await userEvent.click(reset);
    expect(reset).toHaveTextContent("100%");
    view.rerender(
      <VenueMap {...options} documents={precise} selectedCompanyId="AM-2" />,
    );
    await waitFor(() => expect(reset).toHaveTextContent("700%"));
  });

  it("uses image loading dimensions when older map metadata has no intrinsic size", async () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(320);
    const precise = [
      {
        ...documents[0],
        booths: [{ booth: 1, x: 0.1, y: 0.2, width: 0.02, height: 0.02 }],
      },
    ];
    render(
      <VenueMap {...props()} documents={precise} selectedCompanyId="AM-1" />,
    );
    const image = await screen.findByRole("img", { name: "検証1階マップ" });
    Object.defineProperties(image, {
      naturalWidth: { value: 1000 },
      naturalHeight: { value: 1000 },
    });
    fireEvent.load(image);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "拡大率を100パーセントに戻す" }),
      ).toHaveTextContent("700%"),
    );
  });

  it("navigates a PDF tab to its signed URL without creating a blob", async () => {
    const tab = {
      opener: {},
      location: { href: "about:blank" },
      close: vi.fn(),
    };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<VenueMap {...props()} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    await userEvent.click(screen.getByRole("button", { name: "検証用PDF" }));
    await waitFor(() =>
      expect(tab.location.href).toBe(
        "https://api.example.test/documents/guide?token=synthetic",
      ),
    );
    expect(tab.opener).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(documentURL).toHaveBeenLastCalledWith("guide");
  });

  it("closes failed PDF tabs, reports popup blocking and propagates authentication expiry", async () => {
    const options = props();
    const tab = {
      opener: {},
      location: { href: "about:blank" },
      close: vi.fn(),
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(tab as unknown as Window);
    render(<VenueMap {...options} />);
    await screen.findByRole("img", { name: "検証1階マップ" });
    vi.mocked(documentURL).mockRejectedValueOnce(new Error("PDFを開けません"));
    await userEvent.click(screen.getByRole("button", { name: "検証用PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PDFを開けません",
    );
    expect(tab.close).toHaveBeenCalledOnce();
    vi.mocked(documentURL).mockRejectedValueOnce(new APIError(401, "expired"));
    await userEvent.click(screen.getByRole("button", { name: "検証用PDF" }));
    await waitFor(() => expect(options.onExpired).toHaveBeenCalledOnce());
    open.mockReturnValue(null);
    await userEvent.click(screen.getByRole("button", { name: "検証用PDF" }));
    expect(screen.getByRole("alert")).toHaveTextContent("ポップアップを許可");
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
  it("keeps filters compact, dims excluded booths, and exposes an accessible matching list", async () => {
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
      screen.queryByRole("searchbox", { name: "マップの企業名" }),
    ).not.toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.type(
      screen.getByRole("searchbox", { name: "マップの企業名" }),
      "あおば",
    );
    expect(
      screen.getByRole("button", { name: "午前 ブース 1 架空あおば" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toHaveAttribute("data-match", "false");
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByText("表示中の企業（1社）"));
    await userEvent.click(
      screen.getByRole("button", { name: "企業詳細 架空あおば" }),
    );
    expect(options.onSelectCompany).toHaveBeenCalledWith(
      expect.objectContaining({ id: "AM-1" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "解除" }));
    const industrySelect = screen.getByRole("combobox", {
      name: "マップの業種",
    });
    industrySelect.focus();
    await userEvent.selectOptions(industrySelect, "情報");
    expect(industrySelect).toHaveFocus();
    expect(
      industrySelect.closest("label")?.querySelector(".spui-DropDown-visual"),
    ).toHaveTextContent("情報");
    expect(
      screen.getByRole("button", { name: "午前 ブース 1 架空あおば" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "気になる企業のみ" }),
    );
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "指定企業のみ" }),
    );
    expect(
      screen.getByText("条件に合う企業がありません。"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "解除" }));
    expect(screen.getByText("表示中の企業（2社）")).toBeInTheDocument();
    expect(
      screen
        .getByRole("combobox", { name: "マップの業種" })
        .closest("label")
        ?.querySelector(".spui-DropDown-visual"),
    ).toHaveTextContent("すべての業種");
  });

  it("reports controlled filters to the URL owner without overriding its current values", async () => {
    const change = vi.fn(),
      options = props();
    const view = render(
      <VenueMap
        {...options}
        search="あおば"
        industry=""
        onlySaved={false}
        onlyAssigned={false}
        onFiltersChange={change}
      />,
    );
    await screen.findByRole("img", { name: "検証1階マップ" });
    await userEvent.click(
      screen.getByRole("button", { name: "絞り込み（1）" }),
    );
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
        industry=""
        onlySaved={false}
        onlyAssigned={false}
        onFiltersChange={change}
      />,
    );
    expect(
      screen.getByRole("button", { name: "午前 ブース 2 架空いろは" }),
    ).toBeEnabled();
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
