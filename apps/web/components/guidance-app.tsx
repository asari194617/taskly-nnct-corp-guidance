"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { Checkbox } from "@openameba/spindle-ui/Form/Checkbox";
import { IconButton } from "@openameba/spindle-ui/IconButton";
import { TextButton } from "@openameba/spindle-ui/TextButton";
import { SegmentedControl } from "@openameba/spindle-ui/SegmentedControl";
import { UnderlineTab } from "@openameba/spindle-ui/NavigationTab";
import { TextField } from "@openameba/spindle-ui/Form/TextField";
import { DropDown } from "@openameba/spindle-ui/Form/DropDown";
import { InlineNotification } from "@openameba/spindle-ui/InlineNotification";
import { api, APIError, API_URL, documentBlob } from "../lib/api";
import type { Company, Document, Guidance, User } from "../lib/types";
import { Icon, type IconName } from "./icons";

type View = "companies" | "schedule" | "map" | "plan";
const selectLayout = { width: "100%", maxWidth: "100%", minWidth: 0 };
const navigation: { id: View; title: string; short: string; icon: IconName }[] =
  [
    { id: "companies", title: "企業を探す", short: "企業", icon: "building" },
    { id: "schedule", title: "スケジュール", short: "予定", icon: "calendar" },
    { id: "map", title: "会場マップ", short: "マップ", icon: "map" },
    {
      id: "plan",
      title: "自分の見学リスト",
      short: "見学リスト",
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
  children: React.ReactNode;
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
function dateLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00+09:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
        timeZone: "Asia/Tokyo",
      }).format(date);
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

export default function GuidanceApp() {
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<Guidance | null>(null);
  const [status, setStatus] = useState<
    "loading" | "signed-out" | "ready" | "error"
  >("loading");
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("companies");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Company | null>(null);
  const [busy, setBusy] = useState(false);
  const bookmarkRequests = useRef(new Set<string>());
  const expireSession = useCallback(() => {
    setData(null);
    setUser(null);
    setSaved(new Set());
    setSelected(null);
    setError("ログインの有効期限が切れました。もう一度ログインしてください。");
    setStatus("signed-out");
  }, []);
  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const identity = await api<{ user: User }>("/api/me");
      const [guidance, bookmarks] = await Promise.all([
        api<Guidance>("/api/guidance"),
        api<{ company_ids: string[] }>("/api/bookmarks"),
      ]);
      setSaved(new Set(bookmarks.company_ids));
      setUser(identity.user);
      setData(guidance);
      setStatus("ready");
    } catch (cause) {
      setData(null);
      setUser(null);
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
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const clearPrivateView = () => {
      if (document.visibilityState === "hidden") setSelected(null);
    };
    document.addEventListener("visibilitychange", clearPrivateView);
    return () =>
      document.removeEventListener("visibilitychange", clearPrivateView);
  }, []);
  async function toggleSave(company: Company) {
    if (bookmarkRequests.current.has(company.id)) return;
    bookmarkRequests.current.add(company.id);
    const wasSaved = saved.has(company.id);
    setError("");
    try {
      await api<void>(`/api/bookmarks/${encodeURIComponent(company.id)}`, {
        method: wasSaved ? "DELETE" : "PUT",
      });
      setSaved((previous) => {
        const next = new Set(previous);
        if (wasSaved) next.delete(company.id);
        else next.add(company.id);
        return next;
      });
    } catch (cause) {
      if (cause instanceof APIError && cause.status === 401) expireSession();
      else
        setError(
          cause instanceof Error
            ? cause.message
            : "見学リストを更新できませんでした。もう一度お試しください。",
        );
    } finally {
      bookmarkRequests.current.delete(company.id);
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
      setData(null);
      setUser(null);
      setSaved(new Set());
      setSelected(null);
      setStatus("signed-out");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "ログアウトできませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: View) {
    setView(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  const ready = status === "ready" && data && user;
  return (
    <>
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <header className="topbar">
        <Brand />
        <div className="header-right">
          {ready && (
            <>
              <span className="user-name">
                {user.name || "Taskly ユーザー"}
              </span>
              <IconButton
                variant="neutral"
                onClick={() => void logout()}
                disabled={busy}
                aria-label="ログアウト"
              >
                <Icon name="logout" />
              </IconButton>
            </>
          )}
        </div>
      </header>
      {!ready ? (
        <main id="main" className="welcome-main">
          <section className="welcome-content" aria-labelledby="welcome-title">
            <h1 id="welcome-title">企業ガイダンス</h1>
            <p className="welcome-lead">
              企業情報・見学スケジュール・会場マップを確認できます。
            </p>
            <p>企業をチェックすると見学リストに保存できます。</p>
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
                  <p className="secure-note">
                    <Icon name="lock" />
                    企業情報・資料の閲覧にはログインが必要です
                  </p>
                </>
              )}
            </div>
          </section>
        </main>
      ) : (
        <div className="app-layout">
          <aside className="sidebar">
            <p className="sidebar-label">ガイダンスメニュー</p>
            <nav aria-label="メインナビゲーション">
              {navigation.map((item) => (
                <div
                  className="nav-item"
                  key={item.id}
                  data-current={view === item.id ? "true" : undefined}
                >
                  <TextButton
                    variant={view === item.id ? undefined : "subtle"}
                    icon={<Icon name={item.icon} />}
                    onClick={() => navigate(item.id)}
                    aria-current={view === item.id ? "page" : undefined}
                  >
                    {item.title}
                    {item.id === "plan" && saved.size > 0
                      ? ` (${saved.size})`
                      : ""}
                  </TextButton>
                </div>
              ))}
            </nav>
            <div className="sidebar-event">
              <h2>開催情報</h2>
              <b>{data.event.title}</b>
              <span>
                <Icon name="calendar" size={16} />
                {dateLabel(data.event.date)}
              </span>
              <span>
                <Icon name="location" size={16} />
                {data.event.venue}
              </span>
            </div>
            <p className="sidebar-foot">Taskly · 企業ガイダンス</p>
          </aside>
          <main id="main" className="main-content">
            {error && (
              <div className="top-error">
                <Message error>{error}</Message>
              </div>
            )}
            {view === "companies" && (
              <Companies
                data={data}
                saved={saved}
                onSave={toggleSave}
                onSelect={setSelected}
                onMap={() => navigate("map")}
              />
            )}
            {view === "schedule" && <Schedule data={data} />}
            {view === "map" && (
              <Maps documents={data.documents} onExpired={expireSession} />
            )}
            {view === "plan" && (
              <Plan
                data={data}
                saved={saved}
                onSave={toggleSave}
                onSelect={setSelected}
                onFind={() => navigate("companies")}
              />
            )}
            <footer className="content-footer">
              <span>Taskly · 企業ガイダンス</span>
              <span>
                掲載情報は配布資料をもとにしています。変更は学校からの案内をご確認ください。
              </span>
            </footer>
          </main>
          <nav
            className="mobile-navigation"
            aria-label="モバイルナビゲーション"
          >
            <UnderlineTab
              key={view}
              defaultSelectedId={view}
              options={navigation.map((item) => ({
                id: item.id,
                label: item.short,
              }))}
              variant="fixed"
              onClick={(_, id) => navigate(id as View)}
            />
          </nav>
        </div>
      )}
      {selected && data && (
        <CompanyDialog
          company={selected}
          saved={saved.has(selected.id)}
          onSave={() => toggleSave(selected)}
          onClose={() => setSelected(null)}
          onMap={() => {
            setSelected(null);
            navigate("map");
          }}
        />
      )}{" "}
      {!ready && (
        <footer className="welcome-footer">
          <span>Taskly · 企業ガイダンス</span>
        </footer>
      )}
    </>
  );
}

function ViewHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="view-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}
function Companies({
  data,
  saved,
  onSave,
  onSelect,
  onMap,
}: {
  data: Guidance;
  saved: Set<string>;
  onSave: (company: Company) => void;
  onSelect: (company: Company) => void;
  onMap: () => void;
}) {
  const [search, setSearch] = useState("");
  const [session, setSession] = useState("all");
  const [industry, setIndustry] = useState("");
  // Spindle DropDown owns its visible label; remount only when filters reset.
  const [industryReset, setIndustryReset] = useState(0);
  const [onlySaved, setOnlySaved] = useState(false);
  const industries = useMemo(
    () =>
      [
        ...new Set(data.companies.flatMap((company) => company.industries)),
      ].sort((a, b) => a.localeCompare(b, "ja")),
    [data],
  );
  const filtered = useMemo(
    () =>
      data.companies.filter(
        (company) =>
          (session === "all" || company.session === session) &&
          (!industry || company.industries.includes(industry)) &&
          (!onlySaved || saved.has(company.id)) &&
          (!search.trim() ||
            normalized(
              `${company.name} ${company.booth} ${company.industries.join(" ")}`,
            ).includes(normalized(search))),
      ),
    [data, search, session, industry, onlySaved, saved],
  );
  return (
    <>
      <ViewHeading
        title="企業を探す"
        description="企業名・業種・参加時間帯で検索できます。"
      />
      <div className="event-banner">
        <div>
          <span className="event-banner-label">{data.event.title}</span>
          <p>
            <span>
              <Icon name="calendar" size={16} />
              {dateLabel(data.event.date)}
            </span>
            <span>
              <Icon name="location" size={16} />
              {data.event.venue}
            </span>
          </p>
        </div>
        <TextButton
          icon={<Icon name="arrow" />}
          iconPosition="end"
          onClick={onMap}
        >
          会場マップを見る
        </TextButton>
      </div>
      <section className="company-search" aria-label="企業の検索と絞り込み">
        <div className="search-row">
          <label className="search-field">
            <span className="sr-only">企業名・業種・ブース番号で検索</span>
            <TextField
              id="company-search"
              type="search"
              placeholder="企業名・業種・ブース番号で検索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="industry-select bounded-field">
            <label className="sr-only" htmlFor="industry-filter">
              業種で絞り込む
            </label>
            <DropDown
              id="industry-filter"
              key={industryReset}
              style={selectLayout}
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
              aria-label="業種で絞り込む"
            >
              <option value="">すべての業種</option>
              {industries.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </DropDown>
          </div>
        </div>
        <div className="filter-row">
          <fieldset className="session-tabs">
            <legend>参加時間帯</legend>
            <SegmentedControl
              selectedId={session}
              options={[
                { id: "all", label: "すべて" },
                { id: "AM", label: "午前の部" },
                { id: "PM", label: "午後の部" },
              ]}
              onClick={(_, id) => setSession(id)}
            />
          </fieldset>
          <div className="saved-filter">
            <Checkbox
              checked={onlySaved}
              onChange={(event) => setOnlySaved(event.target.checked)}
            >
              保存した企業
            </Checkbox>
          </div>
        </div>
      </section>
      <div className="results-label" aria-live="polite">
        <span>
          <strong>{filtered.length}</strong> 社の企業
        </span>
        <span>企業名順</span>
      </div>
      {filtered.length ? (
        <div className="company-grid">
          {[...filtered]
            .sort((a, b) => a.name.localeCompare(b.name, "ja"))
            .map((company) => (
              <CompanyCard
                key={company.id}
                company={company}
                saved={saved.has(company.id)}
                onSave={() => onSave(company)}
                onSelect={() => onSelect(company)}
              />
            ))}
        </div>
      ) : (
        <Empty
          icon="search"
          title="条件に合う企業が見つかりません"
          text="キーワードを短くするか、絞り込み条件を変更してください。"
        >
          <Button
            variant="outlined"
            onClick={() => {
              setSearch("");
              setSession("all");
              setIndustry("");
              setIndustryReset((previous) => previous + 1);
              setOnlySaved(false);
            }}
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
  onSave,
  onSelect,
}: {
  company: Company;
  saved: boolean;
  onSave: () => void;
  onSelect: () => void;
}) {
  return (
    <article className="company-card">
      <div className="company-card-top">
        <span className="session-badge">
          {sessionLabel(company.session)}の部
        </span>
        <Checkbox
          checked={saved}
          onChange={onSave}
          aria-label={`${company.name}を${saved ? "見学リストから削除" : "見学リストに保存"}`}
        >
          気になる企業
        </Checkbox>
      </div>
      <div className="company-card-main">
        <h2>
          <TextButton onClick={onSelect}>{company.name}</TextButton>
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
        <TextButton
          onClick={onSelect}
          icon={<Icon name="arrow" />}
          iconPosition="end"
        >
          詳細を見る
        </TextButton>
      </div>
    </article>
  );
}
function Empty({
  icon,
  title,
  text,
  children,
}: {
  icon: IconName;
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={30} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}
function CompanyDialog({
  company,
  saved,
  onSave,
  onClose,
  onMap,
}: {
  company: Company;
  saved: boolean;
  onSave: () => void;
  onClose: () => void;
  onMap: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
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
        <div className="dialog-top">
          <span className={`session-badge ${company.session.toLowerCase()}`}>
            {sessionLabel(company.session)}の部
          </span>
          <IconButton
            variant="neutral"
            onClick={onClose}
            aria-label="詳細を閉じる"
          >
            <Icon name="close" />
          </IconButton>
        </div>
        <h2 id="company-dialog-title">{company.name}</h2>
        <div className="industry-tags">
          {company.industries.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </div>
        <div className="booth-detail">
          <Icon name="location" size={27} />
          <div>
            <span>会場ブース番号</span>
            <strong>{company.booth}</strong>
          </div>
          <TextButton
            onClick={onMap}
            icon={<Icon name="arrow" />}
            iconPosition="end"
          >
            マップを確認
          </TextButton>
        </div>
        <p className="detail-note">
          同じブース番号でも、午前と午後で企業が入れ替わります。時間帯をご確認ください。
        </p>
        <div className="detail-interest">
          <Checkbox
            checked={saved}
            onChange={onSave}
            aria-label={`${company.name}を${saved ? "見学リストから削除" : "見学リストに保存"}`}
          >
            気になる企業
          </Checkbox>
        </div>
        <p className="source-note">
          出典：配布PDF {company.source_page} ページ
        </p>
      </div>
    </dialog>
  );
}
function Schedule({ data }: { data: Guidance }) {
  const [grade, setGrade] = useState("4");
  return (
    <>
      <ViewHeading
        title="スケジュール"
        description="指定企業のタームと自由見学の時間を確認できます。"
      />
      <div className="schedule-toolbar">
        <span>
          <Icon name="calendar" />
          {dateLabel(data.event.date)}
        </span>
        <div className="schedule-grade bounded-field">
          <label htmlFor="schedule-grade">学年</label>
          <DropDown
            id="schedule-grade"
            style={selectLayout}
            value={grade}
            onChange={(event) => setGrade(event.target.value)}
            aria-label="スケジュールの学年"
          >
            <option value="3">本科3年</option>
            <option value="4">本科4年</option>
            <option value="5">専攻科1年</option>
          </DropDown>
        </div>
      </div>
      <section className="timeline" aria-label="ガイダンススケジュール">
        {data.schedule.map((slot) => (
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
                    className={`term-badge ${slot.required_grades.includes(Number(grade)) ? "required" : ""}`}
                  >
                    {slot.required_grades.includes(Number(grade))
                      ? "指定企業"
                      : "自由見学"}
                  </span>
                )}
              </div>
              {slot.term ? (
                <p>
                  ターム {slot.term} · {sessionLabel(slot.session)}の部
                </p>
              ) : null}
            </div>
          </article>
        ))}
      </section>
      {data.notices.length > 0 && (
        <section className="notices">
          <h2>
            <Icon name="info" />
            当日のご案内
          </h2>
          <p className="notices-lead">
            学校からの案内を、項目を開いて確認できます。
          </p>
          <div className="notice-sections">
            {data.notices.map((notice, i) => {
              const lines = notice.split("\n");
              const title =
                lines.find((line) => line.trim()) || `ご案内 ${i + 1}`;
              return (
                <details key={i}>
                  <summary>
                    {title.length > 70 ? `配布資料のご案内 ${i + 1}` : title}
                  </summary>
                  <p>{notice}</p>
                </details>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
function Plan({
  data,
  saved,
  onSave,
  onSelect,
  onFind,
}: {
  data: Guidance;
  saved: Set<string>;
  onSave: (company: Company) => void;
  onSelect: (company: Company) => void;
  onFind: () => void;
}) {
  const [department, setDepartment] = useState("");
  const [grade, setGrade] = useState("4");
  const [number, setNumber] = useState("");
  const [lookup, setLookup] = useState<{
    department: string;
    grade: number;
    number: number;
  } | null>(null);
  const departments = [
    ...new Set(data.assignments.map((item) => item.department)),
  ];
  const assignment = lookup
    ? data.assignments.find(
        (item) =>
          item.department === lookup.department &&
          item.grade === lookup.grade &&
          item.number === lookup.number,
      )
    : null;
  const companies = data.companies.filter((company) => saved.has(company.id));
  return (
    <>
      <ViewHeading
        title="自分の見学リスト"
        description="指定企業と保存した企業を確認できます。"
      />
      <section className="assignment-panel">
        <div className="panel-title">
          <span className="panel-icon">
            <Icon name="calendar" />
          </span>
          <div>
            <h2>自分の指定企業を確認</h2>
            <p>配布資料の割り振りを、学科・学年・出席番号から確認できます。</p>
          </div>
        </div>
        <form
          className="assignment-form"
          onSubmit={(event) => {
            event.preventDefault();
            setLookup({
              department,
              grade: Number(grade),
              number: Number(number),
            });
          }}
        >
          <div className="form-field bounded-field">
            <label className="field-label" htmlFor="student-department">
              学科
            </label>
            <DropDown
              id="student-department"
              style={selectLayout}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              required
              aria-label="学科"
            >
              <option value="">学科を選択</option>
              {departments.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </DropDown>
          </div>
          <div className="form-field bounded-field">
            <label className="field-label" htmlFor="student-grade">
              学年
            </label>
            <DropDown
              id="student-grade"
              style={selectLayout}
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
              aria-label="学年"
            >
              <option value="3">本科3年</option>
              <option value="4">本科4年</option>
            </DropDown>
          </div>
          <div className="form-field bounded-field">
            <label className="field-label" htmlFor="student-number">
              出席番号
            </label>
            <TextField
              id="student-number"
              type="number"
              inputMode="numeric"
              min="1"
              max="99"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              placeholder="番号"
              required
            />
          </div>
          <Button type="submit">確認する</Button>
        </form>
        {lookup && (
          <div className="assignment-result" aria-live="polite">
            {assignment ? (
              <>
                <p className="assignment-result-label">
                  <Icon name="check" size={18} />
                  {lookup.department} · {lookup.grade}年 · {lookup.number}番
                </p>
                <div className="assignment-visits">
                  {assignment.visits.map((visit) => {
                    const company = data.companies.find(
                      (item) => item.id === visit.company_id,
                    );
                    const slot = data.schedule.find(
                      (item) => item.term === visit.term,
                    );
                    return (
                      <Button
                        variant="neutral"
                        layout="fullWidth"
                        key={visit.term}
                        onClick={() => company && onSelect(company)}
                        disabled={!company}
                      >
                        <span>
                          ターム {visit.term}
                          <small>{slot ? timeLabel(slot.start) : ""}</small>
                        </span>
                        <b>{company?.name || "資料で確認してください"}</b>
                        <span className="assignment-booth">
                          {company ? `ブース ${company.booth}` : ""}
                          <Icon name="arrow" size={17} />
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </>
            ) : (
              <Message>
                指定企業の登録が見つかりません。学科・学年・番号とガイドブックを確認してください。
              </Message>
            )}
          </div>
        )}
      </section>
      <div className="section-heading">
        <h2>
          <Icon name="bookmark" />
          保存した企業<span>{companies.length}</span>
        </h2>
        <p>保存した企業は、同じTasklyアカウントで確認できます。</p>
      </div>
      {companies.length ? (
        <div className="company-grid">
          {companies.map((company) => (
            <CompanyCard
              key={company.id}
              company={company}
              saved
              onSave={() => onSave(company)}
              onSelect={() => onSelect(company)}
            />
          ))}
        </div>
      ) : (
        <Empty
          icon="bookmark"
          title="保存した企業はありません"
          text="企業の「気になる企業」にチェックすると、見学候補を追加できます。"
        >
          <Button variant="outlined" onClick={onFind}>
            企業を探す
            <Icon name="arrow" size={18} />
          </Button>
        </Empty>
      )}
    </>
  );
}
function Maps({
  documents,
  onExpired,
}: {
  documents: Document[];
  onExpired: () => void;
}) {
  const images = documents.filter(
    (item) => item.kind === "map" && item.mime_type.startsWith("image/"),
  );
  const [selected, setSelected] = useState(images[0]?.id || "");
  const [url, setURL] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [opening, setOpening] = useState(false);
  const current = images.find((item) => item.id === selected);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let objectURL = "";
    setLoading(true);
    setError("");
    setURL("");
    setZoom(100);
    void documentBlob(selected, controller.signal)
      .then((blob) => {
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          if (cause instanceof APIError && cause.status === 401) onExpired();
          else
            setError(
              cause instanceof Error
                ? cause.message
                : "マップを読み込めませんでした。",
            );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [selected, onExpired]);
  async function openDocument(item: Document) {
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    setOpening(true);
    setError("");
    try {
      const blob = await documentBlob(item.id);
      const objectURL = URL.createObjectURL(blob);
      if (tab) tab.location.href = objectURL;
      else {
        URL.revokeObjectURL(objectURL);
        throw new Error(
          "資料を開くには、ブラウザーのポップアップを許可して再度お試しください。",
        );
      }
      window.setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
    } catch (cause) {
      tab?.close();
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
      <ViewHeading
        title="会場マップ"
        description="ブース配置と休憩室の位置を確認できます。"
      />
      <div className="map-tabs" aria-label="会場マップの切り替え">
        {images.map((item) => (
          <Button
            key={item.id}
            aria-pressed={selected === item.id}
            variant={selected === item.id ? "lighted" : "neutral"}
            onClick={() => setSelected(item.id)}
          >
            <Icon name="map" size={18} />
            {item.title}
          </Button>
        ))}
      </div>
      {error && <Message error>{error}</Message>}
      {current ? (
        <section className="map-panel">
          <div className="map-toolbar">
            <span>
              <Icon name="location" size={18} />
              {current.title}
            </span>
            <div>
              <IconButton
                variant="neutral"
                aria-label="マップを縮小"
                disabled={zoom <= 50}
                onClick={() => setZoom(Math.max(50, zoom - 25))}
              >
                <Icon name="minus" size={18} />
              </IconButton>
              <TextButton
                onClick={() => setZoom(100)}
                aria-label="拡大率を100パーセントに戻す"
              >
                {zoom}%
              </TextButton>
              <IconButton
                variant="neutral"
                aria-label="マップを拡大"
                disabled={zoom >= 250}
                onClick={() => setZoom(Math.min(250, zoom + 25))}
              >
                <Icon name="plus" size={18} />
              </IconButton>
            </div>
          </div>
          <div className="map-viewport">
            {loading ? (
              <div className="map-loading" role="status">
                <span className="spinner" />
                マップを読み込んでいます
              </div>
            ) : url ? (
              <img
                src={url}
                alt={current.title}
                style={{ width: `${zoom}%`, maxWidth: "none" }}
              />
            ) : (
              <div className="map-loading">
                {error ? (
                  <Button
                    variant="outlined"
                    onClick={() => {
                      setSelected("");
                      window.setTimeout(() => setSelected(current.id), 0);
                    }}
                  >
                    再読み込み
                  </Button>
                ) : (
                  "マップはまだ登録されていません"
                )}
              </div>
            )}
          </div>
          <p className="map-hint">
            <Icon name="info" size={16} />
            拡大後は縦・横にスクロールして確認できます。
          </p>
        </section>
      ) : (
        <Empty
          icon="map"
          title="マップを準備しています"
          text="登録され次第、ここから会場案内をご覧いただけます。"
        />
      )}
      <section className="document-section">
        <div className="section-heading">
          <h2>配布資料</h2>
          <p>原本のPDFを開いて確認できます。</p>
        </div>
        <div className="document-list">
          {documents
            .filter((item) => item.mime_type === "application/pdf")
            .map((item) => (
              <Button
                variant="neutral"
                layout="fullWidth"
                key={item.id}
                onClick={() => void openDocument(item)}
                disabled={opening}
              >
                <span className="pdf-mark">PDF</span>
                <span>
                  <b>{item.title}</b>
                  <small>
                    配布PDF
                    {item.source_page ? ` · ${item.source_page} ページ` : ""}
                  </small>
                </span>
                <Icon name="external" size={20} />
              </Button>
            ))}
        </div>
      </section>
    </>
  );
}
