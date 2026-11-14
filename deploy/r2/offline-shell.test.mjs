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
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";
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
      await writeFile(join(root, page, "index.html"), `<html>${page}</html>`);
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
        ([route, path]) => route === "/map/" && path === "/map/",
      ),
    );
    assert.equal(
      new Set(first.assets.map((asset) => asset.path)).size,
      first.assets.length,
    );
    for (const asset of first.assets) {
      const file = asset.path.endsWith("/")
        ? `${asset.path}index.html`
        : asset.path;
      assert.equal(
        asset.sha256,
        createHash("sha256")
          .update(await readFile(join(root, file)))
          .digest("hex"),
      );
    }
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

test("emitted worker installs against canonical redirects and serves offline query routes from canonical cache keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "guidance-canonical-shell-"));
  const pages = ["", "search", "favorites", "schedule", "documents", "map"];
  const served = new Map(),
    requests = [];
  let server;
  try {
    for (const page of pages) {
      const route = page ? `/${page}/` : "/";
      const body = `<html><head></head><body>synthetic ${page || "home"}</body></html>`;
      await mkdir(join(root, page), { recursive: true });
      await writeFile(join(root, page, "index.html"), body);
      served.set(route, body);
    }
    await writeFile(join(root, "taskly-logo.svg"), "<svg/>");
    served.set("/taskly-logo.svg", "<svg/>");
    await mkdir(join(root, "_next/static"), { recursive: true });
    await writeFile(join(root, "_next/static", "app.js"), "publicBootstrap();");
    served.set("/_next/static/app.js", "publicBootstrap();");
    server = createServer((req, res) => {
      const url = new URL(req.url, "http://synthetic.invalid");
      requests.push(url.pathname);
      if (url.pathname === "/index.html") {
        res.writeHead(302, { Location: `/${url.search}` });
        return res.end();
      }
      if (!served.has(url.pathname)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200);
      res.end(served.get(url.pathname));
    });
    await new Promise((ok, fail) =>
      server.once("error", fail).listen(0, "127.0.0.1", ok),
    );
    const origin = `http://127.0.0.1:${server.address().port}`;
    // The public deployment redirects this alias. The strict download policy
    // must continue rejecting it instead of silently following arbitrary URLs.
    await assert.rejects(fetch(`${origin}/index.html`, { redirect: "error" }));
    requests.length = 0;
    const manifest = await generateOfflineShell(root);
    assert.deepEqual(
      manifest.assets.map((asset) => asset.path).sort(),
      [...served.keys()].sort(),
    );
    assert.equal(
      new Set(manifest.assets.map((asset) => asset.path)).size,
      manifest.assets.length,
    );
    const stores = new Map(),
      handlers = new Map();
    const scope = {
      location: { origin },
      crypto: webcrypto,
      setTimeout,
      clearTimeout,
      fetch,
      addEventListener(name, handler) {
        handlers.set(name, handler);
      },
      caches: {
        async open(name) {
          if (!stores.has(name)) stores.set(name, new Map());
          const values = stores.get(name);
          return {
            async put(key, response) {
              values.set(key, response.clone());
            },
            async match(key) {
              return values.get(key)?.clone();
            },
          };
        },
        async delete(name) {
          return stores.delete(name);
        },
      },
    };
    vm.runInNewContext(
      await readFile(join(root, "offline-worker.js"), "utf8"),
      { self: scope, URL, Response, AbortController, setTimeout, clearTimeout },
    );
    let installed;
    handlers.get("install")({
      waitUntil(promise) {
        installed = promise;
      },
    });
    await installed;
    assert.deepEqual(requests.sort(), [...served.keys()].sort());
    assert.equal(new Set(requests).size, requests.length);
    scope.fetch = async () => {
      throw Error("synthetic offline");
    };
    for (const path of [
      "/?company=AM-1&q=synthetic",
      "/index.html?company=AM-1",
      "/map?focus=AM-1",
      "/map/index.html?session=AM",
    ]) {
      let result;
      const waits = [];
      handlers.get("fetch")({
        request: {
          url: origin + path,
          method: "GET",
          headers: new Headers(),
          mode: "navigate",
        },
        respondWith(promise) {
          result = promise;
        },
        waitUntil(promise) {
          waits.push(promise);
        },
      });
      const response = await result;
      assert.equal(response.status, 200);
      assert.equal(
        await response.text(),
        served.get(path.startsWith("/map") ? "/map/" : "/"),
      );
      await Promise.all(waits);
    }
    const keys = [...stores.values()][0].keys();
    for (const key of keys)
      assert.ok(!key.includes("?") && !key.endsWith("/index.html"));
  } finally {
    if (server?.listening) await new Promise((ok) => server.close(ok));
    await rm(root, { recursive: true, force: true });
  }
});
