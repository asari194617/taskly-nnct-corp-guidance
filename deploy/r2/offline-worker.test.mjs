import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { startOfflineWorker } from "./offline-worker.mjs";

const origin = "https://guidance.example.test";
const prefix = "taskly-guidance-shell-v1-";
const cacheName = `${prefix}synthetic`;
const stampURL = `${origin}/.offline-shell-stamp`;
const bodies = new Map([
  ["/", "<html>Public home shell</html>"],
  ["/map/", "<html>Public map shell</html>"],
  ["/_next/static/build.js", 'console.log("synthetic public build");'],
]);
const manifest = {
  revision: "synthetic",
  assets: [...bodies].map(([path, body]) => ({
    path,
    sha256: createHash("sha256").update(body).digest("hex"),
  })),
  routes: [
    ["/", "/"],
    ["/index.html", "/"],
    ["/map/", "/map/"],
    ["/map", "/map/"],
    ["/map/index.html", "/map/"],
  ],
};

function harness(fetcher) {
  const listeners = new Map(),
    stores = new Map(),
    calls = [];
  const caches = {
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
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  const scope = {
    location: { origin },
    crypto: webcrypto,
    caches,
    clients: {
      claim: async () => {
        scope.claimed = true;
      },
    },
    setTimeout,
    clearTimeout,
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    async fetch(request, options) {
      calls.push({ request, options });
      if (fetcher) return fetcher(request, options);
      return new Response(
        bodies.get(
          new URL(typeof request === "string" ? request : request.url).pathname,
        ),
      );
    },
  };
  startOfflineWorker(scope, manifest);
  function emit(name, request) {
    const waits = [];
    let response;
    listeners.get(name)({
      request,
      waitUntil(promise) {
        waits.push(promise);
      },
      respondWith(promise) {
        response = promise;
      },
    });
    return {
      get response() {
        return response;
      },
      async done() {
        await Promise.all(waits);
      },
    };
  }
  return {
    scope,
    calls,
    stores,
    caches,
    emit,
    async install() {
      await emit("install").done();
    },
    async stamp(value) {
      const cache = await caches.open(cacheName);
      await cache.put(stampURL, new Response(String(value)));
    },
  };
}
const request = (path, options = {}) => ({
  url: origin + path,
  method: "GET",
  headers: new Headers(),
  mode: "navigate",
  ...options,
});

test("installs an exact hash-checked public shell without cookies, then activates atomically", async () => {
  const h = harness();
  await h.install();
  assert.deepEqual(
    [...h.stores.get(cacheName).keys()].sort(),
    [...bodies.keys()]
      .map((path) => origin + path)
      .concat(stampURL)
      .sort(),
  );
  assert.equal(h.calls.length, bodies.size);
  for (const { options } of h.calls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "reload");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
  }
  await h.caches.open(`${prefix}old`);
  await h.caches.open("unrelated-private-cache");
  await h.emit("activate").done();
  assert.equal(h.scope.claimed, true);
  assert.deepEqual(await h.caches.keys(), [
    cacheName,
    "unrelated-private-cache",
  ]);
  assert.equal("skipWaiting" in h.scope, false);
});

test("failed installs never leave partial shells and verify status, opacity, and actual bytes", async () => {
  for (const mode of ["status", "opaque", "hash", "network"]) {
    const h = harness(async () => {
      if (mode === "network") throw Error("unavailable");
      const response = new Response("tampered public build", {
        status: mode === "status" ? 503 : 200,
      });
      if (mode === "opaque")
        Object.defineProperty(response, "type", { value: "opaque" });
      return response;
    });
    await assert.rejects(h.install());
    assert.deepEqual(await h.caches.keys(), []);
  }
});

test("never intercepts auth, APIs, PDFs, cross-origin, writes, ranged data, or query asset URLs", async () => {
  const h = harness();
  for (const req of [
    request("/api/guidance"),
    request("/auth/logout"),
    request("/guidebook.pdf?token=secret"),
    request("/unknown/"),
    request("/map/", { method: "POST" }),
    request("/map/", { url: "https://api.example.test/api/guidance" }),
    request("/map/", {
      headers: new Headers({ authorization: "Bearer synthetic" }),
    }),
    request("/map/", { headers: new Headers({ range: "bytes=0-5" }) }),
    request("/_next/static/build.js?token=secret", { mode: "cors" }),
  ]) {
    const event = h.emit("fetch", req);
    assert.equal(event.response, undefined);
    await event.done();
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.stores.size, 0);
});

test("offline navigation normalizes only known paths while preserving query state in the browser", async () => {
  const h = harness();
  await h.install();
  h.scope.fetch = async () => {
    throw Error("offline");
  };
  for (const path of [
    "/map/?company=AM-1&q=synthetic",
    "/map?focus=AM-1",
    "/map/index.html?session=AM",
    "/?view=map",
    "/index.html?company=AM-1",
  ]) {
    const event = h.emit("fetch", request(path));
    const response = await event.response;
    assert.equal(response.status, 200);
    assert.match(
      await response.text(),
      path.startsWith("/map") ? /Public map shell/ : /Public home shell/,
    );
    await event.done();
  }
  assert.ok(
    [...h.stores.get(cacheName).keys()].every((key) => !key.includes("?")),
  );
});

test("online navigation remains authoritative and does not cache session failures", async () => {
  const h = harness();
  await h.install();
  h.scope.fetch = async () => new Response("current page", { status: 200 });
  let event = h.emit("fetch", request("/"));
  assert.equal(await (await event.response).text(), "current page");
  await event.done();
  h.scope.fetch = async () => new Response("unauthorized", { status: 401 });
  event = h.emit("fetch", request("/"));
  assert.equal((await event.response).status, 401);
  await event.done();
  const cache = await h.caches.open(cacheName);
  assert.equal(await (await cache.match(`${origin}/`)).text(), bodies.get("/"));
});

test("server outage uses saved shell; an uncached outage preserves its status", async () => {
  const h = harness();
  await h.install();
  h.scope.fetch = async () => new Response("outage", { status: 503 });
  let event = h.emit("fetch", request("/"));
  assert.equal((await event.response).status, 200);
  await event.done();
  await h.stamp(Date.now() - 86400000);
  event = h.emit("fetch", request("/"));
  assert.equal((await event.response).status, 503);
  await event.done();
});

test("missing, expired, invalid or future timestamps never serve saved data", async () => {
  for (const stamp of [
    undefined,
    Date.now() - 86400001,
    "invalid",
    0,
    Date.now() + 86400000,
  ]) {
    const h = harness();
    await h.install();
    if (stamp === undefined) h.stores.get(cacheName).delete(stampURL);
    else await h.stamp(stamp);
    h.scope.fetch = async () => {
      throw Error("offline");
    };
    const event = h.emit("fetch", request("/"));
    const response = await event.response;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /保存済みの画面がありません/);
    await event.done();
  }
});

test("immutable static assets use the current shell cache and fall through when absent", async () => {
  const h = harness();
  await h.install();
  h.scope.fetch = async () => new Response("network bytes");
  let event = h.emit(
    "fetch",
    request("/_next/static/build.js", { mode: "cors" }),
  );
  assert.equal(
    await (await event.response).text(),
    bodies.get("/_next/static/build.js"),
  );
  await event.done();
  h.stores.get(cacheName).delete(`${origin}/_next/static/build.js`);
  event = h.emit("fetch", request("/_next/static/build.js", { mode: "cors" }));
  assert.equal(await (await event.response).text(), "network bytes");
  await event.done();
});

test("successful online return renews a complete shell without persisting request queries", async () => {
  const h = harness();
  await h.install();
  await h.stamp(Date.now() - 86400001);
  const before = h.calls.length;
  const events = [
    h.emit("fetch", request("/?company=AM-1")),
    h.emit("fetch", request("/map/?focus=AM-1")),
  ];
  for (const event of events) await event.response;
  await Promise.all(events.map((event) => event.done()));
  // Two navigations share one complete refresh, rather than racing independent writes.
  assert.equal(h.calls.length - before, bodies.size + 2);
  assert.ok(
    Number(await h.stores.get(cacheName).get(stampURL).text()) >
      Date.now() - 1000,
  );
  assert.ok(
    [...h.stores.get(cacheName).keys()].every((key) => !key.includes("?")),
  );
});

test("a mixed deployment cannot renew or corrupt the previous complete shell", async () => {
  const h = harness();
  await h.install();
  const stale = Date.now() - 86400001;
  await h.stamp(stale);
  h.scope.fetch = async () => new Response("different release");
  const event = h.emit("fetch", request("/"));
  assert.equal((await event.response).status, 200);
  await event.done();
  assert.equal(
    Number(await h.stores.get(cacheName).get(stampURL).text()),
    stale,
  );
  assert.equal(
    await h.stores.get(cacheName).get(`${origin}/`).text(),
    bodies.get("/"),
  );
});

test("a stalled connection falls back after the navigation deadline", async () => {
  const h = harness();
  await h.install();
  h.scope.setTimeout = (callback) => setTimeout(callback, 0);
  h.scope.fetch = async (_request, { signal }) =>
    new Promise((_ok, fail) =>
      signal.addEventListener("abort", () => fail(Error("timeout"))),
    );
  const event = h.emit("fetch", request("/map/"));
  assert.equal((await event.response).status, 200);
  await event.done();
});

test("a stalled shell download aborts rather than reporting an incomplete installation as ready", async () => {
  const h = harness();
  h.scope.setTimeout = (callback) => setTimeout(callback, 0);
  h.scope.fetch = async (_request, { signal }) =>
    new Promise((_ok, fail) =>
      signal.addEventListener("abort", () => fail(Error("timeout"))),
    );
  await assert.rejects(h.install(), /timeout/);
  assert.deepEqual(await h.caches.keys(), []);
});
