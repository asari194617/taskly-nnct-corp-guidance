"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { DropdownMenu } from "@openameba/spindle-ui/DropdownMenu";
import { IconButton } from "@openameba/spindle-ui/IconButton";
import { Icon } from "./icons";
import { useOffline } from "./offline-context";

type Props = {
  name: string;
  rosterNumber: number | null;
  busy: boolean;
  onConfigure: () => void;
  onLogout: () => void;
};

export default function AccountMenu({
  name,
  rosterNumber,
  busy,
  onConfigure,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  const { offline } = useOffline();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialFocus = useRef<"first" | "last">("first");

  useLayoutEffect(() => {
    if (!open) return;
    const menu = root.current?.querySelector<HTMLElement>('[role="menu"]');
    // Spindle's public List API does not forward aria-* attributes.
    menu?.setAttribute("aria-label", "ユーザーメニュー");
    const items =
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (items?.[0]) {
      items[0].disabled = offline;
      items[0].setAttribute("aria-disabled", String(offline));
    }
    const available = Array.from(items || []).filter((item) => !item.disabled);
    if (available.length)
      available[
        initialFocus.current === "last" ? available.length - 1 : 0
      ].focus();
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("click", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("click", dismiss);
    };
  }, [open, offline]);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  return (
    <div
      className="account-menu"
      ref={root}
      onKeyDownCapture={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
          return;
        }
        if (event.key === "Tab") {
          close(true);
          return;
        }
        const items = Array.from(
          root.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)',
          ) || [],
        );
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        let next: number;
        if (event.key === "ArrowDown") next = (index + 1) % items.length;
        else if (event.key === "ArrowUp")
          next = (index - 1 + items.length) % items.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else return;
        event.preventDefault();
        items[next]?.focus();
      }}
    >
      <DropdownMenu.Frame>
        <IconButton
          ref={trigger}
          size="small"
          variant="neutral"
          aria-label="ユーザーメニュー"
          aria-haspopup="menu"
          aria-controls={open ? "account-menu" : undefined}
          aria-expanded={open}
          disabled={busy}
          onClick={() => {
            initialFocus.current = "first";
            setOpen((value) => !value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
              setOpen(true);
            }
          }}
        >
          <span className="account-avatar">
            <Icon name="user" size={18} />
          </span>
        </IconButton>
        <DropdownMenu.List
          id="account-menu"
          triggerRef={trigger}
          open={open}
          onClose={() => close()}
          position="bottomRight"
          variant="textWithIcon"
        >
          <div className="account-menu-identity" role="presentation">
            <DropdownMenu.Title>{name || "Taskly ユーザー"}</DropdownMenu.Title>
            {rosterNumber !== null && (
              <DropdownMenu.Caption>
                Ec4 · {rosterNumber}番
              </DropdownMenu.Caption>
            )}
          </div>
          <DropdownMenu.ListItem
            icon={<Icon name="user" />}
            onClick={() => {
              if (offline) return;
              close();
              onConfigure();
            }}
          >
            <DropdownMenu.Title>名簿番号の設定</DropdownMenu.Title>
          </DropdownMenu.ListItem>
          <DropdownMenu.ListItem
            icon={<Icon name="logout" />}
            onClick={() => {
              close();
              onLogout();
            }}
          >
            <DropdownMenu.Title>ログアウト</DropdownMenu.Title>
          </DropdownMenu.ListItem>
        </DropdownMenu.List>
      </DropdownMenu.Frame>
    </div>
  );
}
