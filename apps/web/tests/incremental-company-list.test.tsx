import { requireValue } from "./required";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IncrementalCompanyList from "../components/incremental-company-list";
import type { Company } from "../lib/types";
import { largeFixture } from "./fixtures";

const companies = largeFixture().companies;
let observers: Observer[];
class Observer {
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = () => [];
  root = null;
  rootMargin = "320px";
  thresholds = [0];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  enter(intersecting = true, duplicate = false) {
    const target = this.observe.mock.calls[0]?.[0] as Element;
    const entry = {
      isIntersecting: intersecting,
      target,
    } as IntersectionObserverEntry;
    act(() =>
      this.callback(
        duplicate ? [entry, entry] : [entry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
}
function list(items: Company[] = companies, resetKey = "directory") {
  return (
    <IncrementalCompanyList companies={items} resetKey={resetKey}>
      {(company) => (
        <article>
          <a href={`/?company=${company.id}`}>{company.name}</a>
        </article>
      )}
    </IncrementalCompanyList>
  );
}
const rendered = () => screen.queryAllByRole("article");
const newest = () => observers[observers.length - 1];
beforeEach(() => {
  observers = [];
  vi.stubGlobal("IntersectionObserver", Observer);
});

describe("incremental company rendering", () => {
  it("renders one bounded page initially and no paging controls for a small catalog", () => {
    const { rerender } = render(list());
    expect(rendered()).toHaveLength(24);
    expect(screen.getByRole("status")).toHaveTextContent("24 / 125社");
    expect(
      screen.getByRole("button", { name: "もっと見る" }),
    ).toBeInTheDocument();
    rerender(list(companies.slice(0, 8)));
    expect(rendered()).toHaveLength(8);
    expect(
      screen.queryByRole("button", { name: "もっと見る" }),
    ).not.toBeInTheDocument();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
  it("adds only one page per intersection batch without moving keyboard focus", () => {
    render(
      <>
        <button type="button">操作中の項目</button>
        {list()}
      </>,
    );
    const focused = screen.getByRole("button", { name: "操作中の項目" });
    focused.focus();
    newest().enter(false);
    expect(rendered()).toHaveLength(24);
    newest().enter(true, true);
    expect(rendered()).toHaveLength(48);
    expect(focused).toHaveFocus();
    newest().enter();
    expect(rendered()).toHaveLength(72);
    expect(screen.getByRole("status")).toHaveTextContent("72 / 125社");
  });
  it("ignores a second positive callback queued before the first append commits", () => {
    render(list());
    const observer = newest();
    const entry = {
      isIntersecting: true,
      target: observer.observe.mock.calls[0][0],
    } as IntersectionObserverEntry;
    act(() => {
      observer.callback([entry], observer as unknown as IntersectionObserver);
      observer.callback([entry], observer as unknown as IntersectionObserver);
    });
    expect(rendered()).toHaveLength(48);
  });

  it("provides an explicit keyboard fallback and moves focus to the first newly revealed company", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(list());
    const more = screen.getByRole("button", { name: "もっと見る" });
    more.focus();
    await userEvent.keyboard("{Enter}");
    expect(rendered()).toHaveLength(48);
    expect(within(rendered()[24]).getByRole("link")).toHaveFocus();
  });
  it("caps the last page to the result count and removes controls when all results are visible", async () => {
    render(list(companies.slice(0, 53)));
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(rendered()).toHaveLength(48);
    await userEvent.click(screen.getByRole("button", { name: "もっと見る" }));
    expect(rendered()).toHaveLength(53);
    expect(
      screen.queryByRole("button", { name: "もっと見る" }),
    ).not.toBeInTheDocument();
    expect(within(rendered()[48]).getByRole("link")).toHaveFocus();
  });
  it("retains a focused fallback button when the observer reveals the final batch", () => {
    render(
      <>
        <button type="button">次の操作</button>
        {list(companies.slice(0, 53))}
      </>,
    );
    newest().enter();
    const more = screen.getByRole("button", { name: "もっと見る" });
    act(() => more.focus());
    newest().enter();
    expect(rendered()).toHaveLength(53);
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute("aria-disabled", "true");
    expect(more).toHaveTextContent("すべて表示しました");
    fireEvent.click(more);
    expect(rendered()).toHaveLength(53);
    act(() => screen.getByRole("button", { name: "次の操作" }).focus());
    expect(
      screen.queryByRole("button", { name: "すべて表示しました" }),
    ).not.toBeInTheDocument();
  });

  it("resets on a new filter and rejects queued callbacks from the old observer", () => {
    const { rerender } = render(list());
    newest().enter();
    expect(rendered()).toHaveLength(48);
    const previous = newest();
    rerender(list(companies, "search:機械"));
    expect(rendered()).toHaveLength(24);
    expect(previous.disconnect).toHaveBeenCalled();
    previous.enter();
    expect(rendered()).toHaveLength(24);
    newest().enter();
    expect(rendered()).toHaveLength(48);
  });
  it("preserves the revealed count through membership and ordering changes for the same conditions", () => {
    const { rerender } = render(list());
    newest().enter();
    expect(rendered()).toHaveLength(48);
    rerender(list(companies.map((company) => ({ ...company }))));
    expect(rendered()).toHaveLength(48);
    rerender(list(companies.slice(1)));
    expect(rendered()).toHaveLength(48);
    rerender(list([...companies].reverse()));
    expect(rendered()).toHaveLength(48);
    expect(within(rendered()[0]).getByRole("link")).toHaveTextContent(
      requireValue(companies.at(-1)).name,
    );
  });
  it("disconnects on unmount and ignores an already queued intersection", () => {
    const { unmount } = render(list());
    const observer = newest();
    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
    expect(() => observer.enter()).not.toThrow();
  });
});
