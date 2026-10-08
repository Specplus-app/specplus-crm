import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleActions, suggestedReadyDate, validateOfferDates, type LeadScheduleState } from '../src/lib/scheduleRules.ts'
import { addDays } from '../src/lib/scheduleDates.ts'

const approvedQuote = { id: 'q1', revision_number: 1, status: 'approved', superseded_at: null, grand_total: 900 }
const offer = { id: 'o1', lead_id: 'l', quote_id: 'q1', quote_revision_number: 1, status: 'active' as const, customer_note: null,
  is_reschedule: false, created_at: '', sent_at: '', closed_at: null, options: [{ id: 'opt', start_date: '2026-11-02' }] }
const request = { id: 'r1', offer_id: 'o1', quote_id: 'q1', start_date: '2026-11-02', status: 'pending' as const, requested_at: '' }
const reservation = { id: 'res', quote_id: 'q1', quote_revision_number: 1, start_date: '2026-11-02', estimated_ready_date: '2026-11-06',
  internal_notes: null, status: 'active' as const, confirmed_at: '', ended_at: null, cancel_reason: null }

function state(patch: Partial<LeadScheduleState> = {}): LeadScheduleState {
  return { version: 3, draftOffer: null, activeOffer: null, pendingRequest: null, reservation: null, pastReservations: [], currentQuote: approvedQuote, ...patch }
}

test('offering requires an approved current quote', () => {
  assert.equal(scheduleActions('approved', state(), false).canOffer, true)
  const sent = scheduleActions('quote_sent', state({ currentQuote: { ...approvedQuote, status: 'sent' } }), false)
  assert.equal(sent.canOffer, false)
  assert.match(sent.offerBlockedReason!, /approve the current quote/)
  assert.equal(scheduleActions('new', state({ currentQuote: null }), false).canOffer, false)
})

test('confirmation needs a pending request on the active options for the current quote', () => {
  assert.equal(scheduleActions('scheduling', state({ activeOffer: offer }), false).canConfirm, false)
  assert.equal(scheduleActions('scheduling', state({ activeOffer: offer, pendingRequest: request }), false).canConfirm, true)
  const revised = { ...approvedQuote, id: 'q2', revision_number: 2, status: 'sent' }
  assert.equal(scheduleActions('scheduling', state({ activeOffer: offer, pendingRequest: request, currentQuote: revised }), false).canConfirm, false)
  assert.equal(scheduleActions('scheduling', state({ activeOffer: offer, pendingRequest: request }), true).canConfirm, false, 'read-only')
})

test('booked jobs: reschedule and cancel until work starts; newer terms are flagged', () => {
  const booked = scheduleActions('scheduled', state({ reservation }), false)
  assert.deepEqual([booked.canOffer, booked.canCancel, booked.offerLabel], [true, true, 'Reschedule'])
  for (const status of ['in_progress', 'completed']) {
    const started = scheduleActions(status, state({ reservation }), false)
    assert.deepEqual([started.canOffer, started.canCancel], [false, false], status)
  }
  const revised = { ...approvedQuote, id: 'q2', revision_number: 2, status: 'sent' }
  const pendingTerms = scheduleActions('scheduled', state({ reservation, currentQuote: revised }), false)
  assert.equal(pendingTerms.newerTerms?.revision_number, 2)
  assert.equal(pendingTerms.canCancel, true, 'cancellation stays possible while new terms await approval')
  assert.equal(pendingTerms.canOffer, false)
})

test('undated Scheduled leads are flagged, never given dates', () => {
  const legacy = scheduleActions('scheduled', state(), false)
  assert.equal(legacy.scheduleMissing, true)
  assert.equal(scheduleActions('scheduled', state({ reservation }), false).scheduleMissing, false)
})

test('offer form validation and ready-date suggestion', () => {
  assert.deepEqual(validateOfferDates(['2026-11-09', '2026-11-02', '2026-11-02', ''], '2026-10-07'), { dates: ['2026-11-02', '2026-11-09'], error: null })
  assert.match(validateOfferDates([], '2026-10-07').error!, /at least one/)
  assert.match(validateOfferDates(['2026-10-06'], '2026-10-07').error!, /past/)
  assert.equal(suggestedReadyDate('2026-12-29', 5, addDays), '2027-01-03')
  assert.equal(suggestedReadyDate('2026-12-29', 0, addDays), '2026-12-29')
})
