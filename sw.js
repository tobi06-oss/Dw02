// 앱 화면 파일을 캐시해 두고, 온라인이면 항상 최신 파일을 먼저 가져옵니다.
const CACHE = "desk-v4";
const SHELL = ["./", "index.html", "engine.js", "firebase-config.js", "manifest.webmanifest", "icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

// 밤 9시 주문 알림 (GitHub Actions → Firebase Cloud Messaging). 받은 내용을 그대로 알림으로 띄웁니다.
self.addEventListener("push", (e) => {
  let m = {};
  try { const j = e.data ? e.data.json() : {}; m = j.data || j.notification || j; } catch (_) {}
  e.waitUntil(self.registration.showNotification(m.title || "주문 데스크", {
    body: m.body || "", tag: m.tag || "order-reminder", renotify: true, icon: "icon-192.png", badge: "icon-192.png"
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
