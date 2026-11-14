import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOfflineShell } from "../lib/offline-shell";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("public offline shell registration", () => {
  it("uses a root-scoped uncached worker and waits for readiness", async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", {
      serviceWorker: { register, ready: Promise.resolve({}) },
    });
    expect(await registerOfflineShell()).toBe(true);
    expect(register).toHaveBeenCalledWith("/offline-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });
  it("degrades when unavailable or registration is denied", async () => {
    vi.stubGlobal("navigator", undefined);
    expect(await registerOfflineShell()).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(await registerOfflineShell()).toBe(false);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn().mockRejectedValue(new Error("blocked")),
      },
    });
    expect(await registerOfflineShell()).toBe(false);
  });
  it("does not hang readiness on an incomplete first installation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn().mockResolvedValue({}),
        ready: new Promise(() => {}),
      },
    });
    const ready = registerOfflineShell();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await ready).toBe(false);
  });
});
