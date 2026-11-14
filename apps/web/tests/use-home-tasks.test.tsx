import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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
      second.resolve(json(task("visit_survey:2", { completed: true })));
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
