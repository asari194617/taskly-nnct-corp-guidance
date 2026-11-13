import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentNavigation } from "../components/use-document-navigation";
import { navigateDocument } from "../lib/document-navigation";

vi.mock("../lib/document-navigation", () => ({ navigateDocument: vi.fn() }));

const signedURL =
  "https://synthetic-r2.example.invalid/private/guide.pdf?X-Amz-Signature=a%2Fb&X-Amz-Expires=300";
const failureMessage = "資料を開けませんでした。もう一度お試しください。";
type FetchStub = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchStub>>;
let onExpired: ReturnType<typeof vi.fn<() => void>>;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function issued() {
  return json({ url: signedURL, expires_at: "2030-05-14T00:17:00Z" });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  fetchMock = vi.fn<FetchStub>().mockImplementation(async () => issued());
  onExpired = vi.fn<() => void>();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(navigateDocument).mockReset();
});

describe("current-tab signed document navigation", () => {
  it("requests a signed URL with authenticated uncached fetch and navigates directly without a popup or blob", async () => {
    const popup = vi.spyOn(window, "open");
    const { result } = renderHook(() => useDocumentNavigation(onExpired));
    await act(async () => {
      await result.current.openDocument("guide/2026", 25);
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/\/api\/documents\/guide%2F2026\/url$/),
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(navigateDocument).toHaveBeenCalledExactlyOnceWith(signedURL, 25);
    expect(popup).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ opening: false, error: "" });
  });

  it("ignores simultaneous duplicate activations until signing settles, then permits another document", async () => {
    const signing = deferred<Response>();
    fetchMock.mockReturnValueOnce(signing.promise);
    const { result } = renderHook(() => useDocumentNavigation(onExpired));
    let first!: Promise<void>;
    act(() => {
      first = result.current.openDocument("first", 25);
      void result.current.openDocument("duplicate", 2);
    });
    expect(result.current.opening).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      signing.resolve(issued());
      await first;
    });
    await act(async () => {
      await result.current.openDocument("next");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(navigateDocument).toHaveBeenNthCalledWith(1, signedURL, 25);
    expect(navigateDocument).toHaveBeenNthCalledWith(2, signedURL, undefined);
  });

  it.each([403, 429, 500, 503])(
    "shows a recoverable signing error for HTTP%s without navigating or retrying automatically",
    async (status) => {
      fetchMock.mockResolvedValueOnce(json({ error: "unavailable" }, status));
      const { result } = renderHook(() => useDocumentNavigation(onExpired));
      await act(async () => {
        await result.current.openDocument("guide", 25);
      });
      expect(result.current).toMatchObject({
        opening: false,
        error: failureMessage,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(navigateDocument).not.toHaveBeenCalled();
      expect(onExpired).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.openDocument("guide", 25);
      });
      expect(result.current.error).toBe("");
      expect(navigateDocument).toHaveBeenCalledExactlyOnceWith(signedURL, 25);
    },
  );

  it.each(["network", "navigation"])(
    "recovers from a %s exception on an explicit retry",
    async (failure) => {
      if (failure === "network")
        fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      else
        vi.mocked(navigateDocument).mockImplementationOnce(() => {
          throw new Error("blocked");
        });
      const { result } = renderHook(() => useDocumentNavigation(onExpired));
      await act(async () => {
        await result.current.openDocument("guide");
      });
      expect(result.current).toMatchObject({
        opening: false,
        error: failureMessage,
      });
      await act(async () => {
        await result.current.openDocument("guide");
      });
      expect(result.current).toMatchObject({ opening: false, error: "" });
    },
  );

  it("uses the latest expiry callback when a signing401 arrives after a rerender", async () => {
    const signing = deferred<Response>();
    fetchMock.mockReturnValueOnce(signing.promise);
    const latest = vi.fn<() => void>();
    const { result, rerender } = renderHook(
      ({ callback }) => useDocumentNavigation(callback),
      { initialProps: { callback: onExpired } },
    );
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.openDocument("guide");
    });
    rerender({ callback: latest });
    await act(async () => {
      signing.resolve(json({}, 401));
      await opening;
    });
    expect(latest).toHaveBeenCalledOnce();
    expect(onExpired).not.toHaveBeenCalled();
    expect(navigateDocument).not.toHaveBeenCalled();
    expect(result.current.opening).toBe(false);
  });

  it.each([200, 401])(
    "aborts unmounted signing and ignores its late HTTP%s response",
    async (status) => {
      const signing = deferred<Response>();
      fetchMock.mockReturnValueOnce(signing.promise);
      const { result, unmount } = renderHook(() =>
        useDocumentNavigation(onExpired),
      );
      let opening!: Promise<void>;
      act(() => {
        opening = result.current.openDocument("guide", 25);
      });
      const signal = fetchMock.mock.calls[0][1]!.signal!;
      unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => {
        signing.resolve(status === 200 ? issued() : json({}, status));
        await opening;
      });
      expect(navigateDocument).not.toHaveBeenCalled();
      expect(onExpired).not.toHaveBeenCalled();
    },
  );

  it.each([200, 401])(
    "resets on auth scope changes without allowing late HTTP%s from the old scope",
    async (status) => {
      const signing = deferred<Response>();
      fetchMock.mockReturnValueOnce(signing.promise);
      const { result, rerender } = renderHook(
        ({ scope }) => useDocumentNavigation(onExpired, scope),
        { initialProps: { scope: "student-a" } },
      );
      let oldOpening!: Promise<void>;
      act(() => {
        oldOpening = result.current.openDocument("old", 25);
      });
      const oldSignal = fetchMock.mock.calls[0][1]!.signal!;
      rerender({ scope: "student-b" });
      expect(oldSignal.aborted).toBe(true);
      expect(result.current).toMatchObject({ opening: false, error: "" });
      await act(async () => {
        await result.current.openDocument("new", 3);
      });
      await act(async () => {
        signing.resolve(status === 200 ? issued() : json({}, status));
        await oldOpening;
      });
      expect(navigateDocument).toHaveBeenCalledExactlyOnceWith(signedURL, 3);
      expect(onExpired).not.toHaveBeenCalled();
      expect(result.current.opening).toBe(false);
    },
  );

  it("aborts after15 seconds, reports failure and permits an explicit retry", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const { result } = renderHook(() => useDocumentNavigation(onExpired));
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.openDocument("guide");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await opening;
    });
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(result.current).toMatchObject({
      opening: false,
      error: failureMessage,
    });
    expect(navigateDocument).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.openDocument("guide", 25);
    });
    expect(result.current.error).toBe("");
    expect(navigateDocument).toHaveBeenCalledExactlyOnceWith(signedURL, 25);
  });

  it("clears a prior error when the authentication scope changes", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { result, rerender } = renderHook(
      ({ scope }) => useDocumentNavigation(onExpired, scope),
      { initialProps: { scope: "old" } },
    );
    await act(async () => {
      await result.current.openDocument("guide");
    });
    expect(result.current.error).toBe(failureMessage);
    rerender({ scope: "new" });
    await waitFor(() => expect(result.current.error).toBe(""));
  });
});
