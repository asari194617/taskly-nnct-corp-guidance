"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { TextButton } from "@openameba/spindle-ui/TextButton";
import { Icon, type IconName } from "./icons";

export const firstVisitTourKey = "guidance-first-visit-tour";

const steps: { title: string; description: string; icon: IconName }[] = [
  {
    title: "ホーム",
    description: "当日の案内や、提出・回答が必要なやることを確認できます。",
    icon: "home",
  },
  {
    title: "探す",
    description: "企業名・業種・ブース番号で検索し、参加時間帯で絞り込めます。",
    icon: "search",
  },
  {
    title: "スケジュール",
    description:
      "当日の流れを確認できます。名簿番号を設定すると、自分の指定訪問先も確認できます。",
    icon: "calendar",
  },
  {
    title: "会場マップ",
    description:
      "ブースの位置を確認できます。地図上のピンから企業詳細を開けます。",
    icon: "map",
  },
  {
    title: "気になる",
    description:
      "企業のしおりアイコンで保存した企業を、「気になる」でまとめて確認できます。",
    icon: "bookmark",
  },
  {
    title: "配布資料の案内",
    description: "ヘッダーの書類アイコンから、当日の配布資料を確認できます。",
    icon: "document",
  },
];

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

  if (!visible) return null;
  return (
    <TourDialog
      onDismiss={() => {
        setVisible(false);
        if (document.activeElement === document.body)
          returnFocusRef.current?.focus({ preventScroll: true });
      }}
    />
  );
}

function TourDialog({ onDismiss }: { onDismiss: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const isLast = index === steps.length - 1;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Announce each newly rendered step by focusing its heading.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [index]);

  function dismiss() {
    dialogRef.current?.close();
    onDismiss();
  }

  return (
    <dialog
      ref={dialogRef}
      className="first-visit-tour"
      aria-labelledby="first-visit-tour-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const active = document.activeElement;
        if (
          event.shiftKey &&
          (active === first || active === headingRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="dialog-inner tour-content">
        <div className="tour-header">
          <h2 id="first-visit-tour-title">ガイドツアー</h2>
          <span id="first-visit-tour-progress">
            {index + 1} / {steps.length}
          </span>
        </div>
        <div className="tour-feature">
          <span className="tour-icon">
            <Icon name={step.icon} size={28} />
          </span>
          <h3
            ref={headingRef}
            tabIndex={-1}
            aria-describedby="first-visit-tour-progress first-visit-tour-description"
          >
            {step.title}
          </h3>
          <p id="first-visit-tour-description">{step.description}</p>
        </div>
        <div className="tour-controls">
          <TextButton type="button" onClick={dismiss}>
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
              onClick={isLast ? dismiss : () => setIndex(index + 1)}
            >
              {isLast ? "はじめる" : "次へ"}
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
