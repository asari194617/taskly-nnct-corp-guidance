import { test, expect } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { captureCurrentPDF, returnToApplication } from "./pdf-navigation";

const API = "http://127.0.0.1:3371";
const ISSUER = "http://127.0.0.1:3372";
const TASKLY = "http://127.0.0.1:3374";
const scenarios = [
  {
    name: "documents",
    path: "/documents/",
    subject: "documents",
    popup: "null" as const,
  },
  { name: "home sheet", path: "/", subject: "home", popup: "throw" as const },
];

async function login(page: Page, subject: string, path: string) {
  await page.goto(path);
  await page
    .getByRole("button", { name: "Tasklyでログイン", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "検証用ログイン" }),
  ).toBeVisible();
  await page.getByLabel("検証アカウント").selectOption(subject);
  await page.getByRole("button", { name: "検証用アカウントで続ける" }).click();
  await page.waitForURL((url) => url.origin === "http://127.0.0.1:3300");
  const preferences = await (
    await page.request.get(`${API}/api/preferences`)
  ).json();
  if (preferences.roster_number === null) {
    const dialog = page.getByRole("dialog", { name: "名簿番号の設定" });
    await dialog.getByRole("spinbutton", { name: "名簿番号" }).fill("7");
    await dialog.getByRole("button", { name: "保存する", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "ユーザーメニュー", exact: true }),
  ).toBeVisible();
  if (path === "/")
    await expect(
      page.locator('.home-task-row[data-task-id="sheet-submission"]'),
    ).toBeVisible();
}

function blockPopups(mode: "null" | "throw") {
  const review = window as Window & { __blockedPDFPopups?: number };
  review.__blockedPDFPopups = 0;
  window.open = () => {
    const count = review.__blockedPDFPopups;
    if (count === undefined)
      throw new Error("Expected the initialized popup counter");
    review.__blockedPDFPopups = count + 1;
    if (mode === "throw") throw new Error("Synthetic iOS popup denial");
    return null;
  };
}
async function forbidPopups(page: Page, mode: "null" | "throw") {
  await page.addInitScript(blockPopups, mode);
  await page.evaluate(blockPopups, mode);
}
const openPDF = (page: Page, path: string) =>
  path === "/"
    ? page
        .locator('.home-task-row[data-task-id="sheet-submission"]')
        .getByRole("button", { name: "資料を見る", exact: true })
        .click()
    : page
        .getByRole("button", { name: "検証用ガイドPDF", exact: true })
        .click();

async function sheetCompleted(request: APIRequestContext, subject: string) {
  const fixtures = await (await request.get(`${TASKLY}/__test/fixture`)).json();
  const response = await request.post(`${TASKLY}/graphql/`, {
    headers: { Authorization: `Bearer ${fixtures.sessions[subject]}` },
    data: {
      query:
        '{ tasks(q:"Synthetic sheet-submission") { items { id is_completed } } }',
    },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  const task = body.data.tasks.items.find(
    (item: { id: string | number }) =>
      String(item.id) === String(fixtures.bindings["sheet-submission"]),
  );
  expect(task).toBeDefined();
  return task.is_completed as boolean;
}

for (const scenario of scenarios) {
  test(`Mobile Safari ${scenario.name} opens a real signed PDF in the current tab when window.open ${scenario.popup === "null" ? "returns null" : "throws"}`, async ({
    page,
    request,
    browserName,
  }, info) => {
    expect(browserName).toBe("webkit");
    await login(page, scenario.subject, scenario.path);
    await forbidPopups(page, scenario.popup);
    const before = await sheetCompleted(request, scenario.subject);
    expect(before).toBe(false);
    let taskWrites = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/home/tasks/"))
        taskWrites++;
    });
    const { signed, appURL } = await captureCurrentPDF(page, () =>
      openPDF(page, scenario.path),
    );
    if (scenario.path === "/") expect(signed.hash).toBe("#page=25");
    expect((await request.storageState()).cookies).toEqual([]);
    const anonymous = await request.get(signed.href);
    expect(anonymous.status()).toBe(200);
    expect(anonymous.headers()["content-type"]).toBe("application/pdf");
    const pdf = (await anonymous.body()).toString("latin1");
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(26);
    expect(pdf).toContain("Synthetic physical page 25");
    const returned = await returnToApplication(page, appURL);
    info.annotations.push({
      type: "PDF navigation",
      description: returned.mode,
    });
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __blockedPDFPopups?: number })
            .__blockedPDFPopups,
      ),
    ).toBe(0);
    expect((await page.request.get(`${API}/api/me`)).status()).toBe(200);
    expect(await sheetCompleted(request, scenario.subject)).toBe(before);
    expect(taskWrites).toBe(0);
  });

  for (const failure of [401, 503]) {
    test(`Mobile Safari ${scenario.name} keeps the app URL when real signing authentication returns ${failure}`, async ({
      page,
      request,
      browserName,
    }) => {
      expect(browserName).toBe("webkit");
      await login(page, scenario.subject, scenario.path);
      await forbidPopups(page, "throw");
      const appURL = page.url();
      const pages = page.context().pages().length;
      const before = await sheetCompleted(request, scenario.subject);
      if (failure === 401)
        expect(
          (
            await request.post(
              `${ISSUER}/__test/revoke?subject=${scenario.subject}`,
            )
          ).status(),
        ).toBe(200);
      else
        expect(
          (await request.post(`${ISSUER}/__test/outage?enabled=1`)).status(),
        ).toBe(200);
      try {
        const failed = page.waitForResponse(
          (r) => r.url() === `${API}/api/documents/guide/url`,
        );
        await openPDF(page, scenario.path);
        expect((await failed).status()).toBe(failure);
        await expect(page).toHaveURL(appURL);
        expect(page.context().pages()).toHaveLength(pages);
        expect(
          await page.evaluate(
            () =>
              (window as Window & { __blockedPDFPopups?: number })
                .__blockedPDFPopups,
          ),
        ).toBe(0);
        if (failure === 401)
          await expect(
            page.getByRole("button", { name: "Tasklyでログイン", exact: true }),
          ).toBeVisible();
        else
          await expect(
            page.getByText("資料を開けませんでした。もう一度お試しください。", {
              exact: true,
            }),
          ).toBeVisible();
        expect(await sheetCompleted(request, scenario.subject)).toBe(before);
      } finally {
        if (failure === 503)
          expect(
            (await request.post(`${ISSUER}/__test/outage?enabled=0`)).status(),
          ).toBe(200);
      }
      if (failure === 503) {
        const { appURL: retryURL } = await captureCurrentPDF(page, () =>
          openPDF(page, scenario.path),
        );
        await returnToApplication(page, retryURL);
        expect(await sheetCompleted(request, scenario.subject)).toBe(before);
      }
    });
  }
}
