// Shop availability helpers for the Schedule page (src/lib/shopAvailability.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BOOKING_WINDOW_DAYS, blockedRanges, bookingWindowLabel, loadShopAvailability, setDatesBlocked, validateBlockRange,
} from '../src/lib/shopAvailability.ts'

test('blocked dates are grouped into consecutive ranges', () => {
  assert.deepEqual(blockedRanges([]), [])
  assert.deepEqual(blockedRanges(['2026-11-05', '2026-11-03', '2026-11-04', '2026-11-04', '2026-11-10']), [
    { start: '2026-11-03', end: '2026-11-05' },
    { start: '2026-11-10', end: '2026-11-10' },
  ])
  // Across a month and year boundary.
  assert.deepEqual(blockedRanges(['2026-12-31', '2027-01-01', '2026-11-30', '2026-12-01']), [
    { start: '2026-11-30', end: '2026-12-01' },
    { start: '2026-12-31', end: '2027-01-01' },
  ])
})

test('the block form is validated like the database', () => {
  const today = '2026-10-28'
  assert.equal(validateBlockRange('', '', today), 'Choose a date.')
  assert.equal(validateBlockRange('2026-11-02', '', today), null, 'a single day needs no end date')
  assert.equal(validateBlockRange('2026-11-02', '2026-11-09', today), null)
  assert.match(validateBlockRange('2026-11-09', '2026-11-02', today)!, /on or after/)
  assert.match(validateBlockRange('2026-11-01', '2027-11-02', today)!, /one year or less/)
  assert.equal(validateBlockRange('2026-11-01', '2027-11-01', today), null, '366 days is allowed')
  assert.match(validateBlockRange('2026-10-01', '2026-10-05', today)!, /Past dates/)
  assert.equal(validateBlockRange('2026-10-20', '2026-11-02', today), null, 'a range reaching into the past is clamped by the server')
})

test('window labels', () => {
  assert.equal(bookingWindowLabel(60), '2 months')
  assert.equal(bookingWindowLabel(45), '45 days')
})

function fakeClient(results: { settings?: unknown; blocked?: unknown; rpc?: unknown; throws?: boolean }) {
  const calls: { table: string; ops: unknown[][] }[] = []
  const rpcCalls: unknown[][] = []
  const client = {
    from(table: string) {
      if (results.throws) throw new Error('Failed to fetch')
      const call = { table, ops: [] as unknown[][] }
      calls.push(call)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'gte', 'order', 'limit', 'maybeSingle']) builder[op] = (...args: unknown[]) => { call.ops.push([op, ...args]); return builder }
      builder.then = (resolve: (v: unknown) => void) => resolve(table === 'shop_schedule_settings' ? results.settings : results.blocked)
      return builder
    },
    async rpc(name: string, args: unknown) {
      rpcCalls.push([name, args])
      return results.rpc
    },
  }
  return { client: client as never, calls, rpcCalls }
}

test('loads one shop: its window (default when unset) and blocked dates from a date on', async () => {
  const { client, calls } = fakeClient({
    settings: { data: { booking_window_days: 30 }, error: null },
    blocked: { data: [{ blocked_date: '2026-11-03' }, { blocked_date: '2026-11-04' }], error: null },
  })
  assert.deepEqual(await loadShopAvailability(client, 'shop-a', '2026-10-27'), {
    data: { bookingWindowDays: 30, blockedDates: ['2026-11-03', '2026-11-04'] }, error: null,
  })
  const ops = (t: string) => calls.find((c) => c.table === t)!.ops.filter(([op]) => op === 'eq' || op === 'gte')
  assert.deepEqual(ops('shop_schedule_settings'), [['eq', 'shop_id', 'shop-a']])
  assert.deepEqual(ops('shop_blocked_dates'), [['eq', 'shop_id', 'shop-a'], ['gte', 'blocked_date', '2026-10-27']])

  const unset = fakeClient({ settings: { data: null, error: null }, blocked: { data: [], error: null } })
  assert.deepEqual((await loadShopAvailability(unset.client, 'shop-b', '2026-10-27')).data,
    { bookingWindowDays: DEFAULT_BOOKING_WINDOW_DAYS, blockedDates: [] }, 'shops without settings use the safe default')
})

test('a failed load is an error, never "nothing blocked"', async () => {
  const failed = fakeClient({ settings: { data: null, error: null }, blocked: { data: null, error: { message: 'permission denied' } } })
  assert.deepEqual(await loadShopAvailability(failed.client, 'shop-a', '2026-10-27'), { data: null, error: 'permission denied' })
  const offline = fakeClient({ throws: true })
  assert.deepEqual(await loadShopAvailability(offline.client, 'shop-a', '2026-10-27'), { data: null, error: 'Failed to fetch' })
})

test('blocking calls the database function with the shop and range', async () => {
  const { client, rpcCalls } = fakeClient({ rpc: { data: { ok: true, changed: 3 }, error: null } })
  assert.deepEqual(await setDatesBlocked(client, 'shop-a', '2026-11-03', '2026-11-05', true), { data: { ok: true, changed: 3 }, error: null })
  assert.deepEqual(rpcCalls, [['set_schedule_dates_blocked', { p_shop_id: 'shop-a', p_start: '2026-11-03', p_end: '2026-11-05', p_blocked: true }]])
  const refused = fakeClient({ rpc: { data: null, error: { message: 'Shop not found' } } })
  assert.deepEqual(await setDatesBlocked(refused.client, 'shop-b', '2026-11-03', '2026-11-03', false), { data: null, error: 'Shop not found' })
})
