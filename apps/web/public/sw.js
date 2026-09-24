// Service worker mínimo: permite instalar la PWA y abrir la app sin red.
// Los datos nunca se cachean aquí: la API siempre valida acceso.
const SHELL = 'tiecoms-shell-v2';
const ROOT = new URL(self.registration.scope).pathname; // '/app/' en la web, '/' en apps
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll([ROOT]))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(ROOT, copy)); return r; }).catch(() => caches.match(ROOT)));
    return;
  }
  if (url.pathname.startsWith(ROOT + 'assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; })));
  }
});
