// Service worker: guarda la app en el teléfono para que abra sin conexión.
const CACHE = "mis-costos-v1";
const ASSETS = [
  "./", "index.html", "manifest.webmanifest", "css/styles.css",
  "js/app.js", "js/db.js", "js/ocr.js", "js/scanner.js", "js/products.js", "js/stats.js",
  "vendor/anthropic.js", "vendor/barcode-detector.js", "vendor/zxing_reader.wasm", "vendor/chart.umd.js",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Archivos propios: primero la red (para recibir actualizaciones), si no hay conexión, la copia guardada.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
