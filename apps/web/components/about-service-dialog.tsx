"use client";

import { useEffect, useRef, type RefObject } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { TextLink } from "@openameba/spindle-ui/TextLink";
import Image from "next/image";

export default function AboutServiceDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const returnFocus = returnFocusRef.current;
    dialog?.showModal();
    closeButton.current?.focus();
    return () => {
      dialog?.close();
      returnFocus?.focus();
    };
  }, [returnFocusRef]);

  return (
    <dialog
      ref={ref}
      className="about-service-dialog"
      aria-label="このサービスについて"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled)",
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className="dialog-inner about-service-content">
        <Image
          className="brand-logo"
          src="/taskly-logo.svg"
          width={558}
          height={160}
          alt=""
        />
        <h2>Taskly 企業ガイダンス</h2>
        <TextLink
          href="https://ritzy-lift-e38.notion.site/28ba3874f8c880a783ddf9d39aea1242"
          target="_blank"
          rel="noopener noreferrer"
        >
          利用規約
        </TextLink>
        <p className="about-service-copyright">
          © 2026{" "}
          <TextLink
            href="https://x.com/asari194617"
            target="_blank"
            rel="noopener noreferrer"
          >
            asari
          </TextLink>
        </p>
        <Button
          ref={closeButton}
          variant="neutral"
          size="small"
          layout="fullWidth"
          onClick={onClose}
        >
          閉じる
        </Button>
      </div>
    </dialog>
  );
}
