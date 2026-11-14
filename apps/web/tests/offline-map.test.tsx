import { requireValue } from "./required";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VenueMap from "../components/venue-map";
import { OfflineProvider } from "../components/offline-context";
import { APIError, documentURL } from "../lib/api";
import { readOfflineMap, saveOfflineMap } from "../lib/offline-store";
import { fixture } from "./fixtures";

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  documentURL: vi.fn(),
}));
vi.mock("../lib/offline-store", async (original) => ({
  ...(await original<typeof import("../lib/offline-store")>()),
  readOfflineMap: vi.fn(),
  saveOfflineMap: vi.fn(),
}));

const session = {
  scope: "qa-profile",
  generation: "qa-generation",
  expiresAt: Date.now() + 86_400_000,
};
const blob = new Blob(["synthetic-map"], { type: "image/png" });
const data = fixture();
const firstMap = requireValue(
  data.documents.find((item) => item.kind === "map"),
);
function mount(offline: boolean) {
  const onExpired = vi.fn(),
    onOffline = vi.fn();
  const view = render(
    <OfflineProvider
      value={{ offline, session, savedAt: Date.now(), onOffline }}
    >
      <VenueMap
        documents={data.documents}
        companies={data.companies}
        session="AM"
        onExpired={onExpired}
        onSelectCompany={vi.fn()}
        onSessionChange={vi.fn()}
      />
    </OfflineProvider>,
  );
  return { ...view, onExpired, onOffline };
}
beforeEach(() => {
  vi.mocked(documentURL).mockReset().mockResolvedValue({
    url: "https://r2.example.test/map.png?X-Amz-Signature=synthetic",
    expires_at: "2030-05-14T10:00:00Z",
  });
  vi.mocked(readOfflineMap).mockReset().mockResolvedValue(null);
  vi.mocked(saveOfflineMap).mockReset().mockResolvedValue(undefined);
});

describe("scoped offline map bytes", () => {
  it("keeps an uncached standalone map usable as an error state when its connection fails", async () => {
    vi.mocked(documentURL).mockRejectedValue(
      new TypeError("network unavailable"),
    );
    const onExpired = vi.fn();
    render(
      <VenueMap
        documents={data.documents}
        companies={data.companies}
        session="AM"
        onExpired={onExpired}
        onSelectCompany={vi.fn()}
        onSessionChange={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この地図は保存されていません",
    );
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("restores a saved map without signing and revokes its transient URL on unmount", async () => {
    vi.mocked(readOfflineMap).mockResolvedValue(blob);
    const view = mount(true);
    expect(
      await screen.findByRole("img", { name: firstMap.title }),
    ).toHaveAttribute("src", "blob:test-document");
    expect(documentURL).not.toHaveBeenCalled();
    expect(readOfflineMap).toHaveBeenCalledWith(session, firstMap.id);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-document");
  });

  it("reports an unacquired map offline instead of requesting a signature", async () => {
    mount(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この地図は保存されていません",
    );
    expect(documentURL).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("img", { name: firstMap.title }),
    ).not.toBeInTheDocument();
  });

  it("fetches image bytes without credentials and stores only the scoped Blob", async () => {
    const fetchImage = vi
      .fn()
      .mockResolvedValue(
        new Response(blob, { headers: { "Content-Type": "image/png" } }),
      );
    vi.stubGlobal("fetch", fetchImage);
    mount(false);
    await screen.findByRole("img", { name: firstMap.title });
    expect(fetchImage).toHaveBeenCalledWith(
      expect.stringContaining("X-Amz-Signature"),
      expect.objectContaining({ credentials: "omit", cache: "no-store" }),
    );
    expect(saveOfflineMap).toHaveBeenCalledWith(
      session,
      firstMap.id,
      expect.any(Blob),
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it.each([401, 403])(
    "does not restore saved bytes after confirmed authorization denial %s",
    async (status) => {
      vi.mocked(readOfflineMap).mockResolvedValue(blob);
      vi.mocked(documentURL).mockRejectedValue(new APIError(status, "denied"));
      const view = mount(false);
      await waitFor(() => expect(view.onExpired).toHaveBeenCalledOnce());
      expect(readOfflineMap).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("img", { name: firstMap.title }),
      ).not.toBeInTheDocument();
    },
  );

  it("restores confirmed bytes after a signer transport failure and makes the app read-only", async () => {
    vi.mocked(readOfflineMap).mockResolvedValue(blob);
    vi.mocked(documentURL).mockRejectedValue(
      new TypeError("network unavailable"),
    );
    const view = mount(false);
    await screen.findByRole("img", { name: firstMap.title });
    expect(view.onOffline).toHaveBeenCalledOnce();
  });

  it("falls back within fifteen seconds when an online signer connection hangs", async () => {
    vi.useFakeTimers();
    vi.mocked(readOfflineMap).mockResolvedValue(blob);
    vi.mocked(documentURL).mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("timeout", "AbortError")),
          );
        }),
    );
    const view = mount(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole("img", { name: firstMap.title })).toHaveAttribute(
      "src",
      "blob:test-document",
    );
    expect(view.onOffline).toHaveBeenCalledOnce();
  });
});
