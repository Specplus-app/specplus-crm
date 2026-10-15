// Exercises the real notification-dispatch Edge Function handler in Node with
// Deno, Supabase, Resend and push services mocked. Push payloads are really
// encrypted and decrypted by an independent receiver. Nothing is sent.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { newReceiver, newVapid } from './helpers/pushReceiver.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('npm:@supabase/supabase-js')) {
      return { url: new URL('./helpers/supabaseMock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

type Handler = (req: Request) => Promise<Response>
let handler: Handler | null = null
const SECRET = 's'.repeat(48)
const vapid = newVapid()
let env: Record<string, string | undefined> = {}
const baseEnv = () => ({
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  RESEND_API_KEY: 're_test',
  NOTIFICATION_DISPATCH_SECRET: SECRET,
  CRM_ORIGIN: 'https://crm.example.test/',
  PUBLIC_QUOTE_ORIGIN: 'https://quotes.example.test',
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: vapid.subject,
})
;(globalThis as Record<string, unknown>).Deno = {
  env: { get: (k: string) => env[k] },
  serve: (h: Handler) => { handler = h },
}

type Sent = { url: string; headers: Record<string, string>; body: any; at: number; hadSignal: boolean }
let emails: Sent[] = []
let pushes: (Sent & { raw: Uint8Array })[] = []
// A status, a network error, a provider that never answers ('stall': only the
// caller's abort signal ends it), or a slow success ({ delayMs }).
type Behaviour = number | 'network' | 'stall' | { delayMs: number }
let resendResponses: Behaviour[] = []
let pushResponses: Behaviour[] = []
let inFlight = 0
let maxInFlight = 0

async function respond(behaviour: Behaviour, signal: AbortSignal | undefined, ok: () => Response): Promise<Response> {
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  try {
    if (behaviour === 'network') throw new TypeError('fetch failed')
    if (behaviour === 'stall' || typeof behaviour === 'object') {
      await new Promise<void>((resolve, reject) => {
        const timer = typeof behaviour === 'object' ? setTimeout(resolve, behaviour.delayMs) : null
        signal?.addEventListener('abort', () => { if (timer) clearTimeout(timer); reject(signal.reason) })
      })
      return ok()
    }
    return behaviour === 200 || behaviour === 201 ? ok() : new Response('provider error', { status: behaviour })
  } finally {
    inFlight--
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
  const base = { url, headers, at: Date.now(), hadSignal: init?.signal instanceof AbortSignal }
  if (url === 'https://api.resend.com/emails') {
    emails.push({ ...base, body: JSON.parse(String(init?.body)) })
    const n = emails.length
    return respond(resendResponses.shift() ?? 200, init?.signal ?? undefined, () => new Response(JSON.stringify({ id: `re_${n}` }), { status: 200 }))
  }
  pushes.push({ ...base, body: null, raw: new Uint8Array(init?.body as ArrayBuffer) })
  return respond(pushResponses.shift() ?? 201, init?.signal ?? undefined, () => new Response(null, { status: 201 }))
}) as typeof fetch

await import('../supabase/functions/notification-dispatch/index.ts')

const LEAD = '0b7e4b9e-1c51-4c39-9b25-6b0f0c7a1d11'
const TOKEN = '5d1c1c1e-8f7a-4e0a-9d3b-2f6e8f9b0a22'
const EVENT = '9a0d7c1e-2b3c-4d5e-8f90-a1b2c3d4e5f6'

type Completion = { p_delivery_id: string; p_lease_token: string; p_outcome: string; p_error: string | null; p_provider_message_id: string | null }
let completions: Completion[] = []
let state: any

function queue(...batches: Record<string, unknown>[][]) {
  completions = []
  state = {
    users: {},
    tables: {},
    rpcCalls: [],
    rpcHandlers: {
      recover_notification_events: () => ({ data: { recovered: 0, failed: 0 }, error: null }),
      claim_notification_deliveries: () => ({ data: batches.shift() ?? [], error: null }),
      complete_notification_delivery: (args: Completion) => {
        completions.push(args)
        return { data: { ok: true }, error: null }
      },
    },
  }
  ;(globalThis as Record<string, unknown>).__supabaseMock = state
}

let n = 0
const lease = () => ({ delivery_id: `d-${++n}`, lease_token: `l-${n}`, attempt: 1 })
const shopEmail = (kind: 'new_request' | 'customer_message', extra: Record<string, unknown> = {}) => ({
  ...lease(), channel: 'email', recipient_type: 'shop', kind, to: 'owner@shop.example.test', shop_name: 'Ridge Fab',
  lead_id: LEAD, lead_path: `/dashboard/leads/${LEAD}`, customer_name: 'Pat <script>alert(1)</script>',
  customer_email: 'pat@customer.example.test', vehicle_name: '2021 Bronco', is_custom: kind === 'new_request', ...extra,
})
const customerEmail = (extra: Record<string, unknown> = {}) => ({
  ...lease(), channel: 'email', recipient_type: 'customer', kind: 'shop_reply', to: 'pat@customer.example.test',
  shop_name: 'Ridge Fab', shop_email: 'owner@shop.example.test', customer_name: 'Pat', vehicle_name: '2021 Bronco',
  quote_path: `/q/${TOKEN}`, ...extra,
})
const pushRow = (receiver: ReturnType<typeof newReceiver>, extra: Record<string, unknown> = {}) => ({
  ...lease(), channel: 'push', recipient_type: 'staff', kind: 'new_request',
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', ...receiver.keys, subscription_id: 'sub-1',
  notification: { title: 'New request', body: 'A customer submitted a new request.', url: `/dashboard/leads/${LEAD}`, tag: EVENT },
  ...extra,
})

const dispatch = async (headers: Record<string, string> = { 'x-notification-secret': SECRET }, method = 'POST') => {
  const res = await handler!(new Request('https://fn.example.invalid/notification-dispatch', { method, headers }))
  return { status: res.status, body: await res.json() }
}
const outcomes = () => completions.map((c) => [c.p_delivery_id, c.p_outcome])

beforeEach(() => {
  env = baseEnv()
  emails = []
  pushes = []
  resendResponses = []
  pushResponses = []
  inFlight = 0
  maxInFlight = 0
  queue()
})

test('only the scheduler holding the secret can run the dispatcher', async () => {
  queue([shopEmail('new_request')])
  assert.equal((await dispatch({}, 'GET')).status, 405)
  assert.equal((await dispatch({})).status, 401)
  assert.equal((await dispatch({ 'x-notification-secret': 'wrong' })).status, 401)
  assert.equal((await dispatch({ 'x-notification-secret': SECRET.slice(0, -1) })).status, 401)
  assert.equal((await dispatch({ Authorization: `Bearer ${SECRET}` })).status, 401)
  env.NOTIFICATION_DISPATCH_SECRET = undefined
  assert.equal((await dispatch()).status, 503)
  env.NOTIFICATION_DISPATCH_SECRET = 'short'
  assert.equal((await dispatch({ 'x-notification-secret': 'short' })).status, 503, 'weak secrets are refused')
  assert.equal(state.rpcCalls.length, 0, 'nothing was claimed')
  assert.equal(emails.length + pushes.length, 0)
})

test('new request email goes to the shop with a CRM lead link', async () => {
  const row = shopEmail('new_request')
  queue([row])
  const res = await dispatch()
  assert.deepEqual(res, { status: 200, body: { recovered: 0, claimed: 1, sent: 1, retry: 0, failed: 0, gone: 0, released: 0, lease_lost: 0 } })
  const [mail] = emails
  assert.deepEqual(mail.body.to, ['owner@shop.example.test'])
  assert.equal(mail.body.reply_to, 'pat@customer.example.test')
  assert.match(mail.body.subject, /^New custom build request from Pat <script>alert\(1\)<\/script> – 2021 Bronco$/)
  assert.ok(mail.body.html.includes(`https://crm.example.test/dashboard/leads/${LEAD}`))
  assert.ok(mail.body.text.includes(`https://crm.example.test/dashboard/leads/${LEAD}`))
  assert.ok(!mail.body.html.includes('<script>'), 'customer input is escaped')
  assert.equal(mail.headers['Idempotency-Key'], `notification-${row.delivery_id}`)
  assert.deepEqual(completions, [{ p_delivery_id: row.delivery_id, p_lease_token: row.lease_token, p_outcome: 'sent', p_error: null, p_provider_message_id: 're_1' }])
})

test('preconfigured request and customer message emails also go to the shop', async () => {
  const pre = shopEmail('new_request', { is_custom: false })
  const msg = shopEmail('customer_message')
  queue([pre, msg])
  await dispatch()
  assert.match(emails[0].body.subject, /^New build request from /)
  assert.match(emails[1].body.subject, /^New message from Pat .* about their 2021 Bronco quote$/)
  assert.equal(emails[1].body.reply_to, undefined, 'replies to messages stay in the CRM')
  assert.ok(emails[1].body.html.includes(`https://crm.example.test/dashboard/leads/${LEAD}`))
  assert.deepEqual(outcomes(), [[pre.delivery_id, 'sent'], [msg.delivery_id, 'sent']])
})

test("shop reply email goes to the customer with their quote link, never the CRM", async () => {
  const row = customerEmail()
  queue([row])
  await dispatch()
  const [mail] = emails
  assert.deepEqual(mail.body.to, ['pat@customer.example.test'])
  assert.equal(mail.body.from, 'Ridge Fab via SpecPlus <quotes@specplus.app>')
  assert.equal(mail.body.reply_to, 'owner@shop.example.test')
  assert.equal(mail.body.subject, 'Ridge Fab replied about your 2021 Bronco quote')
  assert.ok(mail.body.html.includes(`https://quotes.example.test/q/${TOKEN}`))
  assert.ok(!mail.body.html.includes('/dashboard/'), 'customers never get CRM links')
  assert.deepEqual(outcomes(), [[row.delivery_id, 'sent']])
})

test('email failures are classified for retry or permanent failure', async () => {
  const rows = [shopEmail('new_request'), shopEmail('new_request'), shopEmail('new_request'), shopEmail('new_request')]
  resendResponses = [503, 429, 422, 'network']
  queue(rows)
  const res = await dispatch()
  assert.deepEqual(outcomes().map(([, o]) => o), ['retry', 'retry', 'failed', 'retry'])
  assert.match(completions[0].p_error!, /Resend HTTP 503/)
  assert.match(completions[3].p_error!, /^network:/)
  assert.deepEqual([res.body.retry, res.body.failed], [3, 1])

  env.RESEND_API_KEY = undefined
  const later = shopEmail('customer_message')
  queue([later])
  await dispatch()
  assert.deepEqual(completions.map((c) => [c.p_outcome, c.p_error]), [['retry', 'email_not_configured']])
})

test('payloads with unexpected links are never emailed', async () => {
  const bad = [
    shopEmail('new_request', { lead_path: 'https://evil.example.test/phish' }),
    customerEmail({ quote_path: '/dashboard/leads/x' }),
    customerEmail({ to: 'not-an-email' }),
  ]
  queue(bad)
  await dispatch()
  assert.equal(emails.length, 0)
  assert.deepEqual(outcomes().map(([, o]) => o), ['failed', 'failed', 'failed'])
})

test('push is encrypted for the device, generic, and opens the lead', async () => {
  const device = newReceiver()
  const row = pushRow(device)
  queue([row])
  const res = await dispatch()
  assert.equal(res.body.sent, 1)
  const [push] = pushes
  assert.equal(push.url, 'https://fcm.googleapis.com/fcm/send/device-1')
  assert.equal(push.headers['Content-Encoding'], 'aes128gcm')
  assert.equal(push.headers.Topic, EVENT.replace(/-/g, ''))
  assert.equal(push.headers.TTL, '43200')
  assert.match(push.headers.Authorization, new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey}$`))
  assert.ok(!Buffer.from(push.raw).toString('latin1').includes('New request'), 'the push service sees ciphertext only')
  assert.deepEqual(JSON.parse(device.decrypt(push.raw)), {
    title: 'New request', body: 'A customer submitted a new request.', url: `/dashboard/leads/${LEAD}`, tag: EVENT,
  })
  assert.deepEqual(outcomes(), [[row.delivery_id, 'sent']])
})

test('expired, failing and misconfigured push deliveries are recorded correctly', async () => {
  const device = newReceiver()
  const rows = [pushRow(device), pushRow(device), pushRow(device), pushRow(device), pushRow(device, { endpoint: 'https://evil.example.test/hook' })]
  pushResponses = [410, 404, 500, 403]
  queue(rows)
  await dispatch()
  assert.deepEqual(outcomes().map(([, o]) => o), ['gone', 'gone', 'retry', 'failed', 'failed'])
  assert.equal(pushes.length, 4, 'disallowed endpoints are never contacted')
  assert.equal(completions[4].p_error, 'endpoint_not_allowed')

  env.VAPID_PRIVATE_KEY = undefined
  queue([pushRow(device)])
  await dispatch()
  assert.deepEqual(completions.map((c) => [c.p_outcome, c.p_error]), [['retry', 'push_not_configured']])
})

test('drains several batches, and a lost lease or completion error does not stop the run', async () => {
  const first = Array.from({ length: 25 }, () => shopEmail('new_request'))
  const second = [shopEmail('customer_message'), customerEmail()]
  queue(first, second)
  let calls = 0
  state.rpcHandlers.complete_notification_delivery = (args: Completion) => {
    completions.push(args)
    calls++
    if (calls === 1) return { data: null, error: { message: 'connection reset' } }
    if (calls === 2) return { data: { ok: false, error: 'lease_lost' }, error: null }
    return { data: { ok: true }, error: null }
  }
  const res = await dispatch()
  assert.equal(res.body.claimed, 27)
  assert.equal(emails.length, 27)
  assert.deepEqual([res.body.sent, res.body.lease_lost], [25, 1])
  assert.equal(state.rpcCalls.filter((c: any) => c.name === 'claim_notification_deliveries').length, 2)
  assert.ok(state.rpcCalls.every((c: any) => c.isAdmin), 'all database calls use the server-side client')
})

// ---------------------------------------------------------------------------
// Recovery, stalled providers and slow batches
// ---------------------------------------------------------------------------

test('every run first recovers lost events, and a recovery error does not block sending', async () => {
  queue([shopEmail('new_request')])
  state.rpcHandlers.recover_notification_events = () => ({ data: { recovered: 3, failed: 0 }, error: null })
  const res = await dispatch()
  assert.equal(res.body.recovered, 3)
  assert.deepEqual(state.rpcCalls.slice(0, 2).map((c: any) => c.name), ['recover_notification_events', 'claim_notification_deliveries'])
  assert.equal(state.rpcCalls[0].args.p_limit, 100, 'bounded per run')

  queue([shopEmail('new_request')])
  state.rpcHandlers.recover_notification_events = () => ({ data: null, error: { message: 'statement timeout' } })
  const degraded = await dispatch()
  assert.deepEqual([degraded.status, degraded.body.recovered, degraded.body.sent], [200, 0, 1])
})

test('stalled providers are abandoned at the request timeout; nothing is left in flight', async () => {
  env.NOTIFICATION_REQUEST_TIMEOUT_MS = '60'
  const device = newReceiver()
  const rows = [shopEmail('new_request'), pushRow(device)]
  resendResponses = ['stall']
  pushResponses = ['stall']
  queue(rows)
  const t0 = Date.now()
  const res = await dispatch()
  assert.ok(Date.now() - t0 < 2000, `run ended promptly (${Date.now() - t0}ms)`)
  assert.equal(inFlight, 0, 'no provider request outlives the run')
  assert.ok([...emails, ...pushes].every((r) => r.hadSignal), 'every provider request is bounded')
  assert.deepEqual(completions.map((c) => [c.p_outcome, c.p_error]), [['retry', 'timeout after 60ms'], ['retry', 'timeout after 60ms']])
  assert.equal(res.body.retry, 2)
})

test('slow providers: the budget is checked before every delivery and the rest are released unsent', async () => {
  env.NOTIFICATION_REQUEST_TIMEOUT_MS = '200'
  env.NOTIFICATION_RUN_BUDGET_MS = '500'
  const rows = Array.from({ length: 10 }, () => shopEmail('new_request'))
  resendResponses = rows.map(() => ({ delayMs: 120 }))
  queue(rows, [shopEmail('customer_message')])
  const t0 = Date.now()
  const res = await dispatch()
  const elapsed = Date.now() - t0

  const sent = res.body.sent
  assert.ok(sent >= 2 && sent <= 3, `sent ${sent} before the budget ran out`)
  assert.equal(emails.length, sent, 'released deliveries were never sent')
  assert.equal(res.body.released, rows.length - sent)
  assert.deepEqual(completions.slice(sent).map((c) => c.p_outcome), Array(rows.length - sent).fill('release'))
  // A request only starts if it can finish (timeout) inside the budget.
  for (const e of emails) assert.ok(e.at - t0 <= 500 - 200 + 30, `started at ${e.at - t0}ms`)
  assert.ok(elapsed <= 500 + 150, `run finished within budget (${elapsed}ms)`)
  assert.equal(maxInFlight, 1, 'one provider request at a time')
  assert.equal(inFlight, 0)
  assert.equal(state.rpcCalls.filter((c: any) => c.name === 'claim_notification_deliveries').length, 1, 'no new batch once out of time')
})

test('when every provider stalls, the run still ends within budget + one timeout', async () => {
  env.NOTIFICATION_REQUEST_TIMEOUT_MS = '50'
  env.NOTIFICATION_RUN_BUDGET_MS = '200'
  const rows = Array.from({ length: 10 }, () => shopEmail('new_request'))
  resendResponses = rows.map(() => 'stall' as const)
  queue(rows)
  const t0 = Date.now()
  const res = await dispatch()
  assert.ok(Date.now() - t0 <= 200 + 50 + 150, `${Date.now() - t0}ms`)
  assert.equal(res.body.retry + res.body.released, 10)
  assert.ok(res.body.released > 0)
  assert.equal(inFlight, 0)
})
