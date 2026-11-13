"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { TextField } from "@openameba/spindle-ui/Form/TextField";
import { DropDown } from "@openameba/spindle-ui/Form/DropDown";
import { InlineNotification } from "@openameba/spindle-ui/InlineNotification";
import { api, APIError, API_URL, documentBlob } from "../lib/api";
import type { Company, Document, Guidance, User } from "../lib/types";
import { Icon, type IconName } from "./icons";

type View = "companies" | "schedule" | "map" | "plan";
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
      <span className="brand-mark">
        <Icon name="grid" size={22} />
      </span>
      <span>
        taskly<span className="brand-caption">企業ガイダンス</span>
      </span>
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
          <span className="connection">
            <span />
            学生向けガイダンス
          </span>
          {ready && (
            <>
              <span className="user-name">
                {user.name || "Taskly ユーザー"}
              </span>
              <button
                className="icon-button logout-button"
                onClick={() => void logout()}
                disabled={busy}
                aria-label="ログアウト"
              >
                <Icon name="logout" />
              </button>
            </>
          )}
        </div>
      </header>
      {!ready ? (
        <main id="main" className="welcome-main">
          <div className="welcome-content">
            <span className="eyebrow">
              <span className="mini-line" /> FIND YOUR NEXT STEP
            </span>
            <h1>
              知らなかった企業が、
              <br />
              未来の選択肢になる。
            </h1>
            <p className="welcome-lead">
              企業を知る。話を聞く。可能性を広げる。
              <br />
              ガイダンスの準備から、当日の会場案内まで。
            </p>
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
                      icon={<Icon name="arrow" />}
                      iconPosition="end"
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
                    <Icon name="lock" size={15} />
                    企業情報・資料の閲覧にはログインが必要です
                  </p>
                </>
              )}
            </div>
            <div className="welcome-features">
              <span>
                <Icon name="building" />
                企業を探す
              </span>
              <span>
                <Icon name="calendar" />
                見学を準備
              </span>
              <span>
                <Icon name="map" />
                会場を確認
              </span>
            </div>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-dot dot-one" />
            <div className="art-dot dot-two" />
            <div className="art-tag">
              <Icon name="check" size={16} />
              きっと、次の一歩が見つかる。
            </div>
            <div className="art-building">
              <div className="building-top" />
              <div className="building-windows">
                {Array.from({ length: 12 }, (_, index) => (
                  <i key={index} />
                ))}
              </div>
              <div className="building-door" />
            </div>
            <div className="art-card card-one">
              <span className="art-icon">
                <Icon name="building" size={25} />
              </span>
              <div>
                <b>企業との出会い</b>
                <span>視野を、もっと広く。</span>
              </div>
            </div>
            <div className="art-card card-two">
              <Icon name="bookmark" size={21} />
              <span>気になる企業を、見学リストに。</span>
            </div>
            <span className="art-caption">DISCOVER YOUR POSSIBILITIES</span>
          </div>
        </main>
      ) : (
        <div className="app-layout">
          <aside className="sidebar">
            <p className="sidebar-label">GUIDANCE GUIDE</p>
            <nav aria-label="メインナビゲーション">
              {navigation.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${view === item.id ? "active" : ""}`}
                  onClick={() => navigate(item.id)}
                  aria-current={view === item.id ? "page" : undefined}
                >
                  <Icon name={item.icon} />
                  <span>{item.title}</span>
                  {item.id === "plan" && saved.size > 0 && (
                    <span className="nav-count">{saved.size}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="sidebar-event">
              <span className="eyebrow">EVENT INFORMATION</span>
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
            <p className="sidebar-foot">
              出会いを、次の一歩へ。
              <br />
              <span>Powered by Taskly</span>
            </p>
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
            {navigation.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                onClick={() => navigate(item.id)}
                aria-current={view === item.id ? "page" : undefined}
              >
                <Icon name={item.icon} />
                <span>{item.short}</span>
              </button>
            ))}
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
          <span>企業との出会いを、もっと身近に。</span>
        </footer>
      )}
    </>
  );
}

function ViewHeading({
  label,
  title,
  description,
  children,
}: {
  label: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="view-heading">
      <div>
        <span className="eyebrow">{label}</span>
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
  const am = data.companies.filter(
    (company) => company.session === "AM",
  ).length;
  return (
    <>
      <ViewHeading
        label="DISCOVER COMPANIES"
        title="新しい可能性を、見つけよう。"
        description="気になる企業を探して、当日の見学を準備しましょう。"
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
        <button onClick={onMap}>
          会場マップを見る
          <Icon name="arrow" size={18} />
        </button>
      </div>
      <section className="company-search" aria-label="企業の検索と絞り込み">
        <div className="search-row">
          <label className="search-field">
            <span className="sr-only">企業名・業種・ブース番号で検索</span>
            <Icon name="search" />
            <TextField
              id="company-search"
              type="search"
              placeholder="企業名・業種・ブース番号で検索"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="industry-select">
            <span className="sr-only">業種で絞り込む</span>
            <DropDown
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
              aria-label="業種で絞り込む"
            >
              <option value="">すべての業種</option>
              {industries.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </DropDown>
          </label>
        </div>
        <div className="filter-row">
          <div className="session-tabs" aria-label="参加時間帯">
            {[
              { id: "all", label: "すべて", count: data.companies.length },
              { id: "AM", label: "午前の部", count: am },
              {
                id: "PM",
                label: "午後の部",
                count: data.companies.length - am,
              },
            ].map((item) => (
              <button
                key={item.id}
                aria-pressed={session === item.id}
                className={session === item.id ? "active" : ""}
                onClick={() => setSession(item.id)}
              >
                {item.label}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
          <button
            className={`saved-filter ${onlySaved ? "active" : ""}`}
            aria-pressed={onlySaved}
            onClick={() => setOnlySaved(!onlySaved)}
          >
            <Icon name="bookmark" size={17} />
            保存した企業
          </button>
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
        <span className={`session-badge ${company.session.toLowerCase()}`}>
          {sessionLabel(company.session)}の部
        </span>
        <button
          className={`save-button ${saved ? "saved" : ""}`}
          onClick={onSave}
          aria-pressed={saved}
          aria-label={`${company.name}を${saved ? "見学リストから削除" : "見学リストに保存"}`}
        >
          <Icon name="bookmark" size={21} />
        </button>
      </div>
      <button className="company-card-main" onClick={onSelect}>
        <h2>{company.name}</h2>
        <div className="industry-tags">
          {company.industries.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </div>
        <span className="company-card-bottom">
          <span>
            <Icon name="location" size={16} />
            ブース <b>{company.booth}</b>
          </span>
          <span className="card-more">
            詳細を見る
            <Icon name="arrow" size={17} />
          </span>
        </span>
      </button>
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
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="詳細を閉じる"
          >
            <Icon name="close" />
          </button>
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
          <button onClick={onMap}>
            マップを確認
            <Icon name="arrow" size={18} />
          </button>
        </div>
        <p className="detail-note">
          同じブース番号でも、午前と午後で企業が入れ替わります。時間帯をご確認ください。
        </p>
        <Button
          layout="fullWidth"
          variant={saved ? "outlined" : "contained"}
          icon={<Icon name={saved ? "check" : "bookmark"} />}
          onClick={onSave}
        >
          {saved ? "見学リストに保存済み · 解除する" : "見学リストに保存する"}
        </Button>
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
        label="PLAN YOUR DAY"
        title="一日の流れを、確認する。"
        description="指定企業のタームと自由に見学する時間を確認しましょう。"
      />
      <div className="schedule-toolbar">
        <span>
          <Icon name="calendar" />
          {dateLabel(data.event.date)}
        </span>
        <label>
          学年
          <DropDown
            value={grade}
            onChange={(event) => setGrade(event.target.value)}
            aria-label="スケジュールの学年"
          >
            <option value="3">本科3年</option>
            <option value="4">本科4年</option>
            <option value="5">専攻科1年</option>
          </DropDown>
        </label>
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
        label="YOUR VISIT LIST"
        title="自分だけの、見学の準備。"
        description="指定企業を確認して、気になる企業を見学リストにまとめましょう。"
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
          <label>
            <span>学科</span>
            <DropDown
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
          </label>
          <label>
            <span>学年</span>
            <DropDown
              value={grade}
              onChange={(event) => setGrade(event.target.value)}
              aria-label="学年"
            >
              <option value="3">本科3年</option>
              <option value="4">本科4年</option>
            </DropDown>
          </label>
          <label>
            <span>出席番号</span>
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
          </label>
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
                      <button
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
                      </button>
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
          title="気になる企業を保存しましょう"
          text="企業カードの保存ボタンから、見学候補を追加できます。"
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
        label="FIND YOUR WAY"
        title="会場で、迷わないために。"
        description="ブース配置と休憩室の位置を、事前に確認しておきましょう。"
      />
      <div className="map-tabs" aria-label="会場マップの切り替え">
        {images.map((item) => (
          <button
            key={item.id}
            aria-pressed={selected === item.id}
            className={selected === item.id ? "active" : ""}
            onClick={() => setSelected(item.id)}
          >
            <Icon name="map" size={18} />
            {item.title}
          </button>
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
              <button
                className="icon-button"
                aria-label="マップを縮小"
                disabled={zoom <= 50}
                onClick={() => setZoom(Math.max(50, zoom - 25))}
              >
                <Icon name="minus" size={18} />
              </button>
              <button
                className="zoom-reset"
                onClick={() => setZoom(100)}
                aria-label="拡大率を100パーセントに戻す"
              >
                {zoom}%
              </button>
              <button
                className="icon-button"
                aria-label="マップを拡大"
                disabled={zoom >= 250}
                onClick={() => setZoom(Math.min(250, zoom + 25))}
              >
                <Icon name="plus" size={18} />
              </button>
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
              <button
                key={item.id}
                onClick={() => void openDocument(item)}
                disabled={opening}
              >
                <span className="pdf-mark">PDF</span>
                <span>
                  <b>{item.title}</b>
                  <small>
                    配布ガイドブック
                    {item.source_page ? ` · ${item.source_page} ページ` : ""}
                  </small>
                </span>
                <Icon name="external" size={20} />
              </button>
            ))}
        </div>
      </section>
    </>
  );
}
