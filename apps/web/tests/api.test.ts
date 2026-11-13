import { describe, expect, it, vi } from "vitest";
import { api, APIError, API_URL, documentBlob } from "../lib/api";

describe("authenticated API client", () => {
  it("sends cookies and prevents cache storage for JSON", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(api("/api/me", { method: "GET" })).resolves.toEqual({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      `${API_URL}/api/me`,
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        method: "GET",
      }),
    );
  });
  it("accepts successful mutations without a JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(
      api<void>("/api/bookmarks/test", { method: "PUT" }),
    ).resolves.toBeUndefined();
  });
  it.each([401, 403, 500])(
    "returns typed JSON error for status %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("", { status })),
      );
      await expect(api("/api/guidance")).rejects.toMatchObject({ status });
      await expect(api("/api/guidance")).rejects.toBeInstanceOf(APIError);
    },
  );
  it("encodes document IDs and supports cancellation", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("image", { headers: { "Content-Type": "image/png" } }),
      );
    vi.stubGlobal("fetch", fetch);
    const blob = await documentBlob("test /?#", controller.signal);
    expect(blob.type).toBe("image/png");
    expect(fetch).toHaveBeenCalledWith(
      `${API_URL}/api/documents/test%20%2F%3F%23`,
      expect.objectContaining({
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      }),
    );
  });
  it.each([401, 404])(
    "returns typed document error for status %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("", { status })),
      );
      await expect(documentBlob("test")).rejects.toMatchObject({ status });
    },
  );
});
