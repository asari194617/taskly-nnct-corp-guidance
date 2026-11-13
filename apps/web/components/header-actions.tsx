"use client";

import { TextLink } from "@openameba/spindle-ui/TextLink";
import AccountMenu from "./account-menu";
import { Icon } from "./icons";

type Props = {
  name: string;
  rosterNumber: number | null;
  busy: boolean;
  currentView: string;
  onConfigure: () => void;
  onInformation: () => void;
  onLogout: () => void;
};

export default function HeaderActions({
  name,
  rosterNumber,
  busy,
  currentView,
  onConfigure,
  onInformation,
  onLogout,
}: Props) {
  return (
    <div className="header-actions">
      <TextLink
        href="/documents/"
        variant={currentView === "info" ? undefined : "subtle"}
        aria-label="配布資料の案内"
        aria-current={currentView === "info" ? "page" : undefined}
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          onInformation();
        }}
      >
        <Icon name="document" size={22} />
      </TextLink>
      <AccountMenu
        name={name}
        rosterNumber={rosterNumber}
        busy={busy}
        onConfigure={onConfigure}
        onLogout={onLogout}
      />
    </div>
  );
}
