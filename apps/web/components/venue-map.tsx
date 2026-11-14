"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Checkbox } from "@openameba/spindle-ui/Form/Checkbox";
import { TextField } from "@openameba/spindle-ui/Form/TextField";
import { Button } from "@openameba/spindle-ui/Button";
import { IconButton } from "@openameba/spindle-ui/IconButton";
import { TextButton } from "@openameba/spindle-ui/TextButton";
import { SegmentedControl } from "@openameba/spindle-ui/SegmentedControl";
import { InlineNotification } from "@openameba/spindle-ui/InlineNotification";
import { APIError, documentURL } from "../lib/api";
import type { Company, Document } from "../lib/types";
import { Icon } from "./icons";
import { useOffline } from "./offline-context";
import { readOfflineMap, saveOfflineMap } from "../lib/offline-store";
import "./venue-map.css";
import IndustryChips from "./industry-chips";

type Booth = {
  booth: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
type MapDocument = Document & {
  booths?: Booth[];
  image_width?: number;
  image_height?: number;
};
type Props = {
  documents: MapDocument[];
  companies: Company[];
  session: "AM" | "PM";
  selectedCompanyId?: string;
  onSelectCompany: (company: Company) => void;
  onSessionChange: (session: "AM" | "PM") => void;
  onExpired: () => void;
  savedCompanyIds?: ReadonlySet<string>;
  assignedCompanyIds?: ReadonlySet<string>;
  search?: string;
  industries?: string[];
  mode?: "fullscreen" | "embedded";
  detailPanelOpen?: boolean;
  detailPanel?: ReactNode;
  onlySaved?: boolean;
  onlyAssigned?: boolean;
  onFiltersChange?: (patch: Partial<Filters>) => void;
};

type Filters = {
  q: string;
  industries: string[];
  saved: boolean;
  assigned: boolean;
};
const normalized = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, "");
const clampZoom = (value: number) =>
  Math.round(Math.max(50, Math.min(800, value)));

function validBooth(booth: Booth) {
  return (
    Number.isInteger(booth.booth) &&
    booth.booth > 0 &&
    [booth.x, booth.y, booth.width, booth.height].every(Number.isFinite) &&
    booth.x >= 0 &&
    booth.y >= 0 &&
    booth.width > 0 &&
    booth.height > 0 &&
    booth.x + booth.width <= 1.001 &&
    booth.y + booth.height <= 1.001
  );
}

export default function VenueMap({
  documents,
  companies,
  session,
  selectedCompanyId,
  onSelectCompany,
  onSessionChange,
  onExpired,
  savedCompanyIds,
  assignedCompanyIds,
  search,
  industries: chosenIndustries,
  mode = "fullscreen",
  detailPanelOpen = false,
  detailPanel,
  onlySaved,
  onlyAssigned,
  onFiltersChange,
}: Props) {
  const offline = useOffline();
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const images = useMemo(
    () =>
      documents.filter(
        (item) => item.kind === "map" && item.mime_type.startsWith("image/"),
      ),
    [documents],
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [previewCompanyId, setPreviewCompanyId] = useState<string | null>(null);
  const componentId = useId();
  const embedded = mode === "embedded";
  const panelOpen = detailPanelOpen && !embedded;
  const [localFilters, setLocalFilters] = useState<Filters>({
    q: "",
    industries: [],
    saved: false,
    assigned: false,
  });
  const filters = {
    q: search ?? localFilters.q,
    industries: chosenIndustries ?? localFilters.industries,
    saved: onlySaved ?? localFilters.saved,
    assigned: onlyAssigned ?? localFilters.assigned,
  };
  function changeFilters(patch: Partial<Filters>) {
    setLocalFilters((value) => ({ ...value, ...patch }));
    onFiltersChange?.(patch);
  }
  const [floor, setFloor] = useState(images[0]?.id || "");
  const [url, setURL] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [viewReset, setViewReset] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const centeredView = useRef("");
  const [attempt, setAttempt] = useState(0);
  const [imageSize, setImageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const highlighted = useRef<HTMLButtonElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const mapRoot = useRef<HTMLElement | null>(null);
  const bottomControls = useRef<HTMLDivElement | null>(null);
  const previewTooltip = useRef<HTMLDivElement | null>(null);
  const previewPoint = useRef<{ x: number; y: number } | null>(null);
  const previewFrame = useRef<number | null>(null);
  const supportsHoverPreview = () =>
    window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === true;
  function positionPreview() {
    const tooltip = previewTooltip.current;
    const root = mapRoot.current;
    const point = previewPoint.current;
    if (!tooltip || !root || !point) return;
    const bounds = root.getBoundingClientRect();
    const size = tooltip.getBoundingClientRect();
    const gap = 12;
    const edge = 8;
    let left = point.x - bounds.left + gap;
    let top = point.y - bounds.top + gap;
    if (left + size.width > bounds.width - edge)
      left = point.x - bounds.left - size.width - gap;
    if (top + size.height > bounds.height - edge)
      top = point.y - bounds.top - size.height - gap;
    tooltip.style.left = `${Math.max(edge, Math.min(left, bounds.width - size.width - edge))}px`;
    tooltip.style.top = `${Math.max(edge, Math.min(top, bounds.height - size.height - edge))}px`;
  }
  function movePreview(x: number, y: number) {
    previewPoint.current = { x, y };
    if (previewFrame.current !== null) return;
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = null;
      positionPreview();
    });
  }

  const zoomValue = useRef(zoom);
  const zoomAnchor = useRef<{ left: number; top: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
    distance: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [focusedBooth, setFocusedBooth] = useState<number | null>(null);
  function changeZoom(
    value: number,
    point?: { x: number; y: number },
    previousPoint?: { x: number; y: number },
  ) {
    const next = clampZoom(value),
      element = viewport.current;
    if (element) {
      const bounds = element.getBoundingClientRect();
      const x = point ? point.x - bounds.left : element.clientWidth / 2;
      const y = point ? point.y - bounds.top : element.clientHeight / 2;
      const previousX = previousPoint ? previousPoint.x - bounds.left : x;
      const previousY = previousPoint ? previousPoint.y - bounds.top : y;
      const ratio = next / zoomValue.current;
      zoomAnchor.current = {
        left:
          (element.scrollLeft + previousX - element.clientWidth / 2) * ratio +
          element.clientWidth / 2 -
          x,
        top:
          (element.scrollTop + previousY - element.clientHeight / 2) * ratio +
          element.clientHeight / 2 -
          y,
      };
    }
    if (next === zoomValue.current && element && zoomAnchor.current) {
      element.scrollLeft = zoomAnchor.current.left;
      element.scrollTop = zoomAnchor.current.top;
      zoomAnchor.current = null;
    }
    zoomValue.current = next;
    setZoom(next);
  }
  function resetView() {
    changeZoom(100);
    setViewReset((value) => value + 1);
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () =>
      setViewportSize((previous) => {
        const width = element.clientWidth,
          height = element.clientHeight;
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [floor, embedded]);
  useLayoutEffect(() => {
    zoomValue.current = zoom;
    const element = viewport.current,
      anchor = zoomAnchor.current;
    if (element && anchor) {
      element.scrollLeft = anchor.left;
      element.scrollTop = anchor.top;
      zoomAnchor.current = null;
    }
  }, [zoom]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      changeZoom(zoomValue.current * Math.exp(-event.deltaY * 0.005), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [floor]);
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!pointers.current.size) suppressClick.current = false;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const element = event.currentTarget,
      points = [...pointers.current.values()];
    gesture.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
      moved: false,
      distance:
        points.length > 1
          ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
          : 0,
    };
    if (points.length > 1) {
      suppressClick.current = true;
      event.preventDefault();
    }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    const oldPoints = [...pointers.current.values()];
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = [...pointers.current.values()],
      previous = gesture.current;
    if (points.length > 1) {
      const distance = Math.hypot(
        points[0].x - points[1].x,
        points[0].y - points[1].y,
      );
      if (previous.distance > 0)
        changeZoom(
          (zoomValue.current * distance) / previous.distance,
          {
            x: (points[0].x + points[1].x) / 2,
            y: (points[0].y + points[1].y) / 2,
          },
          {
            x: (oldPoints[0].x + oldPoints[1].x) / 2,
            y: (oldPoints[0].y + oldPoints[1].y) / 2,
          },
        );
      previous.distance = distance;
      suppressClick.current = true;
      previous.moved = true;
    } else {
      const dx = event.clientX - previous.x,
        dy = event.clientY - previous.y;
      if (!previous.moved && Math.hypot(dx, dy) < 6) return;
      previous.moved = true;
      suppressClick.current = true;
      event.currentTarget.scrollLeft = previous.left - dx;
      event.currentTarget.scrollTop = previous.top - dy;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }
  function pointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const point = [...pointers.current.values()][0];
    gesture.current = point
      ? {
          x: point.x,
          y: point.y,
          left: event.currentTarget.scrollLeft,
          top: event.currentTarget.scrollTop,
          moved: true,
          distance: 0,
        }
      : null;
    if (!point) setDragging(false);
  }
  const current = images.find((item) => item.id === floor);
  const previewCompany = companies.find((item) => item.id === previewCompanyId);
  const imageWidth = current?.image_width || imageSize?.width || 0;
  const imageHeight = current?.image_height || imageSize?.height || 0;
  const fittedWidth =
    imageWidth && imageHeight && viewportSize.width && viewportSize.height
      ? Math.min(
          viewportSize.width,
          (viewportSize.height * imageWidth) / imageHeight,
        )
      : viewportSize.width;
  const boardWidth = (fittedWidth * zoom) / 100;
  useLayoutEffect(() => {
    const element = viewport.current,
      key = `${floor}:${viewReset}`;
    if (
      !url ||
      !element ||
      !viewportSize.width ||
      !viewportSize.height ||
      !imageWidth ||
      !imageHeight ||
      centeredView.current === key
    )
      return;
    // Padding leaves room to drag even when the whole drawing fits on screen.
    element.scrollLeft = boardWidth / 2;
    element.scrollTop = (boardWidth * imageHeight) / imageWidth / 2;
    centeredView.current = key;
  }, [
    url,
    floor,
    viewReset,
    viewportSize,
    imageWidth,
    imageHeight,
    boardWidth,
  ]);
  const available = useMemo(
    () =>
      new Map(
        companies
          .filter((company) => company.session === session)
          .map((company) => [company.booth, company]),
      ),
    [companies, session],
  );
  const booths = useMemo(
    () =>
      (current?.booths || [])
        .filter(validBooth)
        .sort((a, b) => a.booth - b.booth),
    [current],
  );

  const industries = useMemo(
    () =>
      [...new Set(companies.flatMap((item) => item.industries))].sort((a, b) =>
        a.localeCompare(b, "ja"),
      ),
    [companies],
  );
  const matching = companies.filter(
    (company) =>
      company.session === session &&
      available.has(company.booth) &&
      booths.some((booth) => booth.booth === company.booth) &&
      (!filters.q ||
        normalized(`${company.name} ${company.booth}`).includes(
          normalized(filters.q),
        )) &&
      (!filters.industries.length ||
        filters.industries.some((value) =>
          company.industries.includes(value),
        )) &&
      (!filters.saved || savedCompanyIds?.has(company.id)) &&
      (!filters.assigned || assignedCompanyIds?.has(company.id)),
  );
  const matchedIds = new Set(matching.map((company) => company.id));
  const keyboardBooths = booths.filter((booth) => {
    const company = available.get(booth.booth);
    return company && matchedIds.has(company.id);
  });
  const tabBooth =
    keyboardBooths.find((booth) => booth.booth === focusedBooth)?.booth ??
    keyboardBooths.find(
      (booth) => available.get(booth.booth)?.id === selectedCompanyId,
    )?.booth ??
    keyboardBooths[0]?.booth;
  const activeFilters = [
    filters.q,
    ...filters.industries,
    filters.saved && "気になる",
    filters.assigned && "指定企業",
  ].filter(Boolean);

  // Reserve the actual control stack height, including wrapped floor names.
  // The controls keep their right-bottom anchor when a company pane opens.
  useLayoutEffect(() => {
    const controls = bottomControls.current;
    const root = mapRoot.current;
    if (!controls || !root) return;
    const measure = () => {
      const bounds = controls.getBoundingClientRect();
      root.style.setProperty("--map-controls-height", `${bounds.height}px`);
      root.style.setProperty("--map-controls-width", `${bounds.width}px`);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(controls);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [current?.id, embedded]);

  useLayoutEffect(() => {
    if (previewCompanyId) positionPreview();
  }, [previewCompanyId]);
  useEffect(() => {
    const media = window.matchMedia?.("(hover: hover) and (pointer: fine)");
    const changed = () => {
      if (!media?.matches) setPreviewCompanyId(null);
    };
    media?.addEventListener?.("change", changed);
    window.addEventListener("resize", positionPreview);
    return () => {
      window.removeEventListener("resize", positionPreview);
      media?.removeEventListener?.("change", changed);
      if (previewFrame.current !== null)
        cancelAnimationFrame(previewFrame.current);
    };
  }, []);
  useEffect(() => {
    setPreviewCompanyId(null);
  }, [session]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    const arena = images.find((item) => item.booths?.length);
    if (arena) setFloor(arena.id);
  }, [selectedCompanyId, images]);

  useEffect(() => {
    setPreviewCompanyId(null);
    if (!floor) return;
    const controller = new AbortController();
    const cacheSession = offlineRef.current.session;
    let disposed = false;
    let objectURL: string | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);
    setURL("");
    setLoading(true);
    setError("");
    setImageSize(null);
    pointers.current.clear();
    gesture.current = null;
    suppressClick.current = false;
    setDragging(false);
    const showBlob = (blob: Blob) => {
      if (disposed) return;
      objectURL = URL.createObjectURL(blob);
      setURL(objectURL);
    };
    const restore = async () => {
      const blob = cacheSession
        ? await readOfflineMap(cacheSession, floor)
        : null;
      if (!blob || disposed) return false;
      showBlob(blob);
      return true;
    };
    void (async () => {
      try {
        if (offlineRef.current.offline) {
          if (await restore()) return;
          setError("この地図は保存されていません。接続して取得してください。");
          return;
        }
        const signed = await documentURL(floor, controller.signal);
        if (disposed) return;
        if (await restore()) return;
        if (!cacheSession) {
          setURL(signed.url);
          return;
        }
        const response = await fetch(signed.url, {
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("地図を取得できませんでした。");
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || !blob.size)
          throw new Error("地図を読み込めませんでした。");
        if (disposed || controller.signal.aborted) return;
        await saveOfflineMap(cacheSession, floor, blob);
        if (!disposed) showBlob(blob);
      } catch (cause) {
        if (disposed || (controller.signal.aborted && !timedOut)) return;
        if (
          cause instanceof APIError &&
          (cause.status === 401 || cause.status === 403)
        ) {
          onExpired();
          return;
        }
        const transport =
          timedOut ||
          cause instanceof TypeError ||
          (typeof cause === "object" &&
            cause !== null &&
            "name" in cause &&
            cause.name === "AbortError");
        if (transport && (await restore())) {
          offlineRef.current.onOffline();
          return;
        }
        if (transport) offlineRef.current.onOffline();
        if (!disposed)
          setError(
            transport
              ? "この地図は保存されていません。接続して取得してください。"
              : cause instanceof Error
                ? cause.message
                : "マップを読み込めませんでした。",
          );
      } finally {
        clearTimeout(timer);
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [floor, attempt, onExpired, offline.session?.generation]);

  useEffect(() => {
    if (!embedded) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previous;
      };
    }
  }, [embedded]);

  // Selection can reveal a booth, but never changes a user's chosen zoom.
  useEffect(() => {
    const element = viewport.current,
      target = highlighted.current;
    if (!url || !element || !target || !element.clientWidth) return;
    const root = element.closest(".venue-map");
    const overlays = Array.from(
      root?.querySelectorAll<HTMLElement>(
        ".venue-map-floating:not(.venue-map-preview), .map-company-panel",
      ) ?? [],
    );
    const reveal = () => {
      const bounds = element.getBoundingClientRect();
      const selected = target.getBoundingClientRect();
      const padding = 16;
      const revealOffscreen = () => {
        // A highly zoomed booth may not fit anywhere; preserve its useful edge.
        if (selected.right <= bounds.left)
          element.scrollLeft -= bounds.left + padding - selected.left;
        else if (selected.left >= bounds.right)
          element.scrollLeft += selected.right - bounds.right + padding;
        if (selected.bottom <= bounds.top)
          element.scrollTop -= bounds.top + padding - selected.top;
        else if (selected.top >= bounds.bottom)
          element.scrollTop += selected.bottom - bounds.bottom + padding;
      };
      const obstacles = overlays
        .map((overlay) => overlay.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const intersects = (left: number, top: number, obstacle: DOMRect) =>
        left + selected.width > obstacle.left &&
        left < obstacle.right &&
        top + selected.height > obstacle.top &&
        top < obstacle.bottom;
      const minX = bounds.left + padding;
      const maxX = bounds.right - selected.width - padding;
      const minY = bounds.top + padding;
      const maxY = bounds.bottom - selected.height - padding;
      if (minX > maxX || minY > maxY) {
        revealOffscreen();
        return;
      }
      const clamp = (value: number, min: number, max: number) =>
        Math.max(min, Math.min(max, value));
      const xs = [selected.left, minX, maxX];
      const ys = [selected.top, minY, maxY];
      for (const rect of obstacles) {
        xs.push(rect.left - selected.width - padding, rect.right + padding);
        ys.push(rect.top - selected.height - padding, rect.bottom + padding);
      }
      let best: { left: number; top: number; distance: number } | undefined;
      for (const x of xs) {
        const left = clamp(x, minX, maxX);
        for (const y of ys) {
          const top = clamp(y, minY, maxY);
          if (obstacles.some((rect) => intersects(left, top, rect))) continue;
          const distance =
            (left - selected.left) ** 2 + (top - selected.top) ** 2;
          if (!best || distance < best.distance) best = { left, top, distance };
        }
      }
      // Find the nearest free rectangle against every visible overlay together,
      // rather than moving a booth out of one control and underneath another.
      if (best) {
        element.scrollLeft -= best.left - selected.left;
        element.scrollTop -= best.top - selected.top;
      } else revealOffscreen();
    };
    reveal();
    if (overlays.length && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(reveal);
      overlays.forEach((overlay) => observer.observe(overlay));
      return () => observer.disconnect();
    }
  }, [
    url,
    selectedCompanyId,
    session,
    imageSize,
    panelOpen,
    viewportSize,
    filtersOpen,
    resultsOpen,
    legendOpen,
  ]);

  return (
    <section
      ref={mapRoot}
      className="venue-map"
      data-mode={mode}
      data-detail-open={panelOpen ? "true" : undefined}
      aria-label={embedded ? "企業のブース位置" : "会場マップ"}
    >
      {!embedded && <h1 className="sr-only">会場マップ</h1>}
      {current ? (
        <>
          {!embedded && (
            <div className="venue-map-search-panel venue-map-floating">
              <label className="sr-only" htmlFor={`${componentId}-search`}>
                マップの企業名
              </label>
              <div className="venue-map-search-row">
                <div className="venue-map-search-input">
                  <span className="venue-map-search-icon" aria-hidden="true">
                    <Icon name="search" size={20} />
                  </span>
                  <TextField
                    id={`${componentId}-search`}
                    aria-label="マップの企業名"
                    type="search"
                    placeholder="名前・ブース番号"
                    value={filters.q}
                    onChange={(event) =>
                      changeFilters({ q: event.target.value })
                    }
                  />
                </div>
                {booths.length > 0 && (
                  <IconButton
                    size="small"
                    variant={activeFilters.length ? "lighted" : "neutral"}
                    aria-label="絞り込み"
                    aria-description={`指定条件${activeFilters.length}件`}
                    aria-pressed={activeFilters.length > 0}
                    aria-expanded={filtersOpen}
                    aria-controls={`${componentId}-filters`}
                    onClick={() => {
                      setFiltersOpen((value) => !value);
                      setResultsOpen(false);
                    }}
                  >
                    <Icon name="filter" size={20} />
                  </IconButton>
                )}
              </div>
              {booths.length > 0 && (
                <div className="venue-map-search-actions">
                  <SegmentedControl
                    selectedId={session}
                    options={[
                      { id: "AM", label: "午前の部" },
                      { id: "PM", label: "午後の部" },
                    ]}
                    onClick={(_, value) =>
                      onSessionChange(value as "AM" | "PM")
                    }
                  />
                  <TextButton
                    aria-expanded={resultsOpen}
                    aria-controls={`${componentId}-results`}
                    onClick={() => {
                      setResultsOpen((value) => !value);
                      setFiltersOpen(false);
                    }}
                  >
                    表示中の一覧（{matching.length}社）
                  </TextButton>
                </div>
              )}
            </div>
          )}
          {!embedded && filtersOpen && (
            <section
              className="venue-map-sheet venue-map-floating"
              id={`${componentId}-filters`}
              aria-label="マップの絞り込み"
            >
              <div className="venue-map-sheet-heading">
                <h2>絞り込み</h2>
                <TextButton onClick={() => setFiltersOpen(false)}>
                  閉じる
                </TextButton>
              </div>
              <IndustryChips
                options={industries}
                selected={filters.industries}
                onChange={(industries) => changeFilters({ industries })}
              />
              <Checkbox
                checked={filters.saved}
                onChange={(event) =>
                  changeFilters({ saved: event.target.checked })
                }
              >
                気になるのみ
              </Checkbox>
              <Checkbox
                checked={filters.assigned}
                onChange={(event) =>
                  changeFilters({ assigned: event.target.checked })
                }
              >
                指定企業のみ
              </Checkbox>
              <TextButton
                onClick={() =>
                  changeFilters({
                    q: "",
                    industries: [],
                    saved: false,
                    assigned: false,
                  })
                }
              >
                条件を解除
              </TextButton>
            </section>
          )}
          {!embedded && resultsOpen && (
            <section
              className="venue-map-sheet venue-map-floating"
              id={`${componentId}-results`}
              aria-label="表示中の一覧"
            >
              <div className="venue-map-sheet-heading">
                <h2>一覧（{matching.length}社）</h2>
                <TextButton onClick={() => setResultsOpen(false)}>
                  閉じる
                </TextButton>
              </div>
              {matching.length ? (
                <ul>
                  {[...matching]
                    .sort((a, b) => a.booth - b.booth)
                    .map((company) => (
                      <li key={company.id}>
                        <span className="company-name-link">
                          <TextButton
                            aria-label={`企業詳細 ${company.name}`}
                            onClick={() => {
                              onSelectCompany(company);
                              setResultsOpen(false);
                            }}
                          >
                            ブース {company.booth}　{company.name}
                          </TextButton>
                        </span>
                      </li>
                    ))}
                </ul>
              ) : (
                <p>条件に合う企業がありません。</p>
              )}
            </section>
          )}
          <div ref={bottomControls} className="venue-map-bottom-right">
            <div
              className="venue-map-zoom venue-map-floating"
              aria-label="マップの拡大縮小"
            >
              <IconButton
                variant="neutral"
                size="small"
                aria-label="マップを拡大"
                disabled={zoom >= 800}
                onClick={() => changeZoom(zoom + 25)}
              >
                <Icon name="plus" size={18} />
              </IconButton>
              <IconButton
                variant="neutral"
                size="small"
                aria-label="マップの表示をリセット"
                aria-description={`現在の倍率 ${zoom}パーセント`}
                onClick={resetView}
              >
                <Icon name="fit" size={18} />
              </IconButton>
              <IconButton
                variant="neutral"
                size="small"
                aria-label="マップを縮小"
                disabled={zoom <= 50}
                onClick={() => changeZoom(zoom - 25)}
              >
                <Icon name="minus" size={18} />
              </IconButton>
            </div>
            {!embedded && (
              <div
                className="venue-map-floors venue-map-floating"
                aria-label="会場マップの切り替え"
              >
                {images.map((item) => (
                  <Button
                    key={item.id}
                    size="small"
                    aria-pressed={floor === item.id}
                    variant={floor === item.id ? "lighted" : "neutral"}
                    onClick={() => setFloor(item.id)}
                  >
                    {item.title}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {!embedded &&
            previewCompany &&
            previewCompany.session === session &&
            matchedIds.has(previewCompany.id) && (
              <div
                ref={previewTooltip}
                className="venue-map-preview venue-map-floating"
                role="status"
                aria-label="ポイント中の企業"
              >
                <Icon name="location" size={18} />
                <div>
                  <strong>{previewCompany.name}</strong>
                  <span>ブース {previewCompany.booth}</span>
                </div>
              </div>
            )}
          {!embedded && (
            <div className="venue-map-bottom-left">
              <div className="venue-map-legend venue-map-floating">
                <TextButton
                  aria-expanded={legendOpen}
                  aria-controls={`${componentId}-legend`}
                  onClick={() => setLegendOpen((value) => !value)}
                >
                  凡例
                </TextButton>
                {legendOpen && (
                  <ul id={`${componentId}-legend`} aria-label="マップの凡例">
                    <li>
                      <span data-key="selected" aria-hidden="true" />
                      選択中
                    </li>
                    <li>
                      <span data-key="assigned" aria-hidden="true" />
                      指定企業
                    </li>
                    <li>
                      <span data-key="saved" aria-hidden="true" />
                      気になる
                    </li>
                  </ul>
                )}
              </div>
            </div>
          )}
          <div
            className="venue-map-viewport"
            ref={viewport}
            role="region"
            aria-label="操作できる会場マップ"
            aria-describedby={`${componentId}-keyboard-help`}
            tabIndex={0}
            data-dragging={dragging || undefined}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onClickCapture={(event) => {
              if (suppressClick.current && event.detail !== 0) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const delta: Record<string, [number, number]> = {
                ArrowLeft: [-80, 0],
                ArrowRight: [80, 0],
                ArrowUp: [0, -80],
                ArrowDown: [0, 80],
              };
              if (delta[event.key]) {
                event.preventDefault();
                event.currentTarget.scrollLeft += delta[event.key][0];
                event.currentTarget.scrollTop += delta[event.key][1];
              } else if (["+", "=", "-", "0"].includes(event.key)) {
                event.preventDefault();
                if (event.key === "0") resetView();
                else
                  changeZoom(
                    zoomValue.current + (event.key === "-" ? -25 : 25),
                  );
              }
            }}
          >
            {loading ? (
              <div className="venue-map-loading" role="status">
                マップを読み込んでいます
              </div>
            ) : url ? (
              <div
                className="venue-map-stage"
                style={{
                  width: boardWidth ? `${boardWidth}px` : `${zoom}%`,
                  padding: `${viewportSize.height / 2}px ${viewportSize.width / 2}px`,
                }}
              >
                <div className="venue-map-canvas">
                  <img
                    src={url}
                    alt={current.title}
                    width={current.image_width}
                    height={current.image_height}
                    draggable={false}
                    onLoad={(event) =>
                      setImageSize({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      })
                    }
                    onError={() => {
                      setURL("");
                      setError(
                        "マップを読み込めませんでした。再読み込みしてください。",
                      );
                    }}
                  />
                  {booths.map((booth) => {
                    const company = available.get(booth.booth),
                      isSelected = Boolean(
                        company && company.id === selectedCompanyId,
                      );
                    const isAssigned = Boolean(
                        company && assignedCompanyIds?.has(company.id),
                      ),
                      isSaved = Boolean(
                        company && savedCompanyIds?.has(company.id),
                      );
                    return (
                      <button
                        key={booth.booth}
                        type="button"
                        className="venue-map-booth"
                        ref={isSelected ? highlighted : undefined}
                        disabled={!company || !matchedIds.has(company.id)}
                        aria-label={`${session === "AM" ? "午前" : "午後"} ブース ${booth.booth} ${company?.name || "出展なし"}`}
                        aria-pressed={isSelected}
                        tabIndex={booth.booth === tabBooth ? 0 : -1}
                        onFocus={(event) => {
                          setFocusedBooth(booth.booth);
                          if (
                            supportsHoverPreview() &&
                            event.currentTarget.matches(":focus-visible")
                          ) {
                            const bounds =
                              event.currentTarget.getBoundingClientRect();
                            previewPoint.current = {
                              x: bounds.right,
                              y: bounds.bottom,
                            };
                            setPreviewCompanyId(company?.id ?? null);
                          }
                        }}
                        onBlur={() => setPreviewCompanyId(null)}
                        onPointerEnter={(event) => {
                          if (
                            event.pointerType === "mouse" &&
                            supportsHoverPreview()
                          ) {
                            previewPoint.current = {
                              x: event.clientX,
                              y: event.clientY,
                            };
                            setPreviewCompanyId(company?.id ?? null);
                          }
                        }}
                        onPointerMove={(event) => {
                          if (
                            event.pointerType === "mouse" &&
                            supportsHoverPreview()
                          )
                            movePreview(event.clientX, event.clientY);
                        }}
                        onPointerLeave={() => setPreviewCompanyId(null)}
                        onPointerDown={(event) => {
                          if (event.pointerType === "touch")
                            setPreviewCompanyId(null);
                        }}
                        onKeyDown={(event) => {
                          const keys = [
                            "ArrowLeft",
                            "ArrowRight",
                            "Home",
                            "End",
                          ];
                          if (!keys.includes(event.key)) return;
                          event.preventDefault();
                          const index = keyboardBooths.findIndex(
                            (item) => item.booth === booth.booth,
                          );
                          const nextIndex =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? keyboardBooths.length - 1
                                : (index +
                                    (event.key === "ArrowLeft" ? -1 : 1) +
                                    keyboardBooths.length) %
                                  keyboardBooths.length;
                          const nextBooth = keyboardBooths[nextIndex];
                          if (nextBooth)
                            viewport.current
                              ?.querySelector<HTMLButtonElement>(
                                `[data-booth="${nextBooth.booth}"]`,
                              )
                              ?.focus();
                        }}
                        data-booth={booth.booth}
                        aria-description={
                          [isAssigned && "指定企業", isSaved && "気になる"]
                            .filter(Boolean)
                            .join("、") || undefined
                        }
                        data-match={
                          company && matchedIds.has(company.id)
                            ? "true"
                            : "false"
                        }
                        data-company-id={company?.id}
                        data-selected={isSelected ? "true" : undefined}
                        data-assigned={isAssigned ? "true" : undefined}
                        data-saved={isSaved ? "true" : undefined}
                        style={{
                          left: `${booth.x * 100}%`,
                          top: `${booth.y * 100}%`,
                          width: `${booth.width * 100}%`,
                          height: `${booth.height * 100}%`,
                        }}
                        onClick={() => company && onSelectCompany(company)}
                      >
                        <span className="sr-only">
                          {company?.name || "出展なし"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="venue-map-loading">
                <Button
                  variant="outlined"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  再読み込み
                </Button>
              </div>
            )}
          </div>
        </>
      ) : (
        <p className="venue-map-empty">マップはまだ登録されていません。</p>
      )}
      {error && (
        <div className="venue-map-error venue-map-floating">
          <InlineNotification.Frame visible variant="error" role="alert">
            <InlineNotification.Text>{error}</InlineNotification.Text>
          </InlineNotification.Frame>
        </div>
      )}
      {!embedded && detailPanel}
      <p id={`${componentId}-keyboard-help`} className="sr-only">
        矢印キーで移動、プラス・マイナスキーで拡大縮小、0キーで全体表示。ブースでは左右キーで移動し、Enterキーで詳細を開けます。ドラッグで移動、2本指で拡大縮小できます。
      </p>
    </section>
  );
}
