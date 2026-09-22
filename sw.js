/**
 * sw.js — the service worker. This is what makes the app installable and
 * lets the app SHELL (the page itself, not your tasks) keep working with
 * no signal at all.
 *
 * Bump CACHE_VERSION every time you ship a change to any precached file
 * (index.html, styles.css, config.js, js/*.js, the manifest, or the
 * icons) — that's what makes the old cache get thrown away in `activate`
 * below, instead of the app quietly showing stale code forever.
 */
const CACHE_VERSION = "planner-v1";
const CACHE_NAME = "task-planner-" + CACHE_VERSION;

// Everything needed to draw the screen and run the app offline. Your
// actual tasks are NOT in this list — those only ever come from the live
// server, or from the offline queue in store.js while you're offline.
const SHELL_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/config.js",
  "/manifest.webmanifest",
  "/js/api.js",
  "/js/app.js",
  "/js/logic.js",
  "/js/store.js",
  "/js/ui.js",
  "/js/sheets.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
  "/icons/apple-touch-icon.png",
];

// Requests to the backend must NEVER be touched by this service worker —
// caching or intercepting them could show stale tasks, or break the
// device-key auth check. Let the browser handle these completely normally.
function isBackendRequest(url) {
  return url.hostname === "script.google.com" || url.hostname === "script.googleusercontent.com";
}

self.addEventListener("install", (event) => {
  self.skipWaiting(); // don't wait for old tabs to close before using new code
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()) // start controlling already-open tabs right away
  );
});

// Strategy: network-first for the page itself and for anything that
// changes on deploy (the JS files and CSS) — so a code push shows up on
// the very next load, but the last good copy still works with no signal.
// Cache-first for icons, since those never change without also changing
// their filename.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return; // never intercept writes
  if (isBackendRequest(url)) return; // pass Apps Script calls straight through

  const isIcon = url.pathname.startsWith("/icons/");
  const isNavigation = event.request.mode === "navigate";
  const isShellAsset =
    isNavigation || url.pathname === "/styles.css" || url.pathname === "/config.js" || url.pathname.startsWith("/js/");

  if (isIcon) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    return;
  }

  if (isShellAsset) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only remember good responses — caching a 404 would make an
          // error page "stick" even after it was fixed on the server.
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
    );
  }
});
