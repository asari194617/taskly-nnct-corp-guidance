import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import AccountMenu from "../components/account-menu";
import { OfflineProvider } from "../components/offline-context";

function renderAccount(offline = false) {
  const onConfigure = vi.fn(),
    onLogout = vi.fn();
  const view = render(
    <OfflineProvider
      value={{ offline, session: null, savedAt: null, onOffline: vi.fn() }}
    >
      <AccountMenu
        name="検証ユーザー"
        rosterNumber={7}
        busy={false}
        onConfigure={onConfigure}
        onLogout={onLogout}
      />
    </OfflineProvider>,
  );
  return { ...view, onConfigure, onLogout };
}

async function openAbout() {
  await userEvent.click(
    screen.getByRole("button", { name: "ユーザーメニュー" }),
  );
  await userEvent.click(
    screen.getByRole("menuitem", { name: "このサービスについて" }),
  );
  return screen.getByRole("dialog", { name: "このサービスについて" });
}

it("places the info action immediately before logout and opens a minimal service dialog", async () => {
  const { onConfigure, onLogout } = renderAccount();
  const trigger = screen.getByRole("button", { name: "ユーザーメニュー" });
  await userEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "ユーザーメニュー" });
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "名簿番号の設定",
    "このサービスについて",
    "ログアウト",
  ]);
  expect(items[1].querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  await userEvent.click(items[1]);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  const dialog = screen.getByRole("dialog", { name: "このサービスについて" });
  expect(dialog).toHaveAttribute("open");
  expect(
    within(dialog).getByRole("heading", { name: "Taskly 企業ガイダンス" }),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("link", { name: "利用規約" }),
  ).toHaveAttribute(
    "href",
    "https://ritzy-lift-e38.notion.site/28ba3874f8c880a783ddf9d39aea1242",
  );
  expect(within(dialog).getByRole("link", { name: "asari" })).toHaveAttribute(
    "href",
    "https://x.com/asari194617",
  );
  expect(dialog).toHaveTextContent("© 2026 asari");
  for (const link of within(dialog).getAllByRole("link")) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  const close = within(dialog).getByRole("button", { name: "閉じる" });
  expect(close).toHaveFocus();
  await userEvent.tab();
  expect(within(dialog).getByRole("link", { name: "利用規約" })).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(close).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(within(dialog).getByRole("link", { name: "asari" })).toHaveFocus();
  expect(onConfigure).not.toHaveBeenCalled();
  expect(onLogout).not.toHaveBeenCalled();
  await userEvent.click(close);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("menu", { name: "ユーザーメニュー" })).toBeVisible();
});

it("opens from the keyboard and returns focus to the account button after native Escape cancellation", async () => {
  renderAccount();
  const trigger = screen.getByRole("button", { name: "ユーザーメニュー" });
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  const dialog = screen.getByRole("dialog", { name: "このサービスについて" });
  // jsdom has no native dialog Escape behavior; the browser test covers it.
  const canceled = fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(canceled).toBe(false);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("keeps service information available offline without invoking account or network actions", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { onConfigure, onLogout } = renderAccount(true);
  const dialog = await openAbout();
  expect(within(dialog).getByRole("link", { name: "利用規約" })).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
  expect(onConfigure).not.toHaveBeenCalled();
  expect(onLogout).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
