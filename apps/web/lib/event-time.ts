import type { Slot } from "./types";

export type EventTimeState = {
  isEventDay: boolean;
  automaticSession: "AM" | "PM" | null;
  currentSlotId: string | null;
  nextSlotId: string | null;
  endedSlotIds: string[];
  phase: "outside" | "unavailable" | "before" | "current" | "gap" | "ended";
  timeLabel: string;
  nextBoundary: number | null;
};

const tokyoFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const clockPattern = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;
const isoPattern =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?$/;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

function tokyoParts(now: number) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    return null;
  const parts = Object.fromEntries(
    tokyoFormatter
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** A wall-clock schedule value is always interpreted in Japan, never the device zone. */
export function parseScheduleInstant(
  eventDate: string,
  value: string,
): number | null {
  const clock = clockPattern.exec(value);
  if (clock) {
    if (
      !validDate(eventDate) ||
      Number(clock[1]) > 23 ||
      Number(clock[2]) > 59 ||
      Number(clock[3] || 0) > 59
    )
      return null;
    const normalized = `${clock[1].padStart(2, "0")}:${clock[2]}:${clock[3] || "00"}${clock[4] || ""}`;
    return Date.parse(`${eventDate}T${normalized}+09:00`);
  }
  const iso = isoPattern.exec(value);
  if (
    !iso ||
    !validDate(iso[1]) ||
    parseScheduleInstant(iso[1], iso[2]) === null
  )
    return null;
  const result = Date.parse(`${iso[1]}T${iso[2]}${iso[3] || "+09:00"}`);
  return Number.isFinite(result) ? result : null;
}

export function formatScheduleTime(value: string): string {
  const clock = clockPattern.exec(value);
  if (
    clock &&
    Number(clock[1]) < 24 &&
    Number(clock[2]) < 60 &&
    Number(clock[3] || 0) < 60
  ) {
    return `${clock[1].padStart(2, "0")}:${clock[2]}`;
  }
  const instant = parseScheduleInstant(value.slice(0, 10), value);
  return instant === null ? value : tokyoParts(instant)?.time || value;
}

/** Pure, clock-injected event state; only the imported event date enables live mode. */
export function getEventTimeState(
  eventDate: string,
  slots: Slot[],
  now: number,
): EventTimeState {
  const parts = tokyoParts(now);
  const isEventDay = Boolean(
    parts && validDate(eventDate) && parts.date === eventDate,
  );
  const base: EventTimeState = {
    isEventDay,
    automaticSession:
      isEventDay && parts ? (parts.hour < 12 ? "AM" : "PM") : null,
    currentSlotId: null,
    nextSlotId: null,
    endedSlotIds: [],
    phase: "outside",
    timeLabel: parts?.time || "",
    nextBoundary: null,
  };
  if (!isEventDay) return base;
  const timed = slots
    .flatMap((slot) => {
      const start = parseScheduleInstant(eventDate, slot.start);
      const end = parseScheduleInstant(eventDate, slot.end);
      return start !== null &&
        end !== null &&
        end > start &&
        tokyoParts(start)?.date === eventDate
        ? [{ slot, start, end }]
        : [];
    })
    .sort((a, b) => a.start - b.start);
  if (!timed.length) return { ...base, phase: "unavailable" };
  // A later-starting row wins an overlap; normal imported rows do not overlap.
  const current = timed
    .filter((item) => item.start <= now && now < item.end)
    .at(-1);
  const next = timed.find((item) => item.start > now);
  const boundaries = timed
    .flatMap((item) => [item.start, item.end])
    .filter((value) => value > now);
  return {
    ...base,
    currentSlotId: current?.slot.id || null,
    nextSlotId: next?.slot.id || null,
    endedSlotIds: timed
      .filter((item) => item.end <= now)
      .map((item) => item.slot.id),
    phase: current
      ? "current"
      : next
        ? now < timed[0].start
          ? "before"
          : "gap"
        : "ended",
    nextBoundary: boundaries.length ? Math.min(...boundaries) : null,
  };
}
