"use client";

import { useEffect, useMemo, useState } from "react";
import { getEventTimeState } from "../lib/event-time";
import type { Slot } from "../lib/types";

const emptySlots: Slot[] = [];

/** Refresh at minute/slot boundaries and after returning to a suspended page. */
export function useEventTime(eventDate = "", slots: Slot[] = emptySlots) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer !== undefined) clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (document.visibilityState === "hidden") return;
      const state = getEventTimeState(eventDate, slots, current);
      const nextMinute = (Math.floor(current / 60_000) + 1) * 60_000;
      const next = Math.min(nextMinute, state.nextBoundary ?? nextMinute);
      timer = setTimeout(update, Math.max(1, next - current));
    };
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("pageshow", update);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("pageshow", update);
    };
  }, [eventDate, slots]);
  return useMemo(
    () => getEventTimeState(eventDate, slots, now ?? NaN),
    [eventDate, slots, now],
  );
}
