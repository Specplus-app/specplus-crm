// Shop calendar context shared by the Schedule page and the lead's
// "Offer dates" / "Confirm schedule" dialogs (src/lib/calendarContext.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_OFFER_DATES, dayDetails, jobPosition, loadShopCalendar, requestsByDay, toggleOfferDate,
} from '../src/lib/calendarContext.ts'
import { agendaKey, agendaReducer, initialAgenda } from '../src/lib/agendaState.ts'
import { validateOfferDates } from '../src/lib/scheduleRules.ts'

const job = (id: string, start: string, ready: string, lead_id = `lead-${id}`) => ({ id, lead_id, start_date: start, estimated_ready_date: ready, lead: null })
const request = (id: string, start: string, lead_id = `lead-${id}`) => ({ id, lead_id, start_date: start, requested_at: '2026-10-20T12:00:00Z', lead: null })

test('confirmed jobs appear on every day from start to estimated ready, overlaps allowed', () => {
  const jobs = [job('a', '2026-11-02', '2026-11-05'), job('b', '2026-11-04', '2026-11-04'), job('c', '2026-11-06', '2026-11-09')]
  assert.deepEqual(dayDetails('2026-11-01', jobs, []).jobs, [])
  assert.deepEqual(dayDetails('2026-11-03', jobs, []).jobs.map((j) => [j.id, j.position]), [['a', 'In shop']])
  // Two overlapping jobs on the same day: both shown, starts listed first.
  assert.deepEqual(dayDetails('2026-11-04', jobs, []).jobs.map((j) => [j.id, j.position]), [['b', 'Starts'], ['a', 'In shop']])
  assert.deepEqual(dayDetails('2026-11-05', jobs, []).jobs.map((j) => [j.id, j.position]), [['a', 'Ready']])
  assert.equal(jobPosition(job('x', '2026-11-02', '2026-11-02'), '2026-11-02'), 'Starts', 'one-day job')
})

test('pending requests are kept separate from confirmed bookings and cover only their start date', () => {
  const jobs = [job('a', '2026-11-02', '2026-11-05')]
  const pending = [request('r1', '2026-11-03'), request('r2', '2026-11-03'), request('r3', '2026-11-10')]
  const d = dayDetails('2026-11-03', jobs, pending)
  assert.deepEqual(d.jobs.map((j) => j.id), ['a'])
  assert.deepEqual(d.requests.map((r) => r.id), ['r1', 'r2'])
  assert.deepEqual(dayDetails('2026-11-04', jobs, pending).requests, [], 'a request is not a multi-day booking')
  const byDay = requestsByDay(pending, ['2026-11-03', '2026-11-04', '2026-11-10'])
  assert.deepEqual([...byDay].map(([day, rows]) => [day, rows.length]), [['2026-11-03', 2], ['2026-11-04', 0], ['2026-11-10', 1]])
})

test('offer dates toggle on and off, stay sorted and unique, and match the send-time rules', () => {
  const today = '2026-10-27'
  let dates: string[] = []
  for (const d of ['2026-11-10', '2026-11-03', '2026-11-05']) dates = toggleOfferDate(dates, d, today).dates
  assert.deepEqual(dates, ['2026-11-03', '2026-11-05', '2026-11-10'])
  assert.deepEqual(toggleOfferDate(dates, '2026-11-05', today), { dates: ['2026-11-03', '2026-11-10'], error: null }, 'second tap removes')
  assert.deepEqual(toggleOfferDate(dates, today, today).error, null, 'today can be offered')
  const past = toggleOfferDate(dates, '2026-10-26', today)
  assert.deepEqual(past, { dates, error: 'Start dates cannot be in the past.' })

  const full = Array.from({ length: MAX_OFFER_DATES }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`)
  const eleventh = toggleOfferDate(full, '2026-12-20', today)
  assert.equal(eleventh.dates, full, 'selection unchanged')
  assert.match(eleventh.error!, /at most 10/)
  assert.equal(toggleOfferDate(full, '2026-12-01', today).dates.length, 9, 'removing still works when full')

  // Anything the calendar allows also passes the existing send-time validation.
  assert.deepEqual(validateOfferDates(dates, today), { dates, error: null })
  assert.deepEqual(validateOfferDates(full, today).error, null)
})

// Fake PostgREST builder: records filters and resolves like the real client.
function fakeClient(results: { reservations?: unknown; requests?: unknown; throws?: boolean }) {
  const calls: { table: string; ops: unknown[][] }[] = []
  const client = {
    from(table: string) {
      if (results.throws) throw new Error('Failed to fetch')
      const call = { table, ops: [] as unknown[][] }
      calls.push(call)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'lte', 'gte', 'order']) builder[op] = (...args: unknown[]) => { call.ops.push([op, ...args]); return builder }
      builder.then = (resolve: (v: unknown) => void) => resolve(table === 'schedule_reservations' ? results.reservations : results.requests)
      return builder
    },
  }
  return { client: client as never, calls }
}

test('the shared loader reads one shop: active bookings overlapping the range and pending requests inside it', async () => {
  const jobs = [job('a', '2026-10-28', '2026-11-03')]
  const pending = [request('r', '2026-11-12')]
  const { client, calls } = fakeClient({ reservations: { data: jobs, error: null }, requests: { data: pending, error: null } })
  const res = await loadShopCalendar(client, 'shop-a', '2026-10-27', '2026-12-07')
  assert.deepEqual(res, { data: { jobs, pending }, error: null })
  const ops = (t: string) => calls.find((c) => c.table === t)!.ops.filter(([op]) => op !== 'select' && op !== 'order')
  assert.deepEqual(ops('schedule_reservations'), [
    ['eq', 'shop_id', 'shop-a'], ['eq', 'status', 'active'], ['lte', 'start_date', '2026-12-07'], ['gte', 'estimated_ready_date', '2026-10-27'],
  ])
  assert.deepEqual(ops('schedule_requests'), [
    ['eq', 'shop_id', 'shop-a'], ['eq', 'status', 'pending'], ['gte', 'start_date', '2026-10-27'], ['lte', 'start_date', '2026-12-07'],
  ])
})

test('a failed load is reported as an error, never as an empty schedule', async () => {
  const ok = { data: [], error: null }
  for (const results of [
    { reservations: { data: null, error: { message: 'permission denied' } }, requests: ok },
    { reservations: ok, requests: { data: null, error: { message: 'timeout' } } },
    { throws: true },
  ]) {
    const res = await loadShopCalendar(fakeClient(results).client, 'shop-a', '2026-10-27', '2026-12-07')
    assert.equal(res.data, null)
    assert.ok(res.error)
  }

  // The view state behind both the Schedule page and the dialogs: a failed
  // first load stays "not loaded"; a failed refresh keeps the last rows.
  const key = agendaKey('shop-a', '2026-10-27', '2026-12-07')
  let s = agendaReducer(initialAgenda<unknown, unknown>(), { type: 'loadStart', id: 1, key })
  s = agendaReducer(s, { type: 'loadFailure', id: 1, error: 'timeout' })
  assert.equal(s.loaded, false)
  assert.deepEqual(s.jobs, [])
  s = agendaReducer(s, { type: 'loadStart', id: 2, key })
  s = agendaReducer(s, { type: 'loadSuccess', id: 2, jobs: [job('a', '2026-10-28', '2026-11-03')], pending: [] })
  s = agendaReducer(s, { type: 'loadStart', id: 3, key })
  s = agendaReducer(s, { type: 'loadFailure', id: 3, error: 'offline' })
  assert.equal(s.loaded, true)
  assert.equal(s.jobs.length, 1, 'refresh failure keeps the last loaded data')
  assert.equal(s.error, 'offline')
})
