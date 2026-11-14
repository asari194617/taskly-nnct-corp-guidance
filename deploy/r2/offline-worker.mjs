// This exact function is emitted into the static service worker and measured by
// the dedicated Node coverage suite. It handles public build assets only.
export function startOfflineWorker(scope, manifest) {
  const prefix = 'taskly-guidance-shell-v1-';
  const cacheName = prefix + manifest.revision;
  const stampURL = new URL('/.offline-shell-stamp', scope.location.origin).href;
  const ttl = 24 * 60 * 60 * 1000;
  const assets = new Map(manifest.assets.map(asset => [asset.path, asset.sha256]));
  const routes = new Map(manifest.routes);
  let refreshing;

  async function digest(response) {
    const hash = await scope.crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function populate() {
    const responses = await Promise.all([...assets].map(async ([path, hash]) => {
      const controller = new AbortController();
      const timeout = scope.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await scope.fetch(new URL(path, scope.location.origin).href, {
          credentials: 'omit', cache: 'reload', redirect: 'error', signal: controller.signal,
        });
        if (!response.ok || response.type === 'opaque' || await digest(response) !== hash)
          throw new Error('Public offline shell did not match this build');
        return [path, response];
      } finally { scope.clearTimeout(timeout); }
    }));
    const cache = await scope.caches.open(cacheName);
    for (const [path, response] of responses)
      await cache.put(new URL(path, scope.location.origin).href, response);
    await cache.put(stampURL, new Response(String(Date.now())));
  }

  async function age(cache) {
    const stamp = await cache.match(stampURL);
    const savedAt = stamp ? Number(await stamp.text()) : NaN;
    return savedAt > 0 && savedAt <= Date.now() ? Date.now() - savedAt : Infinity;
  }

  async function cached(path) {
    const cache = await scope.caches.open(cacheName);
    if (await age(cache) >= ttl) return undefined;
    return cache.match(new URL(path, scope.location.origin).href);
  }

  async function refresh() {
    const cache = await scope.caches.open(cacheName);
    if (await age(cache) < 60 * 60 * 1000) return;
    if (!refreshing) refreshing = populate().finally(() => { refreshing = undefined; });
    await refreshing;
  }

  scope.addEventListener('install', event => {
    event.waitUntil(populate().catch(async error => {
      await scope.caches.delete(cacheName);
      throw error;
    }));
    // A newer build waits for existing clients to close, preserving their chunks.
  });
  scope.addEventListener('activate', event => {
    event.waitUntil((async () => {
      for (const name of await scope.caches.keys())
        if (name.startsWith(prefix) && name !== cacheName) await scope.caches.delete(name);
      await scope.clients.claim();
    })());
  });
  scope.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== scope.location.origin ||
        request.headers.has('authorization') || request.headers.has('range')) return;
    const route = request.mode === 'navigate' ? routes.get(url.pathname) : undefined;
    if (!route && (url.search || !assets.has(url.pathname))) return;
    if (route) {
      // Only an allowlisted public HTML path is stored. Queries remain in the
      // address bar for the UI, but are never used as persistent cache keys.
      let online = false;
      const responsePromise = (async () => {
        const controller = new AbortController();
        const timeout = scope.setTimeout(() => controller.abort(), 4000);
        try {
          const response = await scope.fetch(request, { signal: controller.signal });
          if (response.status < 500) {
            online = response.ok;
            return response;
          }
          const fallback = await cached(route);
          return fallback || response;
        } catch {
          return await cached(route) || new Response(
            '<!doctype html><html lang="ja"><meta charset="utf-8"><title>オフライン</title><p>保存済みの画面がありません。通信できる場所で開き直してください。</p></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
          );
        } finally { scope.clearTimeout(timeout); }
      })();
      event.respondWith(responsePromise);
      event.waitUntil(responsePromise.then(() => online ? refresh() : undefined).catch(() => {}));
    } else {
      event.respondWith((async () => await cached(url.pathname) || scope.fetch(request))());
    }
  });
}
