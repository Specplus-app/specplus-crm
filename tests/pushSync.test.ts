// Page-load/login device sync (src/lib/pushSync.ts) against a fake browser
// and a fake server that follows the database contract (register creates,
// touch only refreshes, delete removes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { syncThisDevice, type DeviceStatus, type LocalSubscription } from '../src/lib/pushSync.ts'

function world() {
  const server = new Map<string, string>() // endpoint -> owner
  const calls: string[] = []
  let browserSub: { endpoint: string } | null = null
  let counter = 0

  const api = {
    register: (user: string, endpoint: string) => { calls.push('register'); server.set(endpoint, user) },
    touch: async (user: string, endpoint: string): Promise<DeviceStatus> => {
      calls.push('touch')
      const owner = server.get(endpoint)
      return owner === undefined ? 'missing' : owner === user ? 'active' : 'other_user'
    },
    removeRemotely: (endpoint: string) => { server.delete(endpoint) },
  }
  const browser = {
    // "Enable notifications": the only path that registers.
    enable: (user: string) => {
      browserSub ??= { endpoint: `https://fcm.googleapis.com/fcm/send/device-${++counter}` }
      api.register(user, browserSub.endpoint)
      return browserSub.endpoint
    },
    subscription: () => browserSub,
  }
  // What AppShell runs on every load / login.
  const pageLoad = (user: string, usesCurrentKey = true) => syncThisDevice({
    getSubscription: async (): Promise<LocalSubscription | null> => browserSub && {
      endpoint: browserSub.endpoint, p256dh: 'k', auth: 'a', usesCurrentKey,
      unsubscribe: async () => { browserSub = null; return true },
    },
    touch: (endpoint) => api.touch(user, endpoint),
  })
  return { server, calls, api, browser, pageLoad }
}

test('removal from another device survives reload and login until Enable is tapped again', async () => {
  const w = world()
  const endpoint = w.browser.enable('pat')
  assert.equal(await w.pageLoad('pat'), 'active')

  w.api.removeRemotely(endpoint) // "Remove" on the laptop
  assert.equal(await w.pageLoad('pat'), 'removed', 'reload')
  assert.equal(w.server.has(endpoint), false)
  assert.equal(w.browser.subscription(), null, 'the phone drops its own subscription and shows Off')
  assert.equal(await w.pageLoad('pat'), 'none', 'login later')
  assert.equal(w.server.size, 0, 'still removed')
  assert.ok(!w.calls.slice(1).includes('register'), 'sync never registers')

  w.browser.enable('pat') // explicit re-enable
  assert.equal(w.server.size, 1)
  assert.equal(await w.pageLoad('pat'), 'active')
})

test('a browser now owned by another account is dropped, not taken over', async () => {
  const w = world()
  const endpoint = w.browser.enable('sam')
  assert.equal(await w.pageLoad('pat'), 'removed')
  assert.equal(w.server.get(endpoint), 'sam', 'the other account\'s registration is untouched server-side')
  assert.equal(w.browser.subscription(), null)
})

test('subscriptions made with rotated keys are left for an explicit Enable', async () => {
  const w = world()
  w.browser.enable('pat')
  assert.equal(await w.pageLoad('pat', false), 'stale_key')
  assert.deepEqual(w.calls, ['register'], 'no server call for a stale subscription')
})

test('only the explicit Enable path can register a device', () => {
  const src = readFileSync(new URL('../src/lib/notifications.ts', import.meta.url), 'utf8')
  assert.equal(src.match(/register_push_subscription/g)?.length, 1)
  const saves = src.match(/saveSubscription\(/g)?.length
  assert.equal(saves, 2, 'defined once, called once')
  const enable = src.slice(src.indexOf('export async function enablePushOnThisDevice'), src.indexOf('export async function disablePushOnThisDevice'))
  assert.ok(enable.includes('await saveSubscription(sub)'), 'that one call is in enablePushOnThisDevice')
  const sync = src.slice(src.indexOf('export async function syncPushSubscription'), src.indexOf('export async function loadDevices'))
  assert.ok(sync.includes('touch_push_subscription') && !sync.includes('saveSubscription'))
})
