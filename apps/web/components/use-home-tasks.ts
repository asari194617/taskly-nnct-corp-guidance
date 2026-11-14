"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, APIError } from "../lib/api";
import type {
  HomeTask,
  HomeTaskUpdateResponse,
  HomeTasksResponse,
} from "../lib/types";

type Snapshot = {
  data: HomeTasksResponse | null;
  loading: boolean;
  error: string;
  pending: ReadonlySet<string>;
};

function completionPartner(task: HomeTask, tasks: HomeTask[]) {
  if (!Number.isInteger(task.term) || task.term! <= 0) return;
  const partnerKind =
    task.kind === "visit_survey"
      ? "assigned_visit"
      : task.kind === "assigned_visit" && task.completed
        ? "visit_survey"
        : undefined;
  if (!partnerKind) return;
  const matches = tasks.filter(
    (candidate) =>
      candidate.kind === partnerKind && candidate.term === task.term,
  );
  return matches.length === 1 && matches[0].id !== task.id
    ? matches[0]
    : undefined;
}
function manualCompletion(task: HomeTask, completed: boolean): HomeTask {
  const changed = { ...task, completed };
  delete changed.auto_completed_by;
  return changed;
}

/** A mounted dashboard owns one account/profile scope; Taskly is the source of truth. */
export function useHomeTasks(onExpired: () => void) {
  const [state, setState] = useState<Snapshot>({
    data: null,
    loading: true,
    error: "",
    pending: new Set(),
  });
  const snapshot = useRef(state);
  const mounted = useRef(true);
  const generation = useRef(0);
  const mutations = useRef(new Map<string, number>());
  const writeFailures = useRef(0);
  const pending = useRef(new Set<string>());
  const read = useRef<AbortController | null>(null);
  const writes = useRef(new Set<AbortController>());
  const update = useCallback((change: (previous: Snapshot) => Snapshot) => {
    const next = change(snapshot.current);
    snapshot.current = next;
    setState(next);
  }, []);

  const refresh = useCallback(async () => {
    if (
      !mounted.current ||
      document.visibilityState === "hidden" ||
      read.current
    )
      return;
    const requestGeneration = generation.current;
    const baseline = new Map(mutations.current);
    const pendingAtStart = new Set(pending.current);
    const failuresAtStart = writeFailures.current;
    const controller = new AbortController();
    read.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    update((previous) => ({ ...previous, loading: previous.data === null }));
    try {
      const data = await api<HomeTasksResponse>("/api/home", {
        signal: controller.signal,
      });
      if (!mounted.current || requestGeneration !== generation.current) return;
      update((previous) => ({
        data: {
          ...data,
          tasks: data.tasks.map((task) => {
            const changed =
              mutations.current.get(task.id) !== baseline.get(task.id);
            return changed ||
              pendingAtStart.has(task.id) ||
              pending.current.has(task.id)
              ? previous.data?.tasks.find(
                  (current) => current.id === task.id,
                ) || task
              : task;
          }),
        },
        loading: false,
        error: writeFailures.current === failuresAtStart ? "" : previous.error,
        pending: previous.pending,
      }));
    } catch (cause) {
      if (
        !mounted.current ||
        requestGeneration !== generation.current ||
        (controller.signal.aborted && !timedOut)
      )
        return;
      if (cause instanceof APIError && cause.status === 401) onExpired();
      else
        update((previous) => ({
          ...previous,
          loading: false,
          error: "やることを取得できませんでした。もう一度お試しください。",
        }));
    } finally {
      clearTimeout(timer);
      if (read.current === controller) read.current = null;
    }
  }, [onExpired, update]);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resume = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      void refresh();
      timer = setTimeout(resume, 30_000);
    };
    resume();
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      mounted.current = false;
      generation.current++;
      if (timer !== undefined) clearTimeout(timer);
      read.current?.abort();
      read.current = null;
      for (const request of writes.current) request.abort();
      writes.current.clear();
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);

  const toggle = useCallback(
    async (id: string) => {
      const original = snapshot.current.data?.tasks.find(
        (task) => task.id === id,
      );
      if (
        !mounted.current ||
        !original ||
        pending.current.has(id) ||
        (original.completion_disabled && !original.completed) ||
        snapshot.current.error
      )
        return;
      const partner = completionPartner(original, snapshot.current.data!.tasks);
      const originals = new Map<string, HomeTask>([
        [original.id, original],
        ...(partner ? [[partner.id, partner] as const] : []),
      ]);
      if ([...originals.keys()].some((key) => pending.current.has(key))) return;
      const completed = !original.completed;
      // If completing the partner is forbidden, wait for the server's atomic
      // rejection instead of showing only half of the pair as completed.
      const blockedPartner = Boolean(
        partner &&
        completed &&
        partner.completion_disabled &&
        !partner.completed,
      );
      const requestGeneration = generation.current;
      for (const key of originals.keys()) {
        mutations.current.set(key, (mutations.current.get(key) || 0) + 1);
        pending.current.add(key);
      }
      update((previous) => ({
        ...previous,
        data: previous.data
          ? {
              ...previous.data,
              tasks: previous.data.tasks.map((task) => {
                if (blockedPartner) return task;
                if (task.id === original.id)
                  return original.kind === "assigned_visit"
                    ? manualCompletion(task, completed)
                    : { ...task, completed };
                if (partner && task.id === partner.id) {
                  if (original.kind === "assigned_visit")
                    return original.auto_completed_by === partner.id
                      ? { ...task, completed: false }
                      : task;
                  if (completed && !partner.completed)
                    return {
                      ...task,
                      completed: true,
                      auto_completed_by: original.id,
                    };
                  if (!completed && partner.auto_completed_by === original.id)
                    return manualCompletion(task, false);
                }
                return task;
              }),
            }
          : null,
        pending: new Set(pending.current),
        error: "",
      }));
      const controller = new AbortController();
      writes.current.add(controller);
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await api<HomeTaskUpdateResponse>(
          `/api/home/tasks/${encodeURIComponent(id)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ completed }),
            signal: controller.signal,
          },
        );
        if (!mounted.current || requestGeneration !== generation.current)
          return;
        const { related_tasks: related, ...task } = response;
        if (
          task.id !== id ||
          task.kind !== original.kind ||
          task.term !== original.term
        )
          throw new Error("Unexpected task response");
        if (related !== undefined && !Array.isArray(related))
          throw new Error("Unexpected related tasks");
        if (partner) {
          if (
            related?.length !== 1 ||
            related[0].id !== partner.id ||
            related[0].kind !== partner.kind ||
            related[0].term !== original.term
          )
            throw new Error("Missing or unexpected related task response");
        } else if (related?.length) throw new Error("Unexpected related tasks");
        const confirmed = new Map<string, HomeTask>([[id, task]]);
        if (partner) confirmed.set(partner.id, related![0]);
        update((previous) => ({
          ...previous,
          data: previous.data
            ? {
                ...previous.data,
                tasks: previous.data.tasks.map(
                  (current) => confirmed.get(current.id) || current,
                ),
              }
            : null,
        }));
      } catch (cause) {
        if (!mounted.current || requestGeneration !== generation.current)
          return;
        if (cause instanceof APIError && cause.status === 401) onExpired();
        else {
          writeFailures.current++;
          update((previous) => ({
            ...previous,
            data: previous.data
              ? {
                  ...previous.data,
                  tasks: previous.data.tasks.map(
                    (task) => originals.get(task.id) || task,
                  ),
                }
              : null,
            error:
              cause instanceof APIError && cause.status === 409
                ? "Tasklyでタスクの状態を確認してください。"
                : "完了状態を更新できませんでした。もう一度お試しください。",
          }));
        }
      } finally {
        clearTimeout(timer);
        writes.current.delete(controller);
        for (const key of originals.keys()) pending.current.delete(key);
        if (mounted.current && requestGeneration === generation.current)
          update((previous) => ({
            ...previous,
            pending: new Set(pending.current),
          }));
      }
    },
    [onExpired, update],
  );

  return { ...state, refresh, toggle };
}
