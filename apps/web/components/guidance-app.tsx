"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { Checkbox } from "@openameba/spindle-ui/Form/Checkbox";
import { TextButton } from "@openameba/spindle-ui/TextButton";
import { TextLink } from "@openameba/spindle-ui/TextLink";
import { SegmentedControl } from "@openameba/spindle-ui/SegmentedControl";
import { TextField } from "@openameba/spindle-ui/Form/TextField";
import { InlineNotification } from "@openameba/spindle-ui/InlineNotification";
import { api, APIError, API_URL, documentURL } from "../lib/api";
import {
  defaultRoute,
  readRoute,
  routeHref,
  isAppPath,
  type RouteState,
  type View,
} from "../lib/route-state";
import type {
  Assignment,
  Company,
  Guidance,
  Preferences,
  User,
} from "../lib/types";
import { Icon, type IconName } from "./icons";
import VenueMap from "./venue-map";
import HeaderActions from "./header-actions";
import IncrementalCompanyList from "./incremental-company-list";
import IndustryChips from "./industry-chips";
import {
  CompanyDetailContent,
  FavoriteButton,
  FavoritePendingProvider,
  MapCompanyPanel,
} from "./company-details";

const EC4 = { department: "電子制御工学科", grade: 4 };
const returnKey = "guidance-return-route";
const navigation: { id: View; title: string; short: string; icon: IconName }[] =
  [
    { id: "companies", title: "一覧", short: "一覧", icon: "building" },
    { id: "search", title: "探す", short: "探す", icon: "search" },
    { id: "schedule", title: "スケジュール", short: "予定", icon: "calendar" },
    { id: "map", title: "会場マップ", short: "マップ", icon: "map" },
    {
      id: "plan",
      title: "気になる",
      short: "気になる",
      icon: "bookmark",
    },
  ];
function Brand() {
  return (
    <a className="brand" href="/" aria-label="Taskly 企業ガイダンス ホーム">
      <img
        className="brand-logo"
        src="/taskly-logo.svg"
        width={558}
        height={160}
        alt="Taskly"
      />
      <span className="brand-caption">企業ガイダンス</span>
    </a>
  );
}
function Message({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <InlineNotification.Frame
      visible
      variant={error ? "error" : "information"}
      role={error ? "alert" : "status"}
    >
      <InlineNotification.Icon>
        <Icon name="info" />
      </InlineNotification.Icon>
      <InlineNotification.Text>{children}</InlineNotification.Text>
    </InlineNotification.Frame>
  );
}
function intercept(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  action();
}
function timeLabel(value: string) {
  return value.includes("T") ? value.slice(11, 16) : value;
}
function sessionLabel(value: string) {
  return value === "AM" ? "午前" : value === "PM" ? "午後" : value;
}
function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, "");
}

type BookmarkState = {
  saved: Set<string>;
  retained: Set<string>;
  pending: Set<string>;
};

export default function GuidanceApp({
  initialView = "companies",
}: {
  initialView?: View;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<Guidance | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [status, setStatus] = useState<
    "loading" | "signed-out" | "ready" | "error"
  >("loading");
  const [error, setError] = useState("");
  const [route, setRoute] = useState<RouteState>({
    ...defaultRoute,
    view: initialView,
  });
  const routeRef = useRef(route);
  const [bookmarkState, setBookmarkState] = useState<BookmarkState>(() => ({
    saved: new Set(),
    retained: new Set(),
    pending: new Set(),
  }));
  const bookmarkSnapshot = useRef(bookmarkState);
  const saved = bookmarkState.saved;
  const retainedFavoriteIDs = bookmarkState.retained;
  const updateBookmarks = useCallback(
    (update: (previous: BookmarkState) => BookmarkState) => {
      // Keep event handlers on the latest optimistic snapshot even before
      // React renders a batch of changes for different companies.
      const next = update(bookmarkSnapshot.current);
      bookmarkSnapshot.current = next;
      setBookmarkState(next);
    },
    [],
  );
  const resetBookmarks = useCallback(
    (companyIDs: string[] = []) => {
      updateBookmarks(() => ({
        saved: new Set(companyIDs),
        retained: new Set(companyIDs),
        pending: new Set(),
      }));
    },
    [updateBookmarks],
  );
  const authGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [settingNumber, setSettingNumber] = useState(false);
  const bookmarkRequests = useRef(new Set<string>());
  const mapReturnFocus = useRef<HTMLElement | null>(null);
  const mapInteraction = useRef<"pointer" | "keyboard">("keyboard");
  const panelKeyboardFocus = useRef(true);
  const returnMapFocus = useCallback(() => {
    const previous = mapReturnFocus.current;
    if (
      previous?.isConnected &&
      !previous.matches(":disabled") &&
      !previous.closest("[hidden], [inert]")
    ) {
      previous.focus({ preventScroll: true });
      if (document.activeElement === previous) return;
    }
    document
      .querySelector<HTMLElement>(
        '.venue-map[data-mode="fullscreen"] .venue-map-viewport',
      )
      ?.focus({ preventScroll: true });
  }, []);
  const changeRoute = useCallback(
    (patch: Partial<RouteState>, replace = false) => {
      const next = { ...routeRef.current, ...patch };
      const href = routeHref(next);
      if (href !== window.location.pathname + window.location.search) {
        if (replace)
          window.history.replaceState(window.history.state, "", href);
        else window.history.pushState({}, "", href);
      }
      routeRef.current = next;
      setRoute(next);
    },
    [],
  );
  useEffect(() => {
    let target =
      routeHref(readRoute(window.location.search, window.location.pathname)) +
      window.location.hash;
    try {
      const intent = window.sessionStorage.getItem(returnKey);
      window.sessionStorage.removeItem(returnKey);
      if (
        window.location.pathname === "/" &&
        !window.location.search &&
        intent
      ) {
        const intended = new URL(intent, window.location.origin);
        if (
          intended.origin === window.location.origin &&
          isAppPath(intended.pathname)
        ) {
          target =
            routeHref(readRoute(intended.search, intended.pathname)) +
            intended.hash;
        }
      }
    } catch {
      /* Browsing still works when session storage is unavailable. */
    }
    if (
      target !==
      window.location.pathname + window.location.search + window.location.hash
    ) {
      window.history.replaceState(window.history.state, "", target);
    }
    const sync = () => {
      const current = readRoute(
        window.location.search,
        window.location.pathname,
      );
      routeRef.current = current;
      setRoute(current);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    const title =
      route.view === "info"
        ? "配布資料の案内"
        : navigation.find((item) => item.id === route.view)?.title || "一覧";
    document.title = `${title} | 企業ガイダンス | Taskly`;
  }, [route.view]);
  const expireSession = useCallback(() => {
    authGeneration.current++;
    setData(null);
    setUser(null);
    setPreferences(null);
    resetBookmarks();
    setSettingNumber(false);
    setError("ログインの有効期限が切れました。もう一度ログインしてください。");
    setStatus("signed-out");
  }, [resetBookmarks]);
  const load = useCallback(async () => {
    const generation = ++authGeneration.current;
    resetBookmarks();
    setStatus("loading");
    setError("");
    try {
      const identity = await api<{ user: User }>("/api/me");
      const [guidance, bookmarks, profile] = await Promise.all([
        api<Guidance>("/api/guidance"),
        api<{ company_ids: string[] }>("/api/bookmarks"),
        api<Preferences>("/api/preferences"),
      ]);
      if (generation !== authGeneration.current) return;
      resetBookmarks(bookmarks.company_ids);
      setUser(identity.user);
      setData(guidance);
      setPreferences(profile);
      setSettingNumber(profile.roster_number === null);
      setStatus("ready");
    } catch (cause) {
      if (generation !== authGeneration.current) return;
      setData(null);
      setUser(null);
      setPreferences(null);
      if (cause instanceof APIError && cause.status === 401)
        setStatus("signed-out");
      else {
        setError(
          cause instanceof APIError
            ? cause.message
            : "接続できませんでした。通信環境を確認して、もう一度お試しください。",
        );
        setStatus("error");
      }
    }
  }, [resetBookmarks]);
  useEffect(() => {
    void load();
  }, [load]);
  async function toggleSave(company: Company) {
    const generation = authGeneration.current;
    const requestKey = `${generation}:${company.id}`;
    if (bookmarkRequests.current.has(requestKey)) return;
    bookmarkRequests.current.add(requestKey);
    const wasSaved = bookmarkSnapshot.current.saved.has(company.id);
    const wasRetained = bookmarkSnapshot.current.retained.has(company.id);
    setError("");
    updateBookmarks((previous) => {
      const nextSaved = new Set(previous.saved);
      if (wasSaved) nextSaved.delete(company.id);
      else nextSaved.add(company.id);
      return {
        saved: nextSaved,
        retained: new Set(previous.retained).add(company.id),
        pending: new Set(previous.pending).add(company.id),
      };
    });
    try {
      await api<void>(`/api/bookmarks/${encodeURIComponent(company.id)}`, {
        method: wasSaved ? "DELETE" : "PUT",
      });
    } catch (cause) {
      if (generation !== authGeneration.current) return;
      if (cause instanceof APIError && cause.status === 401) expireSession();
      else {
        // Roll back only this company; simultaneous changes to other
        // companies must remain visible and retain their own server result.
        updateBookmarks((previous) => {
          const nextSaved = new Set(previous.saved);
          const nextRetained = new Set(previous.retained);
          if (wasSaved) nextSaved.add(company.id);
          else nextSaved.delete(company.id);
          if (wasRetained) nextRetained.add(company.id);
          else nextRetained.delete(company.id);
          return {
            saved: nextSaved,
            retained: nextRetained,
            pending: previous.pending,
          };
        });
        setError(
          cause instanceof Error
            ? cause.message
            : "気になるを更新できませんでした。もう一度お試しください。",
        );
      }
    } finally {
      bookmarkRequests.current.delete(requestKey);
      if (generation === authGeneration.current) {
        updateBookmarks((previous) => {
          const pending = new Set(previous.pending);
          pending.delete(company.id);
          return { ...previous, pending };
        });
      }
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("ログアウトできませんでした。もう一度お試しください。");
      authGeneration.current++;
      setData(null);
      setUser(null);
      setPreferences(null);
      resetBookmarks();
      setSettingNumber(false);
      setStatus("signed-out");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ログアウトできませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  function navigate(view: View) {
    changeRoute({ view, company: "" });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function openCompany(company: Company) {
    changeRoute(
      routeRef.current.view === "map"
        ? { company: company.id, focus: company.id, session: company.session }
        : { company: company.id },
    );
  }
  function closeCompany() {
    changeRoute({ company: "" }, true);
  }
  function mapCompany(company: Company) {
    changeRoute({
      view: "map",
      company: "",
      focus: company.id,
      session: company.session,
      q: "",
      industries: [],
      saved: false,
      assigned: false,
    });
  }
  const ready = status === "ready" && data && user && preferences;
  const selected = data?.companies.find(
    (company) => company.id === route.company,
  );
  const assignment = data?.assignments.find(
    (item) =>
      item.department === EC4.department &&
      item.grade === EC4.grade &&
      item.number === preferences?.roster_number,
  );
  const assignedIDs = useMemo(
    () => new Set(assignment?.visits.map((visit) => visit.company_id) || []),
    [assignment],
  );
  function menu(mobile: boolean) {
    return (
      <nav
        className={mobile ? "mobile-navigation" : "desktop-navigation"}
        aria-label={mobile ? "モバイルナビゲーション" : "メインナビゲーション"}
      >
        <ul>
          {navigation.map((item) => (
            <li
              key={item.id}
              data-current={route.view === item.id ? "true" : undefined}
            >
              <TextLink
                href={routeHref({ ...route, view: item.id, company: "" })}
                variant={route.view === item.id ? undefined : "subtle"}
                icon={
                  mobile ? (
                    <Icon
                      name={item.icon}
                      size={23}
                      filled={route.view === item.id}
                    />
                  ) : undefined
                }
                aria-current={route.view === item.id ? "page" : undefined}
                onClick={(event) => intercept(event, () => navigate(item.id))}
              >
                {mobile ? item.short : item.title}
                {item.id === "plan" && saved.size > 0 ? (
                  <span
                    className="saved-count"
                    aria-label={`気になる${saved.size}件`}
                  >
                    {saved.size}
                  </span>
                ) : null}
              </TextLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
  return (
    <FavoritePendingProvider value={bookmarkState.pending}>
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className="topbar">
        <div className="header-brand">
          <Brand />
        </div>
        {ready && menu(false)}
        <div className="header-right">
          {ready && (
            <HeaderActions
              name={user.name}
              rosterNumber={preferences.roster_number}
              busy={busy}
              currentView={route.view}
              onConfigure={() => setSettingNumber(true)}
              onInformation={() => {
                changeRoute({ ...defaultRoute, view: "info" });
                window.scrollTo({ top: 0, behavior: "instant" });
              }}
              onLogout={() => void logout()}
            />
          )}
        </div>
      </header>
      {!ready ? (
        <main id="main" className="welcome-main">
          <section className="welcome-content" aria-labelledby="welcome-title">
            <h1 id="welcome-title">企業ガイダンス</h1>
            <div className="welcome-action">
              {status === "loading" ? (
                <div className="loading-line" role="status">
                  <span className="spinner" />
                  ログイン状態を確認しています
                </div>
              ) : (
                <>
                  {error && <Message error>{error}</Message>}
                  {status === "signed-out" ? (
                    <Button
                      size="large"
                      onClick={() => {
                        try {
                          window.sessionStorage.setItem(
                            returnKey,
                            routeHref(routeRef.current),
                          );
                        } catch {}
                        window.location.href = `${API_URL}/auth/start`;
                      }}
                    >
                      Tasklyでログイン
                    </Button>
                  ) : (
                    <Button size="large" onClick={() => void load()}>
                      もう一度接続する
                    </Button>
                  )}
                </>
              )}
            </div>
          </section>
        </main>
      ) : (
        <>
          <main
            id="main"
            className={route.view === "map" ? "map-main" : "main-content"}
            onPointerDownCapture={() => {
              if (route.view === "map") mapInteraction.current = "pointer";
            }}
            onKeyDownCapture={() => {
              if (route.view === "map") mapInteraction.current = "keyboard";
            }}
          >
            {error && !selected && (
              <div className="top-error">
                <Message error>{error}</Message>
              </div>
            )}
            {route.company && !selected && (
              <div className="top-error">
                <Message error>企業が見つかりません。</Message>
                <TextButton onClick={closeCompany}>一覧へ戻る</TextButton>
              </div>
            )}
            {(route.view === "companies" || route.view === "search") && (
              <Companies
                data={data}
                saved={saved}
                assignedIDs={assignedIDs}
                route={route}
                onRouteChange={changeRoute}
                onSave={toggleSave}
                onSelect={openCompany}
              />
            )}
            {route.view === "schedule" && (
              <Schedule
                data={data}
                assignment={assignment}
                route={route}
                onSelect={openCompany}
                onInformation={() => navigate("info")}
              />
            )}
            {route.view === "map" && (
              <VenueMap
                documents={data.documents}
                companies={data.companies}
                session={route.session === "PM" ? "PM" : "AM"}
                selectedCompanyId={route.company || route.focus}
                search={route.q}
                industries={route.industries}
                mode="fullscreen"
                detailPanelOpen={Boolean(selected && !settingNumber)}
                detailPanel={
                  selected && !settingNumber ? (
                    <MapCompanyPanel
                      company={selected}
                      saved={saved.has(selected.id)}
                      assigned={assignedIDs.has(selected.id)}
                      onSave={() => toggleSave(selected)}
                      notification={
                        error ? <Message error>{error}</Message> : undefined
                      }
                      focusOnOpen={panelKeyboardFocus.current}
                      onClose={closeCompany}
                      returnFocus={returnMapFocus}
                    />
                  ) : undefined
                }
                onlySaved={route.saved}
                onlyAssigned={route.assigned}
                onFiltersChange={(patch) =>
                  changeRoute(
                    patch,
                    typeof patch.q === "string" &&
                      Object.keys(patch).length === 1,
                  )
                }
                savedCompanyIds={saved}
                assignedCompanyIds={assignedIDs}
                onSelectCompany={(company) => {
                  const active = document.activeElement;
                  if (active instanceof HTMLElement && active !== document.body)
                    mapReturnFocus.current = active;
                  panelKeyboardFocus.current =
                    mapInteraction.current === "keyboard";
                  changeRoute({ company: company.id, focus: company.id });
                }}
                onSessionChange={(session) =>
                  changeRoute({ session, company: "", focus: "" })
                }
                onExpired={expireSession}
              />
            )}
            {route.view === "plan" && (
              <Plan
                data={data}
                saved={saved}
                retainedFavoriteIDs={retainedFavoriteIDs}
                assignment={assignment}
                assignedIDs={assignedIDs}
                rosterNumber={preferences.roster_number}
                route={route}
                onSave={toggleSave}
                onSelect={openCompany}
                onConfigure={() => setSettingNumber(true)}
                onFind={() => {
                  changeRoute({ ...defaultRoute, view: "search" });
                  window.scrollTo({ top: 0, behavior: "instant" });
                }}
              />
            )}
            {route.view === "info" && (
              <Information data={data} onExpired={expireSession} />
            )}
          </main>
          {menu(true)}
        </>
      )}
      {ready && settingNumber && (
        <RosterDialog
          number={preferences.roster_number}
          onClose={() => setSettingNumber(false)}
          onExpired={expireSession}
          onSaved={(profile) => {
            setPreferences(profile);
            setSettingNumber(false);
          }}
        />
      )}
      {ready && selected && !settingNumber && route.view !== "map" && (
        <CompanyDialog
          company={selected}
          error={error}
          saved={saved.has(selected.id)}
          assigned={assignedIDs.has(selected.id)}
          route={route}
          onSave={() => toggleSave(selected)}
          onClose={closeCompany}
          onMap={() => mapCompany(selected)}
          data={data}
          savedCompanyIds={saved}
          assignedCompanyIds={assignedIDs}
          onSelect={openCompany}
          onExpired={expireSession}
        />
      )}
    </FavoritePendingProvider>
  );
}

function RosterDialog({
  number,
  onClose,
  onSaved,
  onExpired,
}: {
  number: number | null;
  onClose: () => void;
  onSaved: (profile: Preferences) => void;
  onExpired: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(number === null ? "" : String(number)),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
    input.current?.focus();
    return () => ref.current?.close();
  }, []);
  async function save() {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99) {
      setError("名簿番号を確認してください。");
      return;
    }
    setPending(true);
    setError("");
    try {
      onSaved(
        await api<Preferences>("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roster_number: parsed }),
        }),
      );
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 401) onExpired();
      else
        setError(
          cause instanceof Error
            ? cause.message
            : "保存できませんでした。もう一度お試しください。",
        );
    } finally {
      setPending(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="roster-dialog"
      aria-labelledby="roster-title"
      onCancel={(event) => {
        if (pending) event.preventDefault();
        else onClose();
      }}
    >
      <form
        className="dialog-inner"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id="roster-title">名簿番号の設定</h2>
        <p className="roster-class">Ec4</p>
        <label htmlFor="roster-number">名簿番号</label>
        <TextField
          ref={input}
          id="roster-number"
          type="number"
          inputMode="numeric"
          min="1"
          max="99"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          required
          disabled={pending}
          hasError={Boolean(error)}
          aria-describedby={error ? "roster-error" : undefined}
        />
        {error && (
          <div id="roster-error">
            <Message error>{error}</Message>
          </div>
        )}
        <div className="dialog-actions">
          <TextButton type="button" onClick={onClose} disabled={pending}>
            {number === null ? "あとで" : "キャンセル"}
          </TextButton>
          <Button type="submit" disabled={pending}>
            {pending ? "保存中" : "保存する"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
function IndustryFilter({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="industry-filter">
        <Button
          variant="outlined"
          layout="fullWidth"
          aria-expanded={open}
          aria-controls={open ? "company-industry-options" : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <span>業種{selected.length ? ` · ${selected.length}件` : ""}</span>
          <Icon name={open ? "minus" : "plus"} size={18} />
        </Button>
      </div>
      {open && (
        <div className="industry-options" id="company-industry-options">
          <IndustryChips
            options={options}
            selected={selected}
            onChange={onChange}
          />
          {selected.length > 0 && (
            <TextButton onClick={() => onChange([])}>業種を解除</TextButton>
          )}
        </div>
      )}
    </>
  );
}

function Companies({
  data,
  saved,
  assignedIDs,
  route,
  onRouteChange,
  onSave,
  onSelect,
}: {
  data: Guidance;
  saved: Set<string>;
  assignedIDs: Set<string>;
  route: RouteState;
  onRouteChange: (patch: Partial<RouteState>, replace?: boolean) => void;
  onSave: (company: Company) => Promise<void>;
  onSelect: (company: Company) => void;
}) {
  const industries = useMemo(
    () =>
      [
        ...new Set(data.companies.flatMap((company) => company.industries)),
      ].sort((a, b) => a.localeCompare(b, "ja")),
    [data],
  );
  const searching = route.view === "search";
  const filtered = useMemo(
    () =>
      !searching
        ? data.companies
        : data.companies.filter(
            (company) =>
              (route.session === "all" || company.session === route.session) &&
              (!route.industries.length ||
                route.industries.some((industry) =>
                  company.industries.includes(industry),
                )) &&
              (!route.saved || saved.has(company.id)) &&
              (!route.q.trim() ||
                normalized(
                  `${company.name} ${company.booth} ${company.industries.join(" ")}`,
                ).includes(normalized(route.q))),
          ),
    [data, route, saved, searching],
  );
  const ordered = useMemo(
    () => [...filtered].sort((a, b) => a.name.localeCompare(b.name, "ja")),
    [filtered],
  );
  const listKey = searching
    ? JSON.stringify([
        "search",
        route.q,
        route.session,
        [...route.industries].sort(),
        route.saved,
      ])
    : "directory";
  return (
    <>
      <div className="view-heading">
        <h1>{searching ? "探す" : "一覧"}</h1>
      </div>
      {searching && (
        <section className="company-search" aria-label="企業の検索と絞り込み">
          <div className="search-row">
            <label className="search-field">
              <span className="sr-only">企業名・業種・ブース番号で検索</span>
              <span className="company-search-icon" aria-hidden="true">
                <Icon name="search" size={20} />
              </span>
              <TextField
                id="company-search"
                type="search"
                placeholder="企業名・業種・ブース番号で検索"
                value={route.q}
                onChange={(event) =>
                  onRouteChange({ q: event.target.value }, true)
                }
              />
            </label>
            <IndustryFilter
              options={industries}
              selected={route.industries}
              onChange={(industries) => onRouteChange({ industries })}
            />
          </div>
          <div className="filter-row">
            <fieldset className="session-tabs">
              <legend>参加時間帯</legend>
              <SegmentedControl
                selectedId={route.session}
                options={[
                  { id: "all", label: "すべて" },
                  { id: "AM", label: "午前の部" },
                  { id: "PM", label: "午後の部" },
                ]}
                onClick={(_, session) =>
                  onRouteChange({ session: session as RouteState["session"] })
                }
              />
            </fieldset>
            <div className="saved-filter">
              <Checkbox
                checked={route.saved}
                onChange={(event) =>
                  onRouteChange({ saved: event.target.checked })
                }
              >
                気になるのみ
              </Checkbox>
            </div>
          </div>
        </section>
      )}
      <div className="results-label" aria-live="polite">
        <span>
          <strong>{filtered.length}</strong> 社
        </span>
      </div>
      {filtered.length ? (
        <IncrementalCompanyList companies={ordered} resetKey={listKey}>
          {(company) => (
            <CompanyCard
              key={company.id}
              company={company}
              saved={saved.has(company.id)}
              assigned={assignedIDs.has(company.id)}
              route={route}
              onSave={() => onSave(company)}
              onSelect={() => onSelect(company)}
            />
          )}
        </IncrementalCompanyList>
      ) : (
        <Empty title="条件に合う企業が見つかりません">
          <Button
            variant="outlined"
            onClick={() =>
              onRouteChange({
                q: "",
                session: "all",
                industries: [],
                saved: false,
              })
            }
          >
            条件をリセット
          </Button>
        </Empty>
      )}
    </>
  );
}
function CompanyCard({
  company,
  saved,
  assigned,
  route,
  onSave,
  onSelect,
}: {
  company: Company;
  saved: boolean;
  assigned: boolean;
  route: RouteState;
  onSave: () => Promise<void>;
  onSelect: () => void;
}) {
  const href = routeHref({ ...route, company: company.id });
  return (
    <article className="company-card">
      <div className="company-card-top">
        <span className="session-badge">
          {sessionLabel(company.session)}の部{" "}
          {assigned && <span className="assignment-badge">指定</span>}
        </span>
        <FavoriteButton company={company} saved={saved} onToggle={onSave} />
      </div>
      <div className="company-card-main">
        <h2>
          <span className="company-name-link">
            <TextLink
              href={href}
              onClick={(event) => intercept(event, onSelect)}
            >
              {company.name}
            </TextLink>
          </span>
        </h2>
        <div className="industry-tags">
          {company.industries.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </div>
      </div>
      <div className="company-card-bottom">
        <span>
          ブース <b>{company.booth}</b>
        </span>
        <TextLink
          href={href}
          icon={<Icon name="arrow" />}
          iconPosition="end"
          onClick={(event) => intercept(event, onSelect)}
        >
          詳細を見る
        </TextLink>
      </div>
    </article>
  );
}
function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
function CompanyDialog({
  company,
  error,
  saved,
  assigned,
  route,
  onSave,
  onClose,
  onMap,
  data,
  savedCompanyIds,
  assignedCompanyIds,
  onSelect,
  onExpired,
}: {
  company: Company;
  error: string;
  saved: boolean;
  assigned: boolean;
  route: RouteState;
  onSave: () => Promise<void>;
  onClose: () => void;
  onMap: () => void;
  data: Guidance;
  savedCompanyIds: Set<string>;
  assignedCompanyIds: Set<string>;
  onSelect: (company: Company) => void;
  onExpired: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mapOpen, setMapOpen] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const mapHref = routeHref({
    ...route,
    view: "map",
    company: "",
    focus: company.id,
    session: company.session,
    q: "",
    industries: [],
    saved: false,
    assigned: false,
  });
  return (
    <dialog
      ref={ref}
      className="company-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="company-dialog-title"
    >
      <div className="dialog-inner">
        <CompanyDetailContent
          company={company}
          saved={saved}
          assigned={assigned}
          onSave={onSave}
          titleId="company-dialog-title"
          notification={error ? <Message error>{error}</Message> : undefined}
        />
        <details
          className="company-map-accordion"
          onToggle={(event) => setMapOpen(event.currentTarget.open)}
        >
          <summary>
            <Icon name="map" />
            会場マップ
            <Icon name="plus" size={16} />
          </summary>
          {mapOpen && (
            <div className="company-map-content">
              <VenueMap
                mode="embedded"
                documents={data.documents}
                companies={data.companies}
                session={company.session}
                selectedCompanyId={company.id}
                savedCompanyIds={savedCompanyIds}
                assignedCompanyIds={assignedCompanyIds}
                onSelectCompany={onSelect}
                onSessionChange={() => {}}
                onExpired={onExpired}
              />
              <TextLink
                href={mapHref}
                icon={<Icon name="external" />}
                onClick={(event) => intercept(event, onMap)}
              >
                マップページを開く
              </TextLink>
            </div>
          )}
        </details>
        <div className="company-dialog-actions">
          <Button variant="neutral" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </dialog>
  );
}
function Schedule({
  data,
  assignment,
  route,
  onSelect,
  onInformation,
}: {
  data: Guidance;
  assignment?: Assignment;
  route: RouteState;
  onSelect: (company: Company) => void;
  onInformation: () => void;
}) {
  return (
    <>
      <div className="view-heading">
        <h1>スケジュール</h1>
        <TextLink
          href={routeHref({ ...route, view: "info", company: "" })}
          icon={<Icon name="info" />}
          onClick={(event) => intercept(event, onInformation)}
        >
          配布資料の案内
        </TextLink>
      </div>
      <section className="timeline" aria-label="ガイダンススケジュール">
        {data.schedule.map((slot) => {
          const visit = assignment?.visits.find(
              (item) => item.term === slot.term,
            ),
            company = data.companies.find(
              (item) => item.id === visit?.company_id,
            );
          return (
            <article
              key={slot.id}
              className={`timeline-item ${slot.term ? "is-term" : ""}`}
            >
              <div className="timeline-time">
                <b>{timeLabel(slot.start)}</b>
                <span>{timeLabel(slot.end)}</span>
              </div>
              <div className="timeline-track">
                <span />
              </div>
              <div className="timeline-content">
                <div>
                  <h2>{slot.title}</h2>
                  {slot.term && (
                    <span
                      className={`term-badge ${slot.required_grades.includes(4) ? "required" : ""}`}
                    >
                      {slot.required_grades.includes(4)
                        ? "指定企業"
                        : "自由見学"}
                    </span>
                  )}
                </div>
                {company && (
                  <span className="company-name-link">
                    <TextLink
                      href={routeHref({ ...route, company: company.id })}
                      onClick={(event) =>
                        intercept(event, () => onSelect(company))
                      }
                    >
                      {company.name} · ブース{company.booth}
                    </TextLink>
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </section>
    </>
  );
}
function Information({
  data,
  onExpired,
}: {
  data: Guidance;
  onExpired: () => void;
}) {
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  async function openDocument(id: string) {
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError("資料を開くには、ブラウザーのポップアップを許可してください。");
      return;
    }
    tab.opener = null;
    setOpening(true);
    setError("");
    try {
      tab.location.href = (await documentURL(id)).url;
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
  const documents = data.documents.filter(
    (item) => item.mime_type === "application/pdf",
  );
  return (
    <>
      <div className="view-heading">
        <h1>配布資料の案内</h1>
      </div>
      {error && <Message error>{error}</Message>}
      {documents.length > 0 && (
        <section className="information-documents" aria-label="PDF資料">
          {documents.map((item) => (
            <Button
              key={item.id}
              variant="outlined"
              disabled={opening}
              onClick={() => void openDocument(item.id)}
            >
              {item.title}
              <Icon name="external" size={16} />
            </Button>
          ))}
        </section>
      )}
      {(data.notice_sections?.length || data.notices.length) > 0 ? (
        <div className="notice-sections">
          {data.notice_sections?.length
            ? data.notice_sections.map((section) => (
                <section
                  key={section.id}
                  aria-labelledby={`notice-${section.id}`}
                >
                  <h2 id={`notice-${section.id}`}>{section.title}</h2>
                  {section.blocks.map((block, index) =>
                    block.type === "paragraph" ? (
                      <p key={index}>{block.text}</p>
                    ) : (
                      <ul key={index}>
                        {block.items.map((item, itemIndex) => (
                          <li key={itemIndex}>{item}</li>
                        ))}
                      </ul>
                    ),
                  )}
                </section>
              ))
            : data.notices.map((notice, index) => <p key={index}>{notice}</p>)}
        </div>
      ) : (
        <Empty title="配布資料の案内はありません" />
      )}
    </>
  );
}
function Plan({
  data,
  saved,
  retainedFavoriteIDs,
  assignment,
  assignedIDs,
  rosterNumber,
  route,
  onSave,
  onSelect,
  onConfigure,
  onFind,
}: {
  data: Guidance;
  saved: Set<string>;
  retainedFavoriteIDs: Set<string>;
  assignment?: Assignment;
  assignedIDs: Set<string>;
  rosterNumber: number | null;
  route: RouteState;
  onSave: (company: Company) => Promise<void>;
  onSelect: (company: Company) => void;
  onConfigure: () => void;
  onFind: () => void;
}) {
  const companies = data.companies.filter((company) =>
    retainedFavoriteIDs.has(company.id),
  );
  const savedCount = data.companies.filter((company) =>
    saved.has(company.id),
  ).length;
  return (
    <>
      <div className="view-heading">
        <h1>気になる</h1>
        <TextButton
          onClick={onConfigure}
          aria-label={
            rosterNumber === null ? "名簿番号を設定" : "名簿番号を変更"
          }
        >
          {rosterNumber === null ? "名簿番号を設定" : `Ec4 · ${rosterNumber}番`}
        </TextButton>
      </div>
      <section className="favorites-panel" aria-labelledby="favorites-title">
        <div className="section-heading">
          <h2 id="favorites-title">
            気になる <span>{savedCount}</span>
          </h2>
        </div>
        {companies.length ? (
          <IncrementalCompanyList companies={companies} resetKey="favorites">
            {(company) => (
              <CompanyCard
                key={company.id}
                company={company}
                saved={saved.has(company.id)}
                assigned={assignedIDs.has(company.id)}
                route={route}
                onSave={() => onSave(company)}
                onSelect={() => onSelect(company)}
              />
            )}
          </IncrementalCompanyList>
        ) : (
          <Empty title="まだ追加されていません">
            <Button variant="outlined" onClick={onFind}>
              探す
            </Button>
          </Empty>
        )}
      </section>
      <section className="assignment-panel">
        <h2>指定企業</h2>
        {assignment ? (
          <div className="assignment-visits">
            {assignment.visits.map((visit) => {
              const company = data.companies.find(
                  (item) => item.id === visit.company_id,
                ),
                slot = data.schedule.find((item) => item.term === visit.term);
              return company ? (
                <div className="assignment-visit" key={visit.term}>
                  <span>
                    ターム {visit.term}
                    <small>{slot ? timeLabel(slot.start) : ""}</small>
                  </span>
                  <span className="company-name-link">
                    <TextLink
                      href={routeHref({ ...route, company: company.id })}
                      onClick={(event) =>
                        intercept(event, () => onSelect(company))
                      }
                    >
                      {company.name}
                    </TextLink>
                  </span>
                  <span className="assignment-booth">
                    ブース {company.booth}
                  </span>
                </div>
              ) : null;
            })}
          </div>
        ) : rosterNumber === null ? (
          <TextButton onClick={onConfigure}>名簿番号を設定</TextButton>
        ) : (
          <Message>
            指定企業が見つかりません。名簿番号を確認してください。
          </Message>
        )}
      </section>
    </>
  );
}
