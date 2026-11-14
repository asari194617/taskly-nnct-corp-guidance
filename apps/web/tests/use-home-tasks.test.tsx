import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it.each([403, 409, 429, 503])(
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
