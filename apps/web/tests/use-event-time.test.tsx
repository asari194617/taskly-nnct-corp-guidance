import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEventTime } from "../components/use-event-time";
import { fixture } from "./fixtures";

const data = fixture();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-05-14T09:04:59+09:00"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
describe("live event clock lifecycle", () => {
  it("updates the clock label and half-open current interval without user interaction", () => {
    const { result } = renderHook(() =>
      useEventTime(data.event.date, data.schedule),
    );
    expect(result.current.currentSlotId).toBe("term-1");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toMatchObject({
      phase: "gap",
      currentSlotId: null,
      nextSlotId: "term-2",
      timeLabel: "09:05",
    });
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(result.current).toMatchObject({
      phase: "current",
      currentSlotId: "term-2",
      timeLabel: "09:10",
    });
  });
  it("switches the automatic session exactly at noon, independently of the next slot", () => {
    vi.setSystemTime(new Date("2030-05-14T11:59:59+09:00"));
    const { result } = renderHook(() =>
      useEventTime(data.event.date, data.schedule),
    );
    expect(result.current.automaticSession).toBe("AM");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toMatchObject({
      automaticSession: "PM",
      phase: "gap",
      currentSlotId: null,
      nextSlotId: "term-5",
    });
  });
  it.each(["visibilitychange", "focus", "pageshow"])(
    "refreshes a suspended clock on %s without waiting for the old timer",
    (event) => {
      const { result } = renderHook(() =>
        useEventTime(data.event.date, data.schedule),
      );
      act(() => {
        vi.setSystemTime(new Date("2030-05-14T13:01:00+09:00"));
        (event === "visibilitychange" ? document : window).dispatchEvent(
          new Event(event),
        );
      });
      expect(result.current).toMatchObject({
        automaticSession: "PM",
        currentSlotId: "term-5",
        timeLabel: "13:01",
      });
    },
  );
  it("removes timers and browser listeners on unmount", () => {
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() =>
      useEventTime(data.event.date, data.schedule),
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeDocument).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("pageshow", expect.any(Function));
  });
  it("recomputes when schedule data changes and rolls outside after JST midnight", () => {
    const { result, rerender } = renderHook(
      ({ date, slots }) => useEventTime(date, slots),
      { initialProps: { date: data.event.date, slots: data.schedule } },
    );
    rerender({ date: "2030-05-15", slots: data.schedule });
    expect(result.current.isEventDay).toBe(false);
    rerender({ date: data.event.date, slots: [] });
    expect(result.current).toMatchObject({
      isEventDay: true,
      phase: "unavailable",
      currentSlotId: null,
    });
    act(() => {
      vi.setSystemTime(new Date("2030-05-14T23:59:59+09:00"));
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toMatchObject({
      isEventDay: false,
      automaticSession: null,
      currentSlotId: null,
    });
  });
  it("suspends timer work while hidden and refreshes immediately when visible", () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { result } = renderHook(() =>
      useEventTime(data.event.date, data.schedule),
    );
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.setSystemTime(new Date("2030-05-14T09:10:00+09:00"));
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.currentSlotId).toBe("term-2");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});
