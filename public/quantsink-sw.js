/* eslint-disable no-restricted-globals */
/**
 * Quantsink Zero-Load Service Worker
 * ----------------------------------
 *
 * Responsibilities:
 *   1. Pre-cache the shell assets required to open the app without a
 *      network round-trip.
 *   2. Expose an internal "feed cache" that the page thread can populate
 *      with pre-rendered feed payloads via `postMessage`.
 *   3. Intercept feed fetches and serve cached payloads instantly,
 *      falling back to the network when the cache is cold or stale.
 *   4. Forward background-fetched payloads back to all connected clients
 *      so the UI can re-hydrate without a full reload.
 *
 * Communication contract (page → sw):
 *   { type: "QS_STORE_FEED", userId, payload }         // persist feed
 *   { type: "QS_CLEAR_FEED", userId }                  // invalidate
 *   { type: "QS_LIST_FEEDS" }                          // list keys
 *
 * Communication contract (sw → page, via clients.postMessage):
 *   { type: "QS_FEED_READY", userId, payload }         // after an update
 *   { type: "QS_FEED_MISS",  userId }                  // cold cache
 */

const SW_VERSION = 'quantsink-sw-v1';
const SHELL_CACHE = `${SW_VERSION}-shell`;
const FEED_CACHE = `${SW_VERSION}-feed`;
const SHELL_ASSETS = ['/'];
const FEED_ROUTE_PREFIX = '/api/feed/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        await cache.addAll(SHELL_ASSETS);
      } catch (err) {
        // Non-fatal — individual shell fetches may fail offline-first builds.
        console.warn('[quantsink-sw] shell prefetch failed', err);
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('quantsink-sw-') && !k.startsWith(SW_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function feedCacheKey(userId) {
  return new Request(`${FEED_ROUTE_PREFIX}${encodeURIComponent(userId)}`);
}

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(message);
  }
}

async function storeFeed(userId, payload) {
  const cache = await caches.open(FEED_CACHE);
  const body = JSON.stringify(payload);
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Quantsink-Cached': 'pre-render',
      'X-Quantsink-Generated-At': payload?.generatedAt ?? '',
    },
  });
  await cache.put(feedCacheKey(userId), response);
  await broadcastToClients({
    type: 'QS_FEED_READY',
    userId,
    payload,
  });
}

async function clearFeed(userId) {
  const cache = await caches.open(FEED_CACHE);
  await cache.delete(feedCacheKey(userId));
}

async function listFeeds() {
  const cache = await caches.open(FEED_CACHE);
  const requests = await cache.keys();
  return requests.map((req) => req.url);
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  switch (data.type) {
    case 'QS_STORE_FEED':
      if (typeof data.userId === 'string' && data.payload) {
        event.waitUntil(storeFeed(data.userId, data.payload));
      }
      break;
    case 'QS_CLEAR_FEED':
      if (typeof data.userId === 'string') {
        event.waitUntil(clearFeed(data.userId));
      }
      break;
    case 'QS_LIST_FEEDS':
      event.waitUntil(
        (async () => {
          const urls = await listFeeds();
          event.source?.postMessage({ type: 'QS_FEED_LIST', urls });
        })(),
      );
      break;
    default:
      break;
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Feed route — cache-first with background refresh.
  if (url.pathname.startsWith(FEED_ROUTE_PREFIX)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FEED_CACHE);
        const cached = await cache.match(req);
        if (cached) {
          event.waitUntil(
            (async () => {
              try {
                const fresh = await fetch(req);
                if (fresh.ok) {
                  await cache.put(req, fresh.clone());
                  const payload = await fresh.json();
                  const userId = decodeURIComponent(
                    url.pathname.slice(FEED_ROUTE_PREFIX.length),
                  );
                  await broadcastToClients({
                    type: 'QS_FEED_READY',
                    userId,
                    payload,
                  });
                }
              } catch (err) {
                // Silently ignore — cache already served.
              }
            })(),
          );
          return cached;
        }
        // Cold cache — attempt network and emit miss to clients.
        try {
          const network = await fetch(req);
          if (network.ok) {
            await cache.put(req, network.clone());
          }
          return network;
        } catch (err) {
          return new Response(
            JSON.stringify({ error: 'offline-cold-feed-miss' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }
      })(),
    );
    return;
  }

  // Shell fallback — serve cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch (err) {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match('/');
          return cached ?? new Response('Offline', { status: 503 });
        }
      })(),
    );
  }
});
