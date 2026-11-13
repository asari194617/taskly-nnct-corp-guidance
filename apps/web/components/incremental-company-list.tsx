"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import type { Company } from "../lib/types";

const BATCH_SIZE = 24;

export default function IncrementalCompanyList({
  companies,
  resetKey,
  children,
}: {
  companies: Company[];
  resetKey: string;
  children: (company: Company) => ReactNode;
}) {
  const listKey = resetKey;
  const [page, setPage] = useState({ key: listKey, count: BATCH_SIZE });
  const [moreFocused, setMoreFocused] = useState(false);
  const visibleCount = Math.min(
    page.key === listKey ? page.count : BATCH_SIZE,
    companies.length,
  );
  const hasMore = visibleCount < companies.length;
  const grid = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const focusNext = useRef<number | null>(null);

  useEffect(() => {
    focusNext.current = null;
    setPage((previous) =>
      previous.key === listKey ? previous : { key: listKey, count: BATCH_SIZE },
    );
  }, [listKey]);

  const showMore = useCallback(() => {
    setPage((previous) => ({
      key: listKey,
      count: Math.min(
        (previous.key === listKey ? previous.count : BATCH_SIZE) + BATCH_SIZE,
        companies.length,
      ),
    }));
  }, [listKey, companies.length]);

  useEffect(() => {
    if (
      !hasMore ||
      !sentinel.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) {
          active = false;
          observer.disconnect();
          showMore();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(sentinel.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasMore, listKey, visibleCount, showMore]);

  useLayoutEffect(() => {
    const index = focusNext.current;
    if (index === null) return;
    focusNext.current = null;
    if (index >= visibleCount) return;
    const firstNewCard = grid.current?.children[index];
    firstNewCard
      ?.querySelector<HTMLElement>("a[href], button")
      ?.focus({ preventScroll: true });
  }, [visibleCount]);

  return (
    <>
      <div className="company-grid" ref={grid}>
        {companies.slice(0, visibleCount).map((company) => (
          <Fragment key={company.id}>{children(company)}</Fragment>
        ))}
      </div>
      {companies.length > BATCH_SIZE && (
        <div className="company-list-progress">
          <p role="status">
            {visibleCount} / {companies.length}社
          </p>
          {hasMore && (
            <div
              ref={sentinel}
              className="company-list-sentinel"
              aria-hidden="true"
            />
          )}
          {(hasMore || moreFocused) && (
            <Button
              variant="outlined"
              aria-disabled={!hasMore}
              onFocus={() => setMoreFocused(true)}
              onBlur={() => setMoreFocused(false)}
              onClick={() => {
                if (!hasMore) return;
                focusNext.current = visibleCount;
                showMore();
              }}
            >
              {hasMore ? "もっと見る" : "すべて表示しました"}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
