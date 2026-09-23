// Service worker: make the app shell open instantly, and degrade honestly when
// the laptop serving it is asleep.
//
// The shell (html/css/js/icons) is cached and served cache-first, so launching
// from the home screen never waits on the network. API responses are NOT cached
// as a rule - stale balances are worse than no balances - but the last good
// response for each endpoint is kept as a fallback so an unreachable server
// shows your previous figures with a warning rather than a blank page.

const SHELL = "spendtrack-shell-v9";
const DATA = "spendtrack-data-v1";
const SHELL_FILES = [
  "/",
  "/static/app.js",
  "/static/style.css",
  "/static/manifest.json",
  "/static/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      // one missing file must not abort the whole install
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    // network-first: correctness beats speed for money
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(e.request, { cacheName: DATA });
          if (cached) {
            // mark it so the page can say the figures are stale
            const body = await cached.text();
            return new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/json", "X-Spendtrack-Stale": "1" },
            });
          }
          return new Response(
            JSON.stringify({ detail: "spendtrack is not reachable - is the laptop awake?" }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        })
    );
    return;
  }

  // Stale-while-revalidate. Cache-first would be faster to launch but the cache
  // never expires, so a changed app.js or style.css would be invisible on this
  // device forever - which is exactly what happened with the sort controls.
  // Serve the cached copy now, fetch a fresh one in the background, and the
  // next launch picks it up.
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(e.request);
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
