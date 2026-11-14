import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { IDBFactory } from "fake-indexeddb";
import { fixture } from "./fixtures";
import {
  OfflineProvider,
  type OfflineState,
} from "../components/offline-context";
import {
  readOfflineHome,
  saveOfflineHome,
  deleteOfflineHome,
} from "../lib/offline-store";

vi.mock("../lib/offline-store", () => ({
  readOfflineHome: vi.fn(),
  saveOfflineHome: vi.fn(),
  deleteOfflineHome: vi.fn(),
}));
import { useHomeTasks } from "../components/use-home-tasks";
import type { HomeTask, HomeTasksResponse } from "../lib/types";

function task(
  id = "visit_survey:1",
  overrides: Partial<HomeTask> = {},
): HomeTask {
  return {
    id,
    kind: "visit_survey",
    title: `検証タスク ${id}`,
    completed: false,
    completion_disabled: false,
    taskly_url: `https://taskly.example.invalid/tasks/${encodeURIComponent(id)}`,
    term: 1,
    ...overrides,
  };
}
function home(
  tasks: HomeTask[] = [task(), task("visit_survey:2", { term: 2 })],
): HomeTasksResponse {
  return { event_id: "synthetic-event", roster_configured: true, tasks };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type FetchStub = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchStub>>;
let onExpired: ReturnType<typeof vi.fn<() => void>>;
let setVisibility: (state: DocumentVisibilityState) => void;
beforeEach(() => {
  vi.mocked(readOfflineHome).mockReset().mockResolvedValue(null);
  vi.mocked(saveOfflineHome).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteOfflineHome).mockReset().mockResolvedValue(undefined);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  setVisibility = (state) => {
    visibility.mockReturnValue(state);
  };
  onExpired = vi.fn<() => void>();
  fetchMock = vi.fn<FetchStub>().mockImplementation(async () => json(home()));
  vi.stubGlobal("fetch", fetchMock);
});

function offlineState(offline: boolean): OfflineState {
  return {
    offline,
    onOffline: vi.fn(),
    savedAt: Date.now(),
    session: {
      scope: "student-7",
      generation: "generation-1",
      expiresAt: Date.now() + 86_400_000,
    },
  };
}

describe("Taskly-backed home tasks", () => {
  it("loads the authoritative task snapshot with authenticated noncached requests", async () => {
    const read = deferred<Response>();
    fetchMock.mockReturnValueOnce(read.promise);
    const { result } = renderHook(() => useHomeTasks(onExpired));
    expect(result.current).toMatchObject({
      data: null,
      loading: true,
      error: "",
    });
    await act(async () => read.resolve(json(home())));
    expect(result.current.data).toEqual(home());
    expect(result.current.loading).toBe(false);
    expect(result.current.pending.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/home"),
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("optimistically updates independent keys and rolls back only the failed write", async () => {
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = deferred<Response>(),
      second = deferred<Response>();
    fetchMock.mockImplementation((input, init) => {
      if (init?.method !== "PUT") return Promise.resolve(json(home()));
      return String(input).endsWith("visit_survey%3A1")
        ? first.promise
        : second.promise;
    });
    let firstWrite!: Promise<void>, secondWrite!: Promise<void>;
    act(() => {
      firstWrite = result.current.toggle("visit_survey:1");
      secondWrite = result.current.toggle("visit_survey:2");
      void result.current.toggle("visit_survey:1");
    });
    expect(result.current.data?.tasks.map((row) => row.completed)).toEqual([
      true,
      true,
    ]);
    expect([...result.current.pending]).toEqual([
      "visit_survey:1",
      "visit_survey:2",
    ]);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/home/tasks/visit_survey%3A1"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ completed: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    await act(async () => {
      second.resolve(
        json(
          task("visit_survey:2", {
            term: 2,
            completed: true,
            title: "Tasklyで確認済み",
          }),
        ),
      );
      await secondWrite;
    });
    expect(result.current.pending.has("visit_survey:2")).toBe(false);
    expect(result.current.pending.has("visit_survey:1")).toBe(true);
    await act(async () => {
      first.reject(new Error("検証用の通信切断"));
      await firstWrite;
    });
    expect(result.current.data?.tasks.map((row) => row.completed)).toEqual([
      false,
      true,
    ]);
    expect(result.current.data?.tasks[1].title).toBe("Tasklyで確認済み");
    expect(result.current.pending.size).toBe(0);
    expect(result.current.error).toContain("完了状態を更新できませんでした");
  });

  it.each([409, 429, 503])(
    "rolls back rejected writes without automatically retrying (%s)",
    async (status) => {
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.data).not.toBeNull());
      fetchMock.mockResolvedValueOnce(
        json({ error: "synthetic_failure" }, status),
      );
      await act(async () => result.current.toggle("visit_survey:1"));
      expect(result.current.data?.tasks[0].completed).toBe(false);
      expect(result.current.pending.size).toBe(0);
      expect(result.current.error).toContain(
        status === 409
          ? "Tasklyでタスクの状態を確認"
          : "完了状態を更新できませんでした",
      );
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
      ).toHaveLength(1);
      expect(onExpired).not.toHaveBeenCalled();
    },
  );

  it("does not complete a disabled task, but permits undoing an existing completion", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        home([
          task("locked", { completion_disabled: true }),
          task("completed", { completion_disabled: true, completed: true }),
        ]),
      ),
    );
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.toggle("locked");
      await result.current.toggle("unknown");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(
      json(task("completed", { completion_disabled: true, completed: false })),
    );
    await act(async () => result.current.toggle("completed"));
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/tasks/completed"),
      expect.objectContaining({ body: JSON.stringify({ completed: false }) }),
    );
    expect(result.current.data?.tasks[1].completed).toBe(false);
  });

  it("rejects an unexpected task identity instead of replacing a different task", async () => {
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(
      json(task("unexpected", { completed: true })),
    );
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(result.current.data?.tasks.map((row) => row.id)).toEqual([
      "visit_survey:1",
      "visit_survey:2",
    ]);
    expect(result.current.data?.tasks[0].completed).toBe(false);
    expect(result.current.error).not.toBe("");
  });

  it.each(["read", "write"] as const)(
    "reports expired authentication from a %s",
    async (operation) => {
      if (operation === "read") fetchMock.mockResolvedValueOnce(json({}, 401));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      if (operation === "write") {
        await waitFor(() => expect(result.current.loading).toBe(false));
        fetchMock.mockResolvedValueOnce(json({}, 401));
        await act(async () => result.current.toggle("visit_survey:1"));
      }
      await waitFor(() => expect(onExpired).toHaveBeenCalledOnce());
    },
  );

  it("keeps the last snapshot on a read error and waits for successful synchronization before writes", async () => {
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await act(async () => result.current.refresh());
    expect(result.current.data).toEqual(home());
    expect(result.current.error).toContain("やることを取得できませんでした");
    const requests = fetchMock.mock.calls.length;
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    await act(async () => result.current.refresh());
    expect(result.current.error).toBe("");
    fetchMock.mockResolvedValueOnce(json(task(undefined, { completed: true })));
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(result.current.data?.tasks[0].completed).toBe(true);
  });

  it.each(["before", "during"] as const)(
    "does not let a read started %s a write overwrite its accepted result",
    async (ordering) => {
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const read = deferred<Response>(),
        write = deferred<Response>();
      fetchMock.mockImplementation((_, init) =>
        init?.method === "PUT" ? write.promise : read.promise,
      );
      let reading!: Promise<void>, writing!: Promise<void>;
      act(() => {
        if (ordering === "before") reading = result.current.refresh();
        writing = result.current.toggle("visit_survey:1");
        if (ordering === "during") reading = result.current.refresh();
      });
      await act(async () => {
        write.resolve(json(task(undefined, { completed: true })));
        await writing;
      });
      expect(result.current.pending.size).toBe(0);
      await act(async () => {
        read.resolve(json(home()));
        await reading;
      });
      expect(result.current.data?.tasks[0].completed).toBe(true);
      // A later Taskly change remains authoritative; optimistic protection is not permanent.
      fetchMock.mockResolvedValueOnce(json(home()));
      await act(async () => result.current.refresh());
      expect(result.current.data?.tasks[0].completed).toBe(false);
    },
  );

  it("does not let an older successful read clear a newer failed-write error", async () => {
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const read = deferred<Response>(),
      write = deferred<Response>();
    fetchMock.mockImplementation((_, init) =>
      init?.method === "PUT" ? write.promise : read.promise,
    );
    let reading!: Promise<void>, writing!: Promise<void>;
    act(() => {
      reading = result.current.refresh();
      writing = result.current.toggle("visit_survey:1");
    });
    await act(async () => {
      write.resolve(json({}, 503));
      await writing;
    });
    const error = result.current.error;
    expect(error).toContain("完了状態を更新できませんでした");
    await act(async () => {
      read.resolve(json(home()));
      await reading;
    });
    expect(result.current.error).toBe(error);
    expect(result.current.data?.tasks[0].completed).toBe(false);
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(json(home()));
    await act(async () => result.current.refresh());
    expect(result.current.error).toBe("");
    fetchMock.mockResolvedValueOnce(json(task(undefined, { completed: true })));
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(result.current.data?.tasks[0].completed).toBe(true);
  });

  it("discards old profile responses and expired-auth results after a roster remount", async () => {
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const previous = renderHook(() => useHomeTasks(onExpired));
    const oldSignal = fetchMock.mock.calls[0][1]!.signal as AbortSignal;
    previous.unmount();
    expect(oldSignal.aborted).toBe(true);
    fetchMock.mockResolvedValueOnce(
      json(
        home([
          task("assigned:1", {
            kind: "assigned_visit",
            company_id: "AM-2",
            title: "新しい指定企業",
          }),
        ]),
      ),
    );
    const current = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() =>
      expect(current.result.current.data?.tasks[0].company_id).toBe("AM-2"),
    );
    await act(async () => old.resolve(json({}, 401)));
    expect(onExpired).not.toHaveBeenCalled();
    expect(current.result.current.data?.tasks[0].title).toBe("新しい指定企業");
  });

  it("does not apply an old write or keep its busy state after an account/profile remount", async () => {
    const previous = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(previous.result.current.loading).toBe(false));
    const write = deferred<Response>();
    fetchMock.mockReturnValueOnce(write.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = previous.result.current.toggle("visit_survey:1");
    });
    const signal = fetchMock.mock.calls.at(-1)![1]!.signal as AbortSignal;
    previous.unmount();
    expect(signal.aborted).toBe(true);
    fetchMock.mockResolvedValueOnce(
      json(home([task(undefined, { title: "新しい利用者のタスク" })])),
    );
    const current = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(current.result.current.loading).toBe(false));
    await act(async () => {
      write.resolve(
        json(task(undefined, { completed: true, title: "以前の利用者" })),
      );
      await writing;
    });
    expect(current.result.current.pending.size).toBe(0);
    expect(current.result.current.data?.tasks[0]).toMatchObject({
      title: "新しい利用者のタスク",
      completed: false,
    });
  });

  it("deduplicates in-flight reads and syncs again when focus or page visibility returns", async () => {
    const read = deferred<Response>();
    fetchMock.mockReturnValueOnce(read.promise);
    const mounted = renderHook(() => useHomeTasks(onExpired));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => read.resolve(json(home())));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new Event("pageshow")));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    setVisibility("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    setVisibility("visible");
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    mounted.unmount();
  });

  it("polls only while visible and removes its timer/listeners on unmount", async () => {
    vi.useFakeTimers();
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    const mounted = renderHook(() => useHomeTasks(onExpired));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    mounted.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith("pageshow", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it.each(["read", "write"] as const)(
    "bounds a stalled %s and does not leave a task permanently busy",
    async (operation) => {
      vi.useFakeTimers();
      const stalled = (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      if (operation === "read") fetchMock.mockImplementationOnce(stalled);
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      let writing: Promise<void> | undefined;
      if (operation === "write") {
        fetchMock.mockImplementationOnce(stalled);
        act(() => {
          writing = result.current.toggle("visit_survey:1");
        });
        expect(result.current.pending.has("visit_survey:1")).toBe(true);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await writing;
      });
      expect(result.current.error).not.toBe("");
      expect(result.current.loading).toBe(false);
      expect(result.current.pending.size).toBe(0);
      expect(onExpired).not.toHaveBeenCalled();
    },
  );
  it("restores a scoped saved home read-only without sending requests or queuing writes", async () => {
    const state = offlineState(true);
    vi.mocked(readOfflineHome).mockResolvedValue({
      data: home(),
      savedAt: Date.now(),
    });
    const { result } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.data).toEqual(home()));
    expect(result.current.readonly).toBe(true);
    await act(async () => {
      await result.current.toggle("visit_survey:1");
      await result.current.refresh();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveOfflineHome).not.toHaveBeenCalled();
    expect(result.current.data?.tasks[0].completed).toBe(false);
  });

  it("explicitly reports a home that was never obtained offline", async () => {
    const state = offlineState(true);
    const { result } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toContain("未取得");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the last confirmed saved home on a transport failure and waits for fresh home before unlocking", async () => {
    let state = offlineState(false);
    const { result, rerender } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(readOfflineHome).mockResolvedValue({
      data: home(),
      savedAt: Date.now(),
    });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await act(async () => result.current.refresh());
    expect(state.onOffline).toHaveBeenCalledOnce();
    expect(result.current).toMatchObject({ data: home(), readonly: true });
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(0);
    const resumed = deferred<Response>();
    fetchMock.mockReturnValueOnce(resumed.promise);
    state = {
      ...state,
      session: { ...state.session!, generation: "revalidated" },
    };
    rerender();
    expect(result.current.readonly).toBe(true);
    await act(async () => resumed.resolve(json(home())));
    expect(result.current.readonly).toBe(false);
  });

  it("never restores home after an authentication rejection and clears an explicitly forbidden home", async () => {
    const state = offlineState(false);
    const { result } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await act(async () => result.current.refresh());
    expect(onExpired).toHaveBeenCalledOnce();
    expect(readOfflineHome).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({}, 403));
    await act(async () => result.current.refresh());
    expect(deleteOfflineHome).toHaveBeenCalledWith(state.session);
    expect(result.current.data).toBeNull();
    expect(result.current.readonly).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await act(async () => result.current.refresh());
    expect(result.current.data).toBeNull();
    expect(result.current.error).toContain("利用できません");
  });

  it("does not persist optimistic task completion or let a stale read overwrite confirmed writes", async () => {
    const state = offlineState(false);
    let cached = home();
    vi.mocked(saveOfflineHome).mockImplementation(async (_session, data) => {
      cached = structuredClone(data);
    });
    vi.mocked(readOfflineHome).mockImplementation(async () => ({
      data: cached,
      savedAt: Date.now(),
    }));
    const { result } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = deferred<Response>(),
      second = deferred<Response>(),
      read = deferred<Response>();
    fetchMock.mockImplementation((input, init) =>
      init?.method !== "PUT"
        ? read.promise
        : String(input).endsWith("%3A1")
          ? first.promise
          : second.promise,
    );
    let writingFirst!: Promise<void>,
      writingSecond!: Promise<void>,
      reading!: Promise<void>;
    act(() => {
      reading = result.current.refresh();
      writingFirst = result.current.toggle("visit_survey:1");
      writingSecond = result.current.toggle("visit_survey:2");
    });
    expect(result.current.data?.tasks.map((task) => task.completed)).toEqual([
      true,
      true,
    ]);
    expect(cached.tasks.map((task) => task.completed)).toEqual([false, false]);
    await act(async () => {
      second.resolve(
        json(task("visit_survey:2", { completed: true, term: 2 })),
      );
      await writingSecond;
    });
    expect(cached.tasks.map((task) => task.completed)).toEqual([false, true]);
    await act(async () => {
      read.resolve(json(home()));
      await reading;
    });
    expect(cached.tasks.map((task) => task.completed)).toEqual([false, true]);
    await act(async () => {
      first.reject(new TypeError("offline"));
      await writingFirst;
    });
    expect(result.current.data?.tasks.map((task) => task.completed)).toEqual([
      false,
      true,
    ]);
    expect(
      vi
        .mocked(saveOfflineHome)
        .mock.calls.every(([, data]) => !data.tasks[0].completed),
    ).toBe(true);
  });

  it("does not apply a late read under a different offline session generation", async () => {
    let state = offlineState(false);
    const oldRead = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRead.promise);
    const { result, rerender } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    state = {
      ...state,
      session: { ...state.session!, generation: "new-generation" },
    };
    rerender();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => oldRead.resolve(json({}, 401)));
    expect(onExpired).not.toHaveBeenCalled();
    expect(saveOfflineHome).toHaveBeenCalledOnce();
    expect(saveOfflineHome).toHaveBeenCalledWith(state.session, home());
  });
  it("rolls back an unconfirmed write on an offline transition and ignores its late response", async () => {
    let state = offlineState(false);
    vi.mocked(readOfflineHome).mockResolvedValue({
      data: home(),
      savedAt: Date.now(),
    });
    const { result, rerender } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle("visit_survey:1");
    });
    const signal = fetchMock.mock.calls.at(-1)![1]!.signal!;
    expect(result.current.data?.tasks[0].completed).toBe(true);
    state = { ...state, offline: true };
    rerender();
    expect(signal.aborted).toBe(true);
    await waitFor(() =>
      expect(result.current.data?.tasks[0].completed).toBe(false),
    );
    expect(result.current.pending.size).toBe(0);
    await act(async () => {
      response.resolve(json({}, 401));
      await writing;
    });
    expect(onExpired).not.toHaveBeenCalled();
    expect(saveOfflineHome).toHaveBeenCalledOnce();
    expect(result.current.readonly).toBe(true);
  });
  it("retains the last confirmed home in memory when persistent storage is unavailable", async () => {
    let state: OfflineState = {
      offline: false,
      session: null,
      savedAt: null,
      onOffline: vi.fn(),
    };
    const { result, rerender } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.data).toEqual(home()));
    state = { ...state, offline: true };
    rerender();
    await waitFor(() => expect(result.current.readonly).toBe(true));
    expect(result.current.data).toEqual(home());
    expect(result.current.error).toBe("");
    await act(async () => result.current.toggle("visit_survey:1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readOfflineHome).not.toHaveBeenCalled();
    expect(saveOfflineHome).not.toHaveBeenCalled();
  });
  it("revokes home immediately on PUT403 and waits for deletion and a fresh GET before unlocking", async () => {
    const state = offlineState(false);
    const { result } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const deletion = deferred<void>();
    vi.mocked(deleteOfflineHome).mockReturnValueOnce(deletion.promise);
    fetchMock.mockResolvedValueOnce(json({}, 403));
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle("visit_survey:1");
    });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.readonly).toBe(true);
    expect(result.current.pending.size).toBe(0);
    expect(deleteOfflineHome).toHaveBeenCalledWith(state.session);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      deletion.resolve();
      await writing;
      await refreshing;
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.data).toEqual(home());
    expect(result.current.readonly).toBe(false);
  });

  it("fences pending writes after GET403 so late success cannot restore home or release a newer pending task", async () => {
    const state = offlineState(false);
    const { result } = renderHook(() => useHomeTasks(onExpired), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <OfflineProvider value={state}>{children}</OfflineProvider>
      ),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const first = deferred<Response>(),
      second = deferred<Response>();
    fetchMock.mockImplementation((input, init) =>
      init?.method === "PUT"
        ? String(input).endsWith("%3A1")
          ? first.promise
          : second.promise
        : Promise.resolve(json({}, 403)),
    );
    let firstWrite!: Promise<void>, secondWrite!: Promise<void>;
    act(() => {
      firstWrite = result.current.toggle("visit_survey:1");
      secondWrite = result.current.toggle("visit_survey:2");
    });
    const writeSignals = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => init!.signal!);
    await act(async () => result.current.refresh());
    expect(writeSignals.every((signal) => signal.aborted)).toBe(true);
    expect(result.current).toMatchObject({ data: null, readonly: true });
    expect(result.current.pending.size).toBe(0);
    await act(async () => {
      first.resolve(json(task(undefined, { completed: true })));
      await firstWrite;
    });
    expect(result.current.data).toBeNull();
    expect(saveOfflineHome).toHaveBeenCalledOnce();
    const current = deferred<Response>();
    fetchMock.mockImplementation((_, init) =>
      init?.method === "PUT" ? current.promise : Promise.resolve(json(home())),
    );
    await act(async () => result.current.refresh());
    expect(result.current.readonly).toBe(false);
    let currentWrite!: Promise<void>;
    act(() => {
      currentWrite = result.current.toggle("visit_survey:2");
    });
    await act(async () => {
      second.resolve(
        json(
          task("visit_survey:2", {
            completed: true,
            title: "old forbidden result",
          }),
        ),
      );
      await secondWrite;
    });
    expect(result.current.pending.has("visit_survey:2")).toBe(true);
    expect(result.current.data?.tasks[1].title).not.toBe(
      "old forbidden result",
    );
    expect(saveOfflineHome).toHaveBeenCalledTimes(2);
    await act(async () => {
      current.resolve(
        json(
          task("visit_survey:2", {
            completed: true,
            title: "new accepted result",
            term: 2,
          }),
        ),
      );
      await currentWrite;
    });
    expect(result.current.pending.size).toBe(0);
    expect(result.current.data?.tasks[1].title).toBe("new accepted result");
    expect(deleteOfflineHome).toHaveBeenCalledOnce();
  });
});

function linkedTasks(term = 1, overrides: Partial<HomeTask> = {}): HomeTask[] {
  return [
    task(`visit_survey:${term}`, { term }),
    task(`assigned_visit:${term}`, {
      kind: "assigned_visit",
      term,
      company_id: `AM-${term}`,
      ...overrides,
    }),
  ];
}
function linkedResponse(survey: HomeTask, visit?: HomeTask) {
  return { ...survey, ...(visit ? { related_tasks: [visit] } : {}) };
}
function completionWrites() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
}

describe("survey-owned assigned visit completion", () => {
  it("optimistically reserves and completes the unique same-term visit in one strict survey mutation", async () => {
    const initial = linkedTasks();
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[0].id);
      void result.current.toggle(initial[1].id);
      void result.current.toggle(initial[0].id);
    });
    expect(new Set(result.current.pending)).toEqual(
      new Set(initial.map((row) => row.id)),
    );
    expect(result.current.data?.tasks).toEqual([
      { ...initial[0], completed: true },
      { ...initial[1], completed: true, auto_completed_by: initial[0].id },
    ]);
    expect(completionWrites()).toHaveLength(1);
    expect(JSON.parse(String(completionWrites()[0][1]!.body))).toEqual({
      completed: true,
    });
    const acceptedVisit = {
      ...initial[1],
      completed: true,
      auto_completed_by: initial[0].id,
      title: "Tasklyが確認した見学",
    };
    await act(async () => {
      response.resolve(
        json(linkedResponse({ ...initial[0], completed: true }, acceptedVisit)),
      );
      await writing;
    });
    expect(result.current.data?.tasks[1]).toEqual(acceptedVisit);
    expect(result.current.data?.tasks[0]).not.toHaveProperty("related_tasks");
    expect(result.current.pending.size).toBe(0);
  });

  it("undoes only a visit owned by that survey and restores both original rows after failure", async () => {
    const initial = linkedTasks(1, {
      completed: true,
      auto_completed_by: "visit_survey:1",
    });
    initial[0].completed = true;
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[0].id);
    });
    expect(result.current.data?.tasks.map((row) => row.completed)).toEqual([
      false,
      false,
    ]);
    expect(result.current.data?.tasks[1].auto_completed_by).toBeUndefined();
    await act(async () => {
      response.resolve(json({}, 503));
      await writing;
    });
    expect(result.current.data?.tasks).toEqual(initial);
    expect(result.current.pending.size).toBe(0);
    expect(result.current.error).not.toBe("");
  });

  it("accepts an authoritative linked undo without retaining ownership metadata", async () => {
    const initial = linkedTasks(1, {
      completed: true,
      auto_completed_by: "visit_survey:1",
    });
    initial[0].completed = true;
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const undoneVisit = {
      ...initial[1],
      completed: false,
      auto_completed_by: undefined,
    };
    fetchMock.mockResolvedValueOnce(
      json(linkedResponse({ ...initial[0], completed: false }, undoneVisit)),
    );
    await act(async () => result.current.toggle(initial[0].id));
    expect(result.current.data?.tasks.map((row) => row.completed)).toEqual([
      false,
      false,
    ]);
    expect(result.current.data?.tasks[1].auto_completed_by).toBeUndefined();
  });

  it.each([undefined, "visit_survey:other"])(
    "preserves an already completed visit with ownership %s when the survey is undone",
    async (owner) => {
      const initial = linkedTasks(1, {
        completed: true,
        ...(owner ? { auto_completed_by: owner } : {}),
      });
      initial[0].completed = true;
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      let writing!: Promise<void>;
      act(() => {
        writing = result.current.toggle(initial[0].id);
      });
      expect(result.current.data?.tasks[1]).toEqual(initial[1]);
      await act(async () => {
        response.resolve(
          json(linkedResponse({ ...initial[0], completed: false }, initial[1])),
        );
        await writing;
      });
      expect(result.current.data?.tasks[1]).toEqual(initial[1]);
    },
  );

  it("preserves manual completion when a survey is checked instead of claiming ownership", async () => {
    const initial = linkedTasks(1, { completed: true });
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[0].id);
    });
    expect(result.current.data?.tasks[1]).toEqual(initial[1]);
    await act(async () => {
      response.resolve(
        json(linkedResponse({ ...initial[0], completed: true }, initial[1])),
      );
      await writing;
    });
    expect(result.current.data?.tasks[1]).toEqual(initial[1]);
  });

  it("undoes an automatic visit and lets a subsequent manual completion survive later survey undo", async () => {
    const initial = linkedTasks(1, {
      completed: true,
      auto_completed_by: "visit_survey:1",
    });
    initial[0].completed = true;
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[1].id);
    });
    expect(result.current.data?.tasks[1]).toMatchObject({ completed: false });
    expect(result.current.data?.tasks[1].auto_completed_by).toBeUndefined();
    const manual = {
      ...initial[1],
      completed: false,
      auto_completed_by: undefined,
    };
    await act(async () => {
      response.resolve(
        json(linkedResponse(manual, { ...initial[0], completed: false })),
      );
      await writing;
    });
    fetchMock.mockResolvedValueOnce(json({ ...manual, completed: true }));
    await act(async () => result.current.toggle(initial[1].id));
    expect(result.current.data?.tasks[1].completed).toBe(true);
    expect(result.current.data?.tasks[1].auto_completed_by).toBeUndefined();
    expect(result.current.data?.tasks[0].completed).toBe(false);
    const checkedManual = { ...manual, completed: true };
    fetchMock.mockResolvedValueOnce(
      json(linkedResponse({ ...initial[0], completed: true }, checkedManual)),
    );
    await act(async () => result.current.toggle(initial[0].id));
    fetchMock.mockResolvedValueOnce(
      json(linkedResponse({ ...initial[0], completed: false }, checkedManual)),
    );
    await act(async () => result.current.toggle(initial[0].id));
    expect(result.current.data?.tasks[1]).toEqual(checkedManual);
  });

  it.each(["different-term", "disabled", "ambiguous"])(
    "does not infer an assigned target for a %s survey context",
    async (scenario) => {
      const initial = linkedTasks(
        1,
        scenario === "disabled" ? { completion_disabled: true } : {},
      );
      if (scenario === "different-term") initial[1].term = 2;
      if (scenario === "ambiguous")
        initial.push({ ...initial[1], id: "second-assigned-same-term" });
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      let writing!: Promise<void>;
      act(() => {
        writing = result.current.toggle(initial[0].id);
      });
      expect(result.current.data?.tasks.slice(1)).toEqual(initial.slice(1));
      await act(async () => {
        response.resolve(
          scenario === "disabled"
            ? json({}, 409)
            : json({ ...initial[0], completed: true }),
        );
        await writing;
      });
      expect(result.current.data?.tasks.slice(1)).toEqual(initial.slice(1));
      expect(completionWrites()).toHaveLength(1);
    },
  );

  it("rolls back both rows and provenance atomically on a rejected pair completion", async () => {
    const initial = linkedTasks();
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await act(async () => result.current.toggle(initial[0].id));
    expect(result.current.data?.tasks).toEqual(initial);
    expect(result.current.pending.size).toBe(0);
    expect(result.current.error).toContain("完了状態を更新できませんでした");
  });

  it("keeps disjoint term pairs independent when one fails after the other succeeds", async () => {
    const first = linkedTasks(1),
      second = linkedTasks(2),
      initial = [...first, ...second];
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstWrite = deferred<Response>(),
      secondWrite = deferred<Response>();
    fetchMock.mockImplementation((input) =>
      String(input).endsWith("visit_survey%3A1")
        ? firstWrite.promise
        : secondWrite.promise,
    );
    let a!: Promise<void>, b!: Promise<void>;
    act(() => {
      a = result.current.toggle(first[0].id);
      b = result.current.toggle(second[0].id);
    });
    expect(result.current.pending.size).toBe(4);
    const acceptedSecond = {
      ...second[1],
      completed: true,
      auto_completed_by: second[0].id,
    };
    await act(async () => {
      secondWrite.resolve(
        json(linkedResponse({ ...second[0], completed: true }, acceptedSecond)),
      );
      await b;
    });
    expect(new Set(result.current.pending)).toEqual(
      new Set(first.map((row) => row.id)),
    );
    await act(async () => {
      firstWrite.resolve(json({}, 503));
      await a;
    });
    expect(result.current.data?.tasks).toEqual([
      ...first,
      { ...second[0], completed: true },
      acceptedSecond,
    ]);
    expect(result.current.pending.size).toBe(0);
  });

  it.each(["before", "during"])(
    "fences both linked rows against a GET started %s the mutation",
    async (ordering) => {
      const initial = linkedTasks();
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const read = deferred<Response>(),
        write = deferred<Response>();
      fetchMock.mockImplementation((_input, init) =>
        init?.method === "PUT" ? write.promise : read.promise,
      );
      let reading!: Promise<void>, writing!: Promise<void>;
      act(() => {
        if (ordering === "before") reading = result.current.refresh();
        writing = result.current.toggle(initial[0].id);
        if (ordering === "during") reading = result.current.refresh();
      });
      const acceptedVisit = {
        ...initial[1],
        completed: true,
        auto_completed_by: initial[0].id,
      };
      await act(async () => {
        write.resolve(
          json(
            linkedResponse({ ...initial[0], completed: true }, acceptedVisit),
          ),
        );
        await writing;
      });
      await act(async () => {
        read.resolve(json(home(initial)));
        await reading;
      });
      expect(result.current.data?.tasks).toEqual([
        { ...initial[0], completed: true },
        acceptedVisit,
      ]);
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      await act(async () => result.current.refresh());
      expect(result.current.data?.tasks).toEqual(initial);
    },
  );

  it("rejects primary-only success for a linked pair and restores both originals", async () => {
    const initial = linkedTasks();
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(json({ ...initial[0], completed: true }));
    await act(async () => result.current.toggle(initial[0].id));
    expect(result.current.data?.tasks).toEqual(initial);
    expect(result.current.error).not.toBe("");
  });

  it.each(["empty", "duplicate", "unexpected-id", "wrong-kind", "wrong-term"])(
    "rejects a %s related response atomically without overwriting another row",
    async (scenario) => {
      const initial = [
        ...linkedTasks(),
        task("unrelated", { kind: "overall_survey", term: undefined }),
      ];
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const partner = {
        ...initial[1],
        completed: true,
        auto_completed_by: initial[0].id,
      };
      const related =
        scenario === "empty"
          ? []
          : scenario === "duplicate"
            ? [partner, partner]
            : [
                {
                  ...partner,
                  ...(scenario === "unexpected-id" ? { id: "unrelated" } : {}),
                  ...(scenario === "wrong-kind"
                    ? { kind: "visit_survey" }
                    : {}),
                  ...(scenario === "wrong-term" ? { term: 2 } : {}),
                },
              ];
      fetchMock.mockResolvedValueOnce(
        json({ ...initial[0], completed: true, related_tasks: related }),
      );
      await act(async () => result.current.toggle(initial[0].id));
      expect(result.current.data?.tasks).toEqual(initial);
      expect(result.current.pending.size).toBe(0);
      expect(result.current.error).not.toBe("");
    },
  );

  it("waits for the server on a disabled linked partner without optimistically checking either row", async () => {
    const initial = linkedTasks(1, { completion_disabled: true });
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[0].id);
    });
    expect(result.current.data?.tasks).toEqual(initial);
    expect(new Set(result.current.pending)).toEqual(
      new Set(initial.map((row) => row.id)),
    );
    expect(completionWrites()).toHaveLength(1);
    await act(async () => {
      response.resolve(json({}, 409));
      await writing;
    });
    expect(result.current.data?.tasks).toEqual(initial);
    expect(result.current.error).toContain("Tasklyでタスクの状態を確認");
  });

  it("does not auto-write linked completion when native Taskly state is observed on focus", async () => {
    const initial = linkedTasks();
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(
      json(home([{ ...initial[0], completed: true }, initial[1]])),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.data?.tasks[0].completed).toBe(true),
    );
    expect(result.current.data?.tasks[1]).toEqual(initial[1]);
    expect(completionWrites()).toHaveLength(0);
  });
});

function completedLinkedTasks(term = 1) {
  const pair = linkedTasks(term, {
    completed: true,
    auto_completed_by: `visit_survey:${term}`,
  });
  pair[0].completed = true;
  return pair;
}

describe("undoing a survey-owned assigned visit", () => {
  it("unchecks only its trusted survey, reserves both rows and blocks conflicting clicks during one atomic request", async () => {
    const initial = completedLinkedTasks();
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[1].id);
      void result.current.toggle(initial[0].id);
      void result.current.toggle(initial[1].id);
    });
    expect(result.current.data?.tasks.map((row) => row.completed)).toEqual([
      false,
      false,
    ]);
    expect(result.current.data?.tasks[1].auto_completed_by).toBeUndefined();
    expect(new Set(result.current.pending)).toEqual(
      new Set(initial.map((row) => row.id)),
    );
    expect(completionWrites()).toHaveLength(1);
    expect(completionWrites()[0][0]).toContain("/tasks/assigned_visit%3A1");
    expect(JSON.parse(String(completionWrites()[0][1]!.body))).toEqual({
      completed: false,
    });
    const survey = {
      ...initial[0],
      completed: false,
      title: "Tasklyのアンケート",
    };
    const visit = {
      ...initial[1],
      completed: false,
      auto_completed_by: undefined,
    };
    await act(async () => {
      response.resolve(json(linkedResponse(visit, survey)));
      await writing;
    });
    expect(result.current.data?.tasks).toEqual([survey, visit]);
    expect(result.current.pending.size).toBe(0);
    expect(result.current.error).toBe("");
  });

  it.each([409, 503])(
    "restores both original completions and provenance when reverse undo fails (%s)",
    async (status) => {
      const initial = completedLinkedTasks();
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      fetchMock.mockResolvedValueOnce(json({}, status));
      await act(async () => result.current.toggle(initial[1].id));
      expect(result.current.data?.tasks).toEqual(initial);
      expect(result.current.pending.size).toBe(0);
      expect(result.current.error).not.toBe("");
      expect(completionWrites()).toHaveLength(1);
    },
  );

  it.each(["manual", "other-origin", "other-term", "ambiguous"])(
    "keeps the survey unchanged for an assigned undo with %s provenance",
    async (scenario) => {
      const initial = completedLinkedTasks();
      if (scenario === "manual") delete initial[1].auto_completed_by;
      if (scenario === "other-origin")
        initial[1].auto_completed_by = "visit_survey:other";
      if (scenario === "other-term") initial[0].term = 2;
      if (scenario === "ambiguous")
        initial.push({ ...initial[0], id: "another-same-term-survey" });
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      let writing!: Promise<void>;
      act(() => {
        writing = result.current.toggle(initial[1].id);
      });
      expect(result.current.data?.tasks[0]).toEqual(initial[0]);
      const linked = scenario === "manual" || scenario === "other-origin";
      expect(new Set(result.current.pending)).toEqual(
        new Set(linked ? [initial[1].id, initial[0].id] : [initial[1].id]),
      );
      const manualVisit = {
        ...initial[1],
        completed: false,
        auto_completed_by: undefined,
      };
      await act(async () => {
        response.resolve(
          json(linked ? linkedResponse(manualVisit, initial[0]) : manualVisit),
        );
        await writing;
      });
      expect(result.current.data?.tasks[0]).toEqual(initial[0]);
      expect(result.current.error).toBe("");
    },
  );

  it("never completes a survey when an incomplete assigned visit is manually checked", async () => {
    const initial = linkedTasks(1, { auto_completed_by: "visit_survey:1" });
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[1].id);
    });
    expect(result.current.data?.tasks[0]).toEqual(initial[0]);
    expect(result.current.data?.tasks[1].auto_completed_by).toBeUndefined();
    expect([...result.current.pending]).toEqual([initial[1].id]);
    await act(async () => {
      response.resolve(
        json({ ...initial[1], completed: true, auto_completed_by: undefined }),
      );
      await writing;
    });
    expect(result.current.data?.tasks[0].completed).toBe(false);
  });

  it.each(["before", "during"])(
    "preserves both accepted reverse changes against a GET started %s undo",
    async (ordering) => {
      const initial = completedLinkedTasks();
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const read = deferred<Response>(),
        write = deferred<Response>();
      fetchMock.mockImplementation((_input, init) =>
        init?.method === "PUT" ? write.promise : read.promise,
      );
      let reading!: Promise<void>, writing!: Promise<void>;
      act(() => {
        if (ordering === "before") reading = result.current.refresh();
        writing = result.current.toggle(initial[1].id);
        if (ordering === "during") reading = result.current.refresh();
      });
      const survey = { ...initial[0], completed: false };
      const visit = {
        ...initial[1],
        completed: false,
        auto_completed_by: undefined,
      };
      await act(async () => {
        write.resolve(json(linkedResponse(visit, survey)));
        await writing;
      });
      await act(async () => {
        read.resolve(json(home(initial)));
        await reading;
      });
      expect(result.current.data?.tasks).toEqual([survey, visit]);
    },
  );

  it.each(["missing", "duplicate", "wrong-id", "wrong-kind", "wrong-term"])(
    "rejects a %s related survey response and restores the pair",
    async (scenario) => {
      const initial = completedLinkedTasks();
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const survey = { ...initial[0], completed: false };
      const related =
        scenario === "missing"
          ? []
          : scenario === "duplicate"
            ? [survey, survey]
            : [
                {
                  ...survey,
                  ...(scenario === "wrong-id"
                    ? { id: "unrelated-survey" }
                    : {}),
                  ...(scenario === "wrong-kind"
                    ? { kind: "assigned_visit" }
                    : {}),
                  ...(scenario === "wrong-term" ? { term: 2 } : {}),
                },
              ];
      fetchMock.mockResolvedValueOnce(
        json({ ...initial[1], completed: false, related_tasks: related }),
      );
      await act(async () => result.current.toggle(initial[1].id));
      expect(result.current.data?.tasks).toEqual(initial);
      expect(result.current.error).not.toBe("");
      expect(result.current.pending.size).toBe(0);
    },
  );

  it.each(["missing-auto-hint", "outdated-auto-hint"])(
    "reconciles both authoritative rows after undo despite a %s",
    async (scenario) => {
      const initial = completedLinkedTasks();
      if (scenario === "missing-auto-hint") delete initial[1].auto_completed_by;
      fetchMock.mockResolvedValueOnce(json(home(initial)));
      const { result } = renderHook(() => useHomeTasks(onExpired));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      let writing!: Promise<void>;
      act(() => {
        writing = result.current.toggle(initial[1].id);
      });
      expect(new Set(result.current.pending)).toEqual(
        new Set(initial.map((row) => row.id)),
      );
      expect(result.current.data?.tasks[0].completed).toBe(
        scenario === "missing-auto-hint",
      );
      const survey = {
        ...initial[0],
        completed: scenario === "outdated-auto-hint",
      };
      const visit = {
        ...initial[1],
        completed: false,
        auto_completed_by: undefined,
      };
      await act(async () => {
        response.resolve(json(linkedResponse(visit, survey)));
        await writing;
      });
      expect(result.current.data?.tasks).toEqual([survey, visit]);
      expect(result.current.error).toBe("");
    },
  );

  it("reserves an already incomplete matching survey while undoing its owned visit", async () => {
    const initial = completedLinkedTasks();
    initial[0].completed = false;
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const response = deferred<Response>();
    fetchMock.mockReturnValueOnce(response.promise);
    let writing!: Promise<void>;
    act(() => {
      writing = result.current.toggle(initial[1].id);
    });
    expect(new Set(result.current.pending)).toEqual(
      new Set(initial.map((row) => row.id)),
    );
    await act(async () => {
      response.resolve(
        json(
          linkedResponse(
            { ...initial[1], completed: false, auto_completed_by: undefined },
            initial[0],
          ),
        ),
      );
      await writing;
    });
    expect(result.current.data?.tasks.map((row) => row.completed)).toEqual([
      false,
      false,
    ]);
    expect(result.current.error).toBe("");
  });

  it("does not undo a survey when an independent native Taskly visit undo arrives on focus", async () => {
    const initial = completedLinkedTasks();
    fetchMock.mockResolvedValueOnce(json(home(initial)));
    const { result } = renderHook(() => useHomeTasks(onExpired));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockResolvedValueOnce(
      json(
        home([
          initial[0],
          { ...initial[1], completed: false, auto_completed_by: undefined },
        ]),
      ),
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.data?.tasks[1].completed).toBe(false),
    );
    expect(result.current.data?.tasks[0]).toEqual(initial[0]);
    expect(completionWrites()).toHaveLength(0);
  });
});

function pairMutation(direction: "forward" | "reverse", term = 1) {
  const initial =
    direction === "forward" ? linkedTasks(term) : completedLinkedTasks(term);
  const survey = { ...initial[0], completed: direction === "forward" };
  const visit = {
    ...initial[1],
    completed: direction === "forward",
    auto_completed_by: direction === "forward" ? initial[0].id : undefined,
  };
  return {
    initial: home(initial),
    accepted: home([survey, visit]),
    id: initial[direction === "forward" ? 0 : 1].id,
    response:
      direction === "forward"
        ? linkedResponse(survey, visit)
        : linkedResponse(visit, survey),
  };
}
function pairCacheHarness(initial: HomeTasksResponse) {
  const state = offlineState(false);
  let cached: HomeTasksResponse | null = null;
  vi.mocked(saveOfflineHome).mockImplementation(async (_session, data) => {
    cached = structuredClone(data);
  });
  vi.mocked(readOfflineHome).mockImplementation(async () =>
    cached ? { data: structuredClone(cached), savedAt: Date.now() } : null,
  );
  vi.mocked(deleteOfflineHome).mockImplementation(async () => {
    cached = null;
  });
  fetchMock.mockResolvedValueOnce(json(initial));
  const mounted = renderHook(() => useHomeTasks(onExpired), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <OfflineProvider value={state}>{children}</OfflineProvider>
    ),
  });
  return { ...mounted, cached: () => cached, state };
}

describe("confirmed linked completions in offline storage", () => {
  it.each(["forward", "reverse"] as const)(
    "stores the %s pair in one atomic confirmed snapshot without persisting optimism",
    async (direction) => {
      const pair = pairMutation(direction);
      const mounted = pairCacheHarness(pair.initial);
      await waitFor(() => expect(mounted.result.current.loading).toBe(false));
      expect(saveOfflineHome).toHaveBeenCalledOnce();
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      let writing!: Promise<void>;
      act(() => {
        writing = mounted.result.current.toggle(pair.id);
      });
      expect(mounted.result.current.pending.size).toBe(2);
      expect(mounted.cached()).toEqual(pair.initial);
      expect(saveOfflineHome).toHaveBeenCalledOnce();
      await act(async () => {
        response.resolve(json(pair.response));
        await writing;
      });
      expect(mounted.result.current.data).toEqual(pair.accepted);
      expect(mounted.cached()).toEqual(pair.accepted);
      expect(saveOfflineHome).toHaveBeenCalledTimes(2);
      expect(vi.mocked(saveOfflineHome).mock.calls[1]).toEqual([
        mounted.state.session,
        pair.accepted,
      ]);
    },
  );

  it.each([
    ["forward", "before"],
    ["forward", "during"],
    ["reverse", "before"],
    ["reverse", "during"],
  ] as const)(
    "keeps both %s rows confirmed when a read starts %s its pending mutation",
    async (direction, ordering) => {
      const pair = pairMutation(direction);
      const mounted = pairCacheHarness(pair.initial);
      await waitFor(() => expect(mounted.result.current.loading).toBe(false));
      const read = deferred<Response>(),
        write = deferred<Response>();
      fetchMock.mockImplementation((_input, init) =>
        init?.method === "PUT" ? write.promise : read.promise,
      );
      let reading!: Promise<void>, writing!: Promise<void>;
      act(() => {
        if (ordering === "before") reading = mounted.result.current.refresh();
        writing = mounted.result.current.toggle(pair.id);
        if (ordering === "during") reading = mounted.result.current.refresh();
      });
      expect(mounted.cached()).toEqual(pair.initial);
      await act(async () => {
        read.resolve(json(pair.initial));
        await reading;
      });
      expect(mounted.cached()).toEqual(pair.initial);
      expect(
        vi
          .mocked(saveOfflineHome)
          .mock.calls.every(
            ([, data]) => JSON.stringify(data) === JSON.stringify(pair.initial),
          ),
      ).toBe(true);
      await act(async () => {
        write.resolve(json(pair.response));
        await writing;
      });
      expect(mounted.cached()).toEqual(pair.accepted);
      expect(mounted.result.current.data).toEqual(pair.accepted);
    },
  );

  it.each(["forward", "reverse"] as const)(
    "does not let an old read replace either newly confirmed %s row in storage",
    async (direction) => {
      const pair = pairMutation(direction);
      const mounted = pairCacheHarness(pair.initial);
      await waitFor(() => expect(mounted.result.current.loading).toBe(false));
      const read = deferred<Response>(),
        write = deferred<Response>();
      fetchMock.mockImplementation((_input, init) =>
        init?.method === "PUT" ? write.promise : read.promise,
      );
      let reading!: Promise<void>, writing!: Promise<void>;
      act(() => {
        reading = mounted.result.current.refresh();
        writing = mounted.result.current.toggle(pair.id);
      });
      await act(async () => {
        write.resolve(json(pair.response));
        await writing;
      });
      expect(mounted.cached()).toEqual(pair.accepted);
      await act(async () => {
        read.resolve(json(pair.initial));
        await reading;
      });
      expect(mounted.cached()).toEqual(pair.accepted);
      expect(mounted.result.current.data).toEqual(pair.accepted);
    },
  );

  it.each(["forward", "reverse"] as const)(
    "rolls back both %s rows on failure while retaining only the old confirmed cache",
    async (direction) => {
      const pair = pairMutation(direction);
      const mounted = pairCacheHarness(pair.initial);
      await waitFor(() => expect(mounted.result.current.loading).toBe(false));
      fetchMock.mockResolvedValueOnce(json({}, 503));
      await act(async () => mounted.result.current.toggle(pair.id));
      expect(mounted.result.current.data).toEqual(pair.initial);
      expect(mounted.cached()).toEqual(pair.initial);
      expect(mounted.result.current.pending.size).toBe(0);
      expect(saveOfflineHome).toHaveBeenCalledOnce();
    },
  );

  it.each(["GET", "PUT"])(
    "revokes every pending pair after %s403 and ignores late responses without releasing a new pair",
    async (operation) => {
      const first = pairMutation("forward", 1),
        second = pairMutation("reverse", 2);
      const initial = home([...first.initial.tasks, ...second.initial.tasks]);
      const mounted = pairCacheHarness(initial);
      await waitFor(() => expect(mounted.result.current.loading).toBe(false));
      const a = deferred<Response>(),
        b = deferred<Response>();
      fetchMock.mockImplementation((input, init) =>
        init?.method === "PUT"
          ? String(input).endsWith("visit_survey%3A1")
            ? a.promise
            : b.promise
          : Promise.resolve(json({}, 403)),
      );
      let writeA!: Promise<void>, writeB!: Promise<void>;
      act(() => {
        writeA = mounted.result.current.toggle(first.id);
        writeB = mounted.result.current.toggle(second.id);
      });
      expect(mounted.result.current.pending.size).toBe(4);
      const signals = completionWrites().map(([, init]) => init!.signal!);
      await act(async () => {
        if (operation === "GET") await mounted.result.current.refresh();
        else {
          a.resolve(json({}, 403));
          await writeA;
        }
      });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(mounted.cached()).toBeNull();
      expect(mounted.result.current).toMatchObject({
        data: null,
        readonly: true,
      });
      expect(mounted.result.current.pending.size).toBe(0);
      expect(deleteOfflineHome).toHaveBeenCalledExactlyOnceWith(
        mounted.state.session,
      );
      const current = deferred<Response>();
      fetchMock.mockImplementation((_input, init) =>
        init?.method === "PUT"
          ? current.promise
          : Promise.resolve(json(initial)),
      );
      await act(async () => mounted.result.current.refresh());
      let currentWrite!: Promise<void>;
      act(() => {
        currentWrite = mounted.result.current.toggle(second.id);
      });
      await act(async () => {
        if (operation === "GET") {
          a.resolve(json(first.response));
          await writeA;
        }
        b.resolve(json(second.response));
        await writeB;
      });
      expect(new Set(mounted.result.current.pending)).toEqual(
        new Set(second.initial.tasks.map((row) => row.id)),
      );
      expect(mounted.cached()).toEqual(initial);
      expect(saveOfflineHome).toHaveBeenCalledTimes(2);
      await act(async () => {
        current.resolve(json(second.response));
        await currentWrite;
      });
      expect(mounted.cached()).toEqual(
        home([...first.initial.tasks, ...second.accepted.tasks]),
      );
      expect(mounted.result.current.pending.size).toBe(0);
    },
  );

  it.each(["forward", "reverse"] as const)(
    "persists and restores a confirmed %s pair through native IndexedDB without navigation URLs",
    async (direction) => {
      vi.stubGlobal("indexedDB", new IDBFactory());
      const store = await vi.importActual<
        typeof import("../lib/offline-store")
      >("../lib/offline-store");
      const pack = await store.saveOfflinePack({
        user: {
          sub: "native-cache-student",
          name: "検証学生",
          email: "cache@example.test",
        },
        guidance: fixture(),
        preferences: {
          department: "電子制御工学科",
          grade: 4,
          roster_number: 7,
        },
        bookmarks: [],
      });
      expect(pack).not.toBeNull();
      vi.mocked(saveOfflineHome).mockImplementation(store.saveOfflineHome);
      vi.mocked(readOfflineHome).mockImplementation(store.readOfflineHome);
      vi.mocked(deleteOfflineHome).mockImplementation(store.deleteOfflineHome);
      const pair = pairMutation(direction);
      let state: OfflineState = {
        ...offlineState(false),
        session: pack!.session,
      };
      fetchMock.mockResolvedValueOnce(json(pair.initial));
      const mounted = renderHook(() => useHomeTasks(onExpired), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <OfflineProvider value={state}>{children}</OfflineProvider>
        ),
      });
      await waitFor(() => expect(mounted.result.current.loading).toBe(false));
      const oldCache = await store.readOfflineHome(pack!.session);
      expect(oldCache?.data.tasks.map((row) => row.completed)).toEqual(
        pair.initial.tasks.map((row) => row.completed),
      );
      const response = deferred<Response>();
      fetchMock.mockReturnValueOnce(response.promise);
      let writing!: Promise<void>;
      act(() => {
        writing = mounted.result.current.toggle(pair.id);
      });
      const pendingCache = await store.readOfflineHome(pack!.session);
      expect(pendingCache?.data).toEqual(oldCache?.data);
      await act(async () => {
        response.resolve(json(pair.response));
        await writing;
      });
      const confirmedCache = await store.readOfflineHome(pack!.session);
      expect(confirmedCache?.data.tasks.map((row) => row.completed)).toEqual(
        pair.accepted.tasks.map((row) => row.completed),
      );
      expect(confirmedCache?.data.tasks[1].auto_completed_by).toBe(
        pair.accepted.tasks[1].auto_completed_by,
      );
      expect(
        confirmedCache?.data.tasks.every(
          (row) => row.taskly_url === "" && !row.url,
        ),
      ).toBe(true);
      mounted.unmount();
      state = { ...state, offline: true };
      const restored = renderHook(() => useHomeTasks(onExpired), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <OfflineProvider value={state}>{children}</OfflineProvider>
        ),
      });
      await waitFor(() => expect(restored.result.current.loading).toBe(false));
      expect(restored.result.current.data).toEqual(confirmedCache?.data);
      expect(restored.result.current.readonly).toBe(true);
      const requests = fetchMock.mock.calls.length;
      await act(async () => restored.result.current.toggle(pair.id));
      expect(fetchMock).toHaveBeenCalledTimes(requests);
      restored.unmount();
      await store.clearOfflinePack();
    },
  );
});
