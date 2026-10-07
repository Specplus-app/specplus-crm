// Exercises the real send-quote Edge Function handler in Node with Deno,
// Supabase and Resend mocked. No email is sent and no database is touched.
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

const emails: { to: string[]; html: string }[] = []
let resendStatus = 200
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).startsWith('https://api.resend.com/')) {
    emails.push(JSON.parse(String(init?.body)))
    return new Response(resendStatus === 200 ? '{"id":"e1"}' : 'boom', { status: resendStatus })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

await import('../supabase/functions/send-quote/index.ts')

const QUOTE_ID = '11111111-1111-4111-8111-111111111111'

type MockState = {
  users: Record<string, { id: string }>
  tables: Record<string, Record<string, unknown>[]>
  rpcCalls: { name: string; args: unknown; isAdmin: boolean }[]
  rpcResult?: { data: unknown; error: { message: string } | null }
}

function scenario(overrides: { quoteStatus?: string; isCustom?: boolean; shop?: Record<string, unknown> } = {}): MockState {
  const state: MockState = {
    users: { 'user-token': { id: 'user-a' } },
    tables: {
      profiles: [{ id: 'user-a', role: 'shop_user', shop_id: 'shop-a' }],
      quotes: [{
        id: QUOTE_ID, lead_id: 'lead-1', shop_id: 'shop-a', status: overrides.quoteStatus ?? 'draft', revision_number: 1,
        public_token: '22222222-2222-4222-8222-222222222222', grand_total: 1015, expires_at: null,
        selected_parts: [{ id: 'bumper', price: 650 }], custom_line_items: [{ id: 'l1', quantity: 2, unit_price: 75 }],
      }],
      leads: [{ id: 'lead-1', customer_name: 'Pat', customer_email: 'pat@example.test', vehicle_name: 'Truck', is_custom: overrides.isCustom ?? false }],
      shops: [{ id: 'shop-a', name: 'Shop A', contact_email: 'shop@example.test', subscription_status: 'active', trial_ends_at: null, is_lifetime_free: false, ...overrides.shop }],
    },
    rpcCalls: [],
  }
  ;(globalThis as Record<string, unknown>).__supabaseMock = state
  return state
}

async function send(): Promise<{ status: number; body: Record<string, string> }> {
  const resp = await handler!(new Request('https://fn.invalid/send-quote', {
    method: 'POST',
    headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteId: QUOTE_ID }),
  }))
  return { status: resp.status, body: await resp.json() }
}

beforeEach(() => {
  emails.length = 0
  resendStatus = 200
  env.RESEND_API_KEY = 're_test'
})

for (const isCustom of [false, true]) {
  test(`${isCustom ? 'custom' : 'preconfigured'} quote: emailed, then marked sent`, async () => {
    const state = scenario({ isCustom })
    const { status, body } = await send()
    assert.equal(status, 200)
    assert.equal(emails.length, 1)
    assert.deepEqual(emails[0].to, ['pat@example.test'])
    assert.ok(emails[0].html.includes('$1,015.00'))
    assert.deepEqual(state.rpcCalls.map((c) => [c.name, c.isAdmin]), [['mark_quote_sent', true]])
    assert.ok(body.quote_url.endsWith('/q/22222222-2222-4222-8222-222222222222'))
  })
}

test('email provider failure leaves the quote unsent', async () => {
  const state = scenario()
  resendStatus = 500
  const { status, body } = await send()
  assert.equal(status, 502)
  assert.match(body.error, /not marked as sent/)
  assert.equal(state.rpcCalls.length, 0)
})

test('marking failure after the email is reported, not hidden', async () => {
  const state = scenario()
  state.rpcResult = { data: null, error: { message: 'Only draft quotes can be sent' } }
  const { status, body } = await send()
  assert.equal(status, 500)
  assert.match(body.error, /email was sent/)
  assert.equal(emails.length, 1)
})

test('already-sent quotes are refused before any email', async () => {
  const state = scenario({ quoteStatus: 'sent' })
  const { status } = await send()
  assert.equal(status, 409)
  assert.equal(emails.length, 0)
  assert.equal(state.rpcCalls.length, 0)
})

test('read-only (expired trial) shops cannot send', async () => {
  scenario({ shop: { subscription_status: 'trial', trial_ends_at: '2020-01-01T00:00:00Z' } })
  const { status } = await send()
  assert.equal(status, 403)
  assert.equal(emails.length, 0)
})

test('missing email configuration is reported', async () => {
  scenario()
  delete env.RESEND_API_KEY
  const { status } = await send()
  assert.equal(status, 400)
  assert.equal(emails.length, 0)
})
