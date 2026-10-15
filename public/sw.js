// Retired. An earlier version of this worker cached the app shell, which could
// leave returning visitors on a stale build. Browsers that still have it
// installed fetch this replacement on their next update check: it deletes
// those caches and unregisters itself. Staff notifications use /push-sw.js,
// which caches nothing.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
    await self.registration.unregister()
  })())
})
