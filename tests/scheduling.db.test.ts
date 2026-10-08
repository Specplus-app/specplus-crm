// Production scheduling enforcement, run against the real migrations in an
// isolated in-memory PGlite database (see tests/helpers/pgliteDb.mjs). No
// hosted database, email or network access is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore -- plain JS helper
import { createDb, as, one } from './helpers/pgliteDb.mjs'

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
const D = (offset: number) => isoDay(offset)
const dateText = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))

before(async () => {
  db = await createDb()
  const shop = async (name: string, status: string, trialEnds: string) =>
    (await one(db, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, $4, $5, false) RETURNING id`, [name, `${name}@example.test`, name.toLowerCase(), status, trialEnds])).id
  ids.shopA = await shop('ShopA', 'active', '2020-01-01T00:00:00Z')
  ids.shopB = await shop('ShopB', 'active', '2020-01-01T00:00:00Z')
  ids.shopC = await shop('ShopC', 'trial', '2020-01-01T00:00:00Z') // expired trial: read-only
  const user = async (key: string, role: string, shopId: string | null) => {
    const u = await one(db, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${key}@example.test`])
    await db.query(`INSERT INTO profiles (id, email, full_name, role, shop_id) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, shop_id = EXCLUDED.shop_id`, [u.id, `${key}@example.test`, key, role, shopId])
    ids[key] = u.id
  }
  await user('userA', 'shop_user', ids.shopA)
  await user('userB', 'shop_user', ids.shopB)
  await user('userC', 'shop_user', ids.shopC)
  await user('admin', 'admin', null)
})

// ---------------------------------------------------------------------------
// Fixture helpers (mirror what the app does through PostgREST)
// ---------------------------------------------------------------------------

async function newLead(shopKey: 'shopA' | 'shopB' | 'shopC', isCustom: boolean): Promise<string> {
  const email = `${Math.random().toString(36).slice(2)}@example.test`
  const parts = isCustom
    ? [{ id: 'area', name: 'Fender', type: 'send', price: 0 }]
    : [{ id: 'bumper', name: 'Bumper', type: 'new', price: 650, group_id: 'g1' }, { id: 'cap', name: 'Cap', type: 'send', price: 0 }]
  await as(db, anon, async (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom)
    VALUES ($1, 'Customer', $2, 'veh', 'Truck', 'local', $3, 650, 0, 650, 5, 'new', $4)`,
    [ids[shopKey], email, JSON.stringify(parts), isCustom]))
  return (await one(db, `SELECT id FROM leads WHERE customer_email = $1`, [email])).id
}

const userFor = (shopKey: string) => (shopKey === 'shopA' ? 'userA' : shopKey === 'shopB' ? 'userB' : 'userC')

async function createQuote(leadId: string, userKey: string, price: number, supersedes: string | null = null) {
  return as(db, staff(userKey), async (tx: any) => one(tx, `INSERT INTO quotes (lead_id, supersedes_quote_id, selected_parts, shipping_total)
    VALUES ($1, $2, $3, 0) RETURNING *`, [leadId, supersedes, JSON.stringify([{ id: 'p', name: 'Work', type: 'send', price, priced: true }])]))
}
const sendQuote = (quoteId: string, userKey: string) =>
  as(db, service, async (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [quoteId, ids[userKey]]))
const approve = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.respond_to_quote($1, 'approve') AS r`, [token])).then((r: any) => r.r)

// Lead with an approved quote, ready for date options.
async function approvedLead(isCustom: boolean, shopKey: 'shopA' | 'shopB' | 'shopC' = 'shopA') {
  const leadId = await newLead(shopKey, isCustom)
  const q = await createQuote(leadId, shopKey === 'shopC' ? 'admin' : userFor(shopKey), isCustom ? 1200 : 650)
  await sendQuote(q.id, shopKey === 'shopC' ? 'admin' : userFor(shopKey))
  assert.equal((await approve(q.public_token)).ok, true)
  return { leadId, quote: q }
}

const version = async (leadId: string) =>
  Number((await one(db, `SELECT public.schedule_version_of($1) AS v`, [leadId])).v)
const leadStatus = async (leadId: string) => (await one(db, `SELECT status FROM leads WHERE id = $1`, [leadId])).status

// PGlite has a single connection: read anything needed before opening the
// caller's transaction, never inside it.
async function createOffer(leadId: string, userKey: string, dates: string[], note: string | null = null) {
  const v = await version(leadId)
  return as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.create_schedule_offer($1, $2, $3::date[], $4) AS r`,
    [leadId, v, dates, note])).then((r: any) => r.r)
}
const markSent = (offerId: string, userKey: string) =>
  as(db, service, async (tx: any) => one(tx, `SELECT public.mark_schedule_offer_sent($1, $2) AS r`, [offerId, ids[userKey]])).then((r: any) => r.r)
async function offerDates(leadId: string, userKey: string, dates: string[], note: string | null = null) {
  const created = await createOffer(leadId, userKey, dates, note)
  await markSent(created.offer_id, userKey)
  return created.offer_id as string
}
const publicSchedule = (token: string) =>
  as(db, anon, async (tx: any) => one(tx, `SELECT public.get_public_schedule($1) AS s`, [token])).then((r: any) => r.s)
const requestDate = (token: string, optionId: string, who: any = anon) =>
  as(db, who, async (tx: any) => one(tx, `SELECT public.request_schedule_date($1, $2) AS r`, [token, optionId])).then((r: any) => r.r)
const pendingRequest = (leadId: string) =>
  one(db, `SELECT * FROM schedule_requests WHERE lead_id = $1 AND status = 'pending'`, [leadId])
async function confirm(leadId: string, userKey: string, readyDate: string, notes: string | null = null, expected?: number) {
  const req = await pendingRequest(leadId)
  const v = expected ?? await version(leadId)
  return as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.confirm_schedule($1, $2, $3::date, $4) AS r`,
    [req?.id ?? null, v, readyDate, notes])).then((r: any) => r.r)
}
const cancel = async (leadId: string, userKey: string, reason: string | null = null) => {
  const v = await version(leadId)
  return as(db, staff(userKey), async (tx: any) => one(tx, `SELECT public.cancel_schedule($1, $2, $3) AS r`,
    [leadId, v, reason])).then((r: any) => r.r)
}
const activeReservation = (leadId: string) =>
  one(db, `SELECT * FROM schedule_reservations WHERE lead_id = $1 AND status = 'active'`, [leadId])
const events = async (leadId: string) =>
  (await db.query(`SELECT event_type, actor_type, metadata FROM lead_events WHERE lead_id = $1 ORDER BY created_at, id`, [leadId])).rows

// ---------------------------------------------------------------------------
// Full flow
// ---------------------------------------------------------------------------

for (const isCustom of [false, true]) {
  test(`${isCustom ? 'custom' : 'preconfigured'}: offer -> request -> confirmation`, async () => {
    const { leadId, quote } = await approvedLead(isCustom)
    assert.equal(await leadStatus(leadId), 'approved')

    const created = await createOffer(leadId, 'userA', [D(9), D(3), D(3)], 'Mornings work best.')
    assert.equal(await publicSchedule(quote.public_token).then((s: any) => s.offer), null, 'drafts are not shown to customers')
    await markSent(created.offer_id, 'userA')

    const pub = await publicSchedule(quote.public_token)
    assert.equal(pub.can_request, true)
    assert.equal(pub.offer.note, 'Mornings work best.')
    assert.deepEqual(pub.offer.options.map((o: any) => o.start_date), [D(3), D(9)], 'deduplicated and sorted')
    assert.deepEqual(Object.keys(pub.offer.options[0]).sort(), ['id', 'start_date'])

    const chosen = pub.offer.options[1]
    const r = await requestDate(quote.public_token, chosen.id)
    assert.equal(r.ok, true)
    assert.equal(await leadStatus(leadId), 'scheduling', 'stays in Scheduling while awaiting the shop')
    assert.equal(await activeReservation(leadId), undefined, 'nothing reserved yet')
    assert.equal((await publicSchedule(quote.public_token)).request.start_date, D(9))

    const done = await confirm(leadId, 'userA', D(14), 'Bay 2; parts arrive Monday')
    assert.equal(done.ok, true)
    assert.equal(await leadStatus(leadId), 'scheduled')
    const res = await activeReservation(leadId)
    assert.equal(dateText(res.start_date), D(9))
    assert.equal(dateText(res.estimated_ready_date), D(14))
    assert.equal(res.quote_id, quote.id)

    const after = await publicSchedule(quote.public_token)
    assert.deepEqual(after.booking, { start_date: D(9), estimated_ready_date: D(14) })
    assert.equal(after.offer, null)
    assert.ok(!JSON.stringify(after).includes('Bay 2'), 'internal notes never reach the customer')

    const types = (await events(leadId)).map((e: any) => e.event_type)
    for (const t of ['schedule_options_sent', 'schedule_date_requested', 'schedule_confirmed']) assert.ok(types.includes(t), t)
    const requested = (await events(leadId)).find((e: any) => e.event_type === 'schedule_date_requested')
    assert.equal(requested.actor_type, 'customer')
  })
}

test('dates cannot be offered before the current quote is approved', async () => {
  const leadId = await newLead('shopA', false)
  const q = await createQuote(leadId, 'userA', 500)
  await assert.rejects(createOffer(leadId, 'userA', [D(5)]), /must approve the current quote/)
  await sendQuote(q.id, 'userA')
  await assert.rejects(createOffer(leadId, 'userA', [D(5)]), /must approve the current quote/)
  await assert.rejects(createOffer((await approvedLead(false)).leadId, 'userA', [D(-5)]), /past/)
  await assert.rejects(createOffer((await approvedLead(false)).leadId, 'userA', []), /between 1 and 10/)
})

// ---------------------------------------------------------------------------
// Stale choices, duplicates, concurrency
// ---------------------------------------------------------------------------

test('replacement options supersede earlier options and pending requests', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(4), D(5)])
  const first = (await publicSchedule(quote.public_token)).offer.options[0]
  assert.equal((await requestDate(quote.public_token, first.id)).ok, true)
  const staleRequest = await pendingRequest(leadId)

  await offerDates(leadId, 'userA', [D(10)], 'Availability changed.')
  assert.equal(await pendingRequest(leadId), undefined)
  assert.equal((await one(db, `SELECT status FROM schedule_requests WHERE id = $1`, [staleRequest.id])).status, 'superseded')
  const stale = await requestDate(quote.public_token, first.id)
  assert.deepEqual([stale.ok, stale.error], [false, 'options_replaced'])

  const current = await version(leadId)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.confirm_schedule($1, $2, $3::date, null)`,
    [staleRequest.id, current, D(12)])), /no longer pending/)
  assert.equal(await activeReservation(leadId), undefined)
})

test('repeated and changed customer selections are safe', async () => {
  const { leadId, quote } = await approvedLead(true)
  await offerDates(leadId, 'userA', [D(4), D(6)])
  const [a, b] = (await publicSchedule(quote.public_token)).offer.options
  assert.equal((await requestDate(quote.public_token, a.id)).already_requested, false)
  const again = await requestDate(quote.public_token, a.id)
  assert.deepEqual([again.ok, again.already_requested], [true, true])
  const n = await one(db, `SELECT count(*)::int AS n FROM schedule_requests WHERE lead_id = $1`, [leadId])
  assert.equal(n.n, 1, 'duplicate submission creates no second request')

  assert.equal((await requestDate(quote.public_token, b.id)).ok, true)
  const rows = (await db.query(`SELECT status, start_date FROM schedule_requests WHERE lead_id = $1 ORDER BY requested_at`, [leadId])).rows
  assert.deepEqual(rows.map((r: any) => r.status), ['replaced', 'pending'])

  // An option id from another project is rejected.
  const other = await approvedLead(false)
  await offerDates(other.leadId, 'userA', [D(8)])
  const foreign = (await publicSchedule(other.quote.public_token)).offer.options[0]
  assert.equal((await requestDate(quote.public_token, foreign.id)).error, 'invalid_option')
})

test('stale concurrency versions fail without writing anything', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(4), D(6)])
  const [a, b] = (await publicSchedule(quote.public_token)).offer.options
  await requestDate(quote.public_token, a.id)
  const loaded = await version(leadId)
  const loadedRequest = await pendingRequest(leadId)

  // The customer changes their choice after staff loaded the lead.
  await requestDate(quote.public_token, b.id)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.confirm_schedule($1, $2, $3::date, null)`,
    [loadedRequest.id, loaded, D(9)])), /changed since you loaded it/)
  assert.equal(await activeReservation(leadId), undefined)

  // Two staff confirming the same request: the second one is stale.
  const v = await version(leadId)
  const confirming = await pendingRequest(leadId)
  assert.equal((await confirm(leadId, 'userA', D(9), null, v)).ok, true)
  await assert.rejects(as(db, staff('admin'), async (tx: any) => tx.query(`SELECT public.confirm_schedule($1, $2, $3::date, null)`,
    [confirming.id, v, D(9)])), /changed since you loaded it/)
  const count = await one(db, `SELECT count(*)::int AS n FROM schedule_reservations WHERE lead_id = $1`, [leadId])
  assert.equal(count.n, 1)
})

test('a failed confirmation rolls back completely', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(7)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  const before = { v: await version(leadId), events: (await events(leadId)).length, status: await leadStatus(leadId) }
  await assert.rejects(confirm(leadId, 'userA', D(6)), /on or after the start date/)
  assert.equal(await activeReservation(leadId), undefined)
  assert.equal((await pendingRequest(leadId)).status, 'pending')
  assert.deepEqual({ v: await version(leadId), events: (await events(leadId)).length, status: await leadStatus(leadId) }, before)
  // Same-day ready date is allowed.
  assert.equal((await confirm(leadId, 'userA', D(7))).ok, true)
})

// Simulates time passing: moves a lead's offered/requested dates into the
// past directly, bypassing triggers the way stored data simply ages.
async function ageDates(leadId: string, startDate: string) {
  await db.exec(`SET session_replication_role = replica`)
  try {
    await db.query(`UPDATE schedule_offer_options SET start_date = $2 WHERE lead_id = $1`, [leadId, startDate])
    await db.query(`UPDATE schedule_requests SET start_date = $2 WHERE lead_id = $1`, [leadId, startDate])
  } finally {
    await db.exec(`SET session_replication_role = origin`)
  }
}

async function snapshot(leadId: string) {
  return {
    status: await leadStatus(leadId),
    version: await version(leadId),
    events: (await events(leadId)).length,
    reservations: (await db.query(`SELECT id, status FROM schedule_reservations WHERE lead_id = $1 ORDER BY id`, [leadId])).rows,
    requests: (await db.query(`SELECT id, status FROM schedule_requests WHERE lead_id = $1 ORDER BY id`, [leadId])).rows,
    offers: (await db.query(`SELECT id, status FROM schedule_offers WHERE lead_id = $1 ORDER BY id`, [leadId])).rows,
  }
}

test('a requested start date that has since passed cannot be confirmed', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await ageDates(leadId, D(-7))
  const before = await snapshot(leadId)
  await assert.rejects(confirm(leadId, 'userA', D(1)), /start date has passed\. Offer fresh dates/)
  assert.deepEqual(await snapshot(leadId), before, 'no booking, request, status, version or history change')

  // Same tolerance as offering/requesting: yesterday (UTC) is still open.
  await ageDates(leadId, D(-1))
  assert.equal((await confirm(leadId, 'userA', D(2))).ok, true)
})

test('expired draft options cannot be sent, and a rescheduled booking is kept', async () => {
  const { leadId, quote } = await approvedLead(true)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(8))
  const booked = await activeReservation(leadId)

  const draft = await createOffer(leadId, 'userA', [D(3), D(20)])
  await db.exec(`SET session_replication_role = replica`)
  await db.query(`UPDATE schedule_offer_options SET start_date = $2 WHERE offer_id = $1 AND start_date = $3`, [draft.offer_id, D(-4), D(3)])
  await db.exec(`SET session_replication_role = origin`)
  const before = await snapshot(leadId)
  await assert.rejects(markSent(draft.offer_id, 'userA'), /dates have passed\. Offer fresh dates/)
  assert.deepEqual(await snapshot(leadId), before)
  assert.equal((await activeReservation(leadId)).id, booked.id)
  // A customer can't pick a passed date either.
  const stale = await approvedLead(false)
  await offerDates(stale.leadId, 'userA', [D(5)])
  const option = (await publicSchedule(stale.quote.public_token)).offer.options[0]
  await ageDates(stale.leadId, D(-3))
  assert.equal((await requestDate(stale.quote.public_token, option.id)).error, 'date_passed')
})

test('a late failure during confirmation rolls back the booking and status writes', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  const before = await snapshot(leadId)

  // Fail the audit insert, which runs after the reservation insert, the
  // request/offer updates and the lead status change.
  await db.exec(`
    CREATE FUNCTION public.test_fail_schedule_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type = 'schedule_confirmed' THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_schedule_audit BEFORE INSERT ON public.lead_events
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_schedule_audit();
  `)
  try {
    await assert.rejects(confirm(leadId, 'userA', D(9)), /simulated audit failure/)
    assert.deepEqual(await snapshot(leadId), before, 'nothing from the failed confirmation remains')
    assert.equal(await leadStatus(leadId), 'scheduling')
  } finally {
    await db.exec(`DROP TRIGGER test_fail_schedule_audit ON public.lead_events; DROP FUNCTION public.test_fail_schedule_audit();`)
  }
  assert.equal((await confirm(leadId, 'userA', D(9))).ok, true, 'the same request can still be confirmed afterwards')
})

// ---------------------------------------------------------------------------
// Quote revisions
// ---------------------------------------------------------------------------

test('a quote revision before booking invalidates options and requires re-approval and fresh dates', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  const pending = await pendingRequest(leadId)

  // Repricing above the original lead estimate is legitimate.
  const rev = await createQuote(leadId, 'userA', 990, quote.id)
  assert.equal((await one(db, `SELECT status FROM schedule_requests WHERE id = $1`, [pending.id])).status, 'invalidated')
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM schedule_offers WHERE lead_id = $1 AND status = 'active'`, [leadId])).n, 0)
  assert.ok((await events(leadId)).some((e: any) => e.event_type === 'schedule_options_invalidated'))
  await assert.rejects(createOffer(leadId, 'userA', [D(6)]), /must approve the current quote/)

  await sendQuote(rev.id, 'userA')
  assert.equal(await publicSchedule(quote.public_token), null, 'old link no longer shows scheduling')
  const stale = await requestDate(quote.public_token, (await one(db, `SELECT id FROM schedule_offer_options WHERE lead_id = $1`, [leadId])).id)
  assert.equal(stale.error, 'superseded')
  // Revised but not yet approved: no options and no requests.
  const unapproved = await publicSchedule(rev.public_token)
  assert.equal(unapproved.can_request, false)

  assert.equal((await approve(rev.public_token)).ok, true)
  assert.equal((await publicSchedule(rev.public_token)).offer, null, 'fresh options are required')
  await offerDates(leadId, 'userA', [D(8)])
  await requestDate(rev.public_token, (await publicSchedule(rev.public_token)).offer.options[0].id)
  assert.equal((await confirm(leadId, 'userA', D(10))).ok, true)
  assert.equal((await activeReservation(leadId)).quote_id, rev.id)
})

test('later quote activity never cancels or downgrades a confirmed job', async () => {
  const { leadId, quote } = await approvedLead(true)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(9))
  const booked = await activeReservation(leadId)

  const rev = await createQuote(leadId, 'userA', 1500, quote.id)
  await sendQuote(rev.id, 'userA')
  assert.equal(await leadStatus(leadId), 'scheduled')
  // Cancellation stays possible while new terms await approval.
  assert.equal((await approve(rev.public_token)).ok, true)
  assert.equal(await leadStatus(leadId), 'scheduled')
  const still = await activeReservation(leadId)
  assert.equal(still.id, booked.id)
  assert.equal(still.quote_id, quote.id, 'keeps its linked approved snapshot')
  assert.deepEqual((await publicSchedule(rev.public_token)).booking, { start_date: D(5), estimated_ready_date: D(9) })
})

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test('shops are isolated from each other', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  for (const table of ['schedule_offers', 'schedule_offer_options', 'schedule_requests', 'schedule_reservations', 'lead_schedule_states']) {
    const rows = await as(db, staff('userB'), async (tx: any) => tx.query(`SELECT * FROM ${table} WHERE lead_id = $1`, [leadId]))
    assert.equal(rows.rows.length, 0, table)
  }
  await assert.rejects(createOffer(leadId, 'userB', [D(6)]), /Lead not found/)
  await assert.rejects(confirm(leadId, 'userB', D(9)), /Lead not found/)
  await assert.rejects(markSent((await createOffer(leadId, 'userA', [D(7)])).offer_id, 'userB'), /Lead not found/)
  // Admins can act across shops.
  assert.equal((await confirm(leadId, 'admin', D(9))).ok, true)
})

test('anonymous and staff callers cannot bypass the functions', async () => {
  const { leadId } = await approvedLead(false)
  for (const table of ['schedule_offers', 'schedule_offer_options', 'schedule_requests', 'schedule_reservations', 'lead_schedule_states']) {
    await assert.rejects(as(db, anon, async (tx: any) => tx.query(`SELECT * FROM ${table}`)), /permission denied/, table)
  }
  await assert.rejects(as(db, anon, async (tx: any) => tx.query(`INSERT INTO schedule_reservations (lead_id, shop_id, quote_id, quote_revision_number, start_date, estimated_ready_date)
    VALUES ($1, $2, $1, 1, now(), now())`, [leadId, ids.shopA])), /permission denied/)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`INSERT INTO schedule_reservations (lead_id, shop_id, quote_id, quote_revision_number, start_date, estimated_ready_date)
    VALUES ($1, $2, $1, 1, now(), now())`, [leadId, ids.shopA])), /permission denied/)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE lead_schedule_states SET version = 0`)), /permission denied/)
  for (const sql of [
    `SELECT public.create_schedule_offer('${leadId}', 0, ARRAY[current_date], null)`,
    `SELECT public.cancel_schedule('${leadId}', 0, null)`,
    `SELECT public.mark_schedule_offer_sent('${leadId}', '${ids.userA}')`,
    `SELECT public.schedule_bump_version('${leadId}', '${ids.shopA}')`,
    `SELECT public.record_lead_event('${leadId}', null, 'schedule_confirmed', '{}')`,
  ]) {
    await assert.rejects(as(db, anon, async (tx: any) => tx.query(sql)), /permission denied/, sql)
  }
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.mark_schedule_offer_sent('${leadId}', '${ids.userA}')`)), /permission denied/)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`SELECT public.schedule_bump_version('${leadId}', '${ids.shopA}')`)), /permission denied/)
})

test('staff previewing the customer link cannot request a date', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  const opt = (await publicSchedule(quote.public_token)).offer.options[0]
  assert.equal((await requestDate(quote.public_token, opt.id, staff('userA'))).error, 'staff_preview')
})

test('read-only (billing) shops cannot change schedules', async () => {
  const { leadId, quote } = await approvedLead(false, 'shopC')
  await assert.rejects(createOffer(leadId, 'userC', [D(5)]), /read-only/)
  // An admin can still act; the read-only shop user cannot confirm or cancel.
  await offerDates(leadId, 'admin', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await assert.rejects(confirm(leadId, 'userC', D(8)), /read-only/)
  await assert.rejects(markSent((await createOffer(leadId, 'admin', [D(6)])).offer_id, 'userC'), /read-only/)
  assert.equal((await confirm(leadId, 'admin', D(8))).ok, true)
  await assert.rejects(cancel(leadId, 'userC'), /read-only/)
})

// ---------------------------------------------------------------------------
// Cancellation, rebooking, rescheduling
// ---------------------------------------------------------------------------

test('cancellation keeps history and allows rebooking', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(7))
  assert.equal((await cancel(leadId, 'userA', 'Customer travelling')).ok, true)
  assert.equal(await leadStatus(leadId), 'scheduling')
  assert.equal(await activeReservation(leadId), undefined)
  assert.equal((await publicSchedule(quote.public_token)).booking, null)
  await assert.rejects(cancel(leadId, 'userA'), /no confirmed schedule/)

  await offerDates(leadId, 'userA', [D(12)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(15))
  const history = (await db.query(`SELECT status, start_date, cancel_reason FROM schedule_reservations WHERE lead_id = $1 ORDER BY confirmed_at`, [leadId])).rows
  assert.deepEqual(history.map((r: any) => [r.status, dateText(r.start_date)]), [['cancelled', D(5)], ['active', D(12)]])
  assert.equal(history[0].cancel_reason, 'Customer travelling')
  assert.ok((await events(leadId)).some((e: any) => e.event_type === 'schedule_cancelled'))
})

test('rescheduling keeps the booking until the replacement is confirmed', async () => {
  const { leadId, quote } = await approvedLead(true)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(8))
  const original = await activeReservation(leadId)

  await offerDates(leadId, 'userA', [D(20)], 'Earlier slot fell through.')
  const pub = await publicSchedule(quote.public_token)
  assert.equal(pub.offer.is_reschedule, true)
  assert.deepEqual(pub.booking, { start_date: D(5), estimated_ready_date: D(8) })
  await requestDate(quote.public_token, pub.offer.options[0].id)
  assert.equal((await activeReservation(leadId)).id, original.id, 'old booking still active')
  assert.equal(await leadStatus(leadId), 'scheduled')

  await confirm(leadId, 'userA', D(24))
  const replaced = await one(db, `SELECT * FROM schedule_reservations WHERE id = $1`, [original.id])
  const current = await activeReservation(leadId)
  assert.equal(replaced.status, 'replaced')
  assert.equal(replaced.replaced_by_id, current.id)
  const ev = (await events(leadId)).filter((e: any) => e.event_type === 'schedule_confirmed').at(-1)
  assert.deepEqual([ev.metadata.rescheduled, ev.metadata.previous_start_date, ev.metadata.start_date], [true, D(5), D(20)])
})

test('cancellation works while revised quote terms await approval; rescheduling does not', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(8))
  const rev = await createQuote(leadId, 'userA', 800, quote.id)
  await sendQuote(rev.id, 'userA')
  await assert.rejects(createOffer(leadId, 'userA', [D(9)]), /must approve the current quote/)
  assert.equal((await cancel(leadId, 'userA')).ok, true)
  assert.equal(await leadStatus(leadId), 'scheduling')
})

test('in-progress and completed jobs cannot be rescheduled or cancelled', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(8))
  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = 'in_progress' WHERE id = $1`, [leadId]))
  await assert.rejects(cancel(leadId, 'userA'), /Work has started/)
  await assert.rejects(createOffer(leadId, 'userA', [D(9)]), /Work has started/)
  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = 'completed' WHERE id = $1`, [leadId]))
  assert.equal((await activeReservation(leadId)).status, 'active', 'normal progress keeps the reservation')
})

// ---------------------------------------------------------------------------
// Status bypass and legacy data
// ---------------------------------------------------------------------------

test('Scheduled cannot be set directly, and booked work cannot move back without cancelling', async () => {
  const { leadId, quote } = await approvedLead(false)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = 'scheduled' WHERE id = $1`, [leadId])),
    /requires a confirmed production date/)
  await assert.rejects(as(db, staff('admin'), async (tx: any) => tx.query(`UPDATE leads SET status = 'scheduled' WHERE id = $1`, [leadId])),
    /requires a confirmed production date/)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name, status)
    VALUES ($1, 'X', 'x@example.test', 'v', 'V', 'scheduled')`, [ids.shopA])), /cannot start as Scheduled/)

  // A pending customer request alone is not enough either.
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = 'scheduled' WHERE id = $1`, [leadId])),
    /requires a confirmed production date/)

  await confirm(leadId, 'userA', D(6))
  for (const status of ['scheduling', 'approved', 'contacted', 'lost', 'archived']) {
    await assert.rejects(as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET status = $2 WHERE id = $1`, [leadId, status])),
      /Cancel the schedule/, status)
  }
  // Editing other fields of a booked lead still works.
  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET customer_phone = '555' WHERE id = $1`, [leadId]))
})

test('legacy undated Scheduled leads stay editable and can be given dates', async () => {
  const leadId = await newLead('shopA', false)
  const q = await createQuote(leadId, 'userA', 400)
  await sendQuote(q.id, 'userA')
  await approve(q.public_token)
  // Simulate data that existed before this migration (no reservation).
  await db.exec(`SET session_replication_role = replica`)
  await db.query(`UPDATE leads SET status = 'scheduled' WHERE id = $1`, [leadId])
  await db.exec(`SET session_replication_role = origin`)

  await as(db, staff('userA'), async (tx: any) => tx.query(`UPDATE leads SET notes = 'still editable' WHERE id = $1`, [leadId]))
  assert.equal(await activeReservation(leadId), undefined, 'no dates are fabricated')
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(q.public_token, (await publicSchedule(q.public_token)).offer.options[0].id)
  assert.equal(await leadStatus(leadId), 'scheduled')
  await confirm(leadId, 'userA', D(6))
  assert.ok(await activeReservation(leadId))
})

test('scheduling history is append-only', async () => {
  const { leadId, quote } = await approvedLead(false)
  await offerDates(leadId, 'userA', [D(5)])
  await requestDate(quote.public_token, (await publicSchedule(quote.public_token)).offer.options[0].id)
  await confirm(leadId, 'userA', D(6))
  await assert.rejects(db.query(`UPDATE schedule_reservations SET start_date = start_date + 1 WHERE lead_id = $1`, [leadId]), /cannot be rewritten/)
  await assert.rejects(db.query(`DELETE FROM schedule_reservations WHERE lead_id = $1`, [leadId]), /cannot be deleted/)
  await assert.rejects(db.query(`UPDATE schedule_offer_options SET start_date = start_date + 1 WHERE lead_id = $1`, [leadId]), /cannot be changed/)
  // Deleting the lead still cascades cleanly.
  await db.query(`DELETE FROM leads WHERE id = $1`, [leadId])
  assert.equal((await one(db, `SELECT count(*)::int AS n FROM schedule_reservations WHERE lead_id = $1`, [leadId])).n, 0)
})
