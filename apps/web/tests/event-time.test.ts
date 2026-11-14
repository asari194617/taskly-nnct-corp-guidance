import { describe, expect, it } from "vitest";
import {
  getEventTimeState,
  parseScheduleInstant,
  formatScheduleTime,
} from "../lib/event-time";
import { fixture } from "./fixtures";
import type { Slot } from "../lib/types";

const event = fixture();
const at = (instant: string, slots = event.schedule, date = event.event.date) =>
  getEventTimeState(date, slots, Date.parse(instant));

describe("event-day time in Asia/Tokyo", () => {
  it.each([
    ["2030-05-13T23:59:59+09:00", false, null, "outside", null, "23:59"],
    ["2030-05-14T00:00:00+09:00", true, "AM", "before", null, "00:00"],
    ["2030-05-14T09:00:00+09:00", true, "AM", "current", "term-1", "09:00"],
    ["2030-05-14T09:04:59.999+09:00", true, "AM", "current", "term-1", "09:04"],
    ["2030-05-14T09:05:00+09:00", true, "AM", "gap", null, "09:05"],
    ["2030-05-14T09:10:00+09:00", true, "AM", "current", "term-2", "09:10"],
    ["2030-05-14T11:59:59+09:00", true, "AM", "gap", null, "11:59"],
    ["2030-05-14T12:00:00+09:00", true, "PM", "gap", null, "12:00"],
    ["2030-05-14T12:59:59+09:00", true, "PM", "gap", null, "12:59"],
    ["2030-05-14T13:00:00+09:00", true, "PM", "current", "term-5", "13:00"],
    ["2030-05-14T13:35:00+09:00", true, "PM", "ended", null, "13:35"],
    ["2030-05-15T00:00:00+09:00", false, null, "outside", null, "00:00"],
  ] as const)(
    "classifies %s without relying on the machine timezone",
    (instant, isEventDay, automaticSession, phase, currentSlotId, timeLabel) => {
      expect(at(instant)).toMatchObject({
        isEventDay,
        automaticSession,
        phase,
        currentSlotId,
        timeLabel,
      });
    },
  );
  it("uses the JST date even while the same UTC instant is still on the previous day", () => {
    expect(at("2030-05-13T15:00:00Z")).toMatchObject({
      isEventDay: true,
      automaticSession: "AM",
      phase: "before",
      timeLabel: "00:00",
    });
    expect(at("2030-05-14T00:01:00Z")).toMatchObject({
      currentSlotId: "term-1",
      timeLabel: "09:01",
    });
    expect(at("2030-05-14T04:01:00Z")).toMatchObject({
      currentSlotId: "term-5",
      automaticSession: "PM",
      timeLabel: "13:01",
    });
  });
  it("keeps next and ended rows accurate through a break and after the last row", () => {
    expect(at("2030-05-14T09:00:00+09:00")).toMatchObject({
      nextSlotId: "term-2",
      endedSlotIds: [],
      nextBoundary: Date.parse("2030-05-14T09:05:00+09:00"),
    });
    expect(at("2030-05-14T09:05:00+09:00")).toMatchObject({
      nextSlotId: "term-2",
      endedSlotIds: ["term-1"],
      nextBoundary: Date.parse("2030-05-14T09:10:00+09:00"),
    });
    expect(at("2030-05-14T13:35:00+09:00")).toMatchObject({
      nextSlotId: null,
      endedSlotIds: event.schedule.map((slot) => slot.id),
    });
  });
  it.each([
    "2030-05-14T09:00:00",
    "2030-05-14T09:00:00+09:00",
    "2030-05-14T00:00:00Z",
  ])("accepts unambiguous schedule times: %s", (start) => {
    const end = start.endsWith("Z")
      ? "2030-05-14T00:05:00Z"
      : start.includes("+09:00")
        ? "2030-05-14T09:05:00+09:00"
        : "2030-05-14T09:05:00";
    expect(
      at("2030-05-14T00:01:00Z", [{ ...event.schedule[0], start, end }]),
    ).toMatchObject({ currentSlotId: "term-1", phase: "current" });
  });
  it("ignores malformed or nonpositive intervals instead of selecting them", () => {
    const invalid: Slot[] = [
      { ...event.schedule[0], id: "invalid-time", start: "25:00" },
      { ...event.schedule[0], id: "missing-time", start: "invalid" },
      { ...event.schedule[0], id: "zero", end: "09:00" },
      { ...event.schedule[0], id: "reversed", end: "08:00" },
    ];
    expect(
      at("2030-05-14T09:01:00+09:00", [...invalid, ...event.schedule])
        .currentSlotId,
    ).toBe("term-1");
    expect(at("2030-05-14T09:01:00+09:00", invalid).currentSlotId).toBeNull();
  });
  it("handles an absent schedule and invalid event dates without a current row", () => {
    expect(at("2030-05-14T09:01:00+09:00", []).currentSlotId).toBeNull();
    for (const date of ["", "invalid", "2030-02-30"])
      expect(
        at("2030-05-14T09:01:00+09:00", event.schedule, date),
      ).toMatchObject({
        isEventDay: false,
        currentSlotId: null,
        automaticSession: null,
      });
    expect(
      getEventTimeState(event.event.date, event.schedule, Number.NaN)
        .currentSlotId,
    ).toBeNull();
  });
  it("parses valid second/fraction values and refuses malformed clock components", () => {
    expect(parseScheduleInstant(event.event.date, "9:01:02.125")).toBe(
      Date.parse("2030-05-14T09:01:02.125+09:00"),
    );
    for (const value of [
      "09:60",
      "09:00:60",
      "2030-02-30T09:00",
      "2030-05-14T09:00+25:00",
      "noon",
    ])
      expect(parseScheduleInstant(event.event.date, value)).toBeNull();
    expect(parseScheduleInstant("invalid", "09:00")).toBeNull();
  });
  it("formats clock and offset timestamps as JST and preserves invalid labels", () => {
    expect(formatScheduleTime("9:05:03.125")).toBe("09:05");
    expect(formatScheduleTime("2030-05-14T00:01:00Z")).toBe("09:01");
    expect(formatScheduleTime("invalid")).toBe("invalid");
    expect(formatScheduleTime("25:00")).toBe("25:00");
  });
  it("does not let a timestamp from another date create a current event row", () => {
    const foreign = {
      ...event.schedule[0],
      start: "2030-05-15T09:00:00+09:00",
      end: "2030-05-15T09:05:00+09:00",
    };
    expect(at("2030-05-14T09:01:00+09:00", [foreign])).toMatchObject({
      phase: "unavailable",
      currentSlotId: null,
      nextSlotId: null,
    });
  });
});
