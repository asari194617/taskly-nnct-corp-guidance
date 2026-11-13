import { describe, expect, it, vi } from "vitest";
import { documentHref, navigateDocument } from "../lib/document-navigation";

const signedURL =
  "https://synthetic-r2.example.invalid/private/guide.pdf?X-Amz-Signature=a%2Fb%2Bc&X-Amz-Expires=300#old";

describe("signed document navigation", () => {
  it("preserves the exact signed query while selecting physical PDF page25", () => {
    const href = documentHref(signedURL, 25);
    expect(href).toBe(signedURL.replace("#old", "#page=25"));
    expect(new URL(href).search).toBe(new URL(signedURL).search);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "leaves the issued URL hash alone for an invalid or absent page %s",
    (page) => {
      expect(documentHref(signedURL, page)).toBe(signedURL);
    },
  );

  it("navigates the current tab directly through the injected location", () => {
    const location = { assign: vi.fn() };
    navigateDocument(signedURL, 25, location);
    expect(location.assign).toHaveBeenCalledExactlyOnceWith(
      signedURL.replace("#old", "#page=25"),
    );
  });

  it("accepts an HTTP development URL while rejecting nonweb document destinations", () => {
    expect(
      documentHref("http://127.0.0.1:3373/guide.pdf?signature=synthetic", 25),
    ).toBe("http://127.0.0.1:3373/guide.pdf?signature=synthetic#page=25");
    expect(() => documentHref("javascript:alert(1)")).toThrow(
      "Unsupported document URL",
    );
    expect(() =>
      documentHref("blob:https://example.invalid/synthetic"),
    ).toThrow("Unsupported document URL");
  });

  it("surfaces invalid URLs and failed navigation to the caller", () => {
    const location = {
      assign: vi.fn(() => {
        throw new Error("blocked navigation");
      }),
    };
    expect(() => documentHref("invalid url", 25)).toThrow();
    expect(() => navigateDocument(signedURL, undefined, location)).toThrow(
      "blocked navigation",
    );
  });
});
