import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUEST_FAILED, customerScheduleReducer, customerScheduleView, initialCustomerSchedule, requestErrorMessage,
  type CustomerScheduleAction, type CustomerScheduleState, type PublicSchedule,
} from '../src/lib/customerScheduleState.ts'

const run = (actions: CustomerScheduleAction[], start: CustomerScheduleState = initialCustomerSchedule) =>
  actions.reduce((s, a) => customerScheduleReducer(s, a), start)

const offered: PublicSchedule = {
  can_request: true,
  offer: { note: 'Mornings', is_reschedule: false, options: [{ id: 'o1', start_date: '2026-11-02' }, { id: 'o2', start_date: '2026-11-09' }] },
  request: null,
  booking: null,
}
const nothing: PublicSchedule = { can_request: false, offer: null, request: null, booking: null }

test('loading, failure and "no dates offered" are distinct', () => {
  assert.equal(customerScheduleView(initialCustomerSchedule, true), 'loading')
  const failed = run([{ type: 'loadStart', id: 1 }, { type: 'loadFailure', id: 1 }])
  assert.equal(customerScheduleView(failed, true), 'error')
  assert.equal(customerScheduleView(failed, false), 'error', 'a failure is shown even if a booking might exist')
  const empty = run([{ type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: nothing }])
  assert.equal(customerScheduleView(empty, true), 'empty')
  assert.equal(customerScheduleView(empty, false), 'hidden')
  const content = run([{ type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: offered }])
  assert.equal(customerScheduleView(content, true), 'content')
})

test('a failed refresh keeps the last loaded dates; a retry recovers', () => {
  const loaded = run([{ type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: offered }, { type: 'select', optionId: 'o2' }])
  const failed = run([{ type: 'loadStart', id: 2 }, { type: 'loadFailure', id: 2 }], loaded)
  assert.equal(failed.status, 'error')
  assert.equal(failed.data, offered)
  assert.equal(failed.selected, 'o2')
  assert.equal(customerScheduleView(failed, true), 'content')
  const retried = run([{ type: 'loadStart', id: 3 }, { type: 'loadSuccess', id: 3, data: offered }], failed)
  assert.equal(retried.status, 'ready')
})

test('a request that succeeded stays visible when its follow-up refresh fails', () => {
  const s = run([
    { type: 'loadStart', id: 1 },
    { type: 'loadSuccess', id: 1, data: offered },
    { type: 'select', optionId: 'o2' },
    { type: 'submitStart' },
    { type: 'submitAccepted', option: { id: 'o2', start_date: '2026-11-09' }, at: '2026-10-07T12:00:00Z' },
    { type: 'loadStart', id: 2 },
    { type: 'loadFailure', id: 2 },
    { type: 'submitSettled' },
  ])
  assert.equal(s.submitting, false)
  assert.equal(s.status, 'error')
  assert.deepEqual(s.data?.request, { option_id: 'o2', start_date: '2026-11-09', requested_at: '2026-10-07T12:00:00Z' })
  assert.equal(s.requestError, null)
  assert.equal(customerScheduleView(s, true), 'content')
})

test('rejected and failed requests show a message and always release the busy state', () => {
  const ready = run([{ type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: offered }, { type: 'select', optionId: 'o1' }])
  const rejected = run([{ type: 'submitStart' }, { type: 'submitRejected', message: requestErrorMessage('options_replaced') }, { type: 'submitSettled' }], ready)
  assert.equal(rejected.submitting, false)
  assert.match(rejected.requestError!, /replaced by the shop/)
  assert.equal(rejected.data?.request, null, 'nothing is shown as requested')
  assert.equal(requestErrorMessage('something_new'), REQUEST_FAILED)
  assert.equal(requestErrorMessage(undefined), REQUEST_FAILED)
  // Even with no terminal action (e.g. an exception), settling releases it.
  const settled = run([{ type: 'submitStart' }, { type: 'submitSettled' }], ready)
  assert.equal(settled.submitting, false)
  // Choices are locked while a request is in flight.
  const locked = run([{ type: 'submitStart' }, { type: 'select', optionId: 'o2' }], ready)
  assert.equal(locked.selected, 'o1')
})

test('stale load responses are ignored; replaced options drop an invalid selection', () => {
  const s = run([
    { type: 'loadStart', id: 1 },
    { type: 'loadStart', id: 2 },
    { type: 'loadSuccess', id: 2, data: offered },
    { type: 'loadSuccess', id: 1, data: nothing },
    { type: 'loadFailure', id: 1 },
  ])
  assert.deepEqual([s.status, s.data], ['ready', offered])
  const replaced: PublicSchedule = { ...offered, offer: { ...offered.offer!, options: [{ id: 'o9', start_date: '2026-12-01' }] } }
  const after = run([{ type: 'select', optionId: 'o1' }, { type: 'loadStart', id: 3 }, { type: 'loadSuccess', id: 3, data: replaced }], s)
  assert.equal(after.selected, null)
  const withRequest = run([{ type: 'loadStart', id: 4 }, { type: 'loadSuccess', id: 4, data: { ...offered, request: { option_id: 'o2', start_date: '2026-11-09', requested_at: 'x' } } }], s)
  assert.equal(withRequest.selected, 'o2')
})
