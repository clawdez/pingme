const CACHE = 'pingme-v1';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request)).catch(() => caches.match('/index.html'))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(data.title || '🏓 PingMe', {
    body: data.body || 'Someone wants to play ping pong!',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'pingme-match',
    renotify: true,
    vibrate: [200, 100, 200]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
