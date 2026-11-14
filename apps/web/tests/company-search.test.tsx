import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CompanyDetailContent,
  MapCompanyPanel,
} from "../components/company-details";
import { OfflineProvider } from "../components/offline-context";
import { fixture } from "./fixtures";

const name = "株式会社テスト & Co. ?source=別項目 #研究/開発";
const company = { ...fixture().companies[0], name };
function example(presentation: "dialog" | "map") {
  const props = {
    company,
    saved: false,
    assigned: true,
    onSave: vi.fn(async () => {}),
  };
  return presentation === "dialog" ? (
    <dialog open aria-label="企業詳細">
      <CompanyDetailContent {...props} titleId="company-title" />
    </dialog>
  ) : (
    <MapCompanyPanel
      {...props}
      focusOnOpen={false}
      onClose={vi.fn()}
      returnFocus={vi.fn()}
    />
  );
}

describe.each(["dialog", "map"] as const)(
  "company Google search in %s",
  (presentation) => {
    it("uses the entire company name as the only query on a fixed Google origin", () => {
      render(example(presentation));
      const identity = screen.getByRole("group", { name });
      const google = within(identity).getByRole("link", {
        name: "Googleで調べる",
      });
      const url = new URL(google.getAttribute("href") || "");
      expect(url.origin).toBe("https://google.com");
      expect(url.pathname).toBe("/");
      expect([...url.searchParams.keys()]).toEqual(["q"]);
      expect(url.searchParams.get("q")).toBe(name);
      expect(url.hash).toBe("");
      expect(google).toHaveAttribute("target", "_blank");
      expect(google).toHaveAttribute("rel", "noopener noreferrer");
      const row = identity.querySelector(".company-detail-actions");
      expect(row).toContainElement(google);
      expect(row).toContainElement(
        within(identity).getByRole("button", {
          name: `${name}を気になるに追加`,
        }),
      );
    });

    it("keeps the action visible but non-navigable while offline", () => {
      render(
        <OfflineProvider
          value={{
            offline: true,
            session: null,
            savedAt: null,
            onOffline: vi.fn(),
          }}
        >
          {example(presentation)}
        </OfflineProvider>,
      );
      const identity = screen.getByRole("group", { name });
      expect(
        within(identity).queryByRole("link", { name: "Googleで調べる" }),
      ).toBeNull();
      expect(within(identity).getByText("Googleで調べる")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(
        within(identity).getByRole("button", {
          name: `${name}を気になるに追加`,
        }),
      ).toBeDisabled();
    });
  },
);
