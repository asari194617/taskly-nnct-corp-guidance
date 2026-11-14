import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { generateOfflineShell } from "./offline-shell.mjs";

test("the worker contains only exact public build files and deterministic revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "guidance-shell-"));
  try {
    for (const page of [
      "",
      "search",
      "favorites",
      "schedule",
      "documents",
      "map",
    ]) {
      await mkdir(join(root, page), { recursive: true });
      await writeFile(
        join(root, page, "index.html"),
        "<html>" + page + "</html>",
      );
    }
    await writeFile(join(root, "taskly-logo.svg"), "<svg/>");
    await mkdir(join(root, "_next/static/nested"), { recursive: true });
    for (const file of [
      "app.js",
      "app.css",
      "font.woff2",
      "image.png",
      "app.js.map",
      "private.json",
    ])
      await writeFile(
        join(root, "_next/static/nested", file),
        "public fixture",
      );
    await writeFile(join(root, "guidebook.pdf"), "never include");
    const first = await generateOfflineShell(root),
      second = await generateOfflineShell(root);
    assert.equal(first.revision, second.revision);
    assert.equal(first.assets.length, 11);
    assert.ok(
      first.assets.every(
        (asset) => !/[?]|\.pdf|\.map$|\.json$/.test(asset.path),
      ),
    );
    assert.ok(
      first.routes.some(
        ([route, path]) => route === "/map/" && path === "/map/index.html",
      ),
    );
    for (const asset of first.assets)
      assert.equal(
        asset.sha256,
        createHash("sha256")
          .update(await readFile(join(root, asset.path)))
          .digest("hex"),
      );
    const events = [];
    const self = {
      location: { origin: "https://example.test" },
      addEventListener: (name) => events.push(name),
    };
    vm.runInNewContext(
      await readFile(join(root, "offline-worker.js"), "utf8"),
      { self, URL },
    );
    assert.deepEqual(events, ["install", "activate", "fetch"]);
    await writeFile(join(root, "index.html"), "<html>new release</html>");
    assert.notEqual(
      (await generateOfflineShell(root)).revision,
      first.revision,
    );
    await symlink(join(root, "index.html"), join(root, "_next/static/link.js"));
    await assert.rejects(generateOfflineShell(root), /symlinks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
