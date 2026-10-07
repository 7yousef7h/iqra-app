// Service Worker — makes the app installable and work offline
const CACHE = 'kurras-v21';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// ---- Push notifications (FCM web push) ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { notification: { title: 'كرّاس', body: e.data && e.data.text() } }; }
  const n = d.notification || (d.data && d.data.notification) || {};
  const title = n.title || (d.data && d.data.title) || 'كرّاس';
  const body = n.body || (d.data && d.data.body) || '';
  const link = (d.fcmOptions && d.fcmOptions.link) || (d.data && d.data.link) || './';
  e.waitUntil(self.registration.showNotification(title, { body, icon: './icon-192.png', badge: './icon-192.png', dir: 'rtl', lang: 'ar', data: { link }, vibrate: [200, 100, 200] }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.link) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate && c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
