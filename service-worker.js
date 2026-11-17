/* PanBill PWA service worker.
   Deliberately does not cache API calls, authentication, wallet, Paystack,
   Supabase, VTU purchases, marketplace checkout, or transaction requests. */
const CACHE_NAME = 'panbill-app-shell-v1';
const APP_SHELL = ['/', '/manifest.json', '/icons/panbill-192.png', '/icons/panbill-512.png', '/icons/panbill-512-maskable.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of APP_SHELL) {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) await cache.put(path, response);
      } catch (_) {
        // Installation can still complete if a non-critical shell asset is unavailable.
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('panbill-app-shell-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // App navigation: always try the live site first, then use the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const live = await fetch(request);
        if (live && live.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/', live.clone());
        }
        return live;
      } catch (_) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Only cache the explicit static app-shell files listed above.
  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const live = await fetch(request);
      if (live && live.ok) await cache.put(url.pathname, live.clone());
      return live;
    })());
  }
});
