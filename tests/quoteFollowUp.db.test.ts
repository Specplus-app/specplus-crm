// Quote follow-ups (send_quote_follow_up): permissions, eligibility, the
// 24-hour cooldown, duplicate protection and exactly one customer alert per
// follow-up, run against the real migrations in an isolated in-memory PGlite
// database (see tests/helpers/pgliteDb.mjs). No hosted database, email or
// network access is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore -- plain JS helper
import { createDb, as, one } from './helpers/pgliteDb.mjs'

let db: any
const ids: Record<string, string> = {}

const anon = { role: 'anon' }
const service = { role: 'service_role' }
const staff = (key: string) => ({ role: 'authenticated', id: ids[key] })
const rand = () => Math.random().toString(36).slice(2, 10)

function isoDay(offset: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

before(async () => {
  db = await createDb()
  const shop = async (name: string, status: string) =>
    (await one(db, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, $4, '2020-01-01T00:00:00Z', false) RETURNING id`, [name, `${name.toLowerCase()}@shops.example.test`, name.toLowerCase(), status])).id
  ids.shopA = await shop('ShopA', 'active')
  ids.shopB = await shop('ShopB', 'active')
  ids.shopR = await shop('ShopR', 'cancelled') // read-only
  const user = async (key: string, role: string | null, shopId: string | null) => {
    const u = await one(db, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${key}@example.test`])
    if (role) {
      await db.query(`INSERT INTO profiles (id, email, full_name, role, shop_id) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, shop_id = EXCLUDED.shop_id`, [u.id, `${key}@example.test`, key, role, shopId])
    } else {
      await db.query(`DELETE FROM profiles WHERE id = $1`, [u.id])
    }
    ids[key] = u.id
  }
  await user('a1', 'shop_user', ids.shopA)
  await user('a2', 'shop_user', ids.shopA)
  await user('b1', 'shop_user', ids.shopB)
  await user('r1', 'shop_user', ids.shopR)
  await user('admin', 'admin', null)
  await user('noprofile', null, null)
})

// ---------------------------------------------------------------------------
// Fixtures (mirror what the app does through PostgREST)
// ---------------------------------------------------------------------------

async function newLead(shopKey: string, email = `${rand()}@customers.example.test`): Promise<string> {
  const marker = rand()
  await as(db, anon, async (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom, notes)
    VALUES ($1, 'Jordan Customer', $2, 'veh', 'Bronco', 'local', $3, 650, 0, 650, 5, 'new', false, $4)`,
    [ids[shopKey], email, JSON.stringify([{ id: 'p', name: 'Bumper', type: 'new', price: 650 }]), marker]))
  return (await one(db, `SELECT id FROM leads WHERE notes = $1`, [marker])).id
}

async function draftQuote(leadId: string, userKey: string, opts: { supersedes?: string | null; expires?: string | null } = {}) {
  return as(db, staff(userKey), async (tx: any) => one(tx, `INSERT INTO quotes (lead_id, supersedes_quote_id, selected_parts, shipping_total, expires_at)
    VALUES ($1, $2, $3, 0, $4) RETURNING *`,
    [leadId, opts.supersedes ?? null, JSON.stringify([{ id: 'p', name: 'Work', type: 'send', price: 500, priced: true }]), opts.expires ?? null]))
}
async function sentQuote(leadId: string, userKey = 'a1', opts: { supersedes?: string | null; expires?: string | null } = {}) {
  const q = await draftQuote(leadId, userKey, opts)
  await as(db, service, async (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [q.id, ids[userKey]]))
  return one(db, `SELECT * FROM quotes WHERE id = $1`, [q.id])
}

const followUp = (userKey: string, quoteId: string, body = 'Hi Jordan, just checking in on your quote.', requestId: string | null = null) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.send_quote_follow_up($1, $2, $3) AS r`, [quoteId, body, requestId]))
    .then((r: any) => r.r)
const followUpError = (who: any, quoteId: string) =>
  as(db, who, async (tx: any) => tx.query(`SELECT public.send_quote_follow_up($1, 'Checking in', NULL)`, [quoteId]))
    .then(() => null, (err: any) => err.message as string)
const shopReply = (userKey: string, quoteId: string, body: string) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.send_shop_quote_message($1, $2) AS r`, [quoteId, body])).then((r: any) => r.r)
const customerMessages = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_quote_messages($1) AS r`, [token])).then((r: any) => r.r as any[])

const followUps = async (leadId: string) =>
  (await db.query(`SELECT * FROM quote_messages WHERE lead_id = $1 AND is_follow_up ORDER BY created_at`, [leadId])).rows
const messageEvents = async (leadId: string) =>
  (await db.query(`SELECT * FROM lead_events WHERE lead_id = $1 AND event_type = 'quote_message_added' ORDER BY created_at, id`, [leadId])).rows
const alerts = async (leadId: string) =>
  (await db.query(`SELECT e.kind, d.channel, d.recipient_type FROM notification_events e
    JOIN notification_deliveries d ON d.event_id = e.id
    WHERE e.lead_id = $1 AND e.kind <> 'new_request' ORDER BY d.created_at`, [leadId])).rows
const notificationEvents = async (leadId: string) =>
  (await db.query(`SELECT kind FROM notification_events WHERE lead_id = $1 AND kind <> 'new_request'`, [leadId])).rows.map((r: any) => r.kind)
const inbox = async (leadId: string) =>
  (await db.query(`SELECT * FROM notifications WHERE lead_id = $1 AND kind <> 'new_request'`, [leadId])).rows

// Test-only time travel: bypasses the immutability and quote-write triggers
// to simulate the cooldown elapsing or a quote expiring.
async function withoutTriggers(fn: () => Promise<unknown>) {
  await db.exec(`SET session_replication_role = replica`)
  try {
    await fn()
  } finally {
    await db.exec(`SET session_replication_role = origin`)
  }
}
const age = (leadId: string, interval: string) =>
  withoutTriggers(() => db.query(`UPDATE quote_messages SET created_at = created_at - $2::interval WHERE lead_id = $1 AND is_follow_up`, [leadId, interval]))

// ---------------------------------------------------------------------------
// Posting and alerting
// ---------------------------------------------------------------------------

test('a follow-up posts to the existing conversation and queues exactly one customer alert', async () => {
  const lead = await newLead('shopA')
  const q = await sentQuote(lead)
  await shopReply('a2', q.id, 'Earlier reply') // an ordinary reply, for contrast
  const beforeAlerts = (await alerts(lead)).length
  const beforeQuote = await one(db, `SELECT * FROM quotes WHERE id = $1`, [q.id])
  const beforeLead = await one(db, `SELECT status, updated_at FROM leads WHERE id = $1`, [lead])

  const r = await followUp('a1', q.id, '  Hi Jordan, any questions about your quote?  ')
  assert.equal(r.ok, true)
  assert.equal(r.duplicate, false)
  assert.equal(r.alert, 'queued', 'posting and the alert are reported separately')

  const [msg] = await followUps(lead)
  assert.equal(msg.id, r.message_id)
  assert.equal(msg.body, 'Hi Jordan, any questions about your quote?', 'body is trimmed like other messages')
  assert.equal(msg.sender_type, 'shop_user')
  assert.equal(msg.sender_id, ids.a1)
  assert.equal(msg.quote_id, q.id)

  // The customer reads it in the same conversation as every other message.
  const visible = await customerMessages(q.public_token)
  assert.deepEqual(visible.map((m: any) => m.body), ['Earlier reply', 'Hi Jordan, any questions about your quote?'])
  assert.ok(visible.every((m: any) => !('is_follow_up' in m) && !('sender_id' in m)), 'customer payload is unchanged')

  // Tracked distinctly on the existing lead event.
  const events = await messageEvents(lead)
  assert.equal(events.length, 2)
  assert.equal(events[1].metadata.follow_up, true)
  assert.equal(events[1].metadata.message_id, r.message_id)
  assert.equal(events[1].actor_type, 'shop_user')
  assert.equal(events[0].metadata.follow_up, undefined, 'ordinary replies are not marked')

  // Exactly one new alert: the existing customer email (shop_reply), no staff
  // in-app or push notification, no separate follow-up type.
  const after = await alerts(lead)
  assert.equal(after.length, beforeAlerts + 1)
  assert.deepEqual(after.at(-1), { kind: 'shop_reply', channel: 'email', recipient_type: 'customer' })
  assert.deepEqual(await notificationEvents(lead), ['shop_reply', 'shop_reply'])
  assert.equal((await inbox(lead)).length, 0)

  // The alert links to the quote and carries no message text.
  const delivery = await one(db, `SELECT d.* FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    JOIN lead_events le ON le.id = e.lead_event_id WHERE le.metadata ->> 'message_id' = $1`, [r.message_id])
  const payload = (await one(db, `SELECT public.notification_delivery_payload(d) AS p FROM notification_deliveries d WHERE d.id = $1`, [delivery.id])).p
  assert.equal(payload.kind, 'shop_reply')
  assert.equal(payload.quote_path, `/q/${q.public_token}`)
  assert.ok(!JSON.stringify(payload).includes('any questions'), 'message text stays in the conversation')

  // Recovery never re-queues it.
  await as(db, service, async (tx: any) => tx.query(`SELECT public.recover_notification_events(500)`))
  assert.equal((await alerts(lead)).length, beforeAlerts + 1)

  // Quote status, pricing and view tracking, and the lead itself, are untouched.
  const afterQuote = await one(db, `SELECT * FROM quotes WHERE id = $1`, [q.id])
  assert.deepEqual(afterQuote, beforeQuote)
  assert.deepEqual(await one(db, `SELECT status, updated_at FROM leads WHERE id = $1`, [lead]), beforeLead)
})

test('viewed quotes can be followed up, and admins can follow up for any shop', async () => {
  const lead = await newLead('shopB')
  const q = await sentQuote(lead, 'b1')
  await as(db, anon, async (tx: any) => tx.query(`SELECT public.record_quote_view($1, 'session-1')`, [q.public_token]))
  const viewed = await one(db, `SELECT status, view_count FROM quotes WHERE id = $1`, [q.id])
  assert.equal(viewed.status, 'viewed')

  const r = await followUp('admin', q.id)
  assert.equal(r.ok, true)
  const [msg] = await followUps(lead)
  assert.equal(msg.sender_type, 'admin')
  assert.deepEqual(await one(db, `SELECT status, view_count FROM quotes WHERE id = $1`, [q.id]), viewed)
})

test('posting is reported separately when the alert cannot be delivered', async () => {
  const lead = await newLead('shopA', 'not-an-email')
  const q = await sentQuote(lead)
  const r = await followUp('a1', q.id)
  assert.equal(r.ok, true)
  assert.equal(r.alert, 'no_customer_email')
  assert.equal((await followUps(lead)).length, 1, 'the message is still posted')
})

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test('only staff of the quote\'s shop (or admins) can follow up', async () => {
  const lead = await newLead('shopA')
  const q = await sentQuote(lead)

  assert.match(await followUpError(anon, q.id) ?? '', /permission denied/)
  assert.match(await followUpError({ role: 'authenticated' }, q.id) ?? '', /Not authenticated/)
  assert.match(await followUpError(staff('noprofile'), q.id) ?? '', /Not allowed/)
  assert.match(await followUpError(staff('b1'), q.id) ?? '', /Quote not found/, 'other shops cannot see the quote')
  assert.match(await followUpError(staff('a1'), '00000000-0000-0000-0000-000000000000') ?? '', /Quote not found/)
  assert.equal((await followUps(lead)).length, 0)

  // Clients can't write follow-ups (or any message) directly.
  const direct = await as(db, staff('a1'), async (tx: any) => tx.query(`INSERT INTO quote_messages (lead_id, quote_id, shop_id, sender_type, sender_id, body, is_follow_up)
    VALUES ($1, $2, $3, 'shop_user', $4, 'x', true)`, [lead, q.id, ids.shopA, ids.a1])).then(() => null, (e: any) => e.message)
  assert.match(direct ?? '', /permission denied/)
})

test('read-only shops cannot follow up', async () => {
  const lead = await newLead('shopR')
  // Seed a sent quote as if it was sent before the account lapsed.
  await db.query(`UPDATE shops SET subscription_status = 'active' WHERE id = $1`, [ids.shopR])
  const q = await sentQuote(lead, 'r1')
  await db.query(`UPDATE shops SET subscription_status = 'cancelled' WHERE id = $1`, [ids.shopR])

  assert.match(await followUpError(staff('r1'), q.id) ?? '', /read-only/)
  assert.equal((await followUps(lead)).length, 0)
  assert.equal((await alerts(lead)).length, 0)
})

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('only active, unexpired sent or viewed quotes are eligible', async () => {
  // Draft
  const draftLead = await newLead('shopA')
  const draft = await draftQuote(draftLead, 'a1')
  assert.deepEqual(await followUp('a1', draft.id), { ok: false, error: 'not_eligible', reason: 'draft' })

  // Approved
  const approvedLead = await newLead('shopA')
  const approved = await sentQuote(approvedLead)
  await as(db, anon, async (tx: any) => tx.query(`SELECT public.respond_to_quote($1, 'approve')`, [approved.public_token]))
  assert.deepEqual(await followUp('a1', approved.id), { ok: false, error: 'not_eligible', reason: 'approved' })

  // Superseded by a sent revision; the current revision is eligible.
  const revLead = await newLead('shopA')
  const first = await sentQuote(revLead)
  const second = await sentQuote(revLead, 'a1', { supersedes: first.id })
  assert.deepEqual(await followUp('a1', first.id), { ok: false, error: 'not_eligible', reason: 'superseded' })
  assert.equal((await followUp('a1', second.id)).ok, true)

  // Expired yesterday vs. expiring today (valid through its expiry date).
  const expiredLead = await newLead('shopA')
  const expired = await sentQuote(expiredLead, 'a1', { expires: isoDay(0) })
  await withoutTriggers(() => db.query(`UPDATE quotes SET expires_at = $2 WHERE id = $1`, [expired.id, isoDay(-1)]))
  assert.deepEqual(await followUp('a1', expired.id), { ok: false, error: 'not_eligible', reason: 'expired' })
  const todayLead = await newLead('shopA')
  const today = await sentQuote(todayLead, 'a1', { expires: isoDay(0) })
  assert.equal((await followUp('a1', today.id)).ok, true)

  // Blank message
  const blankLead = await newLead('shopA')
  const blank = await sentQuote(blankLead)
  assert.deepEqual(await followUp('a1', blank.id, '   '), { ok: false, error: 'invalid_message' })
  assert.deepEqual(await followUp('a1', blank.id, 'x'.repeat(5001)), { ok: false, error: 'invalid_message' })

  for (const lead of [draftLead, approvedLead, expiredLead, blankLead]) {
    assert.equal((await followUps(lead)).length, 0)
    assert.deepEqual((await notificationEvents(lead)).filter((k: string) => k === 'shop_reply'), [])
  }
})

// ---------------------------------------------------------------------------
// Cooldown and duplicates
// ---------------------------------------------------------------------------

test('one follow-up per lead per 24 hours, across revisions; ordinary replies do not count', async () => {
  const lead = await newLead('shopA')
  const q = await sentQuote(lead)
  await shopReply('a1', q.id, 'A normal reply does not start the cooldown')
  const first = await followUp('a1', q.id)
  assert.equal(first.ok, true)

  const second = await followUp('a2', q.id, 'Another nudge')
  assert.equal(second.ok, false)
  assert.equal(second.error, 'cooldown')
  assert.equal(new Date(second.last_follow_up_at).toISOString(), new Date(first.created_at).toISOString())
  assert.equal(new Date(second.next_allowed_at).getTime() - new Date(first.created_at).getTime(), 24 * 60 * 60 * 1000)

  // A new revision does not reset the cooldown.
  const revised = await sentQuote(lead, 'a1', { supersedes: q.id })
  assert.equal((await followUp('a1', revised.id)).error, 'cooldown')
  // Admins are held to it too.
  assert.equal((await followUp('admin', revised.id)).error, 'cooldown')

  // Ordinary replies are still allowed during the cooldown.
  assert.equal((await shopReply('a1', revised.id, 'Still replying normally')).ok, true)

  assert.equal((await followUps(lead)).length, 1)
  assert.equal((await messageEvents(lead)).filter((e: any) => e.metadata.follow_up).length, 1)

  // Just inside the window: still blocked. After 24 hours: allowed.
  await age(lead, '23 hours 59 minutes')
  assert.equal((await followUp('a1', revised.id)).error, 'cooldown')
  await age(lead, '2 minutes')
  const later = await followUp('a1', revised.id, 'Following up again')
  assert.equal(later.ok, true)
  assert.equal((await followUps(lead)).length, 2)

  // Cooldown is per lead: another lead of the same shop is unaffected.
  const other = await newLead('shopA')
  assert.equal((await followUp('a1', (await sentQuote(other)).id)).ok, true)
})

test('a retried request posts once and alerts once', async () => {
  const lead = await newLead('shopA')
  const q = await sentQuote(lead)
  const requestId = crypto.randomUUID()

  const first = await followUp('a1', q.id, 'Checking in', requestId)
  const retry = await followUp('a1', q.id, 'Checking in', requestId)
  const retryOtherUser = await followUp('a2', q.id, 'Checking in', requestId)
  assert.equal(first.ok, true)
  assert.equal(first.duplicate, false)
  for (const r of [retry, retryOtherUser]) {
    assert.equal(r.ok, true)
    assert.equal(r.duplicate, true)
    assert.equal(r.message_id, first.message_id)
    assert.equal(r.alert, 'already_handled')
  }
  assert.equal((await followUps(lead)).length, 1)
  assert.equal((await alerts(lead)).length, 1)

  // A request id can't be replayed against a different quote, and the
  // database rejects a second message with the same request id outright.
  const otherLead = await newLead('shopA')
  const otherQuote = await sentQuote(otherLead)
  const reuse = await as(db, staff('a1'), async (tx: any) => tx.query(`SELECT public.send_quote_follow_up($1, 'x', $2)`, [otherQuote.id, requestId]))
    .then(() => null, (e: any) => e.message)
  assert.match(reuse ?? '', /already used/)
  const dup = await db.query(`INSERT INTO quote_messages (lead_id, quote_id, shop_id, sender_type, sender_id, body, is_follow_up, follow_up_request_id)
    VALUES ($1, $2, $3, 'shop_user', $4, 'x', true, $5)`, [otherLead, otherQuote.id, ids.shopA, ids.a1, requestId]).then(() => null, (e: any) => e.message)
  assert.match(dup ?? '', /quote_messages_follow_up_request_key/)
  assert.equal((await followUps(otherLead)).length, 0)
})

test('customers cannot create follow-ups and follow-up flags stay consistent', async () => {
  const lead = await newLead('shopA')
  const q = await sentQuote(lead)
  const r = await as(db, anon, async (tx: any) => one(tx, `SELECT public.send_public_quote_message($1, 'Question') AS r`, [q.public_token]))
  assert.equal(r.r.ok, true)
  assert.equal((await followUps(lead)).length, 0)
  const bad = await db.query(`INSERT INTO quote_messages (lead_id, quote_id, shop_id, sender_type, sender_id, body, is_follow_up)
    VALUES ($1, $2, $3, 'customer', NULL, 'x', true)`, [lead, q.id, ids.shopA]).then(() => null, (e: any) => e.message)
  assert.match(bad ?? '', /quote_messages_follow_up_shape/)
  // A customer message during the cooldown is unaffected; the shop can still follow up.
  assert.equal((await followUp('a1', q.id)).ok, true)
})
