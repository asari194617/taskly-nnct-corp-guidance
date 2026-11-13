import { describe, expect, it, vi } from "vitest";
import { api, APIError, API_URL, documentURL } from "../lib/api";

describe("authenticated API client", () => {
  it("sends cookies and prevents cache storage for JSON", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(api("/api/me", { method: "GET" })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      `${API_URL}/api/me`,
      expect.objectContaining({ credentials: "include", cache: "no-store", method: "GET" }),
    );
  });
  it("accepts successful mutations without a JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api<void>("/api/bookmarks/test", { method: "PUT" })).resolves.toBeUndefined();
  });
  it.each([401, 403, 500])("returns typed JSON error for status %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    await expect(api("/api/guidance")).rejects.toMatchObject({ status });
    await expect(api("/api/guidance")).rejects.toBeInstanceOf(APIError);
  });
  it("explains invalid roster numbers without pretending to save them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 422 })));
    await expect(api("/api/preferences", { method: "PUT" })).rejects.toMatchObject({
      status: 422,
      message: "名簿番号を確認してください。",
    });
  });
  it("requests a signed document URL with encoded ID, authentication and cancellation", async () => {
    const controller = new AbortController();
    const signed = { url: `${API_URL}/documents/test?token=synthetic`, expires_at: "2030-01-01T00:05:00Z" };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(signed)));
    vi.stubGlobal("fetch", fetch);
    await expect(documentURL("test /?#", controller.signal)).resolves.toEqual(signed);
    expect(fetch).toHaveBeenCalledWith(
      `${API_URL}/api/documents/test%20%2F%3F%23/url`,
      expect.objectContaining({ credentials: "include", cache: "no-store", signal: controller.signal }),
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it.each([401, 404])("returns typed signed-document error for status %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    await expect(documentURL("test")).rejects.toMatchObject({ status });
  });
});
