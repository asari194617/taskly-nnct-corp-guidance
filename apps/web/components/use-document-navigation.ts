"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APIError, documentURL } from "../lib/api";
import { navigateDocument } from "../lib/document-navigation";

export function useDocumentNavigation(onExpired: () => void, scope = "") {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const mounted = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const requestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    setOpening(false);
    setError("");
    return () => {
      mounted.current = false;
      generation.current++;
      request.current?.abort();
      request.current = null;
      if (requestTimer.current !== null) clearTimeout(requestTimer.current);
      requestTimer.current = null;
    };
  }, [scope]);

  const openDocument = useCallback(async (id: string, page?: number) => {
    if (!mounted.current || request.current) return;
    const controller = new AbortController();
    const currentGeneration = generation.current;
    request.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    requestTimer.current = timer;
    setOpening(true);
    setError("");
    try {
      const result = await documentURL(id, controller.signal);
      if (
        !mounted.current ||
        currentGeneration !== generation.current ||
        controller.signal.aborted
      )
        return;
      navigateDocument(result.url, page);
    } catch (cause) {
      if (
        !mounted.current ||
        currentGeneration !== generation.current ||
        (controller.signal.aborted && !timedOut)
      )
        return;
      if (cause instanceof APIError && cause.status === 401) expired.current();
      else setError("資料を開けませんでした。もう一度お試しください。");
    } finally {
      clearTimeout(timer);
      if (request.current === controller) {
        request.current = null;
        requestTimer.current = null;
      }
      if (mounted.current && currentGeneration === generation.current)
        setOpening(false);
    }
  }, []);

  return { opening, error, openDocument };
}
