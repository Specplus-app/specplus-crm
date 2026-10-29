// Customer calendar scheduling (20261028120000_add_customer_calendar_scheduling.sql),
// run against the real migrations in an isolated in-memory PGlite database
// (see tests/helpers/pgliteDb.mjs). No hosted database, email or network
// access is involved.
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
const dateText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))

type ShopKey = 'shopA' | 'shopB' | 'shopC'
const userFor = (shopKey: ShopKey) => (shopKey === 'shopA' ? 'userA' : shopKey === 'shopB' ? 'userB' : 'userC')

before(async () => {
  db = await createDb()
  const shop = async (name: string, status: string) =>
    (await one(db, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, $4, '2020-01-01T00:00:00Z', false) RETURNING id`, [name, `${name}@example.test`, name.toLowerCase(), status])).id
  ids.shopA = await shop('CalShopA', 'active')
  ids.shopB = await shop('CalShopB', 'active')
  ids.shopC = await shop('CalShopC', 'trial') // expired trial: read-only
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
})

// ---------------------------------------------------------------------------
// Fixture helpers (mirror what the app does through PostgREST)
// ---------------------------------------------------------------------------

async function newLead(shopKey: ShopKey, name = 'Customer'): Promise<string> {
  const email = `${Math.random().toString(36).slice(2)}@example.test`
  await as(db, anon, async (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom)
    VALUES ($1, $2, $3, 'veh', 'Truck', 'local', '[]', 650, 0, 650, 5, 'new', true)`, [ids[shopKey], name, email]))
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

async function approvedLead(shopKey: ShopKey = 'shopA', name = 'Customer') {
  const leadId = await newLead(shopKey, name)
  const sender = shopKey === 'shopC' ? 'admin' : userFor(shopKey)
  const q = await createQuote(leadId, sender, 900)
  await sendQuote(q.id, sender)
  assert.equal((await approve(q.public_token)).ok, true)
  return { leadId, quote: q, token: q.public_token as string }
}

const version = async (leadId: string) =>
  Number((await one(db, `SELECT public.schedule_version_of($1) AS v`, [leadId])).v)
const leadStatus = async (leadId: string) => (await one(db, `SELECT status FROM leads WHERE id = $1`, [leadId])).status

const publicSchedule = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_schedule($1) AS s`, [token])).then((r: any) => r.s)
const requestCalendar = (token: string, date: string | null, who: any = anon) =>
  as(db, who, async (tx: any) => one(tx, `SELECT public.request_schedule_calendar_date($1, $2::date) AS r`, [token, date])).then((r: any) => r.r)
const requestOption = (token: string, optionId: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.request_schedule_date($1, $2) AS r`, [token, optionId])).then((r: any) => r.r)

const setWindow = (shopKey: ShopKey, days: number | null, userKey: string = userFor(shopKey)) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.set_schedule_booking_window($1, $2) AS r`, [ids[shopKey], days])).then((r: any) => r.r)
const setBlocked = (shopKey: ShopKey, start: string, end: string, blocked: boolean, userKey: string = userFor(shopKey)) =>
  as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.set_schedule_dates_blocked($1, $2::date, $3::date, $4) AS r`,
    [ids[shopKey], start, end, blocked])).then((r: any) => r.r)

async function createOffer(leadId: string, userKey: string, dates: string[]) {
  const v = await version(leadId)
  return as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.create_schedule_offer($1, $2, $3::date[], null) AS r`,
    [leadId, v, dates])).then((r: any) => r.r)
}
async function offerDates(leadId: string, userKey: string, dates: string[]) {
  const created = await createOffer(leadId, userKey, dates)
  await as(db, service, async (tx: any) => tx.query(`SELECT public.mark_schedule_offer_sent($1, $2)`, [created.offer_id, ids[userKey]]))
  return created.offer_id as string
}

const pendingRequest = (leadId: string) =>
  one(db, `SELECT * FROM schedule_requests WHERE lead_id = $1 AND status = 'pending'`, [leadId])
async function confirm(leadId: string, userKey: string, readyDate: string, notes: string | null = null) {
  const req = await pendingRequest(leadId)
  const v = await version(leadId)
  return as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.confirm_schedule($1, $2, $3::date, $4) AS r`,
    [req?.id ?? null, v, readyDate, notes])).then((r: any) => r.r)
}
const activeReservation = (leadId: string) =>
  one(db, `SELECT * FROM schedule_reservations WHERE lead_id = $1 AND status = 'active'`, [leadId])
const events = async (leadId: string) =>
  (await db.query(`SELECT event_type, actor_type, metadata FROM lead_events WHERE lead_id = $1 ORDER BY created_at, id`, [leadId])).rows
const notificationKinds = async (leadId: string) =>
  (await db.query(`SELECT kind FROM notification_events WHERE lead_id = $1 ORDER BY created_at, id`, [leadId])).rows.map((r: any) => r.kind)

async function snapshot(leadId: string) {
  return {
    status: await leadStatus(leadId),
    version: await version(leadId),
    events: (await events(leadId)).length,
    reservations: (await db.query(`SELECT id, status FROM schedule_reservations WHERE lead_id = $1 ORDER BY id`, [leadId])).rows,
    requests: (await db.query(`SELECT id, status FROM schedule_requests WHERE lead_id = $1 ORDER BY id`, [leadId])).rows,
  }
}

// Clears shop A's blocks and window between tests that change them.
async function resetAvailability(shopKey: ShopKey = 'shopA') {
  await db.query(`DELETE FROM shop_blocked_dates WHERE shop_id = $1`, [ids[shopKey]])
  await db.query(`DELETE FROM shop_schedule_settings WHERE shop_id = $1`, [ids[shopKey]])
}

// ---------------------------------------------------------------------------
// Approval -> calendar request -> confirmation
// ---------------------------------------------------------------------------

test('after approval the customer requests a calendar date; the shop confirms it', async () => {
  await resetAvailability()
  const leadId = await newLead('shopA')
  const q = await createQuote(leadId, 'userA', 900)
  await sendQuote(q.id, 'userA')
  const unapproved = await publicSchedule(q.public_token)
  assert.equal(unapproved.calendar, null, 'no calendar before the quote is approved')
  assert.equal(unapproved.can_request, false)
  assert.equal((await requestCalendar(q.public_token, D(10))).error, 'quote_not_approved')

  assert.equal((await approve(q.public_token)).ok, true)
  const pub = await publicSchedule(q.public_token)
  assert.equal(pub.can_request, true)
  assert.equal(pub.offer, null)
  assert.deepEqual(pub.calendar, { earliest: D(1), latest: D(60), blocked_dates: [] }, 'safe default: 60-day window, nothing blocked')

  const r = await requestCalendar(q.public_token, D(10))
  assert.deepEqual([r.ok, r.start_date, r.already_requested], [true, D(10), false])
  assert.equal(await leadStatus(leadId), 'scheduling', 'stays in Scheduling until the shop confirms')
  assert.equal(await activeReservation(leadId), undefined, 'a request books nothing')
  const pending = await pendingRequest(leadId)
  assert.deepEqual([pending.source, pending.offer_id, pending.option_id], ['calendar', null, null])
  const shown = (await publicSchedule(q.public_token)).request
  assert.deepEqual([shown.start_date, shown.source, shown.available, shown.option_id], [D(10), 'calendar', true, null])

  // Same notification path as an offered-date choice.
  const requested = (await events(leadId)).find((e: any) => e.event_type === 'schedule_date_requested')
  assert.equal(requested.actor_type, 'customer')
  assert.equal(requested.metadata.source, 'calendar')
  assert.ok((await notificationKinds(leadId)).includes('date_requested'))
  const inbox = (await db.query(`SELECT user_id FROM notifications WHERE lead_id = $1 AND kind = 'date_requested'`, [leadId])).rows
  assert.deepEqual(inbox.map((r: any) => r.user_id).sort(), [ids.userA, ids.userA2].sort(), 'every staff member of the shop is notified')

  const done = await confirm(leadId, 'userA', D(14), 'Bay 3')
  assert.equal(done.ok, true)
  assert.equal(await leadStatus(leadId), 'scheduled')
  const res = await activeReservation(leadId)
  assert.deepEqual([dateText(res.start_date), dateText(res.estimated_ready_date), res.request_id], [D(10), D(14), pending.id])
  const confirmed = (await events(leadId)).find((e: any) => e.event_type === 'schedule_confirmed')
  assert.equal(confirmed.metadata.source, 'calendar')

  const after = await publicSchedule(q.public_token)
  assert.deepEqual(after.booking, { start_date: D(10), estimated_ready_date: D(14) })
  assert.equal(after.calendar, null, 'booked customers message the shop to change dates')
  assert.equal(after.request, null)
  assert.ok(!JSON.stringify(after).includes('Bay 3'), 'internal notes never reach the customer')
  assert.equal((await requestCalendar(q.public_token, D(20))).error, 'already_scheduled')
})

test('repeated and changed calendar choices are safe', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  assert.equal((await requestCalendar(token, D(5))).already_requested, false)
  const again = await requestCalendar(token, D(5))
  assert.deepEqual([again.ok, again.already_requested], [true, true])
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM schedule_requests WHERE lead_id = $1`, [leadId])).n, 1)
  assert.equal((await requestCalendar(token, D(6))).ok, true)
  const rows = (await db.query(`SELECT status, start_date FROM schedule_requests WHERE lead_id = $1 ORDER BY requested_at`, [leadId])).rows
  assert.deepEqual(rows.map((r: any) => [r.status, dateText(r.start_date)]), [['replaced', D(5)], ['pending', D(6)]])
  assert.equal((await requestCalendar(token, null)).error, 'invalid_date')
  assert.equal((await requestCalendar(token, D(5), staff('userA'))).error, 'staff_preview')
})

// ---------------------------------------------------------------------------
// Availability: window and blocked dates
// ---------------------------------------------------------------------------

test('customers can request only dates inside the window that are not blocked', async () => {
  await resetAvailability()
  const { token } = await approvedLead()
  assert.equal((await setWindow('shopA', 14)).booking_window_days, 14)
  await setBlocked('shopA', D(5), D(7), true)
  await setBlocked('shopA', D(30), D(30), true) // outside the window: not listed

  const cal = (await publicSchedule(token)).calendar
  assert.deepEqual(cal, { earliest: D(1), latest: D(14), blocked_dates: [D(5), D(6), D(7)] })

  assert.equal((await requestCalendar(token, D(0))).error, 'date_passed', 'today is too soon')
  assert.equal((await requestCalendar(token, D(-3))).error, 'date_passed')
  assert.equal((await requestCalendar(token, D(15))).error, 'outside_window')
  assert.equal((await requestCalendar(token, D(6))).error, 'date_blocked')
  assert.equal((await requestCalendar(token, D(14))).ok, true, 'the last day of the window is allowed')

  // Unblocking a single day inside a blocked range reopens just that day.
  assert.equal((await setBlocked('shopA', D(6), D(6), false)).changed, 1)
  assert.deepEqual((await publicSchedule(token)).calendar.blocked_dates, [D(5), D(7)])
  assert.equal((await requestCalendar(token, D(6))).ok, true)
  // Re-blocking an already blocked date changes nothing.
  assert.equal((await setBlocked('shopA', D(5), D(5), true)).changed, 0)
})

test('availability settings are validated', async () => {
  await resetAvailability()
  await assert.rejects(setWindow('shopA', 3), /between 7 and 365/)
  await assert.rejects(setWindow('shopA', 400), /between 7 and 365/)
  await assert.rejects(setWindow('shopA', null), /between 7 and 365/)
  await assert.rejects(setBlocked('shopA', D(9), D(8), true), /on or after the start date/)
  await assert.rejects(setBlocked('shopA', D(1), D(400), true), /one year or less/)
  await assert.rejects(setBlocked('shopA', D(-10), D(-5), true), /Past dates/)
  // A range reaching into the past only blocks from yesterday (UTC) on.
  await setBlocked('shopA', D(-10), D(2), true)
  const rows = (await db.query(`SELECT blocked_date FROM shop_blocked_dates WHERE shop_id = $1 ORDER BY blocked_date`, [ids.shopA])).rows
  assert.deepEqual(rows.map((r: any) => dateText(r.blocked_date)), [D(-1), D(0), D(1), D(2)])
})

test('existing jobs never block a date; overlapping requests are allowed', async () => {
  await resetAvailability()
  const booked = await approvedLead('shopA', 'Booked Customer')
  assert.equal((await requestCalendar(booked.token, D(8))).ok, true)
  assert.equal((await confirm(booked.leadId, 'userA', D(12), 'Secret internal note')).ok, true)

  const other = await approvedLead('shopA', 'Other Customer')
  const pub = await publicSchedule(other.token)
  assert.deepEqual(pub.calendar.blocked_dates, [], 'a confirmed job does not block its dates')
  assert.equal((await requestCalendar(other.token, D(10))).ok, true, 'a date inside another job is still requestable')

  // The other customer's view never shows the first customer's job.
  const text = JSON.stringify(await publicSchedule(other.token))
  for (const secret of [booked.leadId, 'Booked Customer', 'Secret internal note', (await activeReservation(booked.leadId)).id]) {
    assert.ok(!text.includes(secret), `customer view leaks ${secret}`)
  }
})

// ---------------------------------------------------------------------------
// Changed availability between request and confirmation
// ---------------------------------------------------------------------------

test('a date blocked after the request cannot be confirmed; the customer picks another', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  assert.equal((await requestCalendar(token, D(8))).ok, true)
  await setBlocked('shopA', D(8), D(8), true)

  const shown = (await publicSchedule(token)).request
  assert.deepEqual([shown.start_date, shown.available], [D(8), false], 'the customer is told the date is no longer available')

  const before = await snapshot(leadId)
  await assert.rejects(confirm(leadId, 'userA', D(10)), /blocked on your calendar/)
  assert.deepEqual(await snapshot(leadId), before, 'nothing changes when confirmation is refused')

  assert.equal((await requestCalendar(token, D(9))).ok, true, 'the customer can choose another date')
  assert.equal((await confirm(leadId, 'userA', D(11))).ok, true)
  assert.equal(dateText((await activeReservation(leadId)).start_date), D(9))
})

test('a shortened window does not stop staff confirming an existing request', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  assert.equal((await requestCalendar(token, D(40))).ok, true)
  await setWindow('shopA', 14)
  assert.equal((await requestCalendar(token, D(41))).error, 'outside_window', 'new customer choices use the new window')
  assert.equal((await confirm(leadId, 'userA', D(45))).ok, true, 'the window limits customers, not staff')
})

test('a request for a date that has passed cannot be confirmed', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  await requestCalendar(token, D(5))
  await db.exec(`SET session_replication_role = replica`)
  try {
    await db.query(`UPDATE schedule_requests SET start_date = $2 WHERE lead_id = $1`, [leadId, D(-5)])
  } finally {
    await db.exec(`SET session_replication_role = origin`)
  }
  assert.equal((await publicSchedule(token)).request.available, false)
  await assert.rejects(confirm(leadId, 'userA', D(1)), /start date has passed/)
})

// ---------------------------------------------------------------------------
// Existing offers during the transition
// ---------------------------------------------------------------------------

test('customers with offered dates keep using them; blocked offered dates are refused', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  await offerDates(leadId, 'userA', [D(4), D(6)])
  let pub = await publicSchedule(token)
  assert.equal(pub.calendar, null, 'the offered dates are shown instead of the calendar')
  assert.deepEqual(pub.offer.options.map((o: any) => [o.start_date, o.available]), [[D(4), true], [D(6), true]])
  assert.equal((await requestCalendar(token, D(10))).error, 'use_offered_dates')

  await setBlocked('shopA', D(4), D(4), true)
  pub = await publicSchedule(token)
  assert.deepEqual(pub.offer.options.map((o: any) => o.available), [false, true])
  assert.equal((await requestOption(token, pub.offer.options[0].id)).error, 'date_blocked')
  assert.equal((await requestOption(token, pub.offer.options[1].id)).ok, true)
  const pending = await pendingRequest(leadId)
  assert.equal(pending.source, 'offer', 'offered choices keep their source')
  assert.equal((await confirm(leadId, 'userA', D(8))).ok, true)

  // Offering a blocked date is refused with a clear message.
  const other = await approvedLead()
  await assert.rejects(createOffer(other.leadId, 'userA', [D(4), D(5)]), /is blocked on your calendar/)
})

test('an offered request whose date is blocked before confirmation is refused', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  await offerDates(leadId, 'userA', [D(7)])
  await requestOption(token, (await publicSchedule(token)).offer.options[0].id)
  await setBlocked('shopA', D(7), D(7), true)
  await assert.rejects(confirm(leadId, 'userA', D(9)), /blocked on your calendar/)
  assert.equal((await pendingRequest(leadId)).status, 'pending')
})

test('sending date options supersedes a pending calendar request', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  await requestCalendar(token, D(5))
  const calendarRequest = await pendingRequest(leadId)
  await offerDates(leadId, 'userA', [D(9)])
  assert.equal((await one(db, `SELECT status FROM schedule_requests WHERE id = $1`, [calendarRequest.id])).status, 'superseded')
  const pub = await publicSchedule(token)
  assert.deepEqual([pub.request, pub.calendar], [null, null])
})

test('rescheduling a calendar booking still uses offered dates and keeps the booking', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  await requestCalendar(token, D(5))
  await confirm(leadId, 'userA', D(7))
  const original = await activeReservation(leadId)

  await offerDates(leadId, 'userA', [D(20)])
  const pub = await publicSchedule(token)
  assert.equal(pub.offer.is_reschedule, true)
  await requestOption(token, pub.offer.options[0].id)
  assert.equal((await activeReservation(leadId)).id, original.id, 'the booking stays until the new date is confirmed')
  await confirm(leadId, 'userA', D(22))
  assert.equal((await one(db, `SELECT status FROM schedule_reservations WHERE id = $1`, [original.id])).status, 'replaced')
})

test('a quote revision invalidates a pending calendar request', async () => {
  await resetAvailability()
  const { leadId, quote, token } = await approvedLead()
  await requestCalendar(token, D(5))
  const pending = await pendingRequest(leadId)
  const rev = await createQuote(leadId, 'userA', 1100, quote.id)
  assert.equal((await one(db, `SELECT status FROM schedule_requests WHERE id = $1`, [pending.id])).status, 'invalidated')
  await sendQuote(rev.id, 'userA')
  assert.equal((await requestCalendar(token, D(6))).error, 'superseded')
  assert.equal((await publicSchedule(rev.public_token)).calendar, null, 'not until the revision is approved')
  await approve(rev.public_token)
  assert.equal((await requestCalendar(rev.public_token, D(6))).ok, true)
})

test('closed and started jobs get no calendar', async () => {
  await resetAvailability()
  const { leadId, token } = await approvedLead()
  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = 'lost' WHERE id = $1`, [leadId]))
  assert.equal((await publicSchedule(token)).calendar, null)
  assert.equal((await requestCalendar(token, D(5))).error, 'not_available')
})

// ---------------------------------------------------------------------------
// Permissions and shop isolation
// ---------------------------------------------------------------------------

test('availability is isolated per shop and only changed through the functions', async () => {
  await resetAvailability()
  await resetAvailability('shopB')
  await setBlocked('shopA', D(3), D(3), true)
  await setWindow('shopA', 21)

  // Another shop's staff can neither read nor change shop A's availability.
  for (const table of ['shop_schedule_settings', 'shop_blocked_dates']) {
    const rows = await as(db, staff('userB'), async (tx: any) => tx.query(`SELECT * FROM ${table} WHERE shop_id = $1`, [ids.shopA]))
    assert.equal(rows.rows.length, 0, table)
    const own = await as(db, staff('userA'), async (tx: any) => tx.query(`SELECT * FROM ${table} WHERE shop_id = $1`, [ids.shopA]))
    assert.equal(own.rows.length, 1, `${table}: own shop is readable`)
    await assert.rejects(as(db, anon, async (tx: any) => tx.query(`SELECT * FROM ${table}`)), /permission denied/, table)
  }
  await assert.rejects(setWindow('shopA', 30, 'userB'), /Shop not found/)
  await assert.rejects(setBlocked('shopA', D(4), D(4), true, 'userB'), /Shop not found/)

  // Direct writes are refused for staff and anon.
  for (const who of [anon, staff('userA')]) {
    await assert.rejects(as(db, who, async (tx: any) => tx.query(`INSERT INTO shop_blocked_dates (shop_id, blocked_date) VALUES ($1, current_date)`, [ids.shopA])), /permission denied/)
    await assert.rejects(as(db, who, async (tx: any) => tx.query(`DELETE FROM shop_blocked_dates WHERE shop_id = $1`, [ids.shopA])), /permission denied/)
    await assert.rejects(as(db, who, async (tx: any) => tx.query(`UPDATE shop_schedule_settings SET booking_window_days = 365`)), /permission denied/)
  }
  for (const sql of [
    `SELECT public.set_schedule_booking_window('${ids.shopA}', 30)`,
    `SELECT public.set_schedule_dates_blocked('${ids.shopA}', current_date, current_date, true)`,
    `SELECT public.schedule_calendar_date_problem('${ids.shopA}', current_date)`,
    `SELECT public.schedule_date_is_blocked('${ids.shopA}', current_date)`,
    `SELECT public.schedule_authorize_shop('${ids.userA}', '${ids.shopA}')`,
  ]) {
    await assert.rejects(as(db, anon, async (tx: any) => tx.query(sql)), /permission denied/, sql)
  }
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.schedule_date_is_blocked('${ids.shopA}', current_date)`)), /permission denied/)

  // Customers only see their own shop's blocked dates and window.
  const a = await approvedLead('shopA')
  const b = await approvedLead('shopB')
  assert.deepEqual((await publicSchedule(a.token)).calendar, { earliest: D(1), latest: D(21), blocked_dates: [D(3)] })
  assert.deepEqual((await publicSchedule(b.token)).calendar, { earliest: D(1), latest: D(60), blocked_dates: [] })
  assert.equal((await requestCalendar(b.token, D(3))).ok, true, "shop A's blocks don't affect shop B")

  // Another shop's staff can't confirm the request.
  await requestCalendar(a.token, D(5))
  await assert.rejects(confirm(a.leadId, 'userB', D(6)), /Lead not found/)
  assert.equal((await confirm(a.leadId, 'admin', D(6))).ok, true, 'admins can act across shops')
})

test('read-only shops cannot change availability; admins can', async () => {
  await resetAvailability('shopC')
  await assert.rejects(setWindow('shopC', 30), /read-only/)
  await assert.rejects(setBlocked('shopC', D(3), D(3), true), /read-only/)
  assert.equal((await setBlocked('shopC', D(3), D(3), true, 'admin')).ok, true)
  assert.equal((await setWindow('shopC', 30, 'admin')).ok, true)
  // Customers of a read-only shop can still request (as with offered dates);
  // the shop user still can't confirm.
  const { leadId, token } = await approvedLead('shopC')
  assert.equal((await requestCalendar(token, D(4))).ok, true)
  await assert.rejects(confirm(leadId, 'userC', D(6)), /read-only/)
  assert.equal((await confirm(leadId, 'admin', D(6))).ok, true)
})

// ---------------------------------------------------------------------------
// Availability lock
//
// PGlite runs a single connection, so these tests cannot run two
// transactions at once and show one waiting for the other. They verify the
// mechanism instead: inside each caller's transaction, before it commits,
// which per-shop advisory lock it holds (shared for writes that check
// availability, exclusive for availability changes), that this holds for a
// shop with no settings row, and that it is released at commit. Real
// multi-connection blocking is Postgres advisory-lock semantics and is not
// exercised here.
// ---------------------------------------------------------------------------

const lockKey = async (shopKey: ShopKey) =>
  (await one(db, `SELECT public.schedule_availability_lock_key($1)::text AS k`, [ids[shopKey]])).k as string
// Advisory locks on a bigint key report the high/low 32 bits in classid/objid.
// PGlite reports no pid for its single backend, so every row is this
// connection's (the only one).
const heldLocks = async (q: any) => (await q.query(`SELECT mode, ((classid::bigint << 32) | objid::bigint)::text AS key
  FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1`)).rows as { mode: string; key: string }[]
const settingsRows = async (shopKey: ShopKey) =>
  (await one(db, `SELECT count(*)::int AS n FROM shop_schedule_settings WHERE shop_id = $1`, [ids[shopKey]])).n

test('every availability-dependent write holds the shop lock until commit, without a settings row', async () => {
  await resetAvailability()
  assert.equal(await settingsRows('shopA'), 0, 'shop A uses default settings')
  const key = await lockKey('shopA')
  assert.notEqual(key, await lockKey('shopB'), 'each shop has its own lock')
  const expectShared = (locks: { mode: string; key: string }[], what: string) =>
    assert.deepEqual(locks.filter((l) => l.key === key).map((l) => l.mode), ['ShareLock'], what)

  // Customer calendar request.
  const cal = await approvedLead()
  expectShared(await as(db, anon, async (tx: any) => {
    const r = await one(tx, `SELECT public.request_schedule_calendar_date($1, $2::date) AS r`, [cal.token, D(5)])
    assert.equal(r.r.ok, true)
    return heldLocks(tx)
  }), 'request_schedule_calendar_date')
  assert.deepEqual(await heldLocks(db), [], 'released at commit')

  // Staff confirmation.
  const req = await pendingRequest(cal.leadId)
  const v = await version(cal.leadId)
  expectShared(await as(db, staff('userA'), async (tx: any) => {
    await tx.query(`SELECT public.confirm_schedule($1, $2, $3::date, null)`, [req.id, v, D(7)])
    return heldLocks(tx)
  }), 'confirm_schedule')

  // Offer creation, and a customer choosing an offered date.
  const off = await approvedLead()
  const ov = await version(off.leadId)
  let offerId = ''
  expectShared(await as(db, staff('userA'), async (tx: any) => {
    offerId = (await one(tx, `SELECT public.create_schedule_offer($1, $2, $3::date[], null) AS r`, [off.leadId, ov, [D(9)]])).r.offer_id
    return heldLocks(tx)
  }), 'create_schedule_offer')
  await as(db, service, async (tx: any) => tx.query(`SELECT public.mark_schedule_offer_sent($1, $2)`, [offerId, ids.userA]))
  const option = (await publicSchedule(off.token)).offer.options[0]
  expectShared(await as(db, anon, async (tx: any) => {
    assert.equal((await one(tx, `SELECT public.request_schedule_date($1, $2) AS r`, [off.token, option.id])).r.ok, true)
    return heldLocks(tx)
  }), 'request_schedule_date')

  assert.equal(await settingsRows('shopA'), 0, 'still no settings row')
})

test('availability changes take the shop lock exclusively and need no settings row', async () => {
  await resetAvailability()
  const key = await lockKey('shopA')
  for (const [what, sql, params] of [
    ['set_schedule_dates_blocked', `SELECT public.set_schedule_dates_blocked($1, $2::date, $3::date, true)`, [ids.shopA, D(3), D(4)]],
    ['set_schedule_dates_blocked (unblock)', `SELECT public.set_schedule_dates_blocked($1, $2::date, $3::date, false)`, [ids.shopA, D(4), D(4)]],
    ['set_schedule_booking_window', `SELECT public.set_schedule_booking_window($1, 30)`, [ids.shopA]],
  ] as const) {
    const locks = await as(db, staff('userA'), async (tx: any) => {
      await tx.query(sql, params)
      return heldLocks(tx)
    })
    assert.deepEqual(locks.filter((l) => l.key === key).map((l) => l.mode), ['ExclusiveLock'], what)
  }
  assert.deepEqual(await heldLocks(db), [])
})

test('blocking a date for a shop on default settings creates no settings row', async () => {
  await resetAvailability()
  await setBlocked('shopA', D(3), D(3), true)
  assert.equal(await settingsRows('shopA'), 0)
  const { token } = await approvedLead()
  assert.deepEqual((await publicSchedule(token)).calendar, { earliest: D(1), latest: D(60), blocked_dates: [D(3)] })
})

test('the lock helpers are not callable by clients', async () => {
  for (const who of [anon, staff('userA')]) {
    for (const sql of [
      `SELECT public.schedule_lock_availability('${ids.shopA}', true)`,
      `SELECT public.schedule_availability_lock_key('${ids.shopA}')`,
    ]) {
      await assert.rejects(as(db, who, async (tx: any) => tx.query(sql)), /permission denied/, sql)
    }
  }
  // Authorization runs before the lock: another shop's user is refused.
  await assert.rejects(setBlocked('shopA', D(3), D(3), true, 'userB'), /Shop not found/)
})

test('existing request rows default to the offer source and calendar rows must have no offer', async () => {
  const { leadId } = await approvedLead()
  await assert.rejects(db.query(`INSERT INTO schedule_requests (lead_id, shop_id, quote_id, start_date, source)
    SELECT id, shop_id, (SELECT id FROM quotes WHERE lead_id = $1 LIMIT 1), current_date + 3, 'offer' FROM leads WHERE id = $1`, [leadId]),
    /schedule_requests_source_shape/)
  await requestCalendar((await one(db, `SELECT public_token FROM quotes WHERE lead_id = $1`, [leadId])).public_token, D(5))
  await assert.rejects(db.query(`UPDATE schedule_requests SET source = 'offer' WHERE lead_id = $1 AND status = 'pending'`, [leadId]),
    /Invalid change to a date request|schedule_requests_source_shape/)
})
