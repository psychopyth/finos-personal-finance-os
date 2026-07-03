// ============================================================
// FinOS — Service Worker (PATCH 3: Offline PWA support)
// ============================================================
// Scope: this file must live in the SAME directory as index.html and
// manifest.json, and be registered with a RELATIVE path
// (navigator.serviceWorker.register('./service-worker.js')).
// That directory becomes both the SW's default scope AND the base URL
// that every relative path below resolves against — which is what makes
// this work unmodified on GitHub Pages project sites
// (https://user.github.io/repo/...) as well as root/custom domains,
// with zero hardcoded absolute paths anywhere in this file.
//
// Bump CACHE_VERSION on every deploy that changes any cached file.
// That's the entire "cache invalidation" trigger — see notes below.
// ============================================================

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `finos-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `finos-runtime-${CACHE_VERSION}`;
const CACHE_PREFIX = 'finos-'; // used to identify (and clean up) OUR caches only

// ===== PATCH 3 (hardening): explicit size caps + eviction so Cache Storage
// can never grow unbounded, independent of version-bump cleanup. =====
const SHELL_CACHE_MAX_ENTRIES = 30;   // shell is ~5 files today; cap guards against future growth
const RUNTIME_CACHE_MAX_ENTRIES = 40; // fonts/CDN assets
const CACHEABLE_CROSS_ORIGIN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // Cache API preserves insertion order, so the front of the list is oldest —
  // simple FIFO eviction, no extra bookkeeping needed.
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

// Core app-shell files. Kept minimal and explicit — the app itself is a
// single index.html file, so this is intentionally short.
const CORE_ASSETS = ['./', './index.html', './manifest.json'];

// ------------------------------------------------------------
// INSTALL — precache the app shell + manifest + whatever icons the
// manifest actually declares (read dynamically so this file never needs
// to hardcode icon filenames/sizes).
// ------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);

      // Cache each core file individually (not cache.addAll) so a single
      // missing file can't abort the whole install — offline startup
      // should still work with whatever DID cache successfully.
      await Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] precache skip:', url, err))
        )
      );

      // Cache manifest icons dynamically instead of hardcoding filenames.
      try {
        const manifestRes = await fetch('./manifest.json');
        if (manifestRes.ok) {
          const manifestClone = manifestRes.clone();
          await cache.put('./manifest.json', manifestRes);
          const manifest = await manifestClone.json();
          const iconUrls = (manifest.icons || []).map((i) => i.src).filter(Boolean);
          await Promise.all(
            iconUrls.map((src) =>
              cache.add(src).catch((err) => console.warn('[SW] icon precache skip:', src, err))
            )
          );
        }
      } catch (err) {
        console.warn('[SW] could not read manifest.json for icon precache:', err);
      }

      // Intentionally NOT calling self.skipWaiting() here — see "Update
      // detection" in the registration code. We want the new SW to sit in
      // the "waiting" state until the user (or the app) explicitly accepts
      // the update, so an in-progress session's in-memory `db` is never
      // yanked out from under it mid-edit.
    })()
  );
});

// ------------------------------------------------------------
// ACTIVATE — stale cache cleanup. Deletes any of OUR caches that don't
// match the current version (i.e. leftovers from a previous deploy).
// Never touches caches outside the 'finos-' prefix.
// ------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => {
            console.log('[SW] deleting stale cache:', key);
            return caches.delete(key);
          })
      );
      await self.clients.claim();
    })()
  );
});

// ------------------------------------------------------------
// MESSAGE — lets the page tell a waiting worker to take over immediately.
// Used by the "Update available -> Refresh" banner in index.html.
// ------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ------------------------------------------------------------
// FETCH — offline-first for the app shell, stale-while-revalidate for
// everything else same-origin, network-first-with-cache-fallback for
// cross-origin (e.g. the Google Fonts CSS/font files the page @imports).
// ------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept non-GET (imports/exports use Blob URLs, not fetch)

  const url = new URL(req.url);

  // Navigations (typing the URL, opening the installed app, reload while offline):
  // always serve the cached shell first so the app can start with zero network.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cachedShell = await cache.match('./index.html');
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put('./index.html', fresh.clone());
          return fresh;
        } catch (err) {
          return cachedShell || cache.match('./');
        }
      })()
    );
    return;
  }

  if (url.origin === self.location.origin) {
    // Same-origin static assets (manifest.json, icons, this app's own files):
    // cache-first, populate cache opportunistically on first successful fetch.
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) {
            await cache.put(req, fresh.clone());
            trimCache(SHELL_CACHE, SHELL_CACHE_MAX_ENTRIES); // fire-and-forget, doesn't block the response
          }
          return fresh;
        } catch (err) {
          return cached; // undefined -> browser shows its normal offline error for uncached, non-shell assets
        }
      })()
    );
    return;
  }

  // Cross-origin: ONLY cache an explicit allowlist (Google Fonts today). Anything
  // else — including any future external API — is passed straight through to the
  // network and never cached, so a dynamic/authenticated response can't accidentally
  // end up sitting in Cache Storage indefinitely.
  if (!CACHEABLE_CROSS_ORIGIN_HOSTS.includes(url.hostname)) {
    return; // no event.respondWith() = browser handles it natively, untouched
  }

  // Allowlisted cross-origin (fonts): stale-while-revalidate so the page still
  // renders fonts offline after the first successful load.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then(async (res) => {
          if (res && res.ok) {
            await cache.put(req, res.clone());
            trimCache(RUNTIME_CACHE, RUNTIME_CACHE_MAX_ENTRIES); // fire-and-forget
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
