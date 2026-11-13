// Instant customer booking and optional deposits
// (20261111120000_add_instant_booking_and_deposits.sql), run against the real
// migrations in an isolated in-memory PGlite database (tests/helpers/pgliteDb.mjs).
// No hosted database, email, push or payment provider is involved. PGlite
// has one connection, so "double click" tests replay the second call after
// the first; they check the outcome, not two transactions racing.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore -- plain JS helper
import { createDb, as, one } from './helpers/pgliteDb.mjs'

let db: any
const ids: Record<string, string> = {}

const anon = { role: 'anon' }
const service = { role: 'service_role' }
const staff = (key: string) => ({ role: 'authenticated', id: ids[key] })

// Server dates are UTC (current_date), like the database functions.
function D(offset: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const dateText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v))
const rand = () => Math.random().toString(36).slice(2)
const P256DH = 'B' + 'x'.repeat(86)
const AUTH = 'y'.repeat(22)

type ShopKey = 'shopA' | 'shopB' | 'shopC'
const userFor = (shopKey: ShopKey) => (shopKey === 'shopA' ? 'userA' : shopKey === 'shopB' ? 'userB' : 'userC')

before(async () => {
  db = await createDb()
  const shop = async (name: string, status: string) =>
    (await one(db, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, $4, '2020-01-01T00:00:00Z', false) RETURNING id`, [name, `${name}@example.test`, name.toLowerCase(), status])).id
  ids.shopA = await shop('BookShopA', 'active')
  ids.shopB = await shop('BookShopB', 'active')
  ids.shopC = await shop('BookShopC', 'trial') // expired trial: read-only
  const user = async (key: string, role: string, shopId: string | null) => {
    const u = await one(db, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${key}@example.test`])
    await db.query(`INSERT INTO profiles (id, email, full_name, role, shop_id) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, shop_id = EXCLUDED.shop_id`, [u.id, `${key}@example.test`, key, role, shopId])
    ids[key] = u.id
  }
  await user('userA', 'shop_user', ids.shopA)
  await user('userA2', 'shop_user', ids.shopA)
  await user('userB', 'shop_user', ids.shopB)
  await user('userC', 'shop_user', ids.shopC)
  await user('admin', 'admin', null)
  // A device for userA2, to check the push copy of a booking.
  await as(db, staff('userA2'), async (tx: any) => tx.query(`SELECT public.register_push_subscription($1, $2, $3, 'Test browser')`,
    [`https://fcm.googleapis.com/fcm/send/a2-${rand()}`, P256DH, AUTH]))
})

// ---------------------------------------------------------------------------
// Fixture helpers (mirror what the app does through PostgREST)
// ---------------------------------------------------------------------------

async function newLead(shopKey: ShopKey, isCustom = true, name = 'Customer'): Promise<string> {
  const email = `${rand()}@example.test`
  const parts = isCustom
    ? [{ id: 'area', name: 'Fender', type: 'send', price: 0 }]
    : [{ id: 'bumper', name: 'Bumper', type: 'new', price: 650, group_id: 'g1' }]
  await as(db, anon, async (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom)
    VALUES ($1, $2, $3, 'veh', 'Truck', 'local', $4, 650, 0, 650, 5, 'new', $5)`, [ids[shopKey], name, email, JSON.stringify(parts), isCustom]))
  return (await one(db, `SELECT id FROM leads WHERE customer_email = $1`, [email])).id
}
async function createQuote(leadId: string, userKey: string, price: number, supersedes: string | null = null) {
  return as(db, staff(userKey), async (tx: any) => one(tx, `INSERT INTO quotes (lead_id, supersedes_quote_id, selected_parts, shipping_total)
    VALUES ($1, $2, $3, 0) RETURNING *`, [leadId, supersedes, JSON.stringify([{ id: 'p', name: 'Work', type: 'send', price, priced: true }])]))
}
const sendQuote = (quoteId: string, userKey: string) =>
  as(db, service, async (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [quoteId, ids[userKey]]))
const approve = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.respond_to_quote($1, 'approve') AS r`, [token])).then((r: any) => r.r)

// This quote's deposit request, saved on the draft like the app does (a
// direct UPDATE of the draft's columns, as the shop's staff).
type QuoteDeposit = { url: string | null; amount?: number | null; instructions?: string | null }
const setQuoteDeposit = (quoteId: string, userKey: string, requested: boolean, d: QuoteDeposit = { url: null }) =>
  as(db, staff(userKey), async (tx: any) => (await tx.query(`UPDATE quotes SET deposit_requested = $2, deposit_payment_url = $3,
    deposit_amount = $4, deposit_instructions = $5 WHERE id = $1 RETURNING *`,
    [quoteId, requested, d.url, d.amount ?? null, d.instructions ?? null])).rows[0])
const quoteRow = (quoteId: string) => one(db, `SELECT * FROM quotes WHERE id = $1`, [quoteId])

async function approvedLead(shopKey: ShopKey = 'shopA', isCustom = true, name = 'Customer', deposit: QuoteDeposit | null = null) {
  const leadId = await newLead(shopKey, isCustom, name)
  const sender = shopKey === 'shopC' ? 'admin' : userFor(shopKey)
  const q = await createQuote(leadId, sender, 900)
  if (deposit) await setQuoteDeposit(q.id, sender, true, deposit)
  await sendQuote(q.id, sender)
  assert.equal((await approve(q.public_token)).ok, true)
  return { leadId, quote: q, token: q.public_token as string }
}

const version = async (leadId: string) => Number((await one(db, `SELECT public.schedule_version_of($1) AS v`, [leadId])).v)
const leadStatus = async (leadId: string) => (await one(db, `SELECT status FROM leads WHERE id = $1`, [leadId])).status
const publicSchedule = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_schedule($1) AS s`, [token])).then((r: any) => r.s)
const book = (token: string | null, date: string | null, who: any = anon) =>
  as(db, who, async (tx: any) => one(tx, `SELECT public.book_schedule_date($1, $2::date) AS r`, [token, date])).then((r: any) => r.r)
const activeReservation = (leadId: string) =>
  one(db, `SELECT * FROM schedule_reservations WHERE lead_id = $1 AND status = 'active'`, [leadId])
const events = async (leadId: string) =>
  (await db.query(`SELECT event_type, actor_type, actor_id, metadata FROM lead_events WHERE lead_id = $1 ORDER BY created_at, id`, [leadId])).rows
const notificationKinds = async (leadId: string) =>
  (await db.query(`SELECT kind FROM notification_events WHERE lead_id = $1 ORDER BY created_at, id`, [leadId])).rows.map((r: any) => r.kind)
const count = async (sql: string, params: unknown[]) => (await one(db, `SELECT count(*)::int AS n FROM ${sql}`, params)).n as number

const setBlocked = (shopKey: ShopKey, start: string, end: string, blocked: boolean) =>
  as(db, staff(userFor(shopKey)), async (tx: any) => tx.query(`SELECT public.set_schedule_dates_blocked($1, $2::date, $3::date, $4)`,
    [ids[shopKey], start, end, blocked]))
async function setReady(leadId: string, userKey: string, ready: string | null) {
  const v = await version(leadId)
  return as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.set_schedule_ready_date($1, $2, $3::date) AS r`, [leadId, v, ready]))
    .then((r: any) => r.r)
}
// The retired shop-wide defaults: no longer callable by clients.
const setShopDeposit = (shopKey: ShopKey, enabled: boolean, url: string | null, amount: number | null, instructions: string | null, userKey: string = userFor(shopKey)) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.set_shop_deposit_settings($1, $2, $3, $4, $5) AS r`,
    [ids[shopKey], enabled, url, amount, instructions])).then((r: any) => r.r)
// A shop-wide default row left over from before (e.g. on TEST): bookings must ignore it.
const legacyShopDefault = (shopKey: ShopKey, url: string) =>
  db.query(`INSERT INTO shop_deposit_settings (shop_id, enabled, payment_url, amount, instructions) VALUES ($1, true, $2, 75, 'Shop-wide terms.')
    ON CONFLICT (shop_id) DO UPDATE SET enabled = true, payment_url = EXCLUDED.payment_url`, [ids[shopKey], url])
const setLeadDeposit = (leadId: string, requested: boolean, url: string | null, amount: number | null, instructions: string | null, userKey = 'userA') =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.set_lead_deposit($1, $2, $3, $4, $5) AS r`,
    [leadId, requested, url, amount, instructions])).then((r: any) => r.r)
const setReceived = (leadId: string, received: boolean, who: any = staff('userA')) =>
  as(db, who, async (tx: any) => one(tx, `SELECT public.set_deposit_received($1, $2) AS r`, [leadId, received])).then((r: any) => r.r)
const leadDeposit = (leadId: string) => one(db, `SELECT * FROM lead_deposits WHERE lead_id = $1`, [leadId])

async function resetShop(shopKey: ShopKey = 'shopA') {
  await db.query(`DELETE FROM shop_blocked_dates WHERE shop_id = $1`, [ids[shopKey]])
  await db.query(`DELETE FROM shop_schedule_settings WHERE shop_id = $1`, [ids[shopKey]])
  await db.query(`DELETE FROM shop_deposit_settings WHERE shop_id = $1`, [ids[shopKey]])
}

// ---------------------------------------------------------------------------
// Immediate booking
// ---------------------------------------------------------------------------

for (const isCustom of [true, false]) {
  test(`${isCustom ? 'custom' : 'preconfigured'}: approve -> Book It -> Scheduled immediately, no ready date`, async () => {
    await resetShop()
    const { leadId, quote, token } = await approvedLead('shopA', isCustom)
    assert.equal((await publicSchedule(token)).calendar.earliest, D(1))

    const r = await book(token, D(10))
    assert.deepEqual([r.ok, r.start_date, r.already_booked], [true, D(10), false])
    assert.equal(await leadStatus(leadId), 'scheduled', 'no shop approval step')
    const res = await activeReservation(leadId)
    assert.deepEqual([dateText(res.start_date), res.estimated_ready_date, res.source, res.confirmed_by, res.quote_id],
      [D(10), null, 'customer', null, quote.id], 'the ready estimate stays unknown')
    assert.equal(await count(`schedule_requests WHERE lead_id = $1`, [leadId]), 0, 'no pending request is created')

    // A refresh shows the confirmed booking.
    const pub = await publicSchedule(token)
    assert.deepEqual(pub.booking, { start_date: D(10), estimated_ready_date: null })
    assert.deepEqual([pub.calendar, pub.request, pub.deposit], [null, null, null], 'no deposit configured: nothing to pay')

    const booked = (await events(leadId)).find((e: any) => e.event_type === 'schedule_booked')
    assert.equal(booked.actor_type, 'customer')
    assert.equal(booked.metadata.start_date, D(10))
    assert.ok(!(await events(leadId)).some((e: any) => e.event_type === 'schedule_date_requested'))
  })
}

test('the shop is notified that a customer booked, once', async () => {
  await resetShop()
  const { leadId, token } = await approvedLead()
  await book(token, D(12))
  const kinds = await notificationKinds(leadId)
  assert.equal(kinds.filter((k: string) => k === 'date_booked').length, 1)
  assert.ok(!kinds.includes('date_requested'), 'not described as a pending request')
  assert.ok(!kinds.includes('status_changed'), "the customer's move to Scheduled isn't a separate staff notification")
  const inbox = (await db.query(`SELECT user_id FROM notifications WHERE lead_id = $1 AND kind = 'date_booked'`, [leadId])).rows
  assert.deepEqual(inbox.map((r: any) => r.user_id).sort(), [ids.userA, ids.userA2].sort(), 'every staff member of the shop')
  assert.equal(await count(`notifications WHERE lead_id = $1 AND user_id = $2`, [leadId, ids.userB]), 0, 'never another shop')

  const payload = await one(db, `SELECT public.notification_delivery_payload(d) AS p FROM notification_deliveries d
    JOIN notification_events e ON e.id = d.event_id WHERE e.lead_id = $1 AND e.kind = 'date_booked' AND d.channel = 'push'`, [leadId])
  assert.deepEqual([payload.p.notification.title, payload.p.notification.body], ['Production date booked', 'A customer booked a production date.'])
  assert.equal(await count(`notification_deliveries d JOIN notification_events e ON e.id = d.event_id
    WHERE e.lead_id = $1 AND e.kind = 'date_booked' AND d.channel = 'email'`, [leadId]), 0, 'push and in-app only, like date requests')
})

test('double clicks, retries and lost responses never duplicate the booking, history or notifications', async () => {
  await resetShop()
  const { leadId, token } = await approvedLead()
  assert.equal((await book(token, D(8))).already_booked, false)
  const snapshot = async () => ({
    reservations: await count(`schedule_reservations WHERE lead_id = $1`, [leadId]),
    events: await count(`lead_events WHERE lead_id = $1`, [leadId]),
    notifications: await count(`notification_events WHERE lead_id = $1`, [leadId]),
    version: await version(leadId),
  })
  const after = await snapshot()
  for (let i = 0; i < 3; i++) {
    const retry = await book(token, D(8))
    assert.deepEqual([retry.ok, retry.already_booked, retry.start_date], [true, true, D(8)])
  }
  assert.deepEqual(await snapshot(), after)
  assert.equal((await book(token, D(9))).error, 'already_scheduled', 'a different date is not a second booking')
  assert.deepEqual(await snapshot(), after)
})

test('blocked, past and out-of-window days cannot be booked; green and yellow days can, and may be shared', async () => {
  await resetShop()
  await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.set_schedule_booking_window($1, 14)`, [ids.shopA]))
  await setBlocked('shopA', D(5), D(5), true)
  const first = await approvedLead()
  assert.equal((await book(first.token, D(5))).error, 'date_blocked')
  assert.equal((await book(first.token, D(0))).error, 'date_passed')
  assert.equal((await book(first.token, D(-2))).error, 'date_passed')
  assert.equal((await book(first.token, D(15))).error, 'outside_window')
  assert.equal((await book(first.token, null)).error, 'invalid_date')
  assert.equal(await activeReservation(first.leadId), undefined)
  assert.equal((await book(first.token, D(6))).ok, true, 'a green day')

  // A day that already has a confirmed job (yellow) is still bookable.
  const second = await approvedLead()
  assert.equal((await book(second.token, D(6))).ok, true)
  assert.equal(await count(`schedule_reservations WHERE shop_id = $1 AND status = 'active' AND start_date = $2`, [ids.shopA, D(6)]), 2)
  assert.equal(await count(`shop_blocked_dates WHERE shop_id = $1`, [ids.shopA]), 1, 'nothing is blocked automatically')

  // Booking takes the shop's shared availability lock.
  const key = (await one(db, `SELECT public.schedule_availability_lock_key($1)::text AS k`, [ids.shopA])).k
  const third = await approvedLead()
  const locks = await as(db, anon, async (tx: any) => {
    await tx.query(`SELECT public.book_schedule_date($1, $2::date)`, [third.token, D(7)])
    return (await tx.query(`SELECT mode, ((classid::bigint << 32) | objid::bigint)::text AS key FROM pg_locks
      WHERE locktype = 'advisory' AND objsubid = 1`)).rows
  })
  assert.deepEqual(locks.filter((l: any) => l.key === key).map((l: any) => l.mode), ['ShareLock'])
})

test('booking enforces the current approved quote, the token, the project status and staff preview', async () => {
  await resetShop()
  // Not yet approved.
  const leadId = await newLead('shopA')
  const q = await createQuote(leadId, 'userA', 500)
  await sendQuote(q.id, 'userA')
  assert.equal((await book(q.public_token, D(5))).error, 'quote_not_approved')
  // Unknown token.
  assert.equal((await book('00000000-0000-4000-8000-000000000000', D(5))).error, 'not_found')
  assert.equal((await book(null, D(5))).error, 'not_found')

  // Superseded quote link.
  const approved = await approvedLead()
  const rev = await createQuote(approved.leadId, 'userA', 1200, approved.quote.id)
  await sendQuote(rev.id, 'userA')
  assert.equal((await book(approved.token, D(5))).error, 'superseded')
  assert.equal((await book(rev.public_token, D(5))).error, 'quote_not_approved')

  // Staff previewing the customer link (any shop's staff or an admin).
  const preview = await approvedLead()
  for (const who of [staff('userA'), staff('admin')]) assert.equal((await book(preview.token, D(5), who)).error, 'staff_preview')
  assert.equal(await activeReservation(preview.leadId), undefined)

  // Closed projects.
  const lost = await approvedLead()
  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [lost.leadId]))
  assert.equal((await book(lost.token, D(5))).error, 'not_available')
  assert.equal((await publicSchedule(lost.token)).calendar, null)

  // Active offered dates keep the existing offer flow.
  const offered = await approvedLead()
  const v = await version(offered.leadId)
  const draft = await as(db, staff('userA'), async (tx: any) =>
    one(tx, `SELECT public.create_schedule_offer($1, $2, $3::date[], null) AS r`, [offered.leadId, v, [D(9)]])).then((r: any) => r.r)
  await as(db, service, async (tx: any) => tx.query(`SELECT public.mark_schedule_offer_sent($1, $2)`, [draft.offer_id, ids.userA]))
  assert.equal((await book(offered.token, D(5))).error, 'use_offered_dates')
})

test("one shop's availability never affects another shop's customers", async () => {
  await resetShop('shopA')
  await resetShop('shopB')
  await setBlocked('shopA', D(4), D(4), true)
  const b = await approvedLead('shopB')
  assert.equal((await book(b.token, D(4))).ok, true)
  const res = await activeReservation(b.leadId)
  assert.equal(res.shop_id, ids.shopB)
  // Shop A staff can't see shop B's new booking.
  const seen = await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT * FROM schedule_reservations WHERE id = $1`, [res.id]))
  assert.equal(seen.rows.length, 0)
})

test('customers cannot write schedule or deposit rows directly', async () => {
  const { leadId } = await approvedLead()
  for (const sql of [
    `INSERT INTO schedule_reservations (lead_id, shop_id, quote_id, quote_revision_number, start_date) VALUES ('${leadId}', '${ids.shopA}', '${leadId}', 1, current_date)`,
    `INSERT INTO lead_deposits (lead_id, shop_id, requested, received_at) VALUES ('${leadId}', '${ids.shopA}', true, now())`,
    `UPDATE lead_deposits SET received_at = now()`,
    `SELECT * FROM lead_deposits`,
    `SELECT * FROM shop_deposit_settings`,
    `SELECT public.set_deposit_received('${leadId}', true)`,
    `SELECT public.set_lead_deposit('${leadId}', true, null, null, 'x')`,
    `SELECT public.set_schedule_ready_date('${leadId}', 0, current_date)`,
    `SELECT public.set_shop_deposit_settings('${ids.shopA}', false, null, null, null)`,
    `SELECT public.deposit_snapshot_for_booking('${leadId}', '${ids.shopA}')`,
  ]) {
    await assert.rejects(as(db, anon, async (tx: any) => tx.query(sql)), /permission denied/, sql)
  }
  for (const sql of [
    `UPDATE lead_deposits SET received_at = now()`,
    `INSERT INTO shop_deposit_settings (shop_id, enabled) VALUES ('${ids.shopA}', false)`,
    `UPDATE schedule_reservations SET estimated_ready_date = current_date + 30`,
  ]) {
    await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(sql)), /permission denied/, sql)
  }
})

// ---------------------------------------------------------------------------
// Estimated-ready date set later
// ---------------------------------------------------------------------------

test('staff set the ready estimate later as an edit, and the calendar spans start to ready', async () => {
  await resetShop()
  const { leadId, token } = await approvedLead()
  await book(token, D(10))

  // The shop calendar's query (src/lib/calendarContext.ts loadShopCalendar):
  // an unestimated booking shows on its start date only.
  const calendar = (from: string, to: string) => as(db, staff('userA'), async (tx: any) => (await tx.query(
    `SELECT lead_id FROM schedule_reservations WHERE shop_id = $1 AND status = 'active' AND start_date <= $3
       AND (estimated_ready_date >= $2 OR (estimated_ready_date IS NULL AND start_date >= $2))`,
    [ids.shopA, from, to])).rows.map((r: any) => r.lead_id))
  assert.ok((await calendar(D(10), D(10))).includes(leadId))
  assert.ok(!(await calendar(D(11), D(13))).includes(leadId), 'no invented span before an estimate exists')

  await assert.rejects(setReady(leadId, 'userA', D(9)), /on or after the start date/)
  await assert.rejects(setReady(leadId, 'userA', null), /on or after the start date/)
  await assert.rejects(setReady(leadId, 'userB', D(14)), /Lead not found/)
  const before = await version(leadId)
  assert.equal((await setReady(leadId, 'userA', D(14))).ok, true)
  assert.equal(await version(leadId), before + 1)
  const res = await activeReservation(leadId)
  assert.deepEqual([dateText(res.start_date), dateText(res.estimated_ready_date), res.confirmed_by], [D(10), D(14), null],
    'an edit, not another confirmation')
  assert.ok((await calendar(D(12), D(13))).includes(leadId), 'now spans start through ready')
  assert.deepEqual((await publicSchedule(token)).booking, { start_date: D(10), estimated_ready_date: D(14) })
  const ev = (await events(leadId)).find((e: any) => e.event_type === 'schedule_ready_date_set')
  assert.deepEqual([ev.actor_id, ev.metadata.estimated_ready_date, ev.metadata.previous_estimated_ready_date], [ids.userA, D(14), null])
  assert.equal((await setReady(leadId, 'userA', D(14))).unchanged, true)

  // A stale version is refused; cancelled bookings can't be edited.
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.set_schedule_ready_date($1, $2, $3::date)`,
    [leadId, before, D(15)])), /changed since you loaded it/)
  const v = await version(leadId)
  await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.cancel_schedule($1, $2, null)`, [leadId, v]))
  await assert.rejects(setReady(leadId, 'userA', D(16)), /no confirmed schedule/)
  await assert.rejects(db.query(`UPDATE schedule_reservations SET estimated_ready_date = $2 WHERE lead_id = $1`, [leadId, D(20)]),
    /cannot be rewritten/, 'ended bookings stay as they were')
})

// Shop C's trial expired, so it is read-only; this briefly makes it active.
const setShopCActive = (active: boolean) =>
  db.query(`UPDATE shops SET subscription_status = $2 WHERE id = $1`, [ids.shopC, active ? 'active' : 'trial'])

test('read-only shops take no new bookings, without exposing why', async () => {
  await resetShop('shopC')
  const { leadId, token } = await approvedLead('shopC')
  assert.equal((await one(db, `SELECT public.schedule_shop_is_read_only($1) AS r`, [ids.shopC])).r, true)
  const before = await leadStatus(leadId)
  const eventsBefore = await count(`lead_events WHERE lead_id = $1`, [leadId])
  const notificationsBefore = await count(`notification_events WHERE lead_id = $1`, [leadId])

  const pub = await publicSchedule(token)
  assert.deepEqual([pub.calendar, pub.booking_unavailable, pub.can_request], [null, true, false], 'no calendar, a generic flag')
  for (const word of ['trial', 'billing', 'subscription', 'read-only', 'read_only']) assert.ok(!JSON.stringify(pub).includes(word), word)

  for (let i = 0; i < 2; i++) {
    const r = await book(token, D(5))
    assert.deepEqual([r.ok, r.error], [false, 'booking_unavailable'])
  }
  assert.equal(await activeReservation(leadId), undefined, 'no reservation')
  assert.equal(await leadStatus(leadId), before, 'no move to Scheduled')
  assert.equal(await count(`lead_events WHERE lead_id = $1`, [leadId]), eventsBefore, 'no booking or status-change event')
  assert.ok(!(await events(leadId)).some((e: any) => e.event_type === 'schedule_booked'))
  assert.equal(await count(`notification_events WHERE lead_id = $1`, [leadId]), notificationsBefore, 'no notification')
  assert.ok(!(await notificationKinds(leadId)).includes('date_booked'))

  // An eligible shop still books normally.
  await resetShop('shopB')
  const eligible = await approvedLead('shopB')
  assert.equal((await publicSchedule(eligible.token)).booking_unavailable, false)
  assert.equal((await book(eligible.token, D(5))).ok, true)
  assert.equal(await leadStatus(eligible.leadId), 'scheduled')
})

test('a booking made while the shop was active survives it becoming read-only, and retries stay safe', async () => {
  await resetShop('shopC')
  const { leadId, token } = await approvedLead('shopC')
  await setShopCActive(true)
  try {
    assert.equal((await book(token, D(6))).ok, true)
  } finally {
    await setShopCActive(false)
  }
  const snapshot = async () => ({
    reservations: await count(`schedule_reservations WHERE lead_id = $1`, [leadId]),
    events: await count(`lead_events WHERE lead_id = $1`, [leadId]),
    notifications: await count(`notification_events WHERE lead_id = $1`, [leadId]),
  })
  const after = await snapshot()
  const retry = await book(token, D(6))
  assert.deepEqual([retry.ok, retry.already_booked], [true, true], 'a retry of the successful booking still succeeds')
  assert.deepEqual(await snapshot(), after, 'and changes nothing')
  assert.equal((await book(token, D(7))).error, 'already_scheduled')
  const pub = await publicSchedule(token)
  assert.deepEqual([pub.booking?.start_date, pub.booking_unavailable], [D(6), false], 'the existing booking is still shown')
  assert.equal(await leadStatus(leadId), 'scheduled')
})

test('read-only shops cannot set ready dates or deposits; admins can', async () => {
  await resetShop('shopC')
  const { leadId, token } = await approvedLead('shopC')
  await setShopCActive(true)
  try {
    assert.equal((await book(token, D(5))).ok, true)
  } finally {
    await setShopCActive(false)
  }
  await assert.rejects(setReady(leadId, 'userC', D(7)), /read-only/)
  await assert.rejects(setLeadDeposit(leadId, true, null, null, 'Pay at pickup', 'userC'), /read-only/)
  await assert.rejects(setShopDeposit('shopC', false, null, null, null), /permission denied/, 'shop-wide defaults are retired')
  assert.equal((await setReady(leadId, 'admin', D(7))).ok, true)
  assert.equal((await setLeadDeposit(leadId, true, null, null, 'Pay at pickup', 'admin')).ok, true)
  await assert.rejects(setReceived(leadId, true, staff('userC')), /read-only/)
})

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

test('quote deposits are off by default; when on, booking copies this quote’s request for the customer', async () => {
  await resetShop()
  const off = await approvedLead()
  assert.equal(off.quote.deposit_requested, false, 'off by default for new quotes')
  await book(off.token, D(5))
  assert.equal((await publicSchedule(off.token)).deposit, null)
  assert.equal(await leadDeposit(off.leadId), undefined, 'not required')

  const on = await approvedLead('shopA', true, 'Customer',
    { url: 'https://pay.example.com/shop-a?ref=deposit', amount: 150, instructions: 'Pay within 3 days to hold your date.' })
  await book(on.token, D(6))
  const pub = await publicSchedule(on.token)
  assert.deepEqual(pub.booking, { start_date: D(6), estimated_ready_date: null }, 'the booking comes first')
  assert.deepEqual(pub.deposit, {
    status: 'awaiting', amount: 150, payment_url: 'https://pay.example.com/shop-a?ref=deposit', instructions: 'Pay within 3 days to hold your date.',
  })
  for (const secret of ['received_by', 'updated_by', ids.userA]) assert.ok(!JSON.stringify(pub).includes(secret), secret)
  const row = await leadDeposit(on.leadId)
  assert.deepEqual([row.requested, row.source, row.quote_id], [true, 'quote', on.quote.id])
  assert.ok((await events(on.leadId)).find((e: any) => e.event_type === 'schedule_booked').metadata.deposit_requested)
  assert.equal((await publicSchedule(off.token)).deposit, null, 'another booking never gets it')
  // Customers returning to their link still see it.
  assert.equal((await publicSchedule(on.token)).deposit.payment_url, 'https://pay.example.com/shop-a?ref=deposit')
})

test('no fallback to shop-wide defaults: a quote with the deposit off books without one', async () => {
  await resetShop()
  await legacyShopDefault('shopA', 'https://pay.example.com/shop-wide')
  const off = await approvedLead()
  assert.equal((await book(off.token, D(5))).ok, true)
  assert.equal(await leadStatus(off.leadId), 'scheduled')
  assert.equal((await publicSchedule(off.token)).deposit, null, 'no deposit request or payment button')
  assert.equal(await leadDeposit(off.leadId), undefined)
  assert.equal((await events(off.leadId)).find((e: any) => e.event_type === 'schedule_booked').metadata.deposit_requested, false)

  const on = await approvedLead('shopA', true, 'Customer', { url: 'https://invoices.example.com/inv/77' })
  await book(on.token, D(6))
  const pub = await publicSchedule(on.token)
  assert.deepEqual([pub.deposit.payment_url, pub.deposit.amount, pub.deposit.instructions], ['https://invoices.example.com/inv/77', null, null],
    'only this quote’s details; nothing filled in from the shop-wide row')
  await assert.rejects(setShopDeposit('shopA', true, 'https://pay.example.com/x', null, null), /permission denied/)
  await assert.rejects(setShopDeposit('shopA', true, 'https://pay.example.com/x', null, null, 'admin'), /permission denied/)
})

test('different customers and quotes keep their own payment links', async () => {
  await resetShop()
  const a = await approvedLead('shopA', true, 'Alex', { url: 'https://invoices.example.com/inv/A-1', amount: 100 })
  const b = await approvedLead('shopA', false, 'Blair', { url: 'https://checkout.stripe.com/c/pay/cs_test_B2', amount: 250 })
  const c = await approvedLead('shopA', true, 'Casey')
  const other = await approvedLead('shopB', true, 'Dana', { url: 'https://pay.example.org/shop-b/inv/9' })
  for (const [lead, date] of [[a, 5], [b, 6], [c, 7], [other, 8]] as const) assert.equal((await book(lead.token, D(date))).ok, true)
  assert.deepEqual([(await publicSchedule(a.token)).deposit.payment_url, (await publicSchedule(a.token)).deposit.amount],
    ['https://invoices.example.com/inv/A-1', 100])
  assert.deepEqual([(await publicSchedule(b.token)).deposit.payment_url, (await publicSchedule(b.token)).deposit.amount],
    ['https://checkout.stripe.com/c/pay/cs_test_B2', 250])
  assert.equal((await publicSchedule(c.token)).deposit, null)
  assert.equal((await publicSchedule(other.token)).deposit.payment_url, 'https://pay.example.org/shop-b/inv/9')

  // A new quote starts off: nothing is copied from another customer's quote.
  const fresh = await createQuote(await newLead('shopA'), 'userA', 500)
  assert.deepEqual([fresh.deposit_requested, fresh.deposit_payment_url, fresh.deposit_amount], [false, null, null])
  // Staff of another shop can't read or change this shop's quote deposit.
  assert.equal(await setQuoteDeposit(fresh.id, 'userB', true, { url: 'https://evil.example.com/pay' }), undefined, 'RLS: no row updated')
  assert.equal((await quoteRow(fresh.id)).deposit_requested, false)
  const visible = await as(db, staff('userB'), async (tx: any) => (await tx.query(`SELECT id FROM quotes WHERE id = $1`, [fresh.id])).rows)
  assert.equal(visible.length, 0)
})

test('a draft keeps its deposit settings when reopened; off clears them', async () => {
  await resetShop()
  const leadId = await newLead('shopA')
  const q = await createQuote(leadId, 'userA', 800)
  await setQuoteDeposit(q.id, 'userA', true, { url: '  https://invoices.example.com/inv/5001  ', amount: 200, instructions: '  Pay within 3 days.  ' })
  // Reopening the draft (a fresh read) restores the saved, trimmed values.
  const saved = await quoteRow(q.id)
  assert.deepEqual([saved.status, saved.deposit_requested, saved.deposit_payment_url, Number(saved.deposit_amount), saved.deposit_instructions],
    ['draft', true, 'https://invoices.example.com/inv/5001', 200, 'Pay within 3 days.'])
  // The rest of the draft saves in the same update without touching it.
  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE quotes SET customer_notes = 'See you soon' WHERE id = $1`, [q.id]))
  assert.equal((await quoteRow(q.id)).deposit_payment_url, 'https://invoices.example.com/inv/5001')

  await setQuoteDeposit(q.id, 'userA', false, { url: 'https://invoices.example.com/inv/5001', amount: 200 })
  const off = await quoteRow(q.id)
  assert.deepEqual([off.deposit_requested, off.deposit_payment_url, off.deposit_amount, off.deposit_instructions], [false, null, null, null])
})

test('invalid or missing links fail the save, and a failed save leaves the quote unsendable as requested', async () => {
  await resetShop()
  const leadId = await newLead('shopA')
  const q = await createQuote(leadId, 'userA', 800)
  for (const bad of ['http://pay.example.com/x', 'javascript:alert(1)', 'https://user:pass@pay.example.com/x', 'https://pay.example.com/a b', 'ftp://pay.example.com']) {
    await assert.rejects(setQuoteDeposit(q.id, 'userA', true, { url: bad }), /secure payment link/, bad)
  }
  await assert.rejects(setQuoteDeposit(q.id, 'userA', true, { url: null, instructions: 'Pay at drop-off' }), /payment link/)
  await assert.rejects(setQuoteDeposit(q.id, 'userA', true, { url: 'https://pay.example.com/x', amount: 0 }), /deposit amount/)
  const after = await quoteRow(q.id)
  assert.deepEqual([after.deposit_requested, after.deposit_payment_url], [false, null], 'nothing was saved')
  // Bypassing the column checks is impossible too: the table constraint holds.
  await assert.rejects(db.query(`UPDATE quotes SET deposit_requested = true, deposit_payment_url = NULL WHERE id = $1`, [q.id]), /payment link|check constraint/)
})

test('a sent quote’s deposit request is locked; revising never rewrites a booked or received deposit', async () => {
  await resetShop()
  const first = await approvedLead('shopA', true, 'Customer', { url: 'https://invoices.example.com/inv/R1', amount: 100 })
  // Even a privileged write can't change a sent quote's deposit terms.
  await assert.rejects(db.query(`UPDATE quotes SET deposit_payment_url = 'https://invoices.example.com/other' WHERE id = $1`, [first.quote.id]),
    /sent quote cannot be changed/)
  assert.equal(await setQuoteDeposit(first.quote.id, 'userA', false), undefined, 'staff cannot update a sent quote (RLS)')
  await book(first.token, D(5))
  await setReceived(first.leadId, true)

  // Revise: new terms on Quote #2, sent and approved.
  const r2 = await createQuote(first.leadId, 'userA', 950, first.quote.id)
  assert.equal(r2.revision_number, 2)
  await setQuoteDeposit(r2.id, 'userA', true, { url: 'https://invoices.example.com/inv/R2', amount: 400 })
  await sendQuote(r2.id, 'userA')
  assert.equal((await approve(r2.public_token)).ok, true)
  const pub = await publicSchedule(r2.public_token)
  assert.deepEqual([pub.deposit.status, pub.deposit.amount, pub.deposit.payment_url], ['received', 100, 'https://invoices.example.com/inv/R1'],
    'the booked, received deposit is untouched')
  const row = await leadDeposit(first.leadId)
  assert.deepEqual([row.quote_id, row.received_at !== null], [first.quote.id, true])
  assert.deepEqual([(await quoteRow(first.quote.id)).deposit_payment_url, Number((await quoteRow(first.quote.id)).deposit_amount)],
    ['https://invoices.example.com/inv/R1', 100], 'the sent revision keeps its own terms')
})

test('before booking, the booked revision’s deposit request is the one used', async () => {
  await resetShop()
  const first = await approvedLead('shopA', true, 'Customer', { url: 'https://invoices.example.com/inv/V1', amount: 100 })
  // Revised to drop the deposit, then booked: no deposit request.
  const r2 = await createQuote(first.leadId, 'userA', 950, first.quote.id)
  await sendQuote(r2.id, 'userA')
  assert.equal((await approve(r2.public_token)).ok, true)
  assert.equal((await book(r2.public_token, D(6))).ok, true)
  assert.equal((await publicSchedule(r2.public_token)).deposit, null)

  // Another lead revised from no deposit to a new link: the new link is used.
  const plain = await approvedLead()
  const p2 = await createQuote(plain.leadId, 'userA', 990, plain.quote.id)
  await setQuoteDeposit(p2.id, 'userA', true, { url: 'https://invoices.example.com/inv/V2' })
  await sendQuote(p2.id, 'userA')
  await approve(p2.public_token)
  await book(p2.public_token, D(7))
  assert.equal((await publicSchedule(p2.public_token)).deposit.payment_url, 'https://invoices.example.com/inv/V2')
  assert.equal((await leadDeposit(plain.leadId)).quote_id, p2.id)
})

test('a deposit set on the lead takes precedence over the quote, before or after booking', async () => {
  await resetShop()
  // Before booking: a customer-specific invoice link set on the lead.
  const invoiced = await approvedLead('shopA', true, 'Customer', { url: 'https://pay.example.com/from-quote', amount: 100 })
  await setLeadDeposit(invoiced.leadId, true, 'https://invoices.example.com/inv/12345', 425.5, 'Invoice #12345.')
  assert.equal((await publicSchedule(invoiced.token)).deposit, null, 'shown only once booked')
  await book(invoiced.token, D(7))
  assert.deepEqual((await publicSchedule(invoiced.token)).deposit,
    { status: 'awaiting', amount: 425.5, payment_url: 'https://invoices.example.com/inv/12345', instructions: 'Invoice #12345.' })

  // After booking: staff correct an outstanding link.
  const booked = await approvedLead('shopA', true, 'Customer', { url: 'https://pay.example.com/default', amount: 100 })
  await book(booked.token, D(8))
  assert.equal((await setLeadDeposit(booked.leadId, true, 'https://pay.example.com/corrected', 100, null)).ok, true)
  assert.equal((await publicSchedule(booked.token)).deposit.payment_url, 'https://pay.example.com/corrected')
  const ev = (await events(booked.leadId)).filter((e: any) => e.event_type === 'deposit_updated').at(-1)
  assert.deepEqual([ev.actor_id, ev.metadata.changed], [ids.userA, ['payment_url']])
  assert.equal((await setLeadDeposit(booked.leadId, true, 'https://pay.example.com/corrected', 100, null)).unchanged, true)

  // Turning the request off for one lead.
  await setLeadDeposit(booked.leadId, false, null, null, null)
  assert.equal((await publicSchedule(booked.token)).deposit, null)
  await assert.rejects(setLeadDeposit(booked.leadId, true, null, null, null, 'userB'), /Lead not found/)

  // Requesting a deposit later, after a booking made without one.
  const later = await approvedLead()
  await book(later.token, D(9))
  assert.equal((await publicSchedule(later.token)).deposit, null)
  assert.equal((await setLeadDeposit(later.leadId, true, 'https://invoices.example.com/inv/late', 80, null)).ok, true)
  assert.deepEqual([(await publicSchedule(later.token)).deposit.status, (await publicSchedule(later.token)).deposit.payment_url],
    ['awaiting', 'https://invoices.example.com/inv/late'])
})

test('payment links must be safe https URLs, on the server', async () => {
  await resetShop()
  const { leadId } = await approvedLead()
  const draft = await createQuote(await newLead('shopA'), 'userA', 300)
  for (const bad of [
    'http://pay.example.com/x', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'https://user:pass@pay.example.com/x',
    'https://pay@example.com', 'https://pay.example.com/a b', 'https://localhost/pay', 'ftp://pay.example.com',
    ' https://pay.example.com/<script>', 'https://pay.example.com/"onmouseover', 'HTTPS://', 'https://.example.com',
  ]) {
    await assert.rejects(setLeadDeposit(leadId, true, bad, null, null), /secure payment link/, bad)
    await assert.rejects(setQuoteDeposit(draft.id, 'userA', true, { url: bad }), /secure payment link/, bad)
  }
  for (const good of ['https://pay.example.com', 'https://checkout.stripe.com/c/pay/cs_test_a1#fid=x', 'https://example.co.uk:8443/p?a=1&b=@x']) {
    assert.equal((await setLeadDeposit(leadId, true, good, null, null)).ok, true, good)
    assert.equal((await setQuoteDeposit(draft.id, 'userA', true, { url: good })).deposit_payment_url, good)
  }
  for (const amount of [0, -5, 1000001, 10.005]) {
    await assert.rejects(setLeadDeposit(leadId, true, null, amount, 'x'), /deposit amount/, String(amount))
  }
})

test('only shop staff confirm receipt, and history records who', async () => {
  await resetShop()
  const { leadId, token } = await approvedLead('shopA', true, 'Customer', { url: 'https://pay.example.com/a', amount: 200 })
  await book(token, D(9))
  await assert.rejects(setReceived(leadId, true, staff('userB')), /Lead not found/)
  await assert.rejects(setReceived(leadId, true, anon), /permission denied/)
  assert.equal((await leadDeposit(leadId)).received_at, null, 'a payment-link click is never proof of payment')

  assert.equal((await setReceived(leadId, true, staff('userA2'))).ok, true)
  const row = await leadDeposit(leadId)
  assert.equal(row.received_by, ids.userA2)
  assert.equal((await publicSchedule(token)).deposit.status, 'received')
  assert.equal(await leadStatus(leadId), 'scheduled', 'deposit status is separate from the project status')
  const received = (await events(leadId)).find((e: any) => e.event_type === 'deposit_received')
  assert.deepEqual([received.actor_type, received.actor_id], ['shop_user', ids.userA2])
  assert.equal((await setReceived(leadId, true)).unchanged, true)
  await assert.rejects(setLeadDeposit(leadId, false, null, null, null), /Undo that/)

  assert.equal((await setReceived(leadId, false)).ok, true)
  assert.equal((await publicSchedule(token)).deposit.status, 'awaiting')
  assert.ok((await events(leadId)).some((e: any) => e.event_type === 'deposit_receipt_undone'))
  const none = await approvedLead()
  await assert.rejects(setReceived(none.leadId, true), /No deposit is requested/)
  assert.equal((await setReceived(leadId, true, staff('admin'))).ok, true, 'admins can confirm too')
})

test('a received deposit amount cannot silently change; links and instructions can be corrected', async () => {
  await resetShop()
  // The reproduction: request $100, book, mark received, change to $900.
  const { leadId, token } = await approvedLead('shopA', true, 'Customer',
    { url: 'https://pay.example.com/a', amount: 100, instructions: 'Pay to hold your date.' })
  await book(token, D(9))
  await setReceived(leadId, true)
  const row = await leadDeposit(leadId)

  for (const amount of [900, 100.01, null]) {
    await assert.rejects(setLeadDeposit(leadId, true, 'https://pay.example.com/a', amount, 'Pay to hold your date.'),
      /marked as received, so its amount can't change/, String(amount))
  }
  const pub = await publicSchedule(token)
  assert.deepEqual([pub.deposit.status, pub.deposit.amount], ['received', 100], 'still the amount that was received')
  const unchanged = await leadDeposit(leadId)
  assert.deepEqual([Number(unchanged.amount), unchanged.received_at?.toString(), unchanged.received_by],
    [100, row.received_at?.toString(), row.received_by])
  assert.equal(await count(`lead_events WHERE lead_id = $1 AND event_type = 'deposit_updated'`, [leadId]), 0, 'refusals record nothing')

  // The same amount with a corrected link and instructions is fine.
  assert.equal((await setLeadDeposit(leadId, true, 'https://pay.example.com/corrected', 100, 'Thanks — received.')).ok, true)
  const corrected = await publicSchedule(token)
  assert.deepEqual([corrected.deposit.status, corrected.deposit.amount, corrected.deposit.payment_url, corrected.deposit.instructions],
    ['received', 100, 'https://pay.example.com/corrected', 'Thanks — received.'])

  // Undo the receipt explicitly, then the amount can change.
  await setReceived(leadId, false)
  assert.equal((await setLeadDeposit(leadId, true, 'https://pay.example.com/corrected', 900, null)).ok, true)
  assert.deepEqual([(await publicSchedule(token)).deposit.status, (await publicSchedule(token)).deposit.amount], ['awaiting', 900])

  // A deposit received with no amount can't gain one either.
  const noAmount = await approvedLead()
  await setLeadDeposit(noAmount.leadId, true, null, null, 'Pay at drop-off.')
  await book(noAmount.token, D(10))
  await setReceived(noAmount.leadId, true)
  await assert.rejects(setLeadDeposit(noAmount.leadId, true, null, 50, 'Pay at drop-off.'), /amount can't change/)
  assert.equal((await publicSchedule(noAmount.token)).deposit.amount, null)
})

test('deposit configuration problems never block or undo a booking', async () => {
  await resetShop()
  await db.exec(`
    CREATE FUNCTION public.test_fail_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated deposit failure'; END $$;
    CREATE TRIGGER test_fail_deposit BEFORE INSERT ON public.lead_deposits FOR EACH ROW EXECUTE FUNCTION public.test_fail_deposit();
  `)
  try {
    const { leadId, token } = await approvedLead('shopA', true, 'Customer', { url: 'https://pay.example.com/a', amount: 50 })
    const r = await book(token, D(11))
    assert.equal(r.ok, true)
    assert.ok(await activeReservation(leadId))
    assert.equal(await leadStatus(leadId), 'scheduled')
    assert.equal((await publicSchedule(token)).deposit, null)
    assert.equal((await events(leadId)).find((e: any) => e.event_type === 'schedule_booked').metadata.deposit_requested, false)
  } finally {
    await db.exec(`DROP TRIGGER test_fail_deposit ON public.lead_deposits; DROP FUNCTION public.test_fail_deposit();`)
  }

  // A notification failure is isolated too (existing enqueue guard).
  await db.exec(`
    CREATE FUNCTION public.test_fail_notify() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated notification failure'; END $$;
    CREATE TRIGGER test_fail_notify BEFORE INSERT ON public.notification_events FOR EACH ROW EXECUTE FUNCTION public.test_fail_notify();
  `)
  try {
    const { leadId, token } = await approvedLead()
    assert.equal((await book(token, D(12))).ok, true)
    assert.ok(await activeReservation(leadId))
  } finally {
    await db.exec(`DROP TRIGGER test_fail_notify ON public.notification_events; DROP FUNCTION public.test_fail_notify();`)
  }
})

// ---------------------------------------------------------------------------
// Legacy behavior
// ---------------------------------------------------------------------------

test('pending requests from the request flow stay actionable; a customer booking replaces their own', async () => {
  await resetShop()
  const legacy = await approvedLead()
  assert.equal((await as(db, anon, async (tx: any) => one(tx, `SELECT public.request_schedule_calendar_date($1, $2::date) AS r`,
    [legacy.token, D(6)]))).r.ok, true)
  const pending = await one(db, `SELECT * FROM schedule_requests WHERE lead_id = $1 AND status = 'pending'`, [legacy.leadId])
  assert.equal(await leadStatus(legacy.leadId), 'scheduling')
  // Staff can still confirm it with a ready date.
  const v = await version(legacy.leadId)
  assert.equal((await as(db, staff('userA'), async (tx: any) => one(tx, `SELECT public.confirm_schedule($1, $2, $3::date, null) AS r`,
    [pending.id, v, D(8)]))).r.ok, true)
  assert.deepEqual([dateText((await activeReservation(legacy.leadId)).estimated_ready_date), (await activeReservation(legacy.leadId)).source],
    [D(8), 'staff'])

  // Another customer with a pending request books instead.
  const switching = await approvedLead()
  await as(db, anon, async (tx: any) => tx.query(`SELECT public.request_schedule_calendar_date($1, $2::date)`, [switching.token, D(6)]))
  assert.equal((await book(switching.token, D(7))).ok, true)
  assert.deepEqual((await db.query(`SELECT status FROM schedule_requests WHERE lead_id = $1`, [switching.leadId])).rows.map((r: any) => r.status),
    ['replaced'])
  assert.equal(dateText((await activeReservation(switching.leadId)).start_date), D(7))
})

test('staff can still reschedule and cancel a customer booking', async () => {
  await resetShop()
  const { leadId, token } = await approvedLead()
  await book(token, D(5))
  const original = await activeReservation(leadId)
  let v = await version(leadId)
  const draft = await as(db, staff('userA'), async (tx: any) =>
    one(tx, `SELECT public.create_schedule_offer($1, $2, $3::date[], null) AS r`, [leadId, v, [D(20)]])).then((r: any) => r.r)
  await as(db, service, async (tx: any) => tx.query(`SELECT public.mark_schedule_offer_sent($1, $2)`, [draft.offer_id, ids.userA]))
  const option = (await publicSchedule(token)).offer.options[0]
  await as(db, anon, async (tx: any) => tx.query(`SELECT public.request_schedule_date($1, $2)`, [token, option.id]))
  const req = await one(db, `SELECT id FROM schedule_requests WHERE lead_id = $1 AND status = 'pending'`, [leadId])
  v = await version(leadId)
  await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.confirm_schedule($1, $2, $3::date, null)`, [req.id, v, D(24)]))
  assert.equal((await one(db, `SELECT status FROM schedule_reservations WHERE id = $1`, [original.id])).status, 'replaced')
  v = await version(leadId)
  await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.cancel_schedule($1, $2, 'Customer asked')`, [leadId, v]))
  assert.equal(await leadStatus(leadId), 'scheduling')
  // After cancelling, the customer can book again from the calendar.
  assert.equal((await book(token, D(9))).ok, true)
})

// ---------------------------------------------------------------------------
// One quote link, start to finish (what the customer page does in one tab)
// ---------------------------------------------------------------------------

test('one link: a sent, unapproved quote is approved, booked and shows the deposit, with questions along the way', async () => {
  await resetShop()
  const leadId = await newLead('shopA')
  const q = await createQuote(leadId, 'userA', 900)
  // Set while completing the quote, before sending.
  await setQuoteDeposit(q.id, 'userA', true, { url: 'https://pay.example.com/one-link', amount: 200 })
  await sendQuote(q.id, 'userA')
  const token = q.public_token as string
  const publicQuote = () => as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_quote($1) AS r`, [token])).then((r: any) => r.r)
  const ask = (body: string) =>
    as(db, anon, async (tx: any) => one(tx, `SELECT public.send_public_quote_message($1, $2) AS r`, [token, body])).then((r: any) => r.r)
  const thread = () => as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_quote_messages($1) AS r`, [token])).then((r: any) => r.r as any[])

  // Before approval the page loads a schedule with nothing to book, and a
  // booking attempt is refused (the page must reload after approving).
  assert.equal((await publicQuote()).status, 'sent')
  const before = await publicSchedule(token)
  assert.deepEqual([before.calendar, before.booking, before.can_request, before.booking_unavailable], [null, null, false, false])
  assert.equal((await book(token, D(7))).error, 'quote_not_approved')

  // A question before approving goes to the existing conversation.
  assert.equal((await ask('Can you match my factory paint?')).ok, true)

  // Approve with the same token: the very next schedule load has the calendar.
  assert.equal((await approve(token)).ok, true)
  assert.equal((await publicQuote()).status, 'approved')
  const after = await publicSchedule(token)
  assert.equal(after.can_request, true)
  assert.deepEqual([after.calendar.earliest, after.booking], [D(1), null])

  // Book It: Scheduled immediately, deposit link on the following load.
  const r = await book(token, D(7))
  assert.deepEqual([r.ok, r.start_date], [true, D(7)])
  assert.equal(await leadStatus(leadId), 'scheduled')
  const booked = await publicSchedule(token)
  assert.deepEqual(booked.booking, { start_date: D(7), estimated_ready_date: null })
  assert.equal(booked.calendar, null)
  assert.deepEqual([booked.deposit.status, booked.deposit.amount, booked.deposit.payment_url], ['awaiting', 200, 'https://pay.example.com/one-link'])

  // Questions still work after booking, in the same thread.
  assert.equal((await ask('What time should I drop it off?')).ok, true)
  assert.deepEqual((await thread()).map((m: any) => m.body), ['Can you match my factory paint?', 'What time should I drop it off?'])
})

// ---------------------------------------------------------------------------
// Precedence between an earlier lead setting and the booked quote
// ---------------------------------------------------------------------------

async function cancelBooking(leadId: string) {
  const v = await version(leadId)
  await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.cancel_schedule($1, $2, NULL)`, [leadId, v]))
}

// Lead setting first, THEN the quote is created, set and sent (as reproduced).
async function leadSettingThenQuote(lead: { requested: boolean; url: string | null; amount: number | null }, quoteDeposit: QuoteDeposit | null) {
  const leadId = await newLead('shopA')
  await setLeadDeposit(leadId, lead.requested, lead.url, lead.amount, lead.requested && !lead.url ? 'Old terms' : null)
  const q = await createQuote(leadId, 'userA', 900)
  if (quoteDeposit) await setQuoteDeposit(q.id, 'userA', true, quoteDeposit)
  await sendQuote(q.id, 'userA')
  assert.equal((await approve(q.public_token)).ok, true)
  return { leadId, quote: q, token: q.public_token as string }
}

test('case 1: an older $75 lead setting does not override a quote with the deposit off', async () => {
  await resetShop()
  const { leadId, token, quote } = await leadSettingThenQuote({ requested: true, url: 'https://pay.example.com/old-link', amount: 75 }, null)
  assert.equal((await book(token, D(5))).ok, true)
  assert.equal(await leadStatus(leadId), 'scheduled')
  assert.equal((await publicSchedule(token)).deposit, null, 'no old $75 deposit or payment button')
  const row = await leadDeposit(leadId)
  assert.deepEqual([row.requested, row.payment_url, row.amount, row.source, row.quote_id], [false, null, null, 'quote', quote.id])
  assert.ok(row.attached_at, 'now tied to this booking')
  assert.equal((await events(leadId)).find((e: any) => e.event_type === 'schedule_booked').metadata.deposit_requested, false)
})

test('case 2: an older "no deposit" lead setting does not hide the quote’s $100 deposit', async () => {
  await resetShop()
  const { leadId, token, quote } = await leadSettingThenQuote({ requested: false, url: null, amount: null },
    { url: 'https://invoices.example.com/inv/Q-100', amount: 100 })
  assert.equal((await book(token, D(6))).ok, true)
  const pub = await publicSchedule(token)
  assert.deepEqual([pub.deposit?.status, pub.deposit?.amount, pub.deposit?.payment_url], ['awaiting', 100, 'https://invoices.example.com/inv/Q-100'])
  const row = await leadDeposit(leadId)
  assert.deepEqual([row.requested, row.source, row.quote_id], [true, 'quote', quote.id])
})

test('a lead correction saved after the quote was sent still applies to the first booking', async () => {
  await resetShop()
  const { leadId, token } = await approvedLead('shopA', true, 'Customer', { url: 'https://invoices.example.com/inv/sent', amount: 100 })
  await new Promise((r) => setTimeout(r, 5)) // a later timestamp than sent_at
  await setLeadDeposit(leadId, true, 'https://invoices.example.com/inv/corrected', 120, null)
  await book(token, D(7))
  const pub = await publicSchedule(token)
  assert.deepEqual([pub.deposit.amount, pub.deposit.payment_url], [120, 'https://invoices.example.com/inv/corrected'])
  assert.equal((await leadDeposit(leadId)).source, 'staff')
})

test('booked and received deposits are never replaced by a re-booking from a newer quote', async () => {
  await resetShop()
  // Received on the first booking, then cancelled and re-booked from Quote #2 with the deposit off.
  const first = await approvedLead('shopA', true, 'Customer', { url: 'https://invoices.example.com/inv/B1', amount: 100 })
  await book(first.token, D(5))
  await setReceived(first.leadId, true)
  const received = await leadDeposit(first.leadId)
  await cancelBooking(first.leadId)
  const r2 = await createQuote(first.leadId, 'userA', 950, first.quote.id)
  await sendQuote(r2.id, 'userA')
  await approve(r2.public_token)
  assert.equal((await book(r2.public_token, D(8))).ok, true)
  const after = await leadDeposit(first.leadId)
  assert.deepEqual([after.requested, Number(after.amount), after.payment_url, after.received_at?.toString(), after.received_by, after.quote_id],
    [true, 100, 'https://invoices.example.com/inv/B1', received.received_at?.toString(), received.received_by, first.quote.id])
  assert.equal((await publicSchedule(r2.public_token)).deposit.status, 'received')
  await assert.rejects(setLeadDeposit(first.leadId, true, 'https://invoices.example.com/inv/B1', 900, null), /amount can't change/)

  // Unreceived but attached (a deposit requested later on the booked lead): kept on re-booking too.
  const later = await approvedLead()
  await book(later.token, D(9))
  await setLeadDeposit(later.leadId, true, 'https://invoices.example.com/inv/later', 60, null)
  assert.ok((await leadDeposit(later.leadId)).attached_at, 'a correction on a booked lead is attached')
  await cancelBooking(later.leadId)
  const l2 = await createQuote(later.leadId, 'userA', 990, later.quote.id)
  await setQuoteDeposit(l2.id, 'userA', true, { url: 'https://invoices.example.com/inv/other', amount: 500 })
  await sendQuote(l2.id, 'userA')
  await approve(l2.public_token)
  await book(l2.public_token, D(10))
  assert.deepEqual([(await publicSchedule(l2.public_token)).deposit.amount, (await publicSchedule(l2.public_token)).deposit.payment_url],
    [60, 'https://invoices.example.com/inv/later'])
})
