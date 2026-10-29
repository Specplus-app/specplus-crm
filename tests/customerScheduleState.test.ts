import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUEST_FAILED, calendarDateStatus, customerScheduleReducer, customerScheduleView, initialCustomerSchedule, requestErrorMessage,
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
  assert.deepEqual(s.data?.request, { option_id: 'o2', start_date: '2026-11-09', requested_at: '2026-10-07T12:00:00Z', source: 'offer', available: true })
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

// ---------------------------------------------------------------------------
// Calendar requests (no offered dates)
// ---------------------------------------------------------------------------

const calendar = { earliest: '2026-10-29', latest: '2026-12-27', blocked_dates: ['2026-11-05', '2026-11-06'] }
const bookable: PublicSchedule = { can_request: true, offer: null, calendar, request: null, booking: null }

test('calendar days: only inside the window and not blocked', () => {
  assert.equal(calendarDateStatus('2026-10-28', calendar), 'outside', 'before the earliest day')
  assert.equal(calendarDateStatus('2026-10-29', calendar), 'available')
  assert.equal(calendarDateStatus('2026-11-05', calendar), 'blocked')
  assert.equal(calendarDateStatus('2026-12-27', calendar), 'available', 'the last day of the window')
  assert.equal(calendarDateStatus('2026-12-28', calendar), 'outside')
})

test('a bookable calendar is content; blocked and out-of-window days cannot be selected', () => {
  const s = run([{ type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: bookable }])
  assert.equal(customerScheduleView(s, true), 'content')
  assert.equal(run([{ type: 'selectDate', date: '2026-11-05' }], s).selectedDate, null)
  assert.equal(run([{ type: 'selectDate', date: '2027-01-15' }], s).selectedDate, null)
  const picked = run([{ type: 'selectDate', date: '2026-11-10' }], s)
  assert.equal(picked.selectedDate, '2026-11-10')
  assert.equal(run([{ type: 'submitStart' }, { type: 'selectDate', date: '2026-11-11' }], picked).selectedDate, '2026-11-10', 'locked while sending')
})

test('an accepted calendar request is shown even if the refresh fails', () => {
  const s = run([
    { type: 'loadStart', id: 1 },
    { type: 'loadSuccess', id: 1, data: bookable },
    { type: 'selectDate', date: '2026-11-10' },
    { type: 'submitStart' },
    { type: 'submitAccepted', option: { id: null, start_date: '2026-11-10' }, at: '2026-10-28T12:00:00Z' },
    { type: 'loadStart', id: 2 },
    { type: 'loadFailure', id: 2 },
    { type: 'submitSettled' },
  ])
  assert.deepEqual(s.data?.request, { option_id: null, start_date: '2026-11-10', requested_at: '2026-10-28T12:00:00Z', source: 'calendar', available: true })
  assert.equal(s.selectedDate, '2026-11-10')
  assert.equal(s.selected, null)
  assert.equal(customerScheduleView(s, true), 'content')
})

test('a date blocked after the request is dropped so the customer chooses another', () => {
  const requested: PublicSchedule = {
    ...bookable, request: { option_id: null, start_date: '2026-11-10', requested_at: 'x', source: 'calendar', available: true },
  }
  const s = run([{ type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: requested }])
  assert.equal(s.selectedDate, '2026-11-10', 'the pending date starts selected')

  const nowBlocked: PublicSchedule = {
    ...requested,
    calendar: { ...calendar, blocked_dates: [...calendar.blocked_dates, '2026-11-10'] },
    request: { ...requested.request!, available: false },
  }
  const after = run([{ type: 'loadStart', id: 2 }, { type: 'loadSuccess', id: 2, data: nowBlocked }], s)
  assert.equal(after.selectedDate, null)
  assert.equal(after.data?.request?.available, false)
  // A changed choice made before a refresh survives it while still available.
  const changed = run([{ type: 'selectDate', date: '2026-11-12' }, { type: 'loadStart', id: 3 }, { type: 'loadSuccess', id: 3, data: requested }], s)
  assert.equal(changed.selectedDate, '2026-11-12')
})

test('offered options the shop has since blocked are not kept selected', () => {
  const blockedOption: PublicSchedule = {
    ...offered,
    offer: { ...offered.offer!, options: [{ id: 'o1', start_date: '2026-11-02', available: false }, { id: 'o2', start_date: '2026-11-09', available: true }] },
    request: { option_id: 'o1', start_date: '2026-11-02', requested_at: 'x', source: 'offer', available: false },
  }
  const s = run([{ type: 'select', optionId: 'o1' }, { type: 'loadStart', id: 1 }, { type: 'loadSuccess', id: 1, data: blockedOption }])
  assert.equal(s.selected, null)
})

test('calendar error codes have customer-facing messages', () => {
  for (const code of ['date_blocked', 'outside_window', 'use_offered_dates', 'already_scheduled', 'invalid_date']) {
    assert.notEqual(requestErrorMessage(code), REQUEST_FAILED, code)
  }
  assert.match(requestErrorMessage('outside_window'), /message below/)
})
