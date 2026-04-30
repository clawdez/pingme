const CACHE = 'pingme-v13';
const ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

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
  // Skip external requests
  if (e.request.url.includes('supabase.co') || e.request.url.includes('googleapis.com') || e.request.url.includes('gstatic.com') || e.request.url.includes('unpkg.com') || e.request.url.includes('jsdelivr.net')) {
    return;
  }
  // Network-first: always try fresh, fall back to cache
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  const options = {
    body: data.body || 'Someone wants to play ping pong!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'pingme-match',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: '/' },
    // Keep notification alive even when app is closed
    requireInteraction: false,
    actions: [
      { action: 'open', title: 'Open' }
    ]
  };
  e.waitUntil(self.registration.showNotification(data.title || 'pingme', options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Focus existing window or open new one
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If a pingme window is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow('/');
    })
  );
});
