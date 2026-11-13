"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode, Ref } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { IconButton } from "@openameba/spindle-ui/IconButton";
import type { Company } from "../lib/types";
import { Icon } from "./icons";

const FavoritePendingContext = createContext<ReadonlySet<string>>(new Set());
export const FavoritePendingProvider = FavoritePendingContext.Provider;

export function FavoriteButton({
  company,
  saved,
  onToggle,
}: {
  company: Company;
  saved: boolean;
  onToggle: () => Promise<void>;
}) {
  const [pendingCompanies, setPendingCompanies] = useState<Set<string>>(
    () => new Set(),
  );
  const activeRequests = useRef(new Set<string>());
  const sharedPending = useContext(FavoritePendingContext);
  const pending =
    sharedPending.has(company.id) || pendingCompanies.has(company.id);
  return (
    <Button
      size="small"
      variant={saved ? "lighted" : "outlined"}
      icon={<Icon name={saved ? "check" : "plus"} size={18} />}
      aria-pressed={saved}
      aria-busy={pending || undefined}
      aria-label={`${company.name}を${saved ? "気になるから解除" : "気になるに追加"}`}
      disabled={pending}
      onClick={() => {
        const id = company.id;
        if (activeRequests.current.has(id)) return;
        activeRequests.current.add(id);
        setPendingCompanies((previous) => new Set(previous).add(id));
        const settle = () => {
          activeRequests.current.delete(id);
          setPendingCompanies((previous) => {
            const next = new Set(previous);
            next.delete(id);
            return next;
          });
        };
        // The shared save handler reports errors and rolls back the optimistic
        // state. Both outcomes must release this company's pending control.
        void onToggle().then(settle, settle);
      }}
    >
      気になる
    </Button>
  );
}

type DetailProps = {
  company: Company;
  saved: boolean;
  assigned: boolean;
  onSave: () => Promise<void>;
  titleId: string;
  notification?: ReactNode;
  closeAction?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
};

export function CompanyDetailContent({
  company,
  saved,
  assigned,
  onSave,
  titleId,
  notification,
  closeAction,
  headingRef,
}: DetailProps) {
  return (
    <>
      <div className="dialog-top">
        <span className="session-badge">
          {company.session === "AM" ? "午前" : "午後"}の部{" "}
          {assigned && <span className="assignment-badge">指定</span>}
        </span>
      </div>
      <div className="company-identity" role="group" aria-labelledby={titleId}>
        <div className="company-detail-heading">
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={headingRef ? -1 : undefined}
          >
            {company.name}
          </h2>
          {closeAction}
        </div>
        <div className="industry-tags">
          {company.industries.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </div>
        <FavoriteButton company={company} saved={saved} onToggle={onSave} />
      </div>
      {notification}
      <div className="booth-detail">
        <Icon name="location" size={27} />
        <div>
          <span>ブース</span>
          <strong>{company.booth}</strong>
        </div>
      </div>
    </>
  );
}

export function MapCompanyPanel({
  company,
  saved,
  assigned,
  onSave,
  notification,
  focusOnOpen,
  onClose,
  returnFocus,
}: Omit<DetailProps, "titleId" | "closeAction" | "headingRef"> & {
  focusOnOpen: boolean;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (focusOnOpen) heading.current?.focus({ preventScroll: true });
  }, [company.id, focusOnOpen]);
  useLayoutEffect(() => {
    const element = panel.current;
    return () => {
      if (element?.contains(document.activeElement)) returnFocus();
    };
  }, [returnFocus]);
  return (
    <section
      ref={panel}
      className="map-company-panel"
      aria-labelledby="map-company-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="map-company-panel-inner">
        <CompanyDetailContent
          company={company}
          saved={saved}
          assigned={assigned}
          onSave={onSave}
          titleId="map-company-title"
          notification={notification}
          headingRef={heading}
          closeAction={
            <IconButton
              size="small"
              variant="neutral"
              aria-label="企業情報を閉じる"
              onClick={onClose}
            >
              <Icon name="close" />
            </IconButton>
          }
        />
      </div>
    </section>
  );
}
