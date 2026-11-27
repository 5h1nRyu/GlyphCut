"use strict";

const scope = new URL(self.registration.scope);
const cachePrefix = "glyph-cut-workspace:" + scope.pathname + ":";
const cacheVersion = cachePrefix + "v1.1.20-web.1";
const names = ["index.html", "style.css", "workspace.css", "geometry.js", "truetype.js",
  "web-projects.js", "workspace.js", "studio.js", "glyphcut.ico"];
const assets = names.map(name => new URL(name, scope).href);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheVersion).then(cache => cache.addAll(
    assets.map(url => new Request(url, { cache: "reload" }))
  )));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const versions = await caches.keys();
    await Promise.all(versions.filter(name => name.startsWith(cachePrefix) && name !== cacheVersion)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data === "activate") event.waitUntil(self.skipWaiting());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  const asset = event.request.mode === "navigate" && url.href === scope.href ? assets[0] : url.href;
  if (!assets.includes(asset)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheVersion);
    return await cache.match(asset) ?? fetch(event.request);
  })());
});
