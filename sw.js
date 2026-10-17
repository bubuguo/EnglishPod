/* EnglishPod PWA service worker.
 *
 * - App shell: cache-first with network fallback.
 * - Media (audio / txt from archive.org): cache-first with Range
 *   request support. Every cache entry is tracked in IndexedDB with its
 *   size and last-accessed timestamp. When the total media cache exceeds
 *   QUOTA bytes, the least-recently-accessed entries are evicted first.
 */
const VERSION = 'v2';
const SHELL_CACHE = `epod-shell-${VERSION}`;
const MEDIA_CACHE = `epod-media-${VERSION}`;
const DB_NAME = 'epod-cache-db';
const DB_STORE = 'entries';
const QUOTA = 500 * 1024 * 1024; // 500 MB
const MEDIA_PREFIX = 'https://archive.org/download/englishpod_all/';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lessons.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

let nowPlayingUrl = null; // protected from eviction while in use

/* ---------------- IndexedDB helpers ---------------- */

let dbPromise = null; // opened once, reused for the SW's lifetime

function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: 'url' });
        }
      };
      req.onerror = () => {
        dbPromise = null; // transient open failure — allow retry on next call
        reject(req.error);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Drop the memo if the connection is closed under us
        // (versionchange from another client, storage pressure).
        db.onclose = () => {
          dbPromise = null;
        };
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
    });
  }
  return dbPromise;
}

function idbRequest(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const result = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(result.result);
    tx.onerror = () => reject(tx.error);
  });
}

const idbPut = (entry) => idb().then((db) => idbRequest(db, 'readwrite', (s) => s.put(entry)));
const idbGet = (url) => idb().then((db) => idbRequest(db, 'readonly', (s) => s.get(url)));
const idbAll = () => idb().then((db) => idbRequest(db, 'readonly', (s) => s.getAll()));
const idbDelete = (url) => idb().then((db) => idbRequest(db, 'readwrite', (s) => s.delete(url)));
const idbClear = () => idb().then((db) => idbRequest(db, 'readwrite', (s) => s.clear()));

/* ---------------- Media cache with LRU eviction ---------------- */

// Refresh an entry's last-accessed timestamp. Called when the page reports
// 30 s of continuous playback for a URL — fetching alone does not count as
// "accessing", so briefly-opened lessons stay evictable.
async function touchAccessed(url) {
  try {
    const entry = await idbGet(url);
    if (entry) {
      entry.ts = Date.now();
      await idbPut(entry);
    }
  } catch (err) {
    // Non-fatal: eviction metadata only.
  }
}

async function enforceQuota() {
  const entries = await idbAll();
  let total = entries.reduce((sum, e) => sum + (e.size || 0), 0);
  if (total <= QUOTA) return { total, count: entries.length };
  // Least-recently-accessed first; never evict the file currently playing.
  entries.sort((a, b) => a.ts - b.ts);
  const cache = await caches.open(MEDIA_CACHE);
  for (const entry of entries) {
    if (total <= QUOTA) break;
    if (entry.url === nowPlayingUrl) continue;
    await cache.delete(entry.url);
    await idbDelete(entry.url);
    total -= entry.size || 0;
  }
  const remaining = await idbAll();
  return { total: remaining.reduce((s, e) => s + (e.size || 0), 0), count: remaining.length };
}

async function putInCache(url, response) {
  const cache = await caches.open(MEDIA_CACHE);
  let size = Number(response.headers.get('content-length')) || 0;
  if (!size) {
    try {
      size = (await response.clone().blob()).size;
    } catch (err) {
      size = 0;
    }
  }
  await cache.put(new Request(url, { method: 'GET' }), response);
  await idbPut({ url, size, ts: Date.now() });
  return enforceQuota();
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  let start = m[1] === '' ? NaN : Number(m[1]);
  let end = m[2] === '' ? NaN : Number(m[2]);
  if (Number.isNaN(start)) {
    if (Number.isNaN(end)) return null;
    start = Math.max(0, size - end); // suffix range: bytes=-N
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

let playingBuffer = null; // { url, buf } — avoid re-reading the whole file per range request

async function sliceResponse(response, rangeHeader, url) {
  let buf;
  if (playingBuffer && playingBuffer.url === url) {
    buf = playingBuffer.buf;
  } else {
    buf = await response.arrayBuffer();
    playingBuffer = { url, buf };
  }
  const size = buf.byteLength;
  const range = parseRange(rangeHeader, size);
  const headers = {
    'Content-Type': response.headers.get('content-type') || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  if (!range) {
    headers['Content-Length'] = String(size);
    return new Response(buf, { status: 200, headers });
  }
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  headers['Content-Length'] = String(range.end - range.start + 1);
  return new Response(buf.slice(range.start, range.end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
}

async function handleMedia(request) {
  const url = request.url;
  const rangeHeader = request.headers.get('range');
  const cache = await caches.open(MEDIA_CACHE);
  let cached = await cache.match(new Request(url, { method: 'GET' }));

  if (!cached) {
    try {
      // Fetch the full resource (no Range header) so it can be cached whole.
      const full = await fetch(url, { mode: 'cors' });
      if (full.ok && (full.type === 'cors' || full.type === 'basic')) {
        await putInCache(url, full.clone());
        broadcastStats(); // keep the page's cache-usage display current
      }
      if (rangeHeader && full.status === 200) return sliceResponse(full.clone(), rangeHeader, url);
      return full;
    } catch (err) {
      // Offline and not cached: fail cleanly instead of an opaque network error.
      return new Response('media unavailable: ' + err, {
        status: 504,
        statusText: 'Offline',
      });
    }
  }

  if (rangeHeader) return sliceResponse(cached.clone(), rangeHeader, url);
  return cached;
}

/* ---------------- Install / activate ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---------------- Fetch ---------------- */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.url.startsWith(MEDIA_PREFIX)) {
    event.respondWith(handleMedia(request));
    return;
  }

  if (new URL(request.url).origin === self.location.origin) {
    // Stale-while-revalidate: serve the cached copy immediately (works
    // offline) and refresh it in the background so app updates appear
    // on the next reload without a VERSION bump.
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetched = fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached); // offline: keep serving the cached copy
        return cached || fetched;
      })
    );
  }
});

/* ---------------- Messages from the page ---------------- */

function replyTo(event, data) {
  if (!event.ports || !event.ports[0]) return;
  event.ports[0].postMessage(data);
}

async function cacheStats() {
  const entries = await idbAll();
  return {
    type: 'stats',
    total: entries.reduce((sum, e) => sum + (e.size || 0), 0),
    count: entries.length,
    quota: QUOTA,
  };
}

// Push fresh stats to every open client after a cache mutation
// (new file cached or LRU eviction), so the UI stays current.
async function broadcastStats() {
  try {
    const stats = await cacheStats();
    const clients = await self.clients.matchAll();
    for (const client of clients) client.postMessage(stats);
  } catch (err) {
    // Non-fatal: display-only.
  }
}

async function clearMediaCache() {
  playingBuffer = null; // drop the in-memory slice buffer too
  const cache = await caches.open(MEDIA_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.map((req) => cache.delete(req)));
  await idbClear();
  const stats = await cacheStats();
  return { type: 'cleared', ...stats };
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case 'stats':
      cacheStats().then((stats) => replyTo(event, stats));
      break;
    case 'clear':
      clearMediaCache().then((res) => replyTo(event, res));
      break;
    case 'nowPlaying':
      nowPlayingUrl = msg.url || null;
      replyTo(event, { type: 'nowPlaying', url: nowPlayingUrl });
      break;
    case 'touch':
      // Page confirmed 30 s of playback for this URL — refresh its LRU ts.
      touchAccessed(msg.url);
      replyTo(event, { type: 'touched', url: msg.url || null });
      break;
    default:
      break;
  }
});

