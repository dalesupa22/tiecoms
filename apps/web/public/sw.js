// Service worker mínimo: permite instalar la PWA y abrir la app sin red.
// Los datos nunca se cachean aquí: la API siempre valida acceso.
const SHELL = 'tiecoms-shell-v3';
// Lo compartido desde otras apps (Web Share Target con archivos) espera aquí hasta que la pantalla /share lo lee.
const SHARE = 'tiecoms-share';
const ROOT = new URL(self.registration.scope).pathname; // '/app/' en la web, '/' en apps
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll([ROOT]))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== SHARE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname === ROOT + 'share') { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(ROOT, copy)); return r; }).catch(() => caches.match(ROOT)));
    return;
  }
  if (url.pathname.startsWith(ROOT + 'assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; })));
  }
});

/** Guarda texto y archivos compartidos y abre /share?shared=<id>. Solo vive en este dispositivo y se borra al leerlo. */
async function receiveShare(request) {
  const id = String(Date.now());
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE);
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0).slice(0, 10);
    const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: [] };
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = `${ROOT}__share/${id}/${i}`;
      await cache.put(key, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name || `archivo-${i + 1}`) } }));
      meta.files.push(key);
    }
    await cache.put(`${ROOT}__share/${id}/meta`, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  } catch (e) { /* si el navegador no entrega nada, /share muestra el estado vacío */ }
  return Response.redirect(`${ROOT}share?shared=${id}`, 303);
}
