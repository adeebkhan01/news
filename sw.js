'use strict';
// Minimal offline support: the app shell (markup, styles, script, the sql.js
// runtime) is cache-first so a repeat visit opens instantly even offline,
// and each region's database is stale-while-revalidate so a visitor with no
// connection still gets the last successful fetch rather than a blank page,
// while an online visitor still gets the newest data on every load.
//
// Deliberately no explicit precache list: app.css and app.js are requested
// with a content-hash ?v= query string that changes on every deploy (see
// tests/frontend.test.js), so a hardcoded list here would drift out of sync
// with index.html the moment either file changes. Everything is cached on
// first use instead, keyed by its full request URL, hash included.
var CACHE_NAME = 'daily-digest-v1';
var DB_RE = /\/data-(bd|au|global)\.sqlite(\?|$)/;

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (DB_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

function cacheFirst(req) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
    });
  });
}

function staleWhileRevalidate(req) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    });
  });
}
