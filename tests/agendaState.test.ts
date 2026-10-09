import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agendaKey, agendaReducer, initialAgenda, type AgendaAction, type AgendaState } from '../src/lib/agendaState.ts'

type Row = { id: string }
const run = (actions: AgendaAction<Row, Row>[], start: AgendaState<Row, Row> = initialAgenda<Row, Row>()) =>
  actions.reduce((s, a) => agendaReducer(s, a), start)

const W1 = agendaKey('shop-a', '2026-10-05', '2026-10-11')
const W2 = agendaKey('shop-a', '2026-10-12', '2026-10-18')

test('a slow response for the previous week cannot overwrite the new week', () => {
  const s = run([
    { type: 'loadStart', id: 1, key: W1 },
    { type: 'loadStart', id: 2, key: W2 },
    { type: 'loadSuccess', id: 2, jobs: [{ id: 'w2-job' }], pending: [] },
    // Week 1 arrives late.
    { type: 'loadSuccess', id: 1, jobs: [{ id: 'w1-job' }], pending: [{ id: 'w1-request' }] },
  ])
  assert.equal(s.key, W2)
  assert.deepEqual(s.jobs.map((j) => j.id), ['w2-job'])
  assert.deepEqual(s.pending, [])
  assert.equal(s.status, 'ready')
})

test('a stale failure cannot replace newer data or loading state', () => {
  const loading = run([
    { type: 'loadStart', id: 1, key: W1 },
    { type: 'loadStart', id: 2, key: W2 },
    { type: 'loadFailure', id: 1, error: 'old week failed' },
  ])
  assert.deepEqual([loading.status, loading.error], ['loading', null])
  const done = run([{ type: 'loadSuccess', id: 2, jobs: [], pending: [{ id: 'w2-request' }] }, { type: 'loadFailure', id: 1, error: 'late' }], loading)
  assert.deepEqual([done.status, done.error, done.pending.length], ['ready', null, 1])
})

test('switching weeks clears the previous week immediately, even if the new load fails', () => {
  const week1 = run([
    { type: 'loadStart', id: 1, key: W1 },
    { type: 'loadSuccess', id: 1, jobs: [{ id: 'w1-job' }], pending: [{ id: 'w1-request' }] },
  ])
  const switching = agendaReducer(week1, { type: 'loadStart', id: 2, key: W2 })
  assert.deepEqual([switching.jobs, switching.pending, switching.loaded], [[], [], false])
  const failed = agendaReducer(switching, { type: 'loadFailure', id: 2, error: 'network' })
  assert.deepEqual([failed.key, failed.status, failed.error, failed.pending, failed.loaded], [W2, 'error', 'network', [], false])
})

test('retrying the same week keeps its rows while reloading; a shop change clears them', () => {
  const week1 = run([
    { type: 'loadStart', id: 1, key: W1 },
    { type: 'loadSuccess', id: 1, jobs: [{ id: 'w1-job' }], pending: [] },
  ])
  const retry = run([{ type: 'loadStart', id: 2, key: W1 }, { type: 'loadFailure', id: 2, error: 'blip' }], week1)
  assert.deepEqual([retry.jobs.length, retry.loaded, retry.error], [1, true, 'blip'])
  const otherShop = agendaReducer(week1, { type: 'loadStart', id: 3, key: agendaKey('shop-b', '2026-10-05', '2026-10-11') })
  assert.deepEqual([otherShop.jobs, otherShop.loaded], [[], false])
})

test('rapid month/week switching only ever shows the range on screen', () => {
  const OCT = agendaKey('shop-a', '2026-09-28', '2026-11-01') // October month grid
  const s = run([
    { type: 'loadStart', id: 1, key: OCT },
    { type: 'loadStart', id: 2, key: W1 }, // to Week
    { type: 'loadStart', id: 3, key: OCT }, // straight back to Month
    { type: 'loadSuccess', id: 2, jobs: [{ id: 'week-only' }], pending: [] },
    { type: 'loadFailure', id: 1, error: 'first month load failed late' },
  ])
  assert.deepEqual([s.key, s.status, s.jobs, s.loaded, s.error], [OCT, 'loading', [], false, null])
  const done = run([
    { type: 'loadSuccess', id: 3, jobs: [{ id: 'month-job' }], pending: [{ id: 'month-request' }] },
    { type: 'loadSuccess', id: 1, jobs: [{ id: 'stale-month' }], pending: [] },
  ], s)
  assert.deepEqual([done.jobs.map((j) => j.id), done.pending.length, done.status], [['month-job'], 1, 'ready'])
  // Switching to a week inside the month still clears the month's rows.
  assert.deepEqual(agendaReducer(done, { type: 'loadStart', id: 4, key: W1 }).jobs, [])
})
