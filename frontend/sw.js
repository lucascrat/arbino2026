const CACHE = 'arbinomo-v2';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/vnc.html', '/manifest.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

// Rede primeiro (dashboard local — rede e sempre rapida): garante que
// atualizacoes do frontend cheguem sem limpar cache manualmente.
// O cache so serve como fallback offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && e.request.url.startsWith(self.location.origin)) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => { c.put(e.request, clone); });
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
