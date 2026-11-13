"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, APIError } from "../lib/api";
import type { HomeTask, HomeTasksResponse } from "../lib/types";

type Snapshot = {
  data: HomeTasksResponse | null;
  loading: boolean;
  error: string;
  pending: ReadonlySet<string>;
};

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
      const requestGeneration = generation.current;
      const version = (mutations.current.get(id) || 0) + 1;
      mutations.current.set(id, version);
      pending.current.add(id);
      update((previous) => ({
        ...previous,
        data: previous.data
          ? {
              ...previous.data,
              tasks: previous.data.tasks.map((task) =>
                task.id === id
                  ? { ...task, completed: !original.completed }
                  : task,
              ),
            }
          : null,
        pending: new Set(pending.current),
        error: "",
      }));
      const controller = new AbortController();
      writes.current.add(controller);
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const task = await api<HomeTask>(
          `/api/home/tasks/${encodeURIComponent(id)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ completed: !original.completed }),
            signal: controller.signal,
          },
        );
        if (!mounted.current || requestGeneration !== generation.current)
          return;
        if (task.id !== id) throw new Error("Unexpected task response");
        update((previous) => ({
          ...previous,
          data: previous.data
            ? {
                ...previous.data,
                tasks: previous.data.tasks.map((current) =>
                  current.id === id ? task : current,
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
                  tasks: previous.data.tasks.map((task) =>
                    task.id === id
                      ? { ...task, completed: original.completed }
                      : task,
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
        pending.current.delete(id);
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
