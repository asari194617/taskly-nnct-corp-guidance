"use client";

import { useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Button } from "@openameba/spindle-ui/Button";
import { Checkbox } from "@openameba/spindle-ui/Form/Checkbox";
import { TextButton } from "@openameba/spindle-ui/TextButton";
import { TextLink } from "@openameba/spindle-ui/TextLink";
import { InlineNotification } from "@openameba/spindle-ui/InlineNotification";
import type {
  Assignment,
  Company,
  Guidance,
  HomeTask,
  Preferences,
} from "../lib/types";
import type { EventTimeState } from "../lib/event-time";
import { formatScheduleTime } from "../lib/event-time";
import {
  recommendationReasons,
  suggestRecommendations,
} from "../lib/recommendations";
import { routeHref, type RouteState } from "../lib/route-state";
import { FavoriteButton } from "./company-details";
import { Icon } from "./icons";
import { useHomeTasks } from "./use-home-tasks";
import { useDocumentNavigation } from "./use-document-navigation";
import { useOffline } from "./offline-context";

export type HomeDashboardProps = {
  data: Guidance;
  preferences: Preferences;
  assignment?: Assignment;
  savedIDs: ReadonlySet<string>;
  route: RouteState;
  eventTime: EventTimeState;
  onRouteChange: (patch: Partial<RouteState>) => void;
  onSelectCompany: (company: Company) => void;
  onSaveCompany: (company: Company) => Promise<void>;
  onConfigure: () => void;
  onExpired: () => void;
};

function follow(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
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

export default function HomeDashboard({
  data,
  preferences,
  assignment,
  savedIDs,
  route,
  eventTime,
  onRouteChange,
  onSelectCompany,
  onSaveCompany,
  onConfigure,
  onExpired,
}: HomeDashboardProps) {
  const tasks = useHomeTasks(onExpired);
  const { offline } = useOffline();
  const [surveyOpen, setSurveyOpen] = useState(false);
  const {
    opening: openingDocument,
    error: documentError,
    openDocument,
  } = useDocumentNavigation(
    onExpired,
    `${preferences.department}:${preferences.grade}:${preferences.roster_number}`,
  );
  const options = {
    data,
    assignment,
    savedIDs,
    department: preferences.department,
    session: route.session,
  };
  const recommendationScope = `${preferences.department}:${preferences.grade}:${preferences.roster_number}:${route.session}`;
  const initialRecommendations = useMemo(
    () => suggestRecommendations({ ...options, limit: 4 }),
    [data, assignment, recommendationScope],
  );
  const recommendationIDs = useRef({
    scope: recommendationScope,
    ids: initialRecommendations.map((item) => item.company.id),
  });
  if (recommendationIDs.current.scope !== recommendationScope) {
    recommendationIDs.current = {
      scope: recommendationScope,
      ids: initialRecommendations.map((item) => item.company.id),
    };
  }
  const recommendations = recommendationIDs.current.ids.flatMap((id) => {
    const company = data.companies.find((item) => item.id === id);
    return company
      ? [{ company, reasons: recommendationReasons(options, company) }]
      : [];
  });
  const all = tasks.data?.tasks || [];
  const assigned = all
    .filter((task) => task.kind === "assigned_visit")
    .sort((a, b) => (a.term || 0) - (b.term || 0));
  const surveys = all
    .filter((task) => task.kind === "visit_survey")
    .sort((a, b) => (a.term || 0) - (b.term || 0));
  const remaining = all.filter(
    (task) =>
      task.kind === "overall_survey" || task.kind === "sheet_submission",
  );
  const currentTerm =
    data.schedule.find((slot) => slot.id === eventTime.currentSlotId)?.term ||
    [...data.schedule]
      .reverse()
      .find((slot) => slot.term && eventTime.endedSlotIds.includes(slot.id))
      ?.term;
  const currentSurvey =
    surveys.find((task) => task.term === currentTerm) ||
    surveys.find((task) => !task.completed) ||
    surveys[0];
  const completed = all.filter((task) => task.completed).length;
  const tasklyURL = all.find((task) => task.taskly_url)?.taskly_url;

  function map(company: Company) {
    return {
      ...route,
      view: "map" as const,
      company: "",
      focus: company.id,
      session: company.session,
      sessionExplicit: true,
      q: "",
      industries: [],
      saved: false,
      assigned: false,
    };
  }
  function row(task: HomeTask) {
    const company = data.companies.find((item) => item.id === task.company_id);
    const slot = data.schedule.find((item) => item.term === task.term);
    const pending = tasks.pending.has(task.id);
    return (
      <li
        key={task.id}
        className="home-task-row"
        data-task-id={task.id}
        aria-busy={pending || undefined}
      >
        <div className="home-task-toggle">
          <Checkbox
            checked={task.completed}
            aria-label={task.title}
            disabled={
              offline ||
              tasks.readonly ||
              pending ||
              Boolean(tasks.error) ||
              (task.completion_disabled && !task.completed)
            }
            onChange={() => void tasks.toggle(task.id)}
          />
        </div>
        <div className="home-task-main">
          {company && task.kind === "assigned_visit" ? (
            <TextLink
              href={routeHref({ ...route, company: company.id })}
              onClick={(event) => follow(event, () => onSelectCompany(company))}
            >
              {company.name}
            </TextLink>
          ) : task.kind === "overall_survey" ||
            task.kind === "sheet_submission" ? (
            <h3 className="home-task-title">{task.title}</h3>
          ) : (
            <span className="home-task-title">{task.title}</span>
          )}
          {task.term && (
            <span className="home-task-meta">
              ターム {task.term}
              {slot ? ` · ${formatScheduleTime(slot.start)}` : ""}
            </span>
          )}
        </div>
        <div className="home-task-actions">
          {company && task.kind === "assigned_visit" && (
            <TextLink
              href={routeHref(map(company))}
              onClick={(event) =>
                follow(event, () => onRouteChange(map(company)))
              }
              icon={<Icon name="location" size={16} />}
            >
              ブース {company.booth}
            </TextLink>
          )}
          {(task.url ||
            (offline &&
              (task.kind === "visit_survey" ||
                task.kind === "overall_survey"))) &&
            (offline ? (
              <span aria-disabled="true">回答する（オンラインで利用）</span>
            ) : (
              <TextLink
                href={task.url}
                target="_blank"
                rel="noopener noreferrer"
                icon={<Icon name="external" size={14} />}
              >
                回答する
              </TextLink>
            ))}
          {task.document_id && (
            <TextButton
              disabled={offline || openingDocument}
              onClick={() => void openDocument(task.document_id!, task.page)}
            >
              <Icon name="document" size={16} />
              資料を見る
            </TextButton>
          )}
        </div>
      </li>
    );
  }

  return (
    <>
      <div className="view-heading">
        <h1>ホーム</h1>
      </div>
      <div className="home-layout">
        <section
          className="home-task-section"
          aria-labelledby="home-tasks-heading"
        >
          <div className="home-section-heading">
            <h2 id="home-tasks-heading">やること</h2>
            <div className="home-task-summary">
              {tasks.data && (
                <span
                  className="home-count"
                  aria-label={`${all.length}件中${completed}件完了`}
                >
                  {completed}/{all.length}
                </span>
              )}
              {tasklyURL && !offline && (
                <TextLink
                  href={tasklyURL}
                  target="_blank"
                  rel="noopener noreferrer"
                  icon={<Icon name="external" size={14} />}
                >
                  Taskly
                </TextLink>
              )}
            </div>
          </div>
          {tasks.error && (
            <div className="home-task-error">
              <InlineNotification.Frame visible variant="error" role="alert">
                <InlineNotification.Text>{tasks.error}</InlineNotification.Text>
              </InlineNotification.Frame>
              <TextButton
                disabled={offline}
                onClick={() => void tasks.refresh()}
              >
                再読み込み
              </TextButton>
            </div>
          )}
          {documentError && (
            <InlineNotification.Frame visible variant="error" role="alert">
              <InlineNotification.Text>{documentError}</InlineNotification.Text>
            </InlineNotification.Frame>
          )}
          {tasks.loading && !tasks.data ? (
            <div className="home-task-loading" role="status">
              やることを読み込んでいます
            </div>
          ) : (
            tasks.data && (
              <>
                {(!tasks.data.roster_configured ||
                  preferences.roster_number === null) && (
                  <div className="home-roster-action">
                    <Button
                      variant="outlined"
                      disabled={offline}
                      onClick={onConfigure}
                    >
                      名簿番号を設定
                    </Button>
                  </div>
                )}
                {assigned.length > 0 && (
                  <section
                    className="home-assigned"
                    aria-labelledby="home-assigned-heading"
                  >
                    <div className="home-group-heading">
                      <h3 id="home-assigned-heading">指定企業の見学</h3>
                      <span>
                        {assigned.filter((task) => task.completed).length}/
                        {assigned.length}
                      </span>
                    </div>
                    <ul className="home-task-list">{assigned.map(row)}</ul>
                  </section>
                )}
                {surveys.length > 0 && (
                  <section
                    className="home-surveys"
                    aria-labelledby="home-surveys-title"
                  >
                    <div className="home-surveys-heading">
                      <h3>
                        <TextButton
                          aria-expanded={surveyOpen}
                          aria-controls={
                            surveyOpen ? "home-survey-tasks" : undefined
                          }
                          onClick={() => setSurveyOpen((value) => !value)}
                        >
                          <Icon
                            name={surveyOpen ? "minus" : "plus"}
                            size={16}
                          />
                          <span id="home-surveys-title">見学アンケート</span>
                          <span className="home-survey-count">
                            {surveys.filter((task) => task.completed).length}/
                            {surveys.length}
                          </span>
                        </TextButton>
                      </h3>
                      {currentSurvey &&
                        (currentSurvey.url || offline) &&
                        (offline ? (
                          <span aria-disabled="true">
                            {currentTerm
                              ? `ターム ${currentTerm} の回答（オンラインで利用）`
                              : "回答する（オンラインで利用）"}
                          </span>
                        ) : (
                          <TextLink
                            href={currentSurvey.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            icon={<Icon name="external" size={14} />}
                          >
                            {currentTerm
                              ? `ターム ${currentTerm} の回答`
                              : "回答する"}
                          </TextLink>
                        ))}
                    </div>
                    {surveyOpen && (
                      <ul id="home-survey-tasks" className="home-task-list">
                        {surveys.map(row)}
                      </ul>
                    )}
                  </section>
                )}
                {remaining.length > 0 && (
                  <ul className="home-task-list home-final-tasks">
                    {remaining.map(row)}
                  </ul>
                )}
                {all.length === 0 && (
                  <p className="home-empty">やることはありません</p>
                )}
              </>
            )
          )}
        </section>
        <section
          className="home-recommendations"
          aria-labelledby="home-recommendations-heading"
        >
          <div className="home-section-heading">
            <h2 id="home-recommendations-heading">おすすめ</h2>
            <TextLink
              href={routeHref({ ...route, view: "search", company: "" })}
              onClick={(event) =>
                follow(event, () =>
                  onRouteChange({ view: "search", company: "" }),
                )
              }
            >
              探す
            </TextLink>
          </div>
          {recommendations.length ? (
            <ul className="home-recommendation-list">
              {recommendations.map(({ company, reasons }) => (
                <li key={company.id} className="home-recommendation">
                  <div className="home-recommendation-heading">
                    <h3>
                      <TextLink
                        href={routeHref({ ...route, company: company.id })}
                        onClick={(event) =>
                          follow(event, () => onSelectCompany(company))
                        }
                      >
                        {company.name}
                      </TextLink>
                    </h3>
                    <FavoriteButton
                      company={company}
                      saved={savedIDs.has(company.id)}
                      onToggle={() => onSaveCompany(company)}
                    />
                  </div>
                  <div className="home-recommendation-meta">
                    <span>
                      {company.session === "AM" ? "午前" : "午後"} · ブース{" "}
                      {company.booth}
                    </span>
                  </div>
                  {reasons.length > 0 && (
                    <ul
                      className="home-recommendation-reasons"
                      aria-label="おすすめの理由"
                    >
                      {reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="home-empty">条件に合う企業はありません</p>
          )}
        </section>
      </div>
    </>
  );
}
