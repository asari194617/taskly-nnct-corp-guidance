import { expect, type Page } from "@playwright/test";

export const OBJECTS = "http://127.0.0.1:3373";
export const BUCKET = "synthetic-guidance-documents";

/** Observe a genuine signed PDF in the existing tab, never a popup or blob. */
export async function captureCurrentPDF(
  page: Page,
  open: () => Promise<unknown>,
) {
  const appURL = page.url();
  const pageCount = page.context().pages().length;
  let target = "";
  const download = (file: { url(): string }) => {
    target = file.url();
  };
  const navigated = (frame: ReturnType<Page["mainFrame"]>) => {
    if (frame === page.mainFrame() && frame.url().startsWith(OBJECTS))
      target = frame.url();
  };
  page.on("download", download);
  page.on("framenavigated", navigated);
  const navigation = page.waitForEvent("request", {
    predicate: (request) =>
      request.isNavigationRequest() &&
      new URL(request.url()).origin === OBJECTS &&
      new URL(request.url()).pathname === `/${BUCKET}/guide.pdf`,
  });
  try {
    await open();
    const request = await navigation;
    expect(request.frame()).toBe(page.mainFrame());
    expect(request.resourceType()).toBe("document");
    await expect.poll(() => target).not.toBe("");
    expect(page.context().pages()).toHaveLength(pageCount);
    const signed = new URL(target);
    expect(signed.origin).toBe(OBJECTS);
    expect(signed.pathname).toBe(`/${BUCKET}/guide.pdf`);
    expect(signed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(Number(signed.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(0);
    expect(
      Number(signed.searchParams.get("X-Amz-Expires")),
    ).toBeLessThanOrEqual(300);
    return { signed, appURL };
  } finally {
    page.off("download", download);
    page.off("framenavigated", navigated);
  }
}

/** Native viewers permit Back; headless download engines keep the app in place. */
export async function returnToApplication(page: Page, appURL: string) {
  const viewer = new URL(page.url()).origin === OBJECTS;
  if (viewer) await page.goBack();
  await expect(page).toHaveURL(appURL);
  await expect(
    page.getByRole("button", { name: "ユーザーメニュー", exact: true }),
  ).toBeVisible();
  // Reload proves that a fresh page still restores the same authenticated route.
  await page.reload();
  await expect(page).toHaveURL(appURL);
  await expect(
    page.getByRole("button", { name: "ユーザーメニュー", exact: true }),
  ).toBeVisible();
  return {
    mode: viewer ? "native-viewer-back" : "native-download-stayed-on-app",
  };
}
