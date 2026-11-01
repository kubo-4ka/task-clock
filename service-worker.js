/* アプリ本体をキャッシュしてオフラインでも起動できるようにする（データはlocalStorage） */
const CACHE = 'task-clock-v1.0.0-d';
const CORE = [
  './', './index.html', './css/style.css',
  './js/util.js', './js/store.js', './js/sync.js', './js/report.js', './js/notify.js', './js/app.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* ネットワーク優先・失敗時キャッシュ（更新がすぐ反映され、オフラインでも動く） */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
  );
});
/* OS通知をクリックしたらアプリのウインドウを前面に出す */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => c.url.startsWith(self.registration.scope));
    return win ? win.focus() : self.clients.openWindow('./');
  }));
});
