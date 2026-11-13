import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MapCompanyPanel } from "../components/company-details";
import { fixture } from "./fixtures";

function mountPanel() {
  const onSave = vi.fn(async () => {});
  const returnFocus = vi.fn();
  function Example() {
    const [open, setOpen] = useState(true);
    return open ? (
      <MapCompanyPanel
        company={fixture().companies[0]}
        saved={false}
        assigned
        onSave={onSave}
        focusOnOpen
        onClose={() => setOpen(false)}
        returnFocus={returnFocus}
      />
    ) : null;
  }
  render(<Example />);
  return { onSave, returnFocus };
}

describe("map company card close action", () => {
  it("keeps the close action outside the company identity while preserving its favorite action", async () => {
    const { onSave, returnFocus } = mountPanel();
    const identity = screen.getByRole("group", {
      name: "あおばテスト株式会社",
    });
    expect(
      within(identity).queryByRole("button", { name: "企業情報を閉じる" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "あおばテスト株式会社" }),
    ).toHaveFocus();
    await userEvent.click(
      within(identity).getByRole("button", {
        name: "あおばテスト株式会社を気になるに追加",
      }),
    );
    expect(onSave).toHaveBeenCalledOnce();
    await userEvent.click(
      screen.getByRole("button", { name: "企業情報を閉じる" }),
    );
    expect(
      screen.queryByRole("region", { name: "あおばテスト株式会社" }),
    ).toBeNull();
    expect(returnFocus).toHaveBeenCalledOnce();
  });

  it("keeps the floating action keyboard reachable after the favorite and activates it with Enter", async () => {
    const { returnFocus } = mountPanel();
    await userEvent.tab();
    expect(
      screen.getByRole("button", {
        name: "あおばテスト株式会社を気になるに追加",
      }),
    ).toHaveFocus();
    await userEvent.tab();
    expect(
      screen.getByRole("button", { name: "企業情報を閉じる" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(
      screen.queryByRole("region", { name: "あおばテスト株式会社" }),
    ).toBeNull();
    expect(returnFocus).toHaveBeenCalledOnce();
  });

  it("closes with Escape from the company heading and restores map focus", async () => {
    const { returnFocus } = mountPanel();
    await userEvent.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: "あおばテスト株式会社" }),
    ).toBeNull();
    expect(returnFocus).toHaveBeenCalledOnce();
  });
});
