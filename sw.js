'use strict';
const CACHE_NAME='novela-v1';
const PRECACHE=[
  './',
  './index.html',
  './css/main.css',
  './css/reader.css',
  './js/i18n.js','./js/db.js','./js/settings.js','./js/scraper.js','./js/utils.js',
  './js/plugins.js','./js/tts.js','./js/translation.js','./js/backup.js','./js/epub.js',
  './js/reader.js','./js/manga.js','./js/library.js','./js/catalog.js','./js/search.js',
  './js/extensions.js','./js/migration.js','./js/minigames.js','./js/app.js',
];
self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(PRECACHE))
      .then(()=>self.skipWaiting())
  );
});
self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(
    caches.match(event.request).then(cached=>{
      if(cached)return cached;
      return fetch(event.request).then(resp=>{
        if(resp&&resp.ok){
          const clone=resp.clone();
          caches.open(CACHE_NAME).then(c=>c.put(event.request,clone));
        }
        return resp;
      }).catch(()=>caches.match('./index.html'));
    })
  );
});
