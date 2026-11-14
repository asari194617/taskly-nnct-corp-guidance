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
import { TextLink } from "@openameba/spindle-ui/TextLink";
import type { Company } from "../lib/types";
import { Icon } from "./icons";
import { useOffline } from "./offline-context";

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
  const { offline } = useOffline();
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
      disabled={pending || offline}
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
  headingRef?: Ref<HTMLHeadingElement>;
};

export function CompanyDetailContent({
  company,
  saved,
  assigned,
  onSave,
  titleId,
  notification,
  headingRef,
}: DetailProps) {
  const { offline } = useOffline();
  const googleSearch = `https://google.com/?${new URLSearchParams({ q: company.name })}`;
  return (
    <>
      <div className="dialog-top">
        <span className="session-badge">
          {company.session === "AM" ? "午前" : "午後"}の部{" "}
          {assigned && <span className="assignment-badge">指定</span>}
        </span>
      </div>
      <fieldset className="company-identity" aria-labelledby={titleId}>
        <div className="company-detail-heading">
          <h2
            id={titleId}
            ref={headingRef}
            tabIndex={headingRef ? -1 : undefined}
          >
            {company.name}
          </h2>
        </div>
        <div className="industry-tags">
          {company.industries.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </div>
        <div className="company-detail-actions">
          <FavoriteButton company={company} saved={saved} onToggle={onSave} />
          {offline ? (
            <span className="company-google-action" aria-disabled="true">
              Googleで調べる
              <Icon name="external" size={16} />
            </span>
          ) : (
            <span className="company-google-action">
              <TextLink
                href={googleSearch}
                target="_blank"
                rel="noopener noreferrer"
                icon={<Icon name="external" size={16} />}
              >
                Googleで調べる
              </TextLink>
            </span>
          )}
        </div>
      </fieldset>
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
}: Omit<DetailProps, "titleId" | "headingRef"> & {
  focusOnOpen: boolean;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new selected company must receive keyboard focus even when focusOnOpen stays true.
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
        />
      </div>
      <div className="map-company-close">
        <IconButton
          size="small"
          variant="neutral"
          aria-label="企業情報を閉じる"
          onClick={onClose}
        >
          <Icon name="close" />
        </IconButton>
      </div>
    </section>
  );
}
