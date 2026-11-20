"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { TextButton } from "@openameba/spindle-ui/TextButton";
import type { View } from "../lib/route-state";

export const firstVisitTourKey = "guidance-first-visit-tour-v2";

const steps: { target: View; title: string; description: string }[] = [
  {
    target: "home",
    title: "ホーム",
    description: "当日の案内や、提出・回答が必要なやることを確認できます。",
  },
  {
    target: "search",
    title: "探す",
    description: "企業名・業種・ブース番号で検索し、参加時間帯で絞り込めます。",
  },
  {
    target: "schedule",
    title: "スケジュール",
    description:
      "当日の流れを確認できます。名簿番号を設定すると、自分の指定訪問先も確認できます。",
  },
  {
    target: "map",
    title: "会場マップ",
    description:
      "ブースの位置を確認できます。地図上のピンから企業詳細を開けます。",
  },
  {
    target: "plan",
    title: "気になる",
    description:
      "保存した企業は、ここから確認できます。企業一覧のしおりアイコンで追加できます。",
  },
  {
    target: "info",
    title: "配布資料の案内",
    description: "この書類アイコンから、当日の配布資料を確認できます。",
  },
];

const progressId = "first-visit-tour-progress";
const descriptionId = "first-visit-tour-description";
const edge = 12;
const gap = 12;
function placement(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const padding = target.closest(".mobile-navigation") ? 0 : 6;
  const width = document.documentElement.clientWidth || window.innerWidth;
  const height = window.innerHeight;
  const left = Math.max(0, rect.left - padding);
  const right = Math.min(width, rect.right + padding);
  const top = Math.max(0, rect.top - padding);
  const bottom = Math.min(height, rect.bottom + padding);
  const center = (left + right) / 2;
  const cardWidth = Math.min(360, width - edge * 2);
  const cardLeft = Math.min(
    Math.max(center - cardWidth / 2, edge),
    width - cardWidth - edge,
  );
  const side = top > height - bottom ? "above" : "below";
  return {
    side,
    style: {
      "--tour-left": `${left}px`,
      "--tour-right": `${right}px`,
      "--tour-top": `${top}px`,
      "--tour-bottom": `${bottom}px`,
      "--tour-panel-width": `${cardWidth}px`,
      "--tour-panel-left": `${cardLeft}px`,
      "--tour-panel-edge": `${side === "above" ? height - top + gap : bottom + gap}px`,
      "--tour-panel-height": `${Math.max(top, height - bottom) - gap - edge}px`,
      "--tour-arrow-left": `${Math.min(Math.max(center - cardLeft, 16), cardWidth - 16)}px`,
    } as CSSProperties,
  };
}

export default function FirstVisitTour({
  returnFocusRef,
}: {
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(firstVisitTourKey) === "1") return;
      localStorage.setItem(firstVisitTourKey, "1");
      setVisible(true);
    } catch {
      // Only open automatically if the browser can remember the visit.
    }
  }, []);
  const dismiss = useCallback(() => {
    setVisible(false);
    returnFocusRef.current?.focus({ preventScroll: true });
  }, [returnFocusRef]);

  return visible && <Tour onDismiss={dismiss} />;
}

function Tour({ onDismiss }: { onDismiss: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const activeTarget = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState(0);
  const [position, setPosition] = useState<ReturnType<typeof placement> | null>(
    null,
  );
  const step = steps[index];
  const isLast = index === steps.length - 1;

  useLayoutEffect(() => {
    let restoreDescription = () => {};
    let initialized = false;
    const selector = `[data-tour-target="${step.target}"]`;
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(selector),
    );

    function update() {
      const target =
        targets.find((item) => item.getClientRects().length) ?? null;
      const previous = activeTarget.current;

      if (target !== previous) {
        const shouldFocus =
          !previous ||
          document.activeElement === previous ||
          document.activeElement === document.body;
        restoreDescription();
        activeTarget.current = target;
        if (target) {
          const description = target.getAttribute("aria-describedby");
          target.setAttribute(
            "aria-describedby",
            [description, progressId, descriptionId].filter(Boolean).join(" "),
          );
          restoreDescription = () => {
            if (description === null)
              target.removeAttribute("aria-describedby");
            else target.setAttribute("aria-describedby", description);
          };
          if (shouldFocus) {
            const rect = target.getBoundingClientRect();
            if (rect.top < 0 || rect.bottom > window.innerHeight)
              target.scrollIntoView({ block: "nearest", behavior: "instant" });
            target.focus({ preventScroll: true });
          }
        }
      }

      if (target) {
        setPosition(placement(target));
      } else {
        setPosition(null);
        if (!initialized || previous)
          heading.current?.focus({ preventScroll: true });
      }
      initialized = true;
    }

    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    for (const target of targets) observer?.observe(target);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      restoreDescription();
      activeTarget.current = null;
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
    };
  }, [step.target]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== "Tab") return;

      const buttons = panel.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      );
      const target = activeTarget.current;
      const controls = [...(target ? [target] : []), ...(buttons ?? [])];
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0
          ? controls.length - 1
          : current - 1
        : (current + 1) % controls.length;
      event.preventDefault();
      controls[next]?.focus();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onDismiss]);

  return (
    <div
      className="first-visit-tour"
      style={position?.style}
      data-side={position?.side}
    >
      <div className="tour-backdrop" aria-hidden="true">
        {position && (
          <>
            <div className="tour-shade tour-shade-top" />
            <div className="tour-shade tour-shade-left" />
            <div className="tour-shade tour-shade-right" />
            <div className="tour-shade tour-shade-bottom" />
            <div className="tour-highlight" />
          </>
        )}
      </div>
      <div className="tour-callout">
        <section className="tour-content" ref={panel} aria-label="ガイドツアー">
          <div className="tour-header">
            <span>ガイドツアー</span>
            <span id={progressId}>
              {index + 1} / {steps.length}
            </span>
          </div>
          <h2 ref={heading} tabIndex={-1} aria-describedby={descriptionId}>
            {step.title}
          </h2>
          <p id={descriptionId}>{step.description}</p>
          <div className="tour-controls">
            <TextButton type="button" onClick={onDismiss}>
              スキップ
            </TextButton>
            <div className="tour-step-controls">
              <Button
                type="button"
                size="small"
                variant="outlined"
                disabled={index === 0}
                onClick={() => setIndex(index - 1)}
              >
                戻る
              </Button>
              <Button
                type="button"
                size="small"
                onClick={isLast ? onDismiss : () => setIndex(index + 1)}
              >
                {isLast ? "はじめる" : "次へ"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
