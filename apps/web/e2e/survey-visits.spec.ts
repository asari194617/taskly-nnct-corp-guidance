import { requireValue } from "../tests/required";
import { test, expect } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import type {
  HomeTask,
  HomeTaskUpdateResponse,
  HomeTasksResponse,
} from "../lib/types";

const API = "http://127.0.0.1:3371";
const UI = "http://127.0.0.1:3300";
const ISSUER = "http://127.0.0.1:3372";
const TASKLY = "http://127.0.0.1:3374";
const ACTOR = "home-other";
type CanonicalFixture = {
  bindings: Record<string, number>;
  sessions: Record<string, string>;
};
const row = (page: Page, key: string) =>
  page.locator(`.home-task-row[data-task-id="${key}"]`);
const checkbox = (page: Page, key: string) =>
  row(page, key).getByRole("checkbox");

async function fixtures(request: APIRequestContext): Promise<CanonicalFixture> {
  const response = await request.get(`${TASKLY}/__test/fixture`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function graphql(
  request: APIRequestContext,
  fixture: CanonicalFixture,
  actor: string,
  query: string,
) {
  const response = await request.post(`${TASKLY}/graphql/`, {
    headers: { Authorization: `Bearer ${fixture.sessions[actor]}` },
    data: { query },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  return body.data;
}
async function nativeComplete(
  request: APIRequestContext,
  fixture: CanonicalFixture,
  actor: string,
  key: string,
  completed: boolean,
) {
  const operation = completed ? "completeTask" : "uncompleteTask";
  const data = await graphql(
    request,
    fixture,
    actor,
    `mutation { ${operation}(id:${fixture.bindings[key]}) }`,
  );
  expect(data[operation]).toBe(true);
}
async function resetCanonical(
  request: APIRequestContext,
  fixture: CanonicalFixture,
  actor = ACTOR,
) {
  const fields = Object.entries(fixture.bindings)
    .map(([, id], i) => `reset${i}:uncompleteTask(id:${id})`)
    .join(" ");
  const data = await graphql(request, fixture, actor, `mutation { ${fields} }`);
  expect(Object.values(data).every((value) => value === true)).toBe(true);
}
async function canonical(
  request: APIRequestContext,
  fixture: CanonicalFixture,
  actor = ACTOR,
) {
  const data = await graphql(
    request,
    fixture,
    actor,
    '{ tasks(q:"Synthetic",limit:50) { items { id is_completed is_completion_disabled } } }',
  );
  return Object.fromEntries(
    Object.entries(fixture.bindings).map(([key, id]) => {
      const item = data.tasks.items.find(
        (candidate: { id: number | string }) =>
          String(candidate.id) === String(id),
      );
      expect(item, `canonical Taskly task ${key}`).toBeDefined();
      return [key, Boolean(item.is_completed)];
    }),
  );
}
async function home(page: Page): Promise<HomeTasksResponse> {
  const response = await page.request.get(`${API}/api/home`);
  expect(response.status()).toBe(200);
  return response.json();
}
const task = (data: HomeTasksResponse, key: string) => {
  const found = data.tasks.find((item) => item.id === key);
  expect(found, `home task ${key}`).toBeDefined();
  return requireValue(found);
};
async function setRoster(page: Page, number: number) {
  const profile = await (
    await page.request.get(`${API}/api/preferences`)
  ).json();
  if (profile.roster_number !== number) {
    const dialog = page.getByRole("dialog", { name: "名簿番号の設定" });
    if (!(await dialog.isVisible())) {
      await page
        .getByRole("button", { name: "ユーザーメニュー", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "名簿番号の設定", exact: true })
        .click();
    }
    await dialog
      .getByRole("spinbutton", { name: "名簿番号" })
      .fill(String(number));
    await dialog.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(row(page, "assigned-visit-1")).toContainText(
    number === 8 ? "架空いろは機械" : "架空あおばソフト",
  );
}
async function login(
  page: Page,
  actor = ACTOR,
  number = 7,
  tasksAllowed = true,
) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Tasklyでログイン", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証用ログイン" }),
  ).toBeVisible();
  await page.getByLabel("検証アカウント").selectOption(actor);
  await page.getByRole("button", { name: "検証用アカウントで続ける" }).click();
  await page.waitForURL((url) => url.origin === UI);
  const profile = await (
    await page.request.get(`${API}/api/preferences`)
  ).json();
  if (profile.roster_number === null) {
    const dialog = page.getByRole("dialog", { name: "名簿番号の設定" });
    await dialog
      .getByRole("spinbutton", { name: "名簿番号" })
      .fill(String(number));
    await dialog.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "ユーザーメニュー", exact: true }),
  ).toBeVisible();
  if (tasksAllowed) await setRoster(page, number);
}
async function expandSurveys(page: Page) {
  const toggle = page.getByRole("button", { name: /^見学アンケート/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await expect(checkbox(page, "visit-survey-1")).toBeVisible();
}
async function mutate(
  page: Page,
  key: string,
  completed: boolean,
): Promise<HomeTaskUpdateResponse> {
  const control = checkbox(page, key);
  expect(await control.isChecked()).toBe(!completed);
  const response = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/${key}` &&
      r.request().method() === "PUT",
  );
  await control.press("Space");
  const settled = await response;
  expect(settled.status()).toBe(200);
  const body = await settled.json();
  await expect(control).toBeEnabled();
  if (completed) await expect(control).toBeChecked();
  else await expect(control).not.toBeChecked();
  return body;
}
async function put(page: Page, key: string, completed: boolean) {
  return page.request.put(`${API}/api/home/tasks/${key}`, {
    headers: { Origin: UI },
    data: { completed },
  });
}
function partner(
  update: HomeTaskUpdateResponse,
  key = "assigned-visit-1",
): HomeTask {
  expect(update.related_tasks).toHaveLength(1);
  expect(requireValue(update.related_tasks)[0].id).toBe(key);
  return requireValue(update.related_tasks)[0];
}
async function refreshOnFocus(page: Page) {
  const refreshed = page.waitForResponse(
    (r) => r.url() === `${API}/api/home` && r.request().method() === "GET",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect((await refreshed).status()).toBe(200);
}
async function gateForward(page: Page, key: string) {
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const url = `${API}/api/home/tasks/${key}`;
  const handler = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PUT") return route.continue();
    started();
    await held;
    await route.continue();
  };
  await page.route(url, handler);
  return { requested, release, remove: () => page.unroute(url, handler) };
}

test("A survey optimistically checks its assigned visit, commits both Taskly records once, and owns a persistent undo", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/api/home/tasks/"))
      requests.push(r.url());
  });
  const gate = await gateForward(page, "visit-survey-1");
  const response = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/visit-survey-1` &&
      r.request().method() === "PUT",
  );
  try {
    await checkbox(page, "visit-survey-1").press("Space");
    await gate.requested;
    for (const key of ["visit-survey-1", "assigned-visit-1"]) {
      await expect(checkbox(page, key)).toBeChecked();
      await expect(checkbox(page, key)).toBeDisabled();
    }
    const beforeCommit = await canonical(request, fixture);
    expect(beforeCommit["visit-survey-1"]).toBe(false);
    expect(beforeCommit["assigned-visit-1"]).toBe(false);
    expect(requests).toEqual([`${API}/api/home/tasks/visit-survey-1`]);
  } finally {
    gate.release();
  }
  const settled = await response;
  expect(settled.status()).toBe(200);
  expect(settled.request().postDataJSON()).toEqual({ completed: true });
  const update: HomeTaskUpdateResponse = await settled.json();
  expect(update.id).toBe("visit-survey-1");
  expect(partner(update).completed).toBe(true);
  expect(partner(update).auto_completed_by).toBe("visit-survey-1");
  await expect(checkbox(page, "assigned-visit-1")).toBeEnabled();
  await gate.remove();
  const committed = await canonical(request, fixture);
  expect(committed["visit-survey-1"]).toBe(true);
  expect(committed["assigned-visit-1"]).toBe(true);
  expect(committed["assigned-visit-3"]).toBe(false);
  await page.reload();
  await expandSurveys(page);
  await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
  expect(task(await home(page), "assigned-visit-1").auto_completed_by).toBe(
    "visit-survey-1",
  );
  const undone = await mutate(page, "visit-survey-1", false);
  expect(partner(undone).completed).toBe(false);
  expect(partner(undone).auto_completed_by).toBeUndefined();
  await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
  const final = await canonical(request, fixture);
  expect(final["visit-survey-1"]).toBe(false);
  expect(final["assigned-visit-1"]).toBe(false);
});

test("A visit already completed manually in Taskly remains complete when its survey is checked and undone", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await nativeComplete(request, fixture, ACTOR, "assigned-visit-1", true);
  await login(page);
  await expandSurveys(page);
  await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
  const update = await mutate(page, "visit-survey-1", true);
  expect(partner(update).completed).toBe(true);
  expect(partner(update).auto_completed_by).toBeUndefined();
  const undone = await mutate(page, "visit-survey-1", false);
  expect(partner(undone).completed).toBe(true);
  expect(partner(undone).auto_completed_by).toBeUndefined();
  await page.reload();
  await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
  const states = await canonical(request, fixture);
  expect(states["assigned-visit-1"]).toBe(true);
  expect(states["visit-survey-1"]).toBe(false);
});

test("Either Guidance checkbox can undo an automatically owned pair while a subsequent manual visit stays protected", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  await mutate(page, "visit-survey-1", true);
  const gate = await gateForward(page, "assigned-visit-1");
  const response = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/assigned-visit-1` &&
      r.request().method() === "PUT",
  );
  try {
    await checkbox(page, "assigned-visit-1").press("Space");
    await gate.requested;
    for (const key of ["assigned-visit-1", "visit-survey-1"]) {
      await expect(checkbox(page, key)).not.toBeChecked();
      await expect(checkbox(page, key)).toBeDisabled();
    }
    const held = await canonical(request, fixture);
    expect(held["assigned-visit-1"]).toBe(true);
    expect(held["visit-survey-1"]).toBe(true);
  } finally {
    gate.release();
  }
  const settled = await response;
  expect(settled.status()).toBe(200);
  const off: HomeTaskUpdateResponse = await settled.json();
  expect(off.auto_completed_by).toBeUndefined();
  expect(partner(off, "visit-survey-1").completed).toBe(false);
  await expect(checkbox(page, "assigned-visit-1")).toBeEnabled();
  await gate.remove();
  const undone = await canonical(request, fixture);
  expect(undone["assigned-visit-1"]).toBe(false);
  expect(undone["visit-survey-1"]).toBe(false);
  const manual = await mutate(page, "assigned-visit-1", true);
  expect(manual.auto_completed_by).toBeUndefined();
  await expect(checkbox(page, "visit-survey-1")).not.toBeChecked();
  expect(
    partner(await mutate(page, "visit-survey-1", true)).auto_completed_by,
  ).toBeUndefined();
  const manualUndone = await mutate(page, "visit-survey-1", false);
  expect(partner(manualUndone).completed).toBe(true);
  expect(partner(manualUndone).auto_completed_by).toBeUndefined();
  await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
  expect((await canonical(request, fixture))["assigned-visit-1"]).toBe(true);
});

test("Native Taskly touches of either automatic checkbox release ownership through the live poll and focus refresh", async ({
  page,
  request,
}) => {
  await page.clock.install();
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  await mutate(page, "visit-survey-1", true);
  await nativeComplete(request, fixture, ACTOR, "assigned-visit-1", true);
  expect(
    task(await home(page), "assigned-visit-1").auto_completed_by,
  ).toBeUndefined();
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  const poll = page.waitForResponse(
    (r) => r.url() === `${API}/api/home` && r.request().method() === "GET",
  );
  await page.clock.fastForward(30_001);
  expect((await poll).status()).toBe(200);
  const gate = await gateForward(page, "visit-survey-1");
  const response = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/visit-survey-1` &&
      r.request().method() === "PUT",
  );
  try {
    await checkbox(page, "visit-survey-1").press("Space");
    await gate.requested;
    await expect(checkbox(page, "visit-survey-1")).not.toBeChecked();
    await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
  } finally {
    gate.release();
  }
  expect((await response).status()).toBe(200);
  await gate.remove();
  await expect(checkbox(page, "assigned-visit-1")).toBeEnabled();
  await nativeComplete(request, fixture, ACTOR, "assigned-visit-1", false);
  await refreshOnFocus(page);
  await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
  await mutate(page, "visit-survey-1", true);
  await nativeComplete(request, fixture, ACTOR, "visit-survey-1", true);
  await refreshOnFocus(page);
  expect(
    task(await home(page), "assigned-visit-1").auto_completed_by,
  ).toBeUndefined();
  const manuallyClaimed = await mutate(page, "assigned-visit-1", false);
  expect(partner(manuallyClaimed, "visit-survey-1").completed).toBe(true);
  await expect(checkbox(page, "visit-survey-1")).toBeChecked();
  const states = await canonical(request, fixture);
  expect(states["assigned-visit-1"]).toBe(false);
  expect(states["visit-survey-1"]).toBe(true);
  expect(navigations).toBe(0);
});

test("Idempotent survey retries do not recreate a manually undone visit or retroactively link a native Taskly survey", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  await mutate(page, "visit-survey-1", true);
  await nativeComplete(request, fixture, ACTOR, "assigned-visit-1", false);
  await refreshOnFocus(page);
  await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
  const retry = await put(page, "visit-survey-1", true);
  expect(retry.status()).toBe(200);
  expect(partner(await retry.json()).completed).toBe(false);
  expect((await canonical(request, fixture))["assigned-visit-1"]).toBe(false);
  await mutate(page, "visit-survey-1", false);
  expect(
    partner(await mutate(page, "visit-survey-1", true)).auto_completed_by,
  ).toBe("visit-survey-1");
  await resetCanonical(request, fixture);
  await refreshOnFocus(page);
  await expect(checkbox(page, "visit-survey-1")).not.toBeChecked();
  await nativeComplete(request, fixture, ACTOR, "visit-survey-1", true);
  await refreshOnFocus(page);
  await expect(checkbox(page, "visit-survey-1")).toBeChecked();
  await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
  const nativeRetry = await put(page, "visit-survey-1", true);
  expect(nativeRetry.status()).toBe(200);
  const visit = partner(await nativeRetry.json());
  expect(visit.completed).toBe(false);
  expect(visit.auto_completed_by).toBeUndefined();
  expect((await canonical(request, fixture))["assigned-visit-1"]).toBe(false);
});

test("Unassigned survey terms and unrelated tasks never alter another assigned visit", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  expect(
    (await mutate(page, "visit-survey-2", true)).related_tasks,
  ).toBeUndefined();
  let states = await canonical(request, fixture);
  expect(
    Object.keys(states).filter(
      (key) => key.startsWith("assigned-visit-") && states[key],
    ),
  ).toEqual([]);
  const sameTerm = await mutate(page, "visit-survey-6", true);
  expect(partner(sameTerm, "assigned-visit-6").auto_completed_by).toBe(
    "visit-survey-6",
  );
  states = await canonical(request, fixture);
  expect(states["assigned-visit-6"]).toBe(true);
  expect(
    Object.keys(states).filter(
      (key) => key.startsWith("assigned-visit-") && states[key],
    ),
  ).toEqual(["assigned-visit-6"]);
  expect(states["visit-survey-2"]).toBe(true);
  await mutate(page, "visit-survey-6", false);
  expect(
    (await mutate(page, "overall-survey", true)).related_tasks,
  ).toBeUndefined();
  states = await canonical(request, fixture);
  expect(
    Object.keys(states).filter(
      (key) => key.startsWith("assigned-visit-") && states[key],
    ),
  ).toEqual([]);
});

test("Automatic ownership is isolated between accounts and a changed roster cannot undo the previous assignment scope", async ({
  page,
  request,
  browser,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await resetCanonical(request, fixture, "home-failure");
  await login(page);
  await expandSurveys(page);
  await mutate(page, "visit-survey-1", true);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await login(other, "home-failure");
    await expect(checkbox(other, "assigned-visit-1")).not.toBeChecked();
    expect(
      task(await home(other), "assigned-visit-1").auto_completed_by,
    ).toBeUndefined();
    expect(
      (await canonical(request, fixture, "home-failure"))["assigned-visit-1"],
    ).toBe(false);
    await setRoster(page, 8);
    await expandSurveys(page);
    await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
    expect(
      task(await home(page), "assigned-visit-1").auto_completed_by,
    ).toBeUndefined();
    const undone = await mutate(page, "visit-survey-1", false);
    expect(partner(undone).completed).toBe(true);
    expect(partner(undone).auto_completed_by).toBeUndefined();
    await page.reload();
    await expect(row(page, "assigned-visit-1")).toContainText("架空いろは機械");
    await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
    expect(
      task(await home(page), "assigned-visit-1").auto_completed_by,
    ).toBeUndefined();
    await expandSurveys(page);
    // The old profile's provenance must not reverse-undo this profile's survey.
    expect(
      partner(await mutate(page, "visit-survey-1", true)).auto_completed_by,
    ).toBeUndefined();
    expect(
      partner(await mutate(page, "assigned-visit-1", false), "visit-survey-1")
        .completed,
    ).toBe(true);
    await expect(checkbox(page, "visit-survey-1")).toBeChecked();
    const scoped = await canonical(request, fixture);
    expect(scoped["assigned-visit-1"]).toBe(false);
    expect(scoped["visit-survey-1"]).toBe(true);
    await refreshOnFocus(other);
    await expect(checkbox(other, "assigned-visit-1")).not.toBeChecked();
  } finally {
    await otherContext.close();
  }
});

test("A disabled linked visit rejects the whole pair atomically and a forbidden account cannot write a survey", async ({
  page,
  request,
  browser,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  const disable = async (value: boolean) => {
    const data = await graphql(
      request,
      fixture,
      "alice",
      `mutation { updateTask(id:${fixture.bindings["assigned-visit-1"]},is_completion_disabled:${value}) { id is_completion_disabled } }`,
    );
    expect(data.updateTask.is_completion_disabled).toBe(value);
  };
  await disable(true);
  try {
    await page.reload();
    await expandSurveys(page);
    await expect(checkbox(page, "assigned-visit-1")).toBeDisabled();
    const response = page.waitForResponse(
      (r) =>
        r.url() === `${API}/api/home/tasks/visit-survey-1` &&
        r.request().method() === "PUT",
    );
    await checkbox(page, "visit-survey-1").press("Space");
    expect((await response).status()).toBe(409);
    await expect(checkbox(page, "visit-survey-1")).not.toBeChecked();
    await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
    await expect(
      page
        .getByRole("region", { name: "やること", exact: true })
        .getByRole("alert"),
    ).toContainText("Taskly");
  } finally {
    await disable(false);
  }
  // Re-enabling before the canonical read exposes any incorrectly hidden row.
  const states = await canonical(request, fixture);
  expect(states["visit-survey-1"]).toBe(false);
  expect(states["assigned-visit-1"]).toBe(false);
  const deniedContext = await browser.newContext();
  try {
    const denied = await deniedContext.newPage();
    await login(denied, "home-denied", 7, false);
    expect((await put(denied, "visit-survey-1", true)).status()).toBe(403);
    const after = await canonical(request, fixture);
    expect(after["visit-survey-1"]).toBe(false);
    expect(after["assigned-visit-1"]).toBe(false);
  } finally {
    await deniedContext.close();
  }
});

test("Actual identity outages roll back a linked check and reverse undo before successful retries", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  const gate = await gateForward(page, "visit-survey-1");
  expect(
    (await request.post(`${ISSUER}/__test/outage?enabled=1`)).status(),
  ).toBe(200);
  const response = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/visit-survey-1` &&
      r.request().method() === "PUT",
  );
  try {
    await checkbox(page, "visit-survey-1").press("Space");
    await gate.requested;
    await expect(checkbox(page, "visit-survey-1")).toBeChecked();
    await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
    gate.release();
    expect((await response).status()).toBe(503);
    await expect(checkbox(page, "visit-survey-1")).not.toBeChecked();
    await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
    const states = await canonical(request, fixture);
    expect(states["visit-survey-1"]).toBe(false);
    expect(states["assigned-visit-1"]).toBe(false);
  } finally {
    gate.release();
    await gate.remove();
    expect(
      (await request.post(`${ISSUER}/__test/outage?enabled=0`)).status(),
    ).toBe(200);
  }
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await expect(checkbox(page, "visit-survey-1")).toBeEnabled();
  expect(partner(await mutate(page, "visit-survey-1", true)).completed).toBe(
    true,
  );
  const retried = await canonical(request, fixture);
  expect(retried["visit-survey-1"]).toBe(true);
  expect(retried["assigned-visit-1"]).toBe(true);
  const reverseGate = await gateForward(page, "assigned-visit-1");
  expect(
    (await request.post(`${ISSUER}/__test/outage?enabled=1`)).status(),
  ).toBe(200);
  const reverseResponse = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/assigned-visit-1` &&
      r.request().method() === "PUT",
  );
  try {
    await checkbox(page, "assigned-visit-1").press("Space");
    await reverseGate.requested;
    await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
    await expect(checkbox(page, "visit-survey-1")).not.toBeChecked();
    reverseGate.release();
    expect((await reverseResponse).status()).toBe(503);
    await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
    await expect(checkbox(page, "visit-survey-1")).toBeChecked();
    const preserved = await canonical(request, fixture);
    expect(preserved["assigned-visit-1"]).toBe(true);
    expect(preserved["visit-survey-1"]).toBe(true);
  } finally {
    reverseGate.release();
    await reverseGate.remove();
    expect(
      (await request.post(`${ISSUER}/__test/outage?enabled=0`)).status(),
    ).toBe(200);
  }
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await expect(checkbox(page, "assigned-visit-1")).toBeEnabled();
  expect(
    partner(await mutate(page, "assigned-visit-1", false), "visit-survey-1")
      .completed,
  ).toBe(false);
  const reversed = await canonical(request, fixture);
  expect(reversed["assigned-visit-1"]).toBe(false);
  expect(reversed["visit-survey-1"]).toBe(false);
});

test("Revocation during a linked write creates neither record and reauthentication restores the canonical unchecked pair", async ({
  page,
  request,
}) => {
  const fixture = await fixtures(request);
  await resetCanonical(request, fixture);
  await login(page);
  await expandSurveys(page);
  const gate = await gateForward(page, "visit-survey-1");
  expect(
    (await request.post(`${ISSUER}/__test/revoke?subject=${ACTOR}`)).status(),
  ).toBe(200);
  const response = page.waitForResponse(
    (r) =>
      r.url() === `${API}/api/home/tasks/visit-survey-1` &&
      r.request().method() === "PUT",
  );
  try {
    await checkbox(page, "visit-survey-1").press("Space");
    await gate.requested;
    await expect(checkbox(page, "visit-survey-1")).toBeChecked();
    await expect(checkbox(page, "assigned-visit-1")).toBeChecked();
    gate.release();
    expect((await response).status()).toBe(401);
    await expect(
      page.getByRole("button", { name: "Tasklyでログイン", exact: true }),
    ).toBeVisible();
    const states = await canonical(request, fixture);
    expect(states["visit-survey-1"]).toBe(false);
    expect(states["assigned-visit-1"]).toBe(false);
  } finally {
    gate.release();
    await gate.remove();
  }
  await login(page);
  expect(
    task(await home(page), "assigned-visit-1").auto_completed_by,
  ).toBeUndefined();
  await expect(checkbox(page, "assigned-visit-1")).not.toBeChecked();
});
