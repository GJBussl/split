/* Split service worker.
   - The app opens instantly from the copy saved on the phone – no waiting for a weak signal.
   - Each release has its own VERSION (node tools/release.js X.Y.Z bumps it here, in app.js and in
     index.html). The phone notices the changed sw.js, saves the complete new version in one go and
     takes it over at once; the page already open keeps running the old files (they're all loaded at
     start), and the new version is used from the next time Split is opened – never a mix of both.
   - Server calls (script.google.com) are never touched. */
var VERSION = '4.1.0';
var CACHE = 'split-' + VERSION;
var SHELL = ['./', 'index.html', 'styles.css?v=' + VERSION, 'core.js?v=' + VERSION, 'app.js?v=' + VERSION];
var EXTRAS = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];   // nice to have

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    var reload = function (u) { return new Request(u, { cache: 'reload' }); };   // bypass the HTTP cache
    return c.addAll(SHELL.map(reload)).then(function () {
      return Promise.all(EXTRAS.map(function (u) { return c.add(reload(u)).catch(function () { /* a missing icon mustn't break offline use */ }); }));
    });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  var key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res.ok && (req.mode === 'navigate' || url.search.indexOf('v=') >= 0)) cache.put(key, res.clone());
        return res;
      });
    });
  }));
});
