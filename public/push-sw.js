// SpecPlus staff notifications service worker.
//
// Push display and notification clicks ONLY. It deliberately has no fetch
// handler and stores nothing in Cache Storage, so private CRM pages and API
// responses are never cached on the device. Notification text is generic and
// arrives encrypted; tapping opens the lead, and the app asks the user to sign
// in first if their session has ended.

const FALLBACK_TITLE = 'SpecPlus'
const FALLBACK_BODY = 'You have a new notification.'
const LEAD_PATH = /^\/dashboard\/leads\/[0-9a-f-]{36}$/

// Only same-site lead links are ever opened.
function targetPath(url) {
  return typeof url === 'string' && LEAD_PATH.test(url) ? url : '/dashboard'
}

function text(value, fallback, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : fallback
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const options = {
    body: text(data.body, FALLBACK_BODY, 200),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: targetPath(data.url) },
  }
  if (typeof data.tag === 'string' && data.tag.length <= 64) options.tag = data.tag

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(text(data.title, FALLBACK_TITLE, 80), options),
      // Lets an open app refresh its notification bell.
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then((windows) => windows.forEach((w) => w.postMessage({ type: 'notification-received' }))),
    ]),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = targetPath(event.notification.data && event.notification.data.url)
  const target = new URL(path, self.location.origin).href

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin)
    if (existing) {
      await existing.focus()
      try {
        if (existing.navigate) {
          await existing.navigate(target)
          return
        }
      } catch {
        // Not controlled by this worker yet: let the page navigate itself.
      }
      existing.postMessage({ type: 'open-url', url: path })
      return
    }
    await self.clients.openWindow(target)
  })())
})
