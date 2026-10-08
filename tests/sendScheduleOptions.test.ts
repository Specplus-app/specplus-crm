// Exercises the real send-schedule-options Edge Function handler in Node with
// Deno, Supabase and Resend mocked. No email is sent and no database is
// touched; database enforcement is covered separately in scheduling.db.test.ts.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

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
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  RESEND_API_KEY: 're_test',
}
;(globalThis as Record<string, unknown>).Deno = {
  env: { get: (k: string) => env[k] },
  serve: (h: Handler) => { handler = h },
}

const emails: { to: string[]; subject: string; html: string }[] = []
let resendStatus = 200
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).startsWith('https://api.resend.com/')) {
    emails.push(JSON.parse(String(init?.body)))
    return new Response(resendStatus === 200 ? '{"id":"e1"}' : 'boom', { status: resendStatus })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

await import('../supabase/functions/send-schedule-options/index.ts')

const OFFER_ID = '33333333-3333-4333-8333-333333333333'
const TOKEN = '44444444-4444-4444-8444-444444444444'

type MockState = {
  users: Record<string, { id: string }>
  tables: Record<string, Record<string, unknown>[]>
  rpcCalls: { name: string; args: unknown; isAdmin: boolean }[]
  rpcResult?: { data: unknown; error: { message: string } | null }
}

function scenario(overrides: {
  offerStatus?: string; quoteStatus?: string; shop?: Record<string, unknown>; note?: string | null; shopId?: string
} = {}): MockState {
  const state: MockState = {
    users: { 'user-token': { id: 'user-a' } },
    tables: {
      profiles: [{ id: 'user-a', role: 'shop_user', shop_id: 'shop-a' }],
      schedule_offers: [{
        id: OFFER_ID, lead_id: 'lead-1', shop_id: overrides.shopId ?? 'shop-a', quote_id: 'quote-1',
        status: overrides.offerStatus ?? 'draft', customer_note: overrides.note === undefined ? 'Mornings <b>only</b>' : overrides.note,
        is_reschedule: false,
      }],
      schedule_offer_options: [
        { offer_id: OFFER_ID, start_date: '2026-11-09' },
        { offer_id: OFFER_ID, start_date: '2026-11-02' },
      ],
      leads: [{ id: 'lead-1', customer_name: 'Pat', customer_email: 'pat@example.test', vehicle_name: 'Truck' }],
      shops: [{ id: 'shop-a', name: 'Shop A', contact_email: 'shop@example.test', subscription_status: 'active', trial_ends_at: null, is_lifetime_free: false, ...overrides.shop }],
      quotes: [{ id: 'quote-1', status: overrides.quoteStatus ?? 'approved', public_token: TOKEN, superseded_at: null }],
    },
    rpcCalls: [],
    rpcResult: { data: { version: 7 }, error: null },
  }
  ;(globalThis as Record<string, unknown>).__supabaseMock = state
  return state
}

async function send(): Promise<{ status: number; body: Record<string, string> }> {
  const resp = await handler!(new Request('https://fn.invalid/send-schedule-options', {
    method: 'POST',
    headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ offerId: OFFER_ID }),
  }))
  return { status: resp.status, body: await resp.json() }
}

beforeEach(() => {
  emails.length = 0
  resendStatus = 200
  env.RESEND_API_KEY = 're_test'
})

test('emails the existing quote review link with the dates, then activates the options', async () => {
  const state = scenario()
  const { status, body } = await send()
  assert.equal(status, 200)
  assert.equal(emails.length, 1)
  assert.deepEqual(emails[0].to, ['pat@example.test'])
  assert.ok(emails[0].html.includes(`/q/${TOKEN}`), 'links to the project quote review page')
  // Calendar dates, sorted, never shifted by a timezone.
  const nov2 = emails[0].html.indexOf('November 2, 2026')
  const nov9 = emails[0].html.indexOf('November 9, 2026')
  assert.ok(nov2 > 0 && nov9 > nov2)
  assert.ok(emails[0].html.includes('Mornings &lt;b&gt;only&lt;/b&gt;'), 'customer note is escaped')
  assert.deepEqual(state.rpcCalls.map((c) => [c.name, c.isAdmin]), [['mark_schedule_offer_sent', true]])
  assert.equal(body.quote_url, `https://quotes.specplus.app/q/${TOKEN}`)
})

test('email failure leaves the options unsent', async () => {
  const state = scenario()
  resendStatus = 500
  const { status, body } = await send()
  assert.equal(status, 502)
  assert.match(body.error, /not sent/)
  assert.equal(state.rpcCalls.length, 0)
})

test('activation failure after the email is reported, never as success', async () => {
  const state = scenario()
  state.rpcResult = { data: null, error: { message: 'The quote changed. Offer new dates for the current approved quote.' } }
  const { status, body } = await send()
  assert.equal(status, 500)
  assert.match(body.error, /email was sent.*quote changed/)
})

test('already sent or replaced options are refused before any email', async () => {
  for (const offerStatus of ['active', 'superseded', 'invalidated']) {
    const state = scenario({ offerStatus })
    assert.equal((await send()).status, 409)
    assert.equal(state.rpcCalls.length, 0)
  }
  assert.equal(emails.length, 0)
})

test('options for an unapproved or revised quote are refused', async () => {
  scenario({ quoteStatus: 'sent' })
  assert.equal((await send()).status, 409)
  assert.equal(emails.length, 0)
})

test('another shop and read-only shops cannot send', async () => {
  scenario({ shopId: 'shop-b' })
  assert.equal((await send()).status, 404)
  scenario({ shop: { subscription_status: 'cancelled' } })
  assert.equal((await send()).status, 403)
  assert.equal(emails.length, 0)
})

test('missing email configuration is reported', async () => {
  scenario()
  delete env.RESEND_API_KEY
  assert.equal((await send()).status, 400)
  assert.equal(emails.length, 0)
})
