const CACHE = 'delta-sg-v4-mobile-viewport';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './engine.js', './data/roads.json', './data/local-roads.json.gz', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('delta-sg-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    // Cache the plain JSON fallback too if this browser lacks gzip decompression.
    if (response.ok && new URL(event.request.url).pathname.endsWith('/data/local-roads.json')) await cache.put(event.request, response.clone());
    return response;
  }));
});
