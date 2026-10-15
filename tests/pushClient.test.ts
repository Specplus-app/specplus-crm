// Staff push client logic (src/lib/pushSupport.ts) and the push-only service
// worker (public/push-sw.js), run in a sandbox with a fake worker global.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  base64UrlToUint8Array, detectPushSupport, deviceLabel, isIOSDevice, safeReturnPath, uint8ArrayToBase64Url,
  type PushEnvironment,
} from '../src/lib/pushSupport.ts'

const LEAD = '0b7e4b9e-1c51-4c39-9b25-6b0f0c7a1d11'
const desktop: PushEnvironment = {
  isSecureContext: true, hasServiceWorker: true, hasPushManager: true, hasNotification: true,
  permission: 'default', isIOS: false, isStandalone: false, vapidKeyConfigured: true,
}

test('support status covers permission, configuration and iPhone Home Screen installs', () => {
  assert.deepEqual(detectPushSupport(desktop), { state: 'ready' })
  assert.deepEqual(detectPushSupport({ ...desktop, permission: 'granted' }), { state: 'granted' })
  assert.deepEqual(detectPushSupport({ ...desktop, permission: 'denied' }), { state: 'blocked' })
  assert.equal(detectPushSupport({ ...desktop, vapidKeyConfigured: false }).state, 'unsupported')
  assert.equal(detectPushSupport({ ...desktop, isSecureContext: false }).state, 'unsupported')
  assert.equal(detectPushSupport({ ...desktop, hasPushManager: false }).state, 'unsupported')

  // iPhone Safari tab: PushManager is missing until installed to the Home Screen.
  const iphoneTab = { ...desktop, isIOS: true, hasPushManager: false, hasNotification: false }
  assert.deepEqual(detectPushSupport(iphoneTab), { state: 'ios-install' })
  assert.deepEqual(detectPushSupport({ ...iphoneTab, isStandalone: true, hasPushManager: true, hasNotification: true }), { state: 'ready' })
  const oldIOS = detectPushSupport({ ...iphoneTab, isStandalone: true })
  assert.equal(oldIOS.state, 'unsupported')
  assert.match((oldIOS as { reason: string }).reason, /iOS 16\.4/)
})

test('iPhones and iPads (including iPadOS desktop mode) are recognised', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
  const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
  assert.equal(isIOSDevice(iphone, 'iPhone', 5), true)
  assert.equal(isIOSDevice(ipadDesktop, 'MacIntel', 5), true)
  assert.equal(isIOSDevice(ipadDesktop, 'MacIntel', 0), false, 'a real Mac')
  assert.equal(isIOSDevice(android, 'Linux armv8l', 5), false)
  assert.equal(deviceLabel(iphone), 'iPhone · Safari')
  assert.equal(deviceLabel(android), 'Android · Chrome')
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'), 'Windows · Edge')
})

test('VAPID key conversion round-trips', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65))
  assert.deepEqual(base64UrlToUint8Array(uint8ArrayToBase64Url(bytes)), bytes)
})

test('after sign-in, only same-site paths in the user\'s own area are resumed', () => {
  assert.equal(safeReturnPath(`/dashboard/leads/${LEAD}`, 'shop_user'), `/dashboard/leads/${LEAD}`)
  assert.equal(safeReturnPath('/dashboard', 'shop_user'), '/dashboard')
  assert.equal(safeReturnPath('/dashboard/schedule?view=week', 'shop_user'), '/dashboard/schedule?view=week')
  assert.equal(safeReturnPath('/admin/shops/1', 'admin'), '/admin/shops/1')
  for (const bad of ['//evil.example.com/dashboard', 'https://evil.example.com/dashboard', '/\\evil.example.com', '/admin', '/dashboardevil', '/q/abc', null, 42]) {
    assert.equal(safeReturnPath(bad, 'shop_user'), null, String(bad))
  }
  assert.equal(safeReturnPath('/dashboard/leads/x', 'admin'), null)
})

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------

function loadWorker(windows: { url: string; navigateFails?: boolean }[] = []) {
  const listeners: Record<string, (e: any) => void> = {}
  const shown: { title: string; options: any }[] = []
  const opened: string[] = []
  const navigated: string[] = []
  const posted: any[] = []
  const deletedCaches: string[] = []
  const clientList = windows.map((w) => ({
    url: w.url,
    focus: async () => {},
    navigate: async (u: string) => { if (w.navigateFails) throw new TypeError('not controlled'); navigated.push(u) },
    postMessage: (m: any) => posted.push(JSON.parse(JSON.stringify(m))),
  }))
  const self: any = {
    location: { origin: 'https://crm.example.test' },
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn },
    skipWaiting: () => {},
    // JSON round-trip: objects built inside the sandbox belong to another realm.
    registration: { showNotification: async (title: string, options: any) => { shown.push({ title, options: JSON.parse(JSON.stringify(options)) }) } },
    clients: {
      claim: async () => {},
      matchAll: async () => clientList,
      openWindow: async (u: string) => { opened.push(u) },
    },
  }
  const caches = { keys: async () => ['specplus-shell-v1'], delete: async (k: string) => { deletedCaches.push(k); return true } }
  vm.runInNewContext(readFileSync(new URL('../public/push-sw.js', import.meta.url), 'utf8'), { self, caches, URL })
  const fire = async (type: string, event: any) => {
    let pending: Promise<unknown> = Promise.resolve()
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p } })
    await pending
  }
  return { listeners, shown, opened, navigated, posted, deletedCaches, fire }
}

const pushEvent = (payload: unknown) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } })

test('the worker never intercepts requests and clears old caches', async () => {
  const w = loadWorker()
  assert.ok(!('fetch' in w.listeners), 'no fetch handler: nothing private is cached or served offline')
  assert.deepEqual(Object.keys(w.listeners).sort(), ['activate', 'install', 'notificationclick', 'push'])
  await w.fire('activate', {})
  assert.deepEqual(w.deletedCaches, ['specplus-shell-v1'])
})

test('push shows the generic notification and keeps a safe lead link', async () => {
  const w = loadWorker()
  await w.fire('push', pushEvent({ title: 'New request', body: 'A customer submitted a new request.', url: `/dashboard/leads/${LEAD}`, tag: 'event-1' }))
  assert.equal(w.shown[0].title, 'New request')
  assert.equal(w.shown[0].options.body, 'A customer submitted a new request.')
  assert.equal(w.shown[0].options.tag, 'event-1', 'the same event replaces rather than stacks')
  assert.deepEqual(w.shown[0].options.data, { url: `/dashboard/leads/${LEAD}` })

  for (const url of ['https://evil.example.com/phish', '//evil.example.com', '/q/secret-token', 'javascript:alert(1)', `/dashboard/leads/${LEAD}/../../admin`]) {
    await w.fire('push', pushEvent({ title: 'x', url }))
    assert.deepEqual(w.shown.at(-1)!.options.data, { url: '/dashboard' }, url)
  }
  await w.fire('push', { data: { json: () => { throw new SyntaxError('bad') } } })
  assert.deepEqual([w.shown.at(-1)!.title, w.shown.at(-1)!.options.body], ['SpecPlus', 'You have a new notification.'])
})

test('tapping a notification opens the lead in a new or existing window', async () => {
  const notification = { close() {}, data: { url: `/dashboard/leads/${LEAD}` } }
  const fresh = loadWorker()
  await fresh.fire('notificationclick', { notification })
  assert.deepEqual(fresh.opened, [`https://crm.example.test/dashboard/leads/${LEAD}`])

  const running = loadWorker([{ url: 'https://crm.example.test/dashboard/schedule' }])
  await running.fire('notificationclick', { notification })
  assert.deepEqual([running.navigated, running.opened], [[`https://crm.example.test/dashboard/leads/${LEAD}`], []])

  const uncontrolled = loadWorker([{ url: 'https://crm.example.test/login', navigateFails: true }])
  await uncontrolled.fire('notificationclick', { notification })
  assert.deepEqual(uncontrolled.posted, [{ type: 'open-url', url: `/dashboard/leads/${LEAD}` }])

  const other = loadWorker([{ url: 'https://other.example.test/' }])
  await other.fire('notificationclick', { notification: { close() {}, data: { url: 'https://evil.example.com' } } })
  assert.deepEqual(other.opened, ['https://crm.example.test/dashboard'])
})
