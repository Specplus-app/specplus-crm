// State for the customer's production-date section on the quote page. Pure
// (no runtime imports) so loading, refresh and request edge cases are unit
// tested. The database functions remain authoritative.

// Customer-safe shape returned by get_public_schedule.
export type PublicSchedule = {
  can_request: boolean
  offer: { note: string | null; is_reschedule: boolean; options: { id: string; start_date: string }[] } | null
  request: { option_id: string; start_date: string; requested_at: string } | null
  booking: { start_date: string; estimated_ready_date: string } | null
}

export const PUBLIC_SCHEDULE_ERRORS: Record<string, string> = {
  options_replaced: 'These dates were replaced by the shop. Please choose from the current options.',
  superseded: 'This quote has been revised. Please use the latest quote link from the shop.',
  quote_not_approved: 'Approve the current quote before choosing a date.',
  invalid_option: 'That date is not available for this project.',
  date_passed: 'That date has passed. Please choose another date or message the shop.',
  not_available: 'Dates can no longer be chosen for this project. Please message the shop.',
  staff_preview: 'You are signed in as shop staff. Customers choose dates from their own link.',
  rate_limited: 'Too many changes in a short time. Please wait a few minutes and try again.',
  not_found: 'Quote not found.',
}

export const REQUEST_FAILED = 'Your date could not be sent. Please try again.'
export const LOAD_FAILED = 'Production dates could not be loaded.'

export type CustomerScheduleState = {
  // Outcome of the most recent load.
  status: 'loading' | 'ready' | 'error'
  // Last good data. Kept when a later refresh fails.
  data: PublicSchedule | null
  // Sequence number of the newest load; older responses are ignored.
  latestLoad: number
  selected: string | null
  submitting: boolean
  requestError: string | null
}

export type CustomerScheduleAction =
  | { type: 'loadStart'; id: number }
  | { type: 'loadSuccess'; id: number; data: PublicSchedule | null }
  | { type: 'loadFailure'; id: number }
  | { type: 'select'; optionId: string }
  | { type: 'submitStart' }
  // The server recorded the request; reflect it even if the refresh fails.
  | { type: 'submitAccepted'; option: { id: string; start_date: string }; at: string }
  | { type: 'submitRejected'; message: string }
  | { type: 'submitSettled' }

export const initialCustomerSchedule: CustomerScheduleState = {
  status: 'loading', data: null, latestLoad: 0, selected: null, submitting: false, requestError: null,
}

function keepSelection(data: PublicSchedule | null, selected: string | null): string | null {
  const options = data?.offer?.options ?? []
  if (data?.request && options.some((o) => o.id === data.request!.option_id)) return data.request.option_id
  return selected && options.some((o) => o.id === selected) ? selected : null
}

export function customerScheduleReducer(state: CustomerScheduleState, action: CustomerScheduleAction): CustomerScheduleState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, status: 'loading', latestLoad: action.id }
    case 'loadSuccess':
      if (action.id !== state.latestLoad) return state
      return { ...state, status: 'ready', data: action.data, selected: keepSelection(action.data, state.selected) }
    case 'loadFailure':
      if (action.id !== state.latestLoad) return state
      return { ...state, status: 'error' }
    case 'select':
      return state.submitting ? state : { ...state, selected: action.optionId, requestError: null }
    case 'submitStart':
      return { ...state, submitting: true, requestError: null }
    case 'submitAccepted': {
      if (!state.data) return { ...state, submitting: false }
      const request = { option_id: action.option.id, start_date: action.option.start_date, requested_at: action.at }
      return { ...state, submitting: false, requestError: null, selected: action.option.id, data: { ...state.data, request } }
    }
    case 'submitRejected':
      return { ...state, submitting: false, requestError: action.message }
    case 'submitSettled':
      return state.submitting ? { ...state, submitting: false } : state
  }
}

export type CustomerScheduleView = 'hidden' | 'loading' | 'error' | 'empty' | 'content'

// What to render. "empty" (an approved quote with no dates offered yet) is a
// successful load and is shown distinctly from a loading failure.
export function customerScheduleView(state: CustomerScheduleState, quoteApproved: boolean): CustomerScheduleView {
  if (!state.data) {
    if (state.status === 'error') return 'error'
    if (state.status === 'loading') return quoteApproved ? 'loading' : 'hidden'
    return quoteApproved ? 'empty' : 'hidden'
  }
  if (state.data.offer || state.data.booking) return 'content'
  return quoteApproved ? 'empty' : 'hidden'
}

export function requestErrorMessage(code: string | undefined): string {
  return (code && PUBLIC_SCHEDULE_ERRORS[code]) || REQUEST_FAILED
}
