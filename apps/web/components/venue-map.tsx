"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Checkbox } from "@openameba/spindle-ui/Form/Checkbox";
import { TextField } from "@openameba/spindle-ui/Form/TextField";
import { DropDown } from "@openameba/spindle-ui/Form/DropDown";
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
  industry?: string;
  onlySaved?: boolean;
  onlyAssigned?: boolean;
  onFiltersChange?: (patch: Partial<Filters>) => void;
};

type Filters = {
  q: string;
  industry: string;
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
  industry,
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
  const [localFilters, setLocalFilters] = useState<Filters>({
    q: "",
    industry: "",
    saved: false,
    assigned: false,
  });
  const filters = {
    q: search ?? localFilters.q,
    industry: industry ?? localFilters.industry,
    saved: onlySaved ?? localFilters.saved,
    assigned: onlyAssigned ?? localFilters.assigned,
  };
  // Spindle keeps its displayed label internally; resync external resets without
  // replacing the focused select during ordinary keyboard selection.
  const chosenIndustry = useRef(filters.industry);
  const [industryReset, setIndustryReset] = useState(0);
  useEffect(() => {
    if (chosenIndustry.current !== filters.industry) {
      chosenIndustry.current = filters.industry;
      setIndustryReset((value) => value + 1);
    }
  }, [filters.industry]);
  function changeFilters(patch: Partial<Filters>) {
    setLocalFilters((value) => ({ ...value, ...patch }));
    onFiltersChange?.(patch);
  }
  const [floor, setFloor] = useState(images[0]?.id || "");
  const [url, setURL] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
  const [imageSize, setImageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const highlighted = useRef<HTMLButtonElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const automaticZoom = useRef("");
  const zoomValue = useRef(zoom);
  const zoomAnchor = useRef<{ left: number; top: number } | null>(null);
  const focusAfterZoom = useRef(false);
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
        left: (element.scrollLeft + previousX) * ratio - x,
        top: (element.scrollTop + previousY) * ratio - y,
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
  useLayoutEffect(() => {
    zoomValue.current = zoom;
    const element = viewport.current,
      anchor = zoomAnchor.current;
    if (element && anchor) {
      element.scrollLeft = anchor.left;
      element.scrollTop = anchor.top;
      zoomAnchor.current = null;
    }
    if (focusAfterZoom.current && highlighted.current) {
      highlighted.current.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
      focusAfterZoom.current = false;
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
        normalized(company.name).includes(normalized(filters.q))) &&
      (!filters.industry || company.industries.includes(filters.industry)) &&
      (!filters.saved || savedCompanyIds?.has(company.id)) &&
      (!filters.assigned || assignedCompanyIds?.has(company.id)),
  );
  const matchedIds = new Set(matching.map((company) => company.id));
  const activeFilters = [
    filters.q,
    filters.industry,
    filters.saved && "気になる企業",
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
    setZoom(100);
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
    if (!selectedCompanyId) {
      automaticZoom.current = "";
      return;
    }
    if (
      !url ||
      !selected ||
      selected.session !== session ||
      automaticZoom.current === selectedCompanyId
    )
      return;
    const width = viewport.current?.clientWidth || 0;
    const imageWidth = current?.image_width || imageSize?.width || 0;
    const imageHeight = current?.image_height || imageSize?.height || 0;
    const booth = booths.find((item) => item.booth === selected.booth);
    if (!width || !imageWidth || !imageHeight || !booth) return;
    const targetSize = Math.min(
      width * booth.width,
      ((width * imageHeight) / imageWidth) * booth.height,
    );
    const desired = Math.max(
      100,
      Math.min(800, Math.ceil((44 / targetSize) * 4) * 25),
    );
    automaticZoom.current = selectedCompanyId;
    focusAfterZoom.current = desired !== zoomValue.current;
    setZoom(desired);
  }, [url, selectedCompanyId, selected, session, current, imageSize, booths]);

  useEffect(() => {
    if (url && highlighted.current) {
      highlighted.current.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [url, selectedCompanyId, session]);

  async function openDocument(item: Document) {
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError("資料を開くには、ブラウザーのポップアップを許可してください。");
      return;
    }
    tab.opener = null;
    setOpening(true);
    setError("");
    try {
      const result = await documentURL(item.id);
      tab.location.href = result.url;
    } catch (cause) {
      tab.close();
      if (cause instanceof APIError && cause.status === 401) onExpired();
      else
        setError(
          cause instanceof Error ? cause.message : "資料を開けませんでした。",
        );
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <h1>会場マップ</h1>
      <div className="venue-map-floors" aria-label="会場マップの切り替え">
        {images.map((item) => (
          <Button
            key={item.id}
            aria-pressed={floor === item.id}
            variant={floor === item.id ? "lighted" : "neutral"}
            onClick={() => setFloor(item.id)}
          >
            {item.title}
          </Button>
        ))}
      </div>
      {error && (
        <InlineNotification.Frame visible variant="error" role="alert">
          <InlineNotification.Text>{error}</InlineNotification.Text>
        </InlineNotification.Frame>
      )}
      {current ? (
        <section className="venue-map-panel" aria-label={current.title}>
          <div className="venue-map-toolbar">
            {booths.length > 0 ? (
              <SegmentedControl
                selectedId={session}
                options={[
                  { id: "AM", label: "午前の部" },
                  { id: "PM", label: "午後の部" },
                ]}
                onClick={(_, value) => onSessionChange(value as "AM" | "PM")}
              />
            ) : (
              <span>{current.title}</span>
            )}
            <div className="venue-map-zoom">
              <IconButton
                variant="neutral"
                aria-label="マップを縮小"
                disabled={zoom <= 50}
                onClick={() => changeZoom(zoom - 25)}
              >
                <Icon name="minus" size={18} />
              </IconButton>
              <TextButton
                aria-label="拡大率を100パーセントに戻す"
                onClick={() => changeZoom(100)}
              >
                {zoom}%
              </TextButton>
              <IconButton
                variant="neutral"
                aria-label="マップを拡大"
                disabled={zoom >= 800}
                onClick={() => changeZoom(zoom + 25)}
              >
                <Icon name="plus" size={18} />
              </IconButton>
            </div>
          </div>
          {booths.length > 0 && (
            <div className="venue-map-filterbar">
              <TextButton
                aria-expanded={filtersOpen}
                aria-controls="map-filters"
                onClick={() => setFiltersOpen((value) => !value)}
              >
                絞り込み
                {activeFilters.length ? `（${activeFilters.length}）` : ""}
              </TextButton>
              <span aria-live="polite" className="venue-map-count">
                {matching.length}社
              </span>
              {activeFilters.length > 0 && (
                <>
                  <span className="venue-map-filter-summary">
                    {activeFilters.join("・")}
                  </span>
                  <TextButton
                    onClick={() =>
                      changeFilters({
                        q: "",
                        industry: "",
                        saved: false,
                        assigned: false,
                      })
                    }
                  >
                    解除
                  </TextButton>
                </>
              )}
            </div>
          )}
          {booths.length > 0 && filtersOpen && (
            <div className="venue-map-filters" id="map-filters">
              <label htmlFor="map-search">
                企業名
                <TextField
                  id="map-search"
                  aria-label="マップの企業名"
                  type="search"
                  value={filters.q}
                  onChange={(event) => changeFilters({ q: event.target.value })}
                />
              </label>
              <div>
                <label htmlFor="map-industry">業種</label>
                <DropDown
                  id="map-industry"
                  key={industryReset}
                  aria-label="マップの業種"
                  value={filters.industry}
                  style={{ width: "100%", minWidth: 0, maxWidth: "100%" }}
                  onChange={(event) => {
                    chosenIndustry.current = event.target.value;
                    changeFilters({ industry: event.target.value });
                  }}
                >
                  <option value="">すべての業種</option>
                  {industries.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </DropDown>
              </div>
              <Checkbox
                checked={filters.saved}
                onChange={(event) =>
                  changeFilters({ saved: event.target.checked })
                }
              >
                気になる企業のみ
              </Checkbox>
              <Checkbox
                checked={filters.assigned}
                onChange={(event) =>
                  changeFilters({ assigned: event.target.checked })
                }
              >
                指定企業のみ
              </Checkbox>
            </div>
          )}
          {selected && selected.session === session && booths.length > 0 && (
            <div className="venue-map-selection" role="status">
              <Icon name="location" size={18} />
              <span>
                ブース {selected.booth}　{selected.name}
              </span>
            </div>
          )}
          <div
            className="venue-map-viewport"
            ref={viewport}
            role="region"
            aria-label="操作できる会場マップ"
            aria-describedby="map-keyboard-help"
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
                changeZoom(
                  event.key === "0"
                    ? 100
                    : zoomValue.current + (event.key === "-" ? -25 : 25),
                );
              }
            }}
          >
            {loading ? (
              <div className="venue-map-loading" role="status">
                マップを読み込んでいます
              </div>
            ) : url ? (
              <div className="venue-map-canvas" style={{ width: `${zoom}%` }}>
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
                  const company = available.get(booth.booth);
                  const isSelected = Boolean(
                    company && company.id === selectedCompanyId,
                  );
                  const isAssigned = Boolean(
                    company && assignedCompanyIds?.has(company.id),
                  );
                  const isSaved = Boolean(
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
                      aria-description={
                        [isAssigned && "指定企業", isSaved && "気になる企業"]
                          .filter(Boolean)
                          .join("、") || undefined
                      }
                      data-match={
                        company && matchedIds.has(company.id) ? "true" : "false"
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
          <p id="map-keyboard-help" className="sr-only">
            矢印キーで移動、プラス・マイナスキーで拡大縮小、0キーで全体表示。ドラッグで移動、2本指で拡大縮小できます。
          </p>
          {booths.length > 0 && (
            <div className="venue-map-legend" aria-label="ブースの表示">
              <span>
                <i data-kind="selected" />
                選択中
              </span>
              {!!assignedCompanyIds?.size && (
                <span>
                  <i data-kind="assigned" />
                  指定企業
                </span>
              )}
              {!!savedCompanyIds?.size && (
                <span>
                  <i data-kind="saved" />
                  気になる企業
                </span>
              )}
            </div>
          )}
          {booths.length > 0 && (
            <details className="venue-map-results">
              <summary>表示中の企業（{matching.length}社）</summary>
              {matching.length ? (
                <ul>
                  {matching
                    .sort((a, b) => a.booth - b.booth)
                    .map((company) => (
                      <li key={company.id}>
                        <TextButton
                          aria-label={`企業詳細 ${company.name}`}
                          onClick={() => onSelectCompany(company)}
                        >
                          ブース {company.booth}　{company.name}
                        </TextButton>
                      </li>
                    ))}
                </ul>
              ) : (
                <p>条件に合う企業がありません。</p>
              )}
            </details>
          )}
        </section>
      ) : (
        <p className="venue-map-empty">マップはまだ登録されていません。</p>
      )}
      {documents.some((item) => item.mime_type === "application/pdf") && (
        <section className="venue-map-documents" aria-label="配布資料">
          <h2>配布資料</h2>
          <div>
            {documents
              .filter((item) => item.mime_type === "application/pdf")
              .map((item) => (
                <TextButton
                  key={item.id}
                  disabled={opening}
                  icon={<Icon name="external" size={18} />}
                  onClick={() => void openDocument(item)}
                >
                  {item.title}
                </TextButton>
              ))}
          </div>
        </section>
      )}
    </>
  );
}
