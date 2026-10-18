/* wishlist.mcbflow.com service worker (MB Suite v3 template).
   Network-first for the app's own files, cache as the offline fallback. Never touches your list:
   localStorage / IndexedDB aren't involved, and non-GET and cross-origin requests are left alone.
   BUMP VERSION ON EVERY RELEASE so old cached files are dropped. */
const VERSION = 'wishlist-v1.7-20261017-ui101';
const SHELL = ['./', 'index.html', 'manifest.json', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'mb-suite-topbar.css', 'mb-sync.js', 'mb-files.js', 'mb-ui.js', 'vendor/supabase.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('wishlist-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Page loads (including links shared in from the phone's share menu, ?url=…) are stored under './'
  // so the offline copy is always the plain app page, never a one-off URL with someone's link in it.
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith(
    fetch(req)
      .then(res => { if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); } return res; })
      .catch(() => caches.match(key).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
