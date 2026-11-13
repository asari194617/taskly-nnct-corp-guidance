import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import HeaderActions from "../components/header-actions";

it("keeps the guide icon a native link for new-tab gestures while handling an ordinary navigation", () => {
  const onInformation = vi.fn();
  const props = {
    name: "検証ユーザー",
    rosterNumber: 7,
    busy: false,
    currentView: "companies",
    onConfigure: vi.fn(),
    onInformation,
    onLogout: vi.fn(),
  };
  const { rerender } = render(<HeaderActions {...props} />);
  const link = screen.getByRole("link", { name: "配布資料の案内" });
  expect(link).toHaveAttribute("href", "/documents/");
  expect(link).not.toHaveAttribute("aria-current");
  const prevented: boolean[] = [];
  // Suppress jsdom's unimplemented native navigation only after React's
  // handler runs, preserving the browser gesture/default-prevention contract.
  const finishNativeClick = (event: MouseEvent) => {
    prevented.push(event.defaultPrevented);
    event.preventDefault();
  };
  window.addEventListener("click", finishNativeClick);
  try {
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(onInformation).not.toHaveBeenCalled();
    expect(prevented).toEqual([false, false]);
    fireEvent.click(link);
    expect(onInformation).toHaveBeenCalledOnce();
    expect(prevented.at(-1)).toBe(true);
  } finally {
    window.removeEventListener("click", finishNativeClick);
  }
  rerender(<HeaderActions {...props} currentView="info" />);
  expect(link).toHaveAttribute("aria-current", "page");
});
