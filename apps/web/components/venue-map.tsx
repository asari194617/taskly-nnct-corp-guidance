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
import "./venue-map.css";

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
  const images = useMemo(
    () =>
      documents.filter(
        (item) => item.kind === "map" && item.mime_type.startsWith("image/"),
      ),
    [documents],
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
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
  const selected = companies.find((item) => item.id === selectedCompanyId);
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
      key = `${url}:${viewReset}`;
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
  }, [url, viewReset, viewportSize, imageWidth, imageHeight, boardWidth]);
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

  useEffect(() => {
    if (!selectedCompanyId) return;
    const arena = images.find((item) => item.booths?.length);
    if (arena) setFloor(arena.id);
  }, [selectedCompanyId, images]);

  useEffect(() => {
    if (!floor) return;
    const controller = new AbortController();
    setURL("");
    setLoading(true);
    setError("");
    setImageSize(null);
    pointers.current.clear();
    gesture.current = null;
    suppressClick.current = false;
    setDragging(false);
    void documentURL(floor, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setURL(result.url);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof APIError && cause.status === 401) onExpired();
        else
          setError(
            cause instanceof Error
              ? cause.message
              : "マップを読み込めませんでした。",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [floor, attempt, onExpired]);

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
        ".venue-map-floating, .map-company-panel",
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
  ]);

  return (
    <section
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
                  onChange={(event) => changeFilters({ q: event.target.value })}
                />
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
                    aria-label="絞り込み"
                    aria-expanded={filtersOpen}
                    aria-controls={`${componentId}-filters`}
                    onClick={() => {
                      setFiltersOpen((value) => !value);
                      setResultsOpen(false);
                    }}
                    icon={<Icon name="grid" size={18} />}
                  >
                    絞り込み
                    {activeFilters.length ? `（${activeFilters.length}）` : ""}
                  </TextButton>
                </div>
              )}
              {booths.length > 0 && (
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
              <fieldset className="venue-map-industry-options">
                <legend>業種</legend>
                {industries.map((value) => (
                  <Checkbox
                    key={value}
                    checked={filters.industries.includes(value)}
                    onChange={(event) =>
                      changeFilters({
                        industries: event.target.checked
                          ? [...filters.industries, value]
                          : filters.industries.filter((item) => item !== value),
                      })
                    }
                  >
                    {value}
                  </Checkbox>
                ))}
              </fieldset>
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
                        <TextButton
                          aria-label={`企業詳細 ${company.name}`}
                          onClick={() => {
                            onSelectCompany(company);
                            setResultsOpen(false);
                          }}
                        >
                          ブース {company.booth}　{company.name}
                        </TextButton>
                      </li>
                    ))}
                </ul>
              ) : (
                <p>条件に合う企業がありません。</p>
              )}
            </section>
          )}
          <div className="venue-map-bottom-right">
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
              <TextButton
                aria-label="拡大率を100パーセントに戻す"
                onClick={resetView}
              >
                {zoom}%
              </TextButton>
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
          <div className="venue-map-bottom-left">
            {!panelOpen &&
              selected &&
              selected.session === session &&
              matchedIds.has(selected.id) &&
              booths.length > 0 && (
                <div
                  className="venue-map-selection venue-map-floating"
                  role="status"
                >
                  <Icon name="location" size={18} />
                  <span>
                    ブース {selected.booth}　{selected.name}
                  </span>
                </div>
              )}
          </div>
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
                        onFocus={() => setFocusedBooth(booth.booth)}
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
