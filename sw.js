// 앱 화면 파일을 캐시해 두고, 온라인이면 항상 최신 파일을 먼저 가져옵니다.
// cache:"no-cache"로 브라우저 HTTP 캐시(GitHub Pages 10분)도 건너뛰고 서버에 확인한다. 배포 직후 새 index.html과
// 예전 engine.js가 섞여 화면이 멈추는 일을 막는다 (2026-10-30). 오프라인일 때만 저장해 둔 파일을 쓴다.
// 같은 github.io 주소의 다른 앱 캐시는 건드리지 않도록 이 앱 것(desk-)만 정리한다
const CACHE = "desk-v6";
const SHELL = ["./", "index.html", "engine.js", "firebase-config.js", "manifest.webmanifest", "icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("desk-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

