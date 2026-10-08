// Pure scheduling rules for the staff UI. The database functions in
// 20261007120000_add_production_scheduling.sql are authoritative; these only
// decide which actions to offer. No runtime imports, so it is unit tested.
import type { DateOnly } from './scheduleDates'

export type ScheduleOfferStatus = 'draft' | 'active' | 'superseded' | 'invalidated' | 'withdrawn' | 'closed'
export type ScheduleRequestStatus = 'pending' | 'confirmed' | 'replaced' | 'superseded' | 'invalidated' | 'cancelled'
export type ScheduleReservationStatus = 'active' | 'replaced' | 'cancelled'

export type ScheduleOffer = {
  id: string
  lead_id: string
  quote_id: string
  quote_revision_number: number
  status: ScheduleOfferStatus
  customer_note: string | null
  is_reschedule: boolean
  created_at: string
  sent_at: string | null
  closed_at: string | null
  options: { id: string; start_date: DateOnly }[]
}

export type ScheduleRequest = {
  id: string
  offer_id: string
  quote_id: string
  start_date: DateOnly
  status: ScheduleRequestStatus
  requested_at: string
}

export type ScheduleReservation = {
  id: string
  quote_id: string
  quote_revision_number: number
  start_date: DateOnly
  estimated_ready_date: DateOnly
  internal_notes: string | null
  status: ScheduleReservationStatus
  confirmed_at: string
  ended_at: string | null
  cancel_reason: string | null
}

export type QuoteSummary = {
  id: string
  revision_number: number
  status: string
  superseded_at: string | null
  grand_total: number
  estimated_lead_time_days?: number
}

export type LeadScheduleState = {
  version: number
  draftOffer: ScheduleOffer | null
  activeOffer: ScheduleOffer | null
  pendingRequest: ScheduleRequest | null
  reservation: ScheduleReservation | null
  pastReservations: ScheduleReservation[]
  currentQuote: QuoteSummary | null
}

const STARTED = ['in_progress', 'completed']
const CLOSED = ['lost', 'archived']

export function currentQuoteApproved(quote: QuoteSummary | null): boolean {
  return !!quote && quote.status === 'approved' && !quote.superseded_at
}

export type ScheduleActions = {
  canOffer: boolean
  canConfirm: boolean
  canCancel: boolean
  offerLabel: 'Offer dates' | 'Offer new dates' | 'Reschedule'
  // Why offering is unavailable, when it is.
  offerBlockedReason: string | null
  scheduleMissing: boolean
  // A newer quote revision than the one the confirmed booking was made against.
  newerTerms: QuoteSummary | null
}

export function scheduleActions(leadStatus: string, state: LeadScheduleState, readOnly: boolean): ScheduleActions {
  const started = STARTED.includes(leadStatus)
  const closed = CLOSED.includes(leadStatus)
  const approved = currentQuoteApproved(state.currentQuote)
  const reservation = state.reservation

  let offerBlockedReason: string | null = null
  if (readOnly) offerBlockedReason = 'Your account is read-only.'
  else if (started) offerBlockedReason = 'Work has started, so this job cannot be rescheduled here.'
  else if (closed) offerBlockedReason = 'Reopen this lead before offering dates.'
  else if (!state.currentQuote) offerBlockedReason = 'Send a quote and get customer approval before offering dates.'
  else if (!approved) offerBlockedReason = 'The customer must approve the current quote before dates can be offered.'

  const newerTerms = reservation && state.currentQuote && state.currentQuote.id !== reservation.quote_id
    ? state.currentQuote
    : null

  return {
    canOffer: offerBlockedReason === null,
    canConfirm: !readOnly && !started && !closed && approved && !!state.pendingRequest && !!state.activeOffer
      && state.pendingRequest.offer_id === state.activeOffer.id && state.pendingRequest.quote_id === state.currentQuote?.id,
    canCancel: !readOnly && !started && !!reservation,
    offerLabel: reservation ? 'Reschedule' : state.activeOffer ? 'Offer new dates' : 'Offer dates',
    offerBlockedReason,
    scheduleMissing: leadStatus === 'scheduled' && !reservation,
    newerTerms,
  }
}

// Default estimated-ready date for the confirm dialog: the start date plus
// the approved quote's lead-time estimate (reference only; calendar days, no
// business-day or holiday rules).
export function suggestedReadyDate(start: DateOnly, leadTimeDays: number, addDays: (d: DateOnly, n: number) => DateOnly): DateOnly {
  const days = Number.isFinite(leadTimeDays) && leadTimeDays > 0 ? Math.round(leadTimeDays) : 0
  return addDays(start, days)
}

// Validates the offer form before calling the database (which re-checks).
export function validateOfferDates(dates: string[], today: DateOnly): { dates: DateOnly[]; error: string | null } {
  const cleaned = Array.from(new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort()
  if (cleaned.length === 0) return { dates: cleaned, error: 'Add at least one start date.' }
  if (cleaned.length > 10) return { dates: cleaned, error: 'Offer at most 10 start dates.' }
  if (cleaned[0] < today) return { dates: cleaned, error: 'Start dates cannot be in the past.' }
  return { dates: cleaned, error: null }
}
