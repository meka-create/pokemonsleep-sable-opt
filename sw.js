const CACHE_NAME = 'legendary-sable-opt-v7-update-delivery';
const APP_SHELL = [
  './',
  './index.html',
  './app.js?v=20260929a',
  './solver-worker.js?v=20260929a',
  './manifest.webmanifest?v=20260929a',
  './ogp-card.png',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];
const NETWORK_FIRST_PATHS = new Set([
  './index.html',
  './app.js',
  './solver-worker.js',
  './manifest.webmanifest'
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // HTTPキャッシュを経由せず、公開中の最新版をアプリ用Cacheへ保存する。
    await Promise.all(APP_SHELL.map(async (url) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response || !response.ok) throw new Error(`Precache failed: ${url}`);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const networkFirst = async (request, fallback) => {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.status === 200 && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) || (fallback ? await caches.match(fallback) : undefined);
  }
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  const relativePath = `./${url.pathname.split('/').pop()}`;
  if (NETWORK_FIRST_PATHS.has(relativePath)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request, { cache: 'no-store' }).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
