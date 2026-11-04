// Regen Design Requests — offline shell cache (data always comes live from the server)
const CACHE = 'regen-design-jobs-v9';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './regen-logo.png', './badge-96.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // only remove this app's old caches, never other apps on the same github.io site
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith('regen-design-jobs-') && k !== CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch API calls
  // network first so updates show immediately; cache when offline
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

// ---------- phone notifications (sent by the server through Firebase Cloud Messaging) ----------
self.addEventListener('push', e => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = j.data || j.notification || j; }
  catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Design Requests';
  const opts = {
    body: d.body || '', icon: 'icon-192.png', badge: 'badge-96.png',
    data: { url: d.url || './' }, vibrate: [120, 60, 120],
    tag: d.tag || undefined, renotify: !!d.tag, requireInteraction: d.prio === '5'
  };
  e.waitUntil((async () => {
    (await self.clients.matchAll({ type: 'window' })).forEach(c => c.postMessage({ type: 'refresh' }));
    await self.registration.showNotification(title, opts);
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge((await self.registration.getNotifications()).length); } catch (err) {}
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(c => c.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); win.postMessage({ type: 'open', url }); }
    else await self.clients.openWindow(url);
    try { if (self.navigator.setAppBadge) await self.navigator.setAppBadge((await self.registration.getNotifications()).length); } catch (err) {}
  })());
});
