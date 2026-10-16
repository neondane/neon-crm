/* Neon CRM app service worker (scope /app/).
   - Keeps the app shell (page, icons, manifest) so it opens fast and works offline.
   - NEVER caches data: Supabase, /api/*, neon-api and Access requests always go to the network.
   - Push handlers are ready for Phase 4 (nothing subscribes yet). */
const SHELL = 'ncrm-shell-v7';
const SHELL_FILES = ['/app/', '/app/manifest.webmanifest', '/app/icons/icon-192.png?v=2', '/app/icons/icon-512.png?v=2', '/app/icons/apple-touch-icon.png?v=2', '/app/icons/favicon-64.png?v=2'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(SHELL_FILES.map((u) => fetch(u, { credentials: 'same-origin' }).then((r) => { if (r.ok && r.type === 'basic') return c.put(u, r); }).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('ncrm-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return; // data + login: straight to network
  if (req.mode === 'navigate') {
    // Network first so updates show up right away; the cached shell only when offline.
    e.respondWith(fetch(req).then((r) => { if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(SHELL).then((c) => c.put('/app/', copy)); } return r; }).catch(() => caches.match('/app/')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Neon CRM', body: e.data ? e.data.text() : '' }; }
  const url = d.url || '/app/#inbox';
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Neon CRM', {
      body: d.body || '', icon: '/app/icons/icon-192.png?v=2', badge: '/app/icons/badge-96.png',
      tag: d.tag || undefined, renotify: !!d.tag, data: { url }, timestamp: Date.now(),
    });
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach((c) => c.postMessage({ type: 'push', category: d.category || '', url }));
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app/#inbox', self.location.origin).href;
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if (c.url.includes('/app/')) { await c.focus(); try { await c.navigate(url); } catch (_) { c.postMessage({ type: 'open', url }); } return; } }
    await self.clients.openWindow(url);
  })());
});
