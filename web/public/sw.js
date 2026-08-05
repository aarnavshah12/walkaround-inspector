/* Offline shell for Walkaround Inspector.
 * Recording works offline; API traffic is never cached — uploads queue at the
 * app layer (IndexedDB) and resume when connectivity returns. */
const CACHE = "wi-shell-v2";
const SHELL = ["/", "/record", "/upload"];

// Precache the shell pages AND the static assets they reference — a page
// whose HTML is cached but whose JS chunks aren't would render inert on
// first offline use, which is exactly when the recording page matters.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const assets = new Set();
        await Promise.all(
          SHELL.map(async (path) => {
            try {
              const res = await fetch(path);
              if (!res.ok) return;
              const text = await res.clone().text();
              await cache.put(path, res);
              for (const m of text.matchAll(/\/_next\/static\/[a-zA-Z0-9_\-./]+|\/icons\/[a-zA-Z0-9_\-.]+/g)) {
                assets.add(m[0]);
              }
            } catch {
              /* offline install — runtime caching fills in later */
            }
          })
        );
        await Promise.all(
          [...assets].map(async (url) => {
            try {
              const res = await fetch(url);
              if (res.ok) await cache.put(url, res);
            } catch {}
          })
        );
      } finally {
        await self.skipWaiting();
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // network only, never cached

  // Navigations: network first, offline shell fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("/"))
        )
    );
    return;
  }

  // Hashed static assets: cache first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
      )
    );
  }
});
