// 只快取 App 外殼；Google API 一律走網路
const CACHE = 'travel-toy-v9';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/api.js', 'js/categories.js', 'js/classify.js', 'js/hours.js', 'js/ai.js', 'js/mock.js',
  'js/gateway.js', 'js/group.js', 'js/safeurl.js', 'js/vendor/qrcode.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 網路優先，離線時才用快取
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

// ---------- 群組找人：Web Push ----------
// 推播內容只有名字與 findId，不含任何權杖或金鑰
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { /* 沒有內容就用預設文字 */ }
  const title = typeof d.title === 'string' ? d.title : '旅遊玩意';
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === 'string' ? d.body : '',
    tag: typeof d.tag === 'string' ? d.tag : undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    requireInteraction: d.kind === 'ask',
    vibrate: [250, 120, 250, 120, 250],
    data: { kind: d.kind, findId: d.findId },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { kind, findId } = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open-find', kind, findId });
    } else {
      await self.clients.openWindow(`./?find=${encodeURIComponent(findId || '')}&kind=${encodeURIComponent(kind || '')}`);
    }
  })());
});
