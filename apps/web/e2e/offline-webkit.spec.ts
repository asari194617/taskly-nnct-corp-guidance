import { requireValue } from "../tests/required";
import { test, expect } from "./fixtures";
import {
  expectNoPrivateStorageURLs,
  expectOfflineHome,
  expectOfflineMap,
  loginOfflineUser,
  readOfflineSnapshot,
  resetInterests,
  waitForOfflinePack,
} from "./offline-fixtures";

test("Mobile Safari restores native IndexedDB snapshots and map image bytes through its service worker while actually offline", async ({
  page,
  context,
  browserName,
}) => {
  test.setTimeout(60_000);
  expect(browserName).toBe("webkit");
  await loginOfflineUser(page);
  await resetInterests(page, ["AM-1"]);
  const prepared = await waitForOfflinePack(page);
  await expectNoPrivateStorageURLs(page);
  try {
    await context.setOffline(true);
    await page.reload();
    await expectOfflineHome(page);
    await page.goto("/favorites/?session=all");
    await expect(
      page.getByRole("heading", { name: "気になる", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "架空あおばソフトを気になるから解除",
        exact: true,
      }),
    ).toBeDisabled();
    await expectOfflineMap(page);
    const restored = await readOfflineSnapshot(page);
    expect(requireValue(restored.active).pack.session.scope).toBe(
      prepared.pack.session.scope,
    );
    expect(restored.maps).toHaveLength(2);
    expect(
      restored.maps.every(
        (map) => map.isArrayBuffer && map.type === "image/png" && map.size > 0,
      ),
    ).toBe(true);
    await expectNoPrivateStorageURLs(page);
  } finally {
    await context.setOffline(false);
  }
});
