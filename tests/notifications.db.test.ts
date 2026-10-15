// Notification enqueueing, routing, authorization, retries and duplicate
// protection, run against the real migrations in an isolated in-memory PGlite
// database (see tests/helpers/pgliteDb.mjs). No hosted database, email, push
// service or network access is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore -- plain JS helper
import { createDb, applyMigrations, as, one } from './helpers/pgliteDb.mjs'

const NOTIFICATIONS_MIGRATION = '20261014120000_add_notifications.sql'

let db: any
const ids: Record<string, string> = {}

const anon = { role: 'anon' }
const service = { role: 'service_role' }
const staff = (key: string) => ({ role: 'authenticated', id: ids[key] })

function isoDay(offset: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

async function seedShopsAndUsers(target: any) {
  const shop = async (name: string) =>
    (await one(target, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, 'active', '2020-01-01T00:00:00Z', false) RETURNING id`, [name, `${name.toLowerCase()}@shops.example.test`, name.toLowerCase()])).id
  ids.shopA = await shop('ShopA')
  ids.shopB = await shop('ShopB')
  const user = async (key: string, role: string, shopId: string | null) => {
    const u = await one(target, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${key}@example.test`])
    await target.query(`INSERT INTO profiles (id, email, full_name, role, shop_id) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, shop_id = EXCLUDED.shop_id`, [u.id, `${key}@example.test`, key, role, shopId])
    ids[key] = u.id
  }
  await user('a1', 'shop_user', ids.shopA)
  await user('a2', 'shop_user', ids.shopA)
  await user('b1', 'shop_user', ids.shopB)
  await user('admin', 'admin', null)
}

before(async () => {
  db = await createDb()
  await seedShopsAndUsers(db)
})

// ---------------------------------------------------------------------------
// Fixture helpers (mirror what the app does through PostgREST)
// ---------------------------------------------------------------------------

const rand = () => Math.random().toString(36).slice(2, 10)
const P256DH = 'B' + 'x'.repeat(86) // 87 base64url chars = 65 bytes
const AUTH = 'y'.repeat(22) // 16 bytes

async function newLead(target: any, shopKey: 'shopA' | 'shopB', isCustom: boolean, who: any = anon): Promise<string> {
  const email = `${rand()}@customers.example.test`
  await as(target, who, async (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom)
    VALUES ($1, 'Jordan Customer', $2, 'veh', 'Bronco', 'local', $3, 650, 0, 650, 5, 'new', $4)`,
    [ids[shopKey], email, JSON.stringify([{ id: 'p', name: 'Bumper', type: 'new', price: 650 }]), isCustom]))
  return (await one(target, `SELECT id FROM leads WHERE customer_email = $1`, [email])).id
}
const customerLead = (shopKey: 'shopA' | 'shopB', isCustom = false) => newLead(db, shopKey, isCustom)

async function createQuote(leadId: string, userKey: string, supersedes: string | null = null) {
  return as(db, staff(userKey), async (tx: any) => one(tx, `INSERT INTO quotes (lead_id, supersedes_quote_id, selected_parts, shipping_total)
    VALUES ($1, $2, $3, 0) RETURNING *`, [leadId, supersedes, JSON.stringify([{ id: 'p', name: 'Work', type: 'send', price: 500, priced: true }])]))
}
const markQuoteSent = (quoteId: string, userKey: string) =>
  as(db, service, async (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [quoteId, ids[userKey]]))
async function sentQuote(leadId: string, userKey = 'a1', supersedes: string | null = null) {
  const q = await createQuote(leadId, userKey, supersedes)
  await markQuoteSent(q.id, userKey)
  return q
}
const customerMessage = (token: string, body: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.send_public_quote_message($1, $2) AS r`, [token, body])).then((r: any) => r.r)
const shopReply = (quoteId: string, userKey: string, body: string) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.send_shop_quote_message($1, $2) AS r`, [quoteId, body])).then((r: any) => r.r)
const approve = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.respond_to_quote($1, 'approve') AS r`, [token])).then((r: any) => r.r)

async function subscribe(userKey: string, endpoint = `https://fcm.googleapis.com/fcm/send/${userKey}-${rand()}`) {
  const r = await as(db, staff(userKey), async (tx: any) =>
    one(tx, `SELECT public.register_push_subscription($1, $2, $3, 'Test browser') AS id`, [endpoint, P256DH, AUTH]))
  return { id: r.id as string, endpoint }
}

const kinds = async (leadId: string) =>
  (await db.query(`SELECT kind FROM notification_events WHERE lead_id = $1 ORDER BY created_at, id`, [leadId])).rows.map((r: any) => r.kind)
const deliveries = async (leadId: string, kind?: string) =>
  (await db.query(`SELECT d.* FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE e.lead_id = $1 AND ($2::text IS NULL OR e.kind = $2) ORDER BY d.channel, d.recipient_key`, [leadId, kind ?? null])).rows
const inboxUsers = async (leadId: string, kind?: string) =>
  (await db.query(`SELECT user_id FROM notifications WHERE lead_id = $1 AND ($2::text IS NULL OR kind = $2)`, [leadId, kind ?? null]))
    .rows.map((r: any) => r.user_id).sort()
const sorted = (...keys: string[]) => keys.map((k) => ids[k]).sort()

// Delivery worker calls (service_role, like the notification-dispatch function).
const claim = (limit = 100) =>
  as(db, service, async (tx: any) => one(tx, `SELECT public.claim_notification_deliveries($1) AS r`, [limit])).then((r: any) => r.r as any[])
const complete = (row: any, outcome: string, error: string | null = null, providerId: string | null = null) =>
  as(db, service, async (tx: any) => one(tx, `SELECT public.complete_notification_delivery($1, $2, $3, $4, $5) AS r`,
    [row.delivery_id, row.lease_token, outcome, error, providerId])).then((r: any) => r.r)
// Each claim-focused test starts with an empty queue so other tests' rows
// don't interleave.
const clearQueue = () => db.query(`UPDATE notification_deliveries SET status = 'skipped', last_error = 'test reset' WHERE status IN ('pending', 'sending')`)
const deliveryRow = (id: string) => one(db, `SELECT * FROM notification_deliveries WHERE id = $1`, [id])
const makeDue = (id: string) => db.query(`UPDATE notification_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id])

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

for (const isCustom of [false, true]) {
  test(`${isCustom ? 'custom' : 'preconfigured'} request notifies the shop by email and every other staff device`, async () => {
    const a1Phone = await subscribe('a1')
    const a1Laptop = await subscribe('a1')
    const a2Phone = await subscribe('a2')
    const b1Phone = await subscribe('b1')

    const leadId = await customerLead('shopA', isCustom)
    assert.deepEqual(await kinds(leadId), ['new_request'])

    const rows = await deliveries(leadId)
    const email = rows.filter((d: any) => d.channel === 'email')
    assert.deepEqual(email.map((d: any) => [d.recipient_type, d.status]), [['shop', 'pending']])
    const pushTargets = rows.filter((d: any) => d.channel === 'push').map((d: any) => d.subscription_id).sort()
    const shopADevices = (await db.query(`SELECT s.id FROM push_subscriptions s JOIN profiles p ON p.id = s.user_id
      WHERE p.shop_id = $1`, [ids.shopA])).rows.map((r: any) => r.id).sort()
    assert.deepEqual(pushTargets, shopADevices, 'every device of every shop A member')
    for (const device of [a1Phone, a1Laptop, a2Phone]) assert.ok(pushTargets.includes(device.id))
    assert.ok(!pushTargets.includes(b1Phone.id), 'other shops are never notified')
    assert.deepEqual(await inboxUsers(leadId), sorted('a1', 'a2'), 'in-app: shop A staff only, never admins or shop B')
  })
}

test('customer messages notify the shop; shop replies email only the customer', async () => {
  await subscribe('a2')
  const leadId = await customerLead('shopA')
  const q = await sentQuote(leadId, 'a1')

  assert.equal((await customerMessage(q.public_token, 'Can you do it in matte black?')).ok, true)
  const fromCustomer = await deliveries(leadId, 'customer_message')
  assert.deepEqual(fromCustomer.filter((d: any) => d.channel === 'email').map((d: any) => d.recipient_type), ['shop'])
  assert.ok(fromCustomer.some((d: any) => d.channel === 'push'))
  assert.deepEqual(await inboxUsers(leadId, 'customer_message'), sorted('a1', 'a2'))

  assert.equal((await shopReply(q.id, 'a1', 'Yes, no extra charge.')).ok, true)
  const fromShop = await deliveries(leadId, 'shop_reply')
  assert.deepEqual(fromShop.map((d: any) => [d.channel, d.recipient_type]), [['email', 'customer']])
  assert.deepEqual(await inboxUsers(leadId, 'shop_reply'), [], 'staff are not notified about replies')

  // Message bodies are never copied into notification storage.
  const stored = JSON.stringify((await db.query(`SELECT * FROM notification_events WHERE lead_id = $1`, [leadId])).rows)
    + JSON.stringify((await db.query(`SELECT * FROM notifications WHERE lead_id = $1`, [leadId])).rows)
  assert.ok(!stored.includes('matte black') && !stored.includes('no extra charge'))
})

test('a burst of customer messages sends one shop email but records every message', async () => {
  const leadId = await customerLead('shopA')
  const q = await sentQuote(leadId, 'a1')
  for (const body of ['Hello?', 'Anyone there?', 'Also: tint?']) assert.equal((await customerMessage(q.public_token, body)).ok, true)
  const rows = await deliveries(leadId, 'customer_message')
  assert.equal(rows.filter((d: any) => d.channel === 'email').length, 1)
  assert.equal((await kinds(leadId)).filter((k: string) => k === 'customer_message').length, 3)
  assert.equal((await inboxUsers(leadId, 'customer_message')).length, 3 * 2, 'in-app history keeps every message')
  // After the window passes, the next message emails again.
  await db.query(`UPDATE notification_deliveries SET created_at = now() - interval '11 minutes' WHERE event_id IN
    (SELECT id FROM notification_events WHERE lead_id = $1)`, [leadId])
  await customerMessage(q.public_token, 'Following up')
  assert.equal((await deliveries(leadId, 'customer_message')).filter((d: any) => d.channel === 'email').length, 2)
})

test('new-request emails are capped per shop per hour', async () => {
  const shop = (await one(db, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
    VALUES ('Flooded', 'flooded@shops.example.test', 'flooded', 'active', '2020-01-01T00:00:00Z', false) RETURNING id`)).id
  ids.shopFlooded = shop
  const leads: string[] = []
  for (let i = 0; i < 52; i++) leads.push(await newLead(db, 'shopFlooded' as any, false))
  const emailCount = (await one(db, `SELECT count(*)::int AS n FROM notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE e.shop_id = $1 AND d.channel = 'email'`, [shop])).n
  assert.equal(emailCount, 50)
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM notification_events WHERE shop_id = $1`, [shop])).n, 52, 'every request is still recorded')
})

test('approvals and customer date selections notify staff; staff do not hear about their own actions', async () => {
  const leadId = await customerLead('shopA')
  const q = await sentQuote(leadId, 'a1')
  assert.equal((await approve(q.public_token)).ok, true)
  assert.deepEqual(await inboxUsers(leadId, 'quote_approved'), sorted('a1', 'a2'))

  const v = Number((await one(db, `SELECT public.schedule_version_of($1) AS v`, [leadId])).v)
  const offer = await as(db, staff('a1'), async (tx: any) =>
    one(tx, `SELECT public.create_schedule_offer($1, $2, $3::date[], null) AS r`, [leadId, v, [isoDay(10)]])).then((r: any) => r.r)
  await as(db, service, async (tx: any) => tx.query(`SELECT public.mark_schedule_offer_sent($1, $2)`, [offer.offer_id, ids.a1]))
  const schedule = await as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_schedule($1) AS s`, [q.public_token])).then((r: any) => r.s)
  const requested = await as(db, anon, async (tx: any) =>
    one(tx, `SELECT public.request_schedule_date($1, $2) AS r`, [q.public_token, schedule.offer.options[0].id])).then((r: any) => r.r)
  assert.equal(requested.ok, true)
  assert.deepEqual(await inboxUsers(leadId, 'date_requested'), sorted('a1', 'a2'))

  // Offering/sending dates and quotes are staff actions: no staff notifications.
  assert.deepEqual(await kinds(leadId), ['new_request', 'quote_approved', 'date_requested'])
})

test('relevant staff status changes notify other staff members only', async () => {
  const leadId = await customerLead('shopA')
  await as(db, staff('a1'), async (tx: any) => tx.query(`UPDATE leads SET status = 'contacted' WHERE id = $1`, [leadId]))
  assert.deepEqual(await kinds(leadId), ['new_request'], 'routine stage changes are not pushed')

  await as(db, staff('a1'), async (tx: any) => tx.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [leadId]))
  assert.deepEqual(await inboxUsers(leadId, 'status_changed'), sorted('a2'), 'the member who changed it is not notified')
  const ev = await one(db, `SELECT metadata FROM notification_events WHERE lead_id = $1 AND kind = 'status_changed'`, [leadId])
  assert.deepEqual(ev.metadata, { to: 'lost' })

  // An admin acting on the shop's lead notifies all of the shop's staff.
  await as(db, staff('admin'), async (tx: any) => tx.query(`UPDATE leads SET status = 'completed' WHERE id = $1`, [leadId]))
  const completed = (await db.query(`SELECT n.user_id FROM notifications n JOIN notification_events e ON e.id = n.event_id
    WHERE n.lead_id = $1 AND e.metadata ->> 'to' = 'completed'`, [leadId])).rows.map((r: any) => r.user_id).sort()
  assert.deepEqual(completed, sorted('a1', 'a2'))
})

test('a request submitted from a signed-in browser still notifies, except the submitter', async () => {
  // The public request forms also accept signed-in browsers (leads INSERT is
  // granted to authenticated), e.g. staff testing their own form.
  const leadId = await newLead(db, 'shopA', true, staff('a1'))
  assert.deepEqual(await kinds(leadId), ['new_request'])
  assert.ok((await deliveries(leadId)).some((d: any) => d.channel === 'email' && d.recipient_type === 'shop'))
  assert.deepEqual(await inboxUsers(leadId), sorted('a2'))
  assert.ok(!(await deliveries(leadId)).some((d: any) => d.user_id === ids.a1))
  // Staff of another shop submitting a request is a normal request for this shop.
  const fromOtherShop = await newLead(db, 'shopA', false, staff('b1'))
  assert.deepEqual(await inboxUsers(fromOtherShop), sorted('a1', 'a2'))
})

// ---------------------------------------------------------------------------
// Durability, duplicates, history
// ---------------------------------------------------------------------------

const breakNotifications = () => db.exec(`
  CREATE FUNCTION public.test_break_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'notification storage unavailable'; END $$;
  CREATE TRIGGER test_break_notifications BEFORE INSERT ON public.notification_events
    FOR EACH ROW EXECUTE FUNCTION public.test_break_notifications();`)
const repairNotifications = () =>
  db.exec(`DROP TRIGGER test_break_notifications ON public.notification_events; DROP FUNCTION public.test_break_notifications();`)
const recover = (limit = 100) =>
  as(db, service, async (tx: any) => one(tx, `SELECT public.recover_notification_events($1) AS r`, [limit])).then((r: any) => r.r)
// Simulates an event whose notification was lost, written with triggers off.
async function lostEvent(leadId: string, createdAt: string) {
  await db.exec(`SET session_replication_role = replica`)
  try {
    return (await one(db, `INSERT INTO lead_events (lead_id, shop_id, event_type, actor_type, metadata, created_at)
      SELECT id, shop_id, 'lead_created', 'customer', '{}'::jsonb, ${createdAt} FROM leads WHERE id = $1 RETURNING id`, [leadId])).id as string
  } finally {
    await db.exec(`SET session_replication_role = origin`)
  }
}

test('notification failures never fail or lose the customer action, and are recovered once storage works', async () => {
  await subscribe('a2')
  const leadId = await customerLead('shopA')
  const q = await sentQuote(leadId, 'a1')
  let brokenLead = ''
  let messageId = ''
  await breakNotifications()
  try {
    brokenLead = await customerLead('shopA', true)
    assert.ok(brokenLead, 'the request was still saved')
    assert.equal((await one(db, `SELECT count(*)::int AS n FROM lead_events WHERE lead_id = $1 AND event_type = 'lead_created'`, [brokenLead])).n, 1)
    assert.deepEqual(await kinds(brokenLead), [])

    const sent = await customerMessage(q.public_token, 'Still there?')
    assert.equal(sent.ok, true, 'the message was still sent')
    messageId = sent.message_id
    assert.equal((await one(db, `SELECT count(*)::int AS n FROM quote_messages WHERE id = $1`, [messageId])).n, 1)

    // Recovery while storage is still failing: nothing lost, nothing raised.
    const whileBroken = await recover()
    assert.ok(whileBroken.failed >= 2)
    assert.deepEqual(await kinds(brokenLead), [])
  } finally {
    await repairNotifications()
  }

  // The dispatcher's next run rebuilds both from the preserved audit events.
  const first = await recover()
  assert.equal(first.failed, 0)
  assert.ok(first.recovered >= 2)
  assert.deepEqual(await kinds(brokenLead), ['new_request'])
  assert.ok((await deliveries(brokenLead)).some((d: any) => d.channel === 'email' && d.recipient_type === 'shop'))
  assert.ok((await deliveries(brokenLead)).some((d: any) => d.channel === 'push'))
  assert.deepEqual(await inboxUsers(brokenLead), sorted('a1', 'a2'))
  assert.deepEqual(await kinds(leadId), ['new_request', 'customer_message'])

  // Idempotent: running again (or concurrently) adds nothing.
  const before = (await deliveries(brokenLead)).length
  assert.deepEqual(await recover(), { recovered: 0, failed: 0 })
  assert.equal((await deliveries(brokenLead)).length, before)
  // The customer's records were never touched.
  assert.ok(await one(db, `SELECT id FROM leads WHERE id = $1`, [brokenLead]))
  assert.ok(await one(db, `SELECT id FROM quote_messages WHERE id = $1`, [messageId]))
})

test('recovery is bounded: activation boundary, 24-hour window and per-run limit', async () => {
  await recover(500) // start from a clean slate
  const leadId = await customerLead('shopA')
  const activatedAt = (await one(db, `SELECT activated_at FROM notification_settings`)).activated_at
  const tooOld = await lostEvent(leadId, `now() - interval '25 hours'`)
  const historical = await lostEvent(leadId, `'${new Date(new Date(activatedAt).getTime() - 1000).toISOString()}'::timestamptz`)
  const lost = [await lostEvent(leadId, 'now()'), await lostEvent(leadId, 'now()'), await lostEvent(leadId, 'now()')]

  assert.deepEqual(await recover(2), { recovered: 2, failed: 0 }, 'at most p_limit per call')
  assert.deepEqual(await recover(2), { recovered: 1, failed: 0 })
  assert.deepEqual(await recover(2), { recovered: 0, failed: 0 })
  const queued = (await db.query(`SELECT lead_event_id FROM notification_events WHERE lead_event_id = ANY($1::uuid[])`,
    [[tooOld, historical, ...lost]])).rows.map((r: any) => r.lead_event_id).sort()
  assert.deepEqual(queued, [...lost].sort(), 'never events before activation or older than 24 hours')

  // Ineligible events (e.g. quote views) are never "recovered".
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM notification_events n JOIN lead_events e ON e.id = n.lead_event_id
    WHERE e.event_type NOT IN ('lead_created', 'quote_message_added', 'quote_approved', 'quote_declined', 'schedule_date_requested', 'status_changed')`)).n, 0)

  for (const who of [anon, staff('a1'), staff('admin')]) {
    await assert.rejects(as(db, who, async (tx: any) => tx.query(`SELECT public.recover_notification_events(10)`)), /permission denied/)
  }
  // Re-running the migration's settings insert keeps the original boundary.
  await db.query(`INSERT INTO notification_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`)
  assert.equal(new Date((await one(db, `SELECT activated_at FROM notification_settings`)).activated_at).getTime(), new Date(activatedAt).getTime())
})

test('a lead event is only ever queued once', async () => {
  await subscribe('a2')
  const leadId = await customerLead('shopA')
  const before = await deliveries(leadId)
  const again = await one(db, `SELECT public.notification_enqueue(e) AS id FROM lead_events e WHERE e.lead_id = $1 AND e.event_type = 'lead_created'`, [leadId])
  assert.equal(again.id, null)
  assert.equal((await deliveries(leadId)).length, before.length)
  assert.deepEqual(await kinds(leadId), ['new_request'])
  await assert.rejects(db.query(`INSERT INTO notification_deliveries (event_id, channel, recipient_type, recipient_key)
    SELECT event_id, channel, recipient_type, recipient_key FROM notification_deliveries WHERE id = $1`, [before[0].id]), /duplicate key/)
})

test('historical records are not notified when the migration is installed', async () => {
  const fresh = await createDb({ before: NOTIFICATIONS_MIGRATION })
  const saved = { ...ids }
  try {
    await seedShopsAndUsers(fresh)
    const oldLead = await newLead(fresh, 'shopA', false)
    await applyMigrations(fresh, { from: NOTIFICATIONS_MIGRATION })
    assert.equal((await one(fresh, `SELECT count(*)::int AS n FROM notification_events`)).n, 0)
    assert.equal((await one(fresh, `SELECT count(*)::int AS n FROM notification_deliveries`)).n, 0)
    assert.equal((await one(fresh, `SELECT count(*)::int AS n FROM lead_events WHERE lead_id = $1`, [oldLead])).n, 1)
    // Recovery does not treat pre-activation events as lost.
    const recovered = await as(fresh, { role: 'service_role' }, async (tx: any) => one(tx, `SELECT public.recover_notification_events(500) AS r`)).then((r: any) => r.r)
    assert.deepEqual(recovered, { recovered: 0, failed: 0 })
    assert.equal((await one(fresh, `SELECT count(*)::int AS n FROM notification_events`)).n, 0)
    // ...while new events afterwards are.
    const newer = await newLead(fresh, 'shopA', false)
    assert.equal((await one(fresh, `SELECT count(*)::int AS n FROM notification_events WHERE lead_id = $1`, [newer])).n, 1)
  } finally {
    Object.assign(ids, saved)
    await fresh.close()
  }
})

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('staff see and manage only their own notifications', async () => {
  const leadId = await customerLead('shopA')
  const visible = async (userKey: string) => as(db, staff(userKey), async (tx: any) =>
    (await tx.query(`SELECT id, user_id FROM notifications WHERE lead_id = $1`, [leadId])).rows)
  const a1Rows = await visible('a1')
  assert.equal(a1Rows.length, 1)
  assert.equal(a1Rows[0].user_id, ids.a1)
  assert.deepEqual(await visible('b1'), [], 'other shops see nothing')
  assert.deepEqual(await visible('admin'), [], 'admins have no inbox for shop events')

  const a2Id = (await one(db, `SELECT id FROM notifications WHERE lead_id = $1 AND user_id = $2`, [leadId, ids.a2])).id
  const markA2 = await as(db, staff('a1'), async (tx: any) => one(tx, `SELECT public.mark_notifications_read($1::uuid[]) AS n`, [[a2Id]]))
  assert.equal(markA2.n, 0, "cannot mark someone else's notification read")
  assert.equal((await one(db, `SELECT read_at FROM notifications WHERE id = $1`, [a2Id])).read_at, null)
  const markOwn = await as(db, staff('a1'), async (tx: any) => one(tx, `SELECT public.mark_notifications_read($1::uuid[]) AS n`, [[a1Rows[0].id]]))
  assert.equal(markOwn.n, 1)

  for (const sql of [
    `UPDATE notifications SET read_at = now()`,
    `DELETE FROM notifications`,
    `INSERT INTO notifications (event_id, user_id, shop_id, lead_id, kind) SELECT event_id, user_id, shop_id, lead_id, kind FROM notifications LIMIT 1`,
    `SELECT * FROM notification_events`,
    `SELECT * FROM notification_deliveries`,
    `SELECT p256dh FROM push_subscriptions`,
    `SELECT public.claim_notification_deliveries(10)`,
  ]) {
    await assert.rejects(as(db, staff('a1'), async (tx: any) => tx.query(sql)), /permission denied/, sql)
  }
  for (const sql of [`SELECT * FROM notifications`, `SELECT * FROM push_subscriptions`, `SELECT public.mark_notifications_read(null)`]) {
    await assert.rejects(as(db, anon, async (tx: any) => tx.query(sql)), /permission denied/, sql)
  }

  // Moving to another shop hides the old shop's inbox.
  await db.query(`UPDATE profiles SET shop_id = $1 WHERE id = $2`, [ids.shopB, ids.a2])
  try {
    assert.deepEqual(await visible('a2'), [])
  } finally {
    await db.query(`UPDATE profiles SET shop_id = $1 WHERE id = $2`, [ids.shopA, ids.a2])
  }
})

test('device subscriptions: own devices only, known push services only', async () => {
  const mine = await subscribe('a1')
  const theirs = await subscribe('a2')

  const listed = await as(db, staff('a1'), async (tx: any) => (await tx.query(`SELECT id, user_id FROM push_subscriptions`)).rows)
  assert.ok(listed.every((r: any) => r.user_id === ids.a1))
  assert.ok(listed.some((r: any) => r.id === mine.id) && !listed.some((r: any) => r.id === theirs.id))

  const delTheirs = await as(db, staff('a1'), async (tx: any) => one(tx, `SELECT public.delete_push_subscription($1, $2) AS ok`, [theirs.id, theirs.endpoint]))
  assert.equal(delTheirs.ok, false)
  assert.ok(await one(db, `SELECT id FROM push_subscriptions WHERE id = $1`, [theirs.id]))

  await assert.rejects(as(db, anon, async (tx: any) => tx.query(`SELECT public.register_push_subscription('https://fcm.googleapis.com/fcm/send/x', $1, $2)`, [P256DH, AUTH])), /permission denied/)
  await assert.rejects(as(db, staff('admin'), async (tx: any) => tx.query(`SELECT public.register_push_subscription('https://fcm.googleapis.com/fcm/send/x', $1, $2)`, [P256DH, AUTH])), /Only shop staff/)
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://evil.example.com/push',
    'https://fcm.googleapis.com.evil.example.com/x',
    'https://fcm.googleapis.com@evil.example.com/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/push',
  ]) {
    await assert.rejects(subscribe('a1', endpoint), /Unsupported push service/, endpoint)
  }
  for (const endpoint of [
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QABC',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
  ]) {
    assert.ok((await subscribe('a1', endpoint)).id, endpoint)
  }
  await assert.rejects(as(db, staff('a1'), async (tx: any) =>
    tx.query(`SELECT public.register_push_subscription('https://fcm.googleapis.com/fcm/send/bad-key', 'not-a-key', $1)`, [AUTH])), /check constraint/)

  const delMine = await as(db, staff('a1'), async (tx: any) => one(tx, `SELECT public.delete_push_subscription(null, $1) AS ok`, [mine.endpoint]))
  assert.equal(delMine.ok, true)
  assert.equal(await one(db, `SELECT id FROM push_subscriptions WHERE id = $1`, [mine.id]), undefined)
})

// ---------------------------------------------------------------------------
// Delivery: payloads, re-checks, retries, leases
// ---------------------------------------------------------------------------

test('claimed payloads carry the right links and generic push text', async () => {
  await clearQueue()
  const a2Phone = await subscribe('a2')
  const leadId = await customerLead('shopA', true)
  const q1 = await sentQuote(leadId, 'a1')
  await shopReply(q1.id, 'a1', 'First reply')
  // The customer's current link moves to the newest revision.
  const q2 = await sentQuote(leadId, 'a1', q1.id)

  const claimed = (await claim()).filter((r: any) => (r.lead_id ?? '') === leadId || r.quote_path || r.endpoint === a2Phone.endpoint)
  const shopEmail = claimed.find((r: any) => r.channel === 'email' && r.recipient_type === 'shop')
  assert.equal(shopEmail.to, 'shopa@shops.example.test')
  assert.equal(shopEmail.lead_path, `/dashboard/leads/${leadId}`)
  assert.equal(shopEmail.kind, 'new_request')
  assert.equal(shopEmail.is_custom, true)

  const customerEmail = claimed.find((r: any) => r.channel === 'email' && r.recipient_type === 'customer')
  assert.equal(customerEmail.kind, 'shop_reply')
  assert.equal(customerEmail.quote_path, `/q/${q2.public_token}`)
  assert.match(customerEmail.to, /@customers\.example\.test$/)

  const push = claimed.find((r: any) => r.channel === 'push' && r.endpoint === a2Phone.endpoint)
  assert.deepEqual(push.notification.url, `/dashboard/leads/${leadId}`)
  assert.equal(push.notification.title, 'New request')
  const pushText = JSON.stringify(push.notification)
  assert.ok(!/Jordan|Bronco|customers\.example/.test(pushText), 'no customer details on the lock screen')
  assert.equal(push.attempt, 1)

  for (const row of claimed) await complete(row, 'sent')
})

test('a delivery is leased to one worker at a time and only that lease can complete it', async () => {
  await clearQueue()
  const leadId = await customerLead('shopA')
  const [first] = (await claim()).filter((r: any) => r.lead_id === leadId)
  assert.ok(first)
  assert.deepEqual((await claim()).filter((r: any) => r.lead_id === leadId), [], 'a second worker gets nothing while leased')

  assert.deepEqual(await complete({ ...first, lease_token: '00000000-0000-4000-8000-000000000000' }, 'sent'), { ok: false, error: 'lease_lost' })

  // The worker died: once the lease expires another worker may take over, and
  // the first worker's late completion is rejected.
  await db.query(`UPDATE notification_deliveries SET leased_until = now() - interval '1 second' WHERE id = $1`, [first.delivery_id])
  const [retaken] = (await claim()).filter((r: any) => r.delivery_id === first.delivery_id)
  assert.equal(retaken.attempt, 2)
  assert.deepEqual(await complete(first, 'sent'), { ok: false, error: 'lease_lost' })
  assert.deepEqual(await complete(retaken, 'sent', null, 'resend-id-1'), { ok: true, status: 'sent' })
  const row = await deliveryRow(first.delivery_id)
  assert.deepEqual([row.status, row.provider_message_id, row.lease_token], ['sent', 'resend-id-1', null])
  assert.deepEqual(await complete(retaken, 'sent'), { ok: false, error: 'lease_lost' }, 'cannot be completed twice')
})

test('transient failures retry with backoff and stop after five attempts', async () => {
  await clearQueue()
  const leadId = await customerLead('shopA')
  let [row] = (await claim()).filter((r: any) => r.lead_id === leadId)
  const id = row.delivery_id
  const waits: number[] = []
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(row.attempt, attempt)
    const res = await complete(row, 'retry', `HTTP 503 on attempt ${attempt}`)
    const after = await deliveryRow(id)
    if (attempt < 5) {
      assert.deepEqual([res.status, after.status], ['pending', 'pending'])
      waits.push(Math.round((new Date(after.next_attempt_at).getTime() - new Date(after.updated_at).getTime()) / 60000))
      assert.deepEqual((await claim()).filter((r: any) => r.delivery_id === id), [], 'not retried before its backoff')
      await makeDue(id)
      ;[row] = (await claim()).filter((r: any) => r.delivery_id === id)
    } else {
      assert.deepEqual([res.status, after.status, after.attempts, after.last_error], ['failed', 'failed', 5, 'HTTP 503 on attempt 5'])
    }
  }
  assert.deepEqual(waits, [1, 2, 4, 8])
  await makeDue(id)
  assert.deepEqual((await claim()).filter((r: any) => r.delivery_id === id), [], 'failed deliveries are never retried')

  // Permanent failures stop immediately.
  const other = await customerLead('shopA')
  const [perm] = (await claim()).filter((r: any) => r.lead_id === other)
  assert.equal((await complete(perm, 'failed', 'HTTP 422 invalid recipient')).status, 'failed')
})

test('undelivered work older than a day is abandoned instead of sent late', async () => {
  await clearQueue()
  const leadId = await customerLead('shopA')
  const [row] = await deliveries(leadId)
  await db.query(`UPDATE notification_deliveries SET created_at = now() - interval '25 hours' WHERE id = $1`, [row.id])
  assert.deepEqual((await claim()).filter((r: any) => r.delivery_id === row.id), [])
  const after = await deliveryRow(row.id)
  assert.equal(after.status, 'failed')
  assert.match(after.last_error, /expired/)
})

test('expired push subscriptions are removed and their queued pushes skipped', async () => {
  await clearQueue()
  const phone = await subscribe('a2')
  const lead1 = await customerLead('shopA')
  const lead2 = await customerLead('shopA')
  const claimed = (await claim()).filter((r: any) => r.channel === 'push' && r.subscription_id === phone.id)
  assert.equal(claimed.length, 2)
  assert.deepEqual(await complete(claimed[0], 'gone', 'HTTP 410'), { ok: true, status: 'skipped' })
  assert.equal(await one(db, `SELECT id FROM push_subscriptions WHERE id = $1`, [phone.id]), undefined)
  // The other in-flight push to the same device can still be recorded...
  assert.equal((await complete(claimed[1], 'retry', 'HTTP 500')).status, 'pending')
  // ...but it is skipped rather than retried, because the device is gone.
  await makeDue(claimed[1].delivery_id)
  assert.deepEqual((await claim()).filter((r: any) => r.delivery_id === claimed[1].delivery_id), [])
  assert.deepEqual([(await deliveryRow(claimed[1].delivery_id)).status, (await deliveryRow(claimed[1].delivery_id)).last_error], ['skipped', 'unsubscribed'])
  // New events no longer target the removed device.
  const lead3 = await customerLead('shopA')
  assert.ok(!(await deliveries(lead3)).some((d: any) => d.subscription_id === phone.id))
  void lead1; void lead2
})

test('authorization and recipients are re-checked at delivery time', async () => {
  await clearQueue()
  const a2Phone = await subscribe('a2')
  const shared = await subscribe('a1')
  const leadId = await customerLead('shopA')
  const queued = await deliveries(leadId)
  const a2Push = queued.find((d: any) => d.subscription_id === a2Phone.id)
  const sharedPush = queued.find((d: any) => d.subscription_id === shared.id)

  // a2 leaves shop A; a1's browser is now signed in to b1; the shop changes its contact email.
  await db.query(`UPDATE profiles SET shop_id = $1 WHERE id = $2`, [ids.shopB, ids.a2])
  await subscribe('b1', shared.endpoint)
  await db.query(`UPDATE shops SET contact_email = 'new-inbox@shops.example.test' WHERE id = $1`, [ids.shopA])
  try {
    const claimed = await claim()
    assert.deepEqual([(await deliveryRow(a2Push.id)).status, (await deliveryRow(a2Push.id)).last_error], ['skipped', 'not_authorized'])
    assert.deepEqual([(await deliveryRow(sharedPush.id)).status, (await deliveryRow(sharedPush.id)).last_error], ['skipped', 'subscription_reassigned'])
    assert.ok(!claimed.some((r: any) => r.endpoint === shared.endpoint || r.endpoint === a2Phone.endpoint))
    const email = claimed.find((r: any) => r.lead_id === leadId && r.channel === 'email')
    assert.equal(email.to, 'new-inbox@shops.example.test')
    for (const row of claimed) await complete(row, 'sent')

    // No contact email: skipped, not failed or retried.
    await db.query(`UPDATE shops SET contact_email = '' WHERE id = $1`, [ids.shopA])
    const noEmailLead = await customerLead('shopA')
    await claim()
    const skipped = (await deliveries(noEmailLead)).find((d: any) => d.channel === 'email')
    assert.deepEqual([skipped.status, skipped.last_error], ['skipped', 'no_shop_email'])
  } finally {
    await db.query(`UPDATE profiles SET shop_id = $1 WHERE id = $2`, [ids.shopA, ids.a2])
    await db.query(`UPDATE shops SET contact_email = 'shopa@shops.example.test' WHERE id = $1`, [ids.shopA])
  }
})

test('only the service role can claim or complete deliveries', async () => {
  for (const who of [anon, staff('a1'), staff('admin')]) {
    await assert.rejects(as(db, who, async (tx: any) => tx.query(`SELECT public.claim_notification_deliveries(10)`)), /permission denied/)
    await assert.rejects(as(db, who, async (tx: any) =>
      tx.query(`SELECT public.complete_notification_delivery(gen_random_uuid(), gen_random_uuid(), 'sent')`)), /permission denied/)
  }
  for (const fn of [`public.notification_enqueue(null::public.lead_events)`, `public.push_endpoint_is_allowed('x')`]) {
    await assert.rejects(as(db, staff('a1'), async (tx: any) => tx.query(`SELECT ${fn}`)), /permission denied/, fn)
  }
})

// ---------------------------------------------------------------------------
// Device removal stays effective; lease-safe release
// ---------------------------------------------------------------------------

const touch = (userKey: string, endpoint: string) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.touch_push_subscription($1, $2, $3) AS s`, [endpoint, P256DH, AUTH])).then((r: any) => r.s)
const pushTargetsFor = async (leadId: string) => (await deliveries(leadId)).filter((d: any) => d.channel === 'push').map((d: any) => d.subscription_id)

test('a removed device stays removed through reload and login until it is explicitly re-enabled', async () => {
  const phone = await subscribe('a2')
  assert.equal(await touch('a2', phone.endpoint), 'active', 'page load refreshes an existing registration')

  // Removed from another device (Notifications > Your devices > Remove).
  const removed = await as(db, staff('a2'), async (tx: any) => one(tx, `SELECT public.delete_push_subscription($1, null) AS ok`, [phone.id]))
  assert.equal(removed.ok, true)

  // The phone reloads, then signs in again: page-load sync must not resurrect it.
  assert.equal(await touch('a2', phone.endpoint), 'missing')
  assert.equal(await touch('a2', phone.endpoint), 'missing')
  assert.equal(await one(db, `SELECT id FROM push_subscriptions WHERE endpoint = $1`, [phone.endpoint]), undefined)
  const whileRemoved = await customerLead('shopA')
  assert.ok(!(await pushTargetsFor(whileRemoved)).includes(phone.id), 'the removed phone is not targeted')

  // Only an explicit Enable on that device brings it back.
  const again = await subscribe('a2', phone.endpoint)
  assert.equal(await touch('a2', phone.endpoint), 'active')
  const afterEnable = await customerLead('shopA')
  assert.ok((await pushTargetsFor(afterEnable)).includes(again.id))
})

test('device sync never takes over or reveals another account\'s device', async () => {
  const shared = await subscribe('b1')
  assert.equal(await touch('a1', shared.endpoint), 'other_user')
  const row = await one(db, `SELECT user_id FROM push_subscriptions WHERE endpoint = $1`, [shared.endpoint])
  assert.equal(row.user_id, ids.b1, 'ownership unchanged')
  await assert.rejects(as(db, anon, async (tx: any) => tx.query(`SELECT public.touch_push_subscription($1, $2, $3)`, [shared.endpoint, P256DH, AUTH])), /permission denied/)
})

test('a worker out of time releases its lease without spending an attempt', async () => {
  await clearQueue()
  const leadId = await customerLead('shopA')
  const [row] = (await claim()).filter((r: any) => r.lead_id === leadId)
  const leased = await deliveryRow(row.delivery_id)
  const leaseSeconds = (new Date(leased.leased_until).getTime() - new Date(leased.updated_at).getTime()) / 1000
  const { LEASE_SECONDS } = await import('../supabase/functions/_shared/dispatchLimits.ts')
  assert.equal(leaseSeconds, LEASE_SECONDS, 'dispatcher time limits assume this lease')

  assert.deepEqual(await complete(row, 'release'), { ok: true, status: 'pending' })
  const released = await deliveryRow(row.delivery_id)
  assert.deepEqual([released.status, released.attempts, released.lease_token], ['pending', 0, null])
  assert.deepEqual(await complete(row, 'sent'), { ok: false, error: 'lease_lost' }, 'the released lease is dead')
  const [again] = (await claim()).filter((r: any) => r.delivery_id === row.delivery_id)
  assert.equal(again.attempt, 1, 'immediately claimable, still on its first attempt')
  await complete(again, 'sent')
})
