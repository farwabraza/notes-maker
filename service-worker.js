/* Ward service worker — offline after first load.
   Cache-first for the app shell; network-first-with-fallback for fonts. */
const CACHE = "ward-v6";
const SHELL = [
  "./",
  "./index.html",
  "./engine.js",
  "./md.js",
  "./app.js",
  "./samples.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // add individually so one 404 (e.g. missing icon) doesn't abort install
      Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))
    )
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // don't cache /api/enrich POSTs
  const url = new URL(req.url);

  // Google Fonts: cache after first fetch so they work offline.
  if (/fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((hit) =>
          hit ||
          fetch(req).then((res) => { c.put(req, res.clone()); return res; }).catch(() => hit)
        )
      )
    );
    return;
  }

  // App shell + samples: cache-first, fall back to network, then cache.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
