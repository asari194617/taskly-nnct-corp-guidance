"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, APIError } from "../lib/api";
import type {
  HomeTask,
  HomeTaskUpdateResponse,
  HomeTasksResponse,
} from "../lib/types";
import {
  readOfflineHome,
  saveOfflineHome,
  deleteOfflineHome,
  type OfflineSession,
} from "../lib/offline-store";
import { useOffline } from "./offline-context";

type Snapshot = {
  data: HomeTasksResponse | null;
  loading: boolean;
  error: string;
  pending: ReadonlySet<string>;
  readonly: boolean;
};

function completionPartner(task: HomeTask, tasks: HomeTask[]) {
  if (
    typeof task.term !== "number" ||
    !Number.isInteger(task.term) ||
    task.term <= 0
  )
    return;
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
  const offline = useOffline();
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const [state, setState] = useState<Snapshot>({
    data: null,
    loading: true,
    error: "",
    pending: new Set(),
    readonly: offline.offline,
  });
  const snapshot = useRef(state);
  const confirmed = useRef<HomeTasksResponse | null>(null);
  const activeScope = useRef(offline.session?.scope || "");
  const mounted = useRef(true);
  const generation = useRef(0);
  const mutations = useRef(new Map<string, number>());
  const writeFailures = useRef(0);
  const pending = useRef(new Set<string>());
  const read = useRef<AbortController | null>(null);
  const writes = useRef(new Set<AbortController>());
  const homeForbidden = useRef(false);
  const homeDeletion = useRef<Promise<void> | null>(null);
  const update = useCallback((change: (previous: Snapshot) => Snapshot) => {
    const next = change(snapshot.current);
    snapshot.current = next;
    setState(next);
  }, []);

  const currentRequest = useCallback(
    (requestGeneration: number, session: OfflineSession | null) =>
      mounted.current &&
      requestGeneration === generation.current &&
      session?.generation === offlineRef.current.session?.generation &&
      session?.scope === offlineRef.current.session?.scope,
    [],
  );
  const persistConfirmed = useCallback((session: OfflineSession | null) => {
    if (session && confirmed.current)
      void saveOfflineHome(session, confirmed.current).catch(() => {});
  }, []);
  const forbidHome = useCallback(
    async (session: OfflineSession | null) => {
      if (
        !mounted.current ||
        session?.generation !== offlineRef.current.session?.generation ||
        session?.scope !== offlineRef.current.session?.scope
      )
        return;
      // Revoke this home generation before awaiting storage: an older accepted
      // write must never resurrect a snapshot that the server has forbidden.
      generation.current++;
      homeForbidden.current = true;
      read.current?.abort();
      read.current = null;
      for (const controller of writes.current) controller.abort();
      writes.current.clear();
      pending.current.clear();
      mutations.current.clear();
      confirmed.current = null;
      update(() => ({
        data: null,
        loading: false,
        error: "やることを利用できません。",
        pending: new Set(),
        readonly: true,
      }));
      const deletion = session
        ? deleteOfflineHome(session).catch(() => {})
        : Promise.resolve();
      homeDeletion.current = deletion;
      await deletion;
      if (homeDeletion.current === deletion) homeDeletion.current = null;
    },
    [update],
  );
  const restore = useCallback(
    async (requestGeneration: number) => {
      const session = offlineRef.current.session;
      if (homeDeletion.current) await homeDeletion.current;
      if (!currentRequest(requestGeneration, session)) return;
      if (homeForbidden.current) {
        update(() => ({
          data: null,
          loading: false,
          error: "やることを利用できません。",
          pending: new Set(),
          readonly: true,
        }));
        return;
      }
      const cached = session ? await readOfflineHome(session) : null;
      if (!currentRequest(requestGeneration, session)) return;
      const sameScope = (session?.scope || "") === activeScope.current;
      const memoryValid =
        sameScope && (!session || session.expiresAt > Date.now());
      const data = cached?.data || (memoryValid ? confirmed.current : null);
      if (cached) confirmed.current = cached.data;
      update(() => ({
        data,
        loading: false,
        error: data ? "" : "オフラインで表示できるやることは未取得です。",
        pending: new Set(),
        readonly: true,
      }));
    },
    [currentRequest, update],
  );

  const refresh = useCallback(async () => {
    if (homeDeletion.current) await homeDeletion.current;
    if (
      !mounted.current ||
      document.visibilityState === "hidden" ||
      read.current
    )
      return;
    const requestGeneration = generation.current;
    const session = offlineRef.current.session;
    if (offlineRef.current.offline) {
      await restore(requestGeneration);
      return;
    }
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
      if (!currentRequest(requestGeneration, session)) return;
      homeForbidden.current = false;
      confirmed.current = {
        ...data,
        tasks: data.tasks.map((task) => {
          const changed =
            mutations.current.get(task.id) !== baseline.get(task.id);
          return changed ||
            pendingAtStart.has(task.id) ||
            pending.current.has(task.id)
            ? confirmed.current?.tasks.find(
                (current) => current.id === task.id,
              ) || task
            : task;
        }),
      };
      persistConfirmed(session);
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
        readonly: false,
      }));
    } catch (cause) {
      if (
        !currentRequest(requestGeneration, session) ||
        (controller.signal.aborted && !timedOut)
      )
        return;
      if (cause instanceof APIError && cause.status === 401) onExpired();
      else if (cause instanceof APIError && cause.status === 403) {
        await forbidHome(session);
      } else if (
        offlineRef.current.session &&
        (cause instanceof TypeError || timedOut)
      ) {
        offlineRef.current.onOffline();
        await restore(requestGeneration);
      } else
        update((previous) => ({
          ...previous,
          loading: false,
          error: "やることを取得できませんでした。もう一度お試しください。",
        }));
    } finally {
      clearTimeout(timer);
      if (read.current === controller) read.current = null;
    }
  }, [
    onExpired,
    currentRequest,
    forbidHome,
    persistConfirmed,
    restore,
    update,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new authenticated session generation must abort and refetch even when the account/profile scope stays the same.
  useEffect(() => {
    mounted.current = true;
    const scope = offline.session?.scope || "";
    const changedScope = scope !== activeScope.current;
    activeScope.current = scope;
    if (changedScope) {
      confirmed.current = null;
      homeForbidden.current = false;
      homeDeletion.current = null;
    }
    pending.current.clear();
    update((previous) => ({
      ...previous,
      data: changedScope ? null : confirmed.current || previous.data,
      pending: new Set(),
      readonly: previous.readonly || offline.offline,
    }));
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
    window.addEventListener("online", resume);
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
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [
    refresh,
    offline.offline,
    offline.session?.generation,
    offline.session?.scope,
    update,
  ]);

  const toggle = useCallback(
    async (id: string) => {
      const currentTasks = snapshot.current.data?.tasks;
      const original = currentTasks?.find((task) => task.id === id);
      if (
        !mounted.current ||
        offlineRef.current.offline ||
        navigator.onLine === false ||
        snapshot.current.readonly ||
        !currentTasks ||
        !original ||
        pending.current.has(id) ||
        (original.completion_disabled && !original.completed) ||
        snapshot.current.error
      )
        return;
      const partner = completionPartner(original, currentTasks);
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
      const session = offlineRef.current.session;
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
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15_000);
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
        if (!currentRequest(requestGeneration, session)) return;
        const { related_tasks: related, ...task } = response;
        if (
          task.id !== id ||
          task.kind !== original.kind ||
          task.term !== original.term
        )
          throw new Error("Unexpected task response");
        if (related !== undefined && !Array.isArray(related))
          throw new Error("Unexpected related tasks");
        const relatedTask = related?.[0];
        if (partner) {
          if (
            related?.length !== 1 ||
            !relatedTask ||
            relatedTask.id !== partner.id ||
            relatedTask.kind !== partner.kind ||
            relatedTask.term !== original.term
          )
            throw new Error("Missing or unexpected related task response");
        } else if (related?.length) throw new Error("Unexpected related tasks");
        const acceptedTasks = new Map<string, HomeTask>([[id, task]]);
        if (partner && relatedTask) acceptedTasks.set(partner.id, relatedTask);
        // Persist one authoritative snapshot for the entire accepted pair.
        // The UI may also contain other optimistic writes, which must not enter storage.
        if (confirmed.current) {
          confirmed.current = {
            ...confirmed.current,
            tasks: confirmed.current.tasks.map(
              (current) => acceptedTasks.get(current.id) || current,
            ),
          };
          persistConfirmed(session);
        }
        update((previous) => ({
          ...previous,
          data: previous.data
            ? {
                ...previous.data,
                tasks: previous.data.tasks.map(
                  (current) => acceptedTasks.get(current.id) || current,
                ),
              }
            : null,
        }));
      } catch (cause) {
        if (!currentRequest(requestGeneration, session)) return;
        if (cause instanceof APIError && cause.status === 401) onExpired();
        else if (cause instanceof APIError && cause.status === 403) {
          await forbidHome(session);
        } else {
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
          if (
            offlineRef.current.session &&
            (cause instanceof TypeError || timedOut)
          ) {
            offlineRef.current.onOffline();
            await restore(requestGeneration);
          }
        }
      } finally {
        clearTimeout(timer);
        writes.current.delete(controller);
        if (currentRequest(requestGeneration, session)) {
          for (const key of originals.keys()) pending.current.delete(key);
          update((previous) => ({
            ...previous,
            pending: new Set(pending.current),
          }));
        }
      }
    },
    [onExpired, currentRequest, forbidHome, persistConfirmed, restore, update],
  );

  return { ...state, refresh, toggle };
}
