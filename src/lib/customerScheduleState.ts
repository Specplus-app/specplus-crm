// State for the customer's production-date section on the quote page. Pure
// (no runtime imports) so loading, refresh and request edge cases are unit
// tested. The database functions remain authoritative.

// The booking window the customer may pick from (no offered dates): from
// `earliest` through `latest`, except the shop's blocked dates.
export type PublicCalendar = { earliest: string; latest: string; blocked_dates: string[] }

// Customer-safe shape returned by get_public_schedule.
export type PublicSchedule = {
  can_request: boolean
  offer: { note: string | null; is_reschedule: boolean; options: { id: string; start_date: string; available?: boolean }[] } | null
  calendar?: PublicCalendar | null
  // source 'calendar' requests have no option_id. available = false when the
  // shop has since blocked the date (or it passed): choose another.
  request: { option_id: string | null; start_date: string; requested_at: string; source?: 'offer' | 'calendar'; available?: boolean } | null
  booking: { start_date: string; estimated_ready_date: string } | null
}

export const PUBLIC_SCHEDULE_ERRORS: Record<string, string> = {
  options_replaced: 'These dates were replaced by the shop. Please choose from the current options.',
  superseded: 'This quote has been revised. Please use the latest quote link from the shop.',
  quote_not_approved: 'Approve the current quote before choosing a date.',
  invalid_option: 'That date is not available for this project.',
  invalid_date: 'Choose a start date from the calendar.',
  date_passed: 'That date has passed or is too soon. Please choose another date or message the shop.',
  date_blocked: 'The shop is no longer available on that date. Please choose another date.',
  outside_window: "That date is further ahead than the shop is booking. Choose an earlier date, or send the shop a message below if you need a later one.",
  use_offered_dates: 'The shop has offered specific dates. Please choose one of those.',
  already_scheduled: 'Your project is already scheduled. Send the shop a message below if you need to change the date.',
  not_available: 'Dates can no longer be chosen for this project. Please message the shop.',
  staff_preview: 'You are signed in as shop staff. Customers choose dates from their own link.',
  rate_limited: 'Too many changes in a short time. Please wait a few minutes and try again.',
  not_found: 'Quote not found.',
}

export type CalendarDateStatus = 'available' | 'blocked' | 'outside'

// Whether a day can be requested from the calendar. The database checks the
// same rule again when the request is sent.
export function calendarDateStatus(day: string, calendar: PublicCalendar): CalendarDateStatus {
  if (day < calendar.earliest || day > calendar.latest) return 'outside'
  return calendar.blocked_dates.includes(day) ? 'blocked' : 'available'
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
  // Offered option id chosen (offer flow).
  selected: string | null
  // Calendar date chosen (calendar flow).
  selectedDate: string | null
  submitting: boolean
  requestError: string | null
}

export type CustomerScheduleAction =
  | { type: 'loadStart'; id: number }
  | { type: 'loadSuccess'; id: number; data: PublicSchedule | null }
  | { type: 'loadFailure'; id: number }
  | { type: 'select'; optionId: string }
  | { type: 'selectDate'; date: string }
  | { type: 'submitStart' }
  // The server recorded the request; reflect it even if the refresh fails.
  // A calendar request has no option id.
  | { type: 'submitAccepted'; option: { id: string | null; start_date: string }; at: string }
  | { type: 'submitRejected'; message: string }
  | { type: 'submitSettled' }

export const initialCustomerSchedule: CustomerScheduleState = {
  status: 'loading', data: null, latestLoad: 0, selected: null, selectedDate: null, submitting: false, requestError: null,
}

function keepSelection(data: PublicSchedule | null, selected: string | null): string | null {
  // Options the shop has since blocked can't be chosen.
  const options = (data?.offer?.options ?? []).filter((o) => o.available !== false)
  if (data?.request && options.some((o) => o.id === data.request!.option_id)) return data.request.option_id
  return selected && options.some((o) => o.id === selected) ? selected : null
}

// Keeps the chosen calendar date while it can still be requested; otherwise
// falls back to the pending request's date if that is still available.
function keepDate(data: PublicSchedule | null, selectedDate: string | null): string | null {
  const calendar = data?.calendar
  if (!calendar) return null
  if (selectedDate && calendarDateStatus(selectedDate, calendar) === 'available') return selectedDate
  const request = data?.request
  if (request?.source === 'calendar' && calendarDateStatus(request.start_date, calendar) === 'available') return request.start_date
  return null
}

export function customerScheduleReducer(state: CustomerScheduleState, action: CustomerScheduleAction): CustomerScheduleState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, status: 'loading', latestLoad: action.id }
    case 'loadSuccess':
      if (action.id !== state.latestLoad) return state
      return {
        ...state, status: 'ready', data: action.data,
        selected: keepSelection(action.data, state.selected), selectedDate: keepDate(action.data, state.selectedDate),
      }
    case 'loadFailure':
      if (action.id !== state.latestLoad) return state
      return { ...state, status: 'error' }
    case 'select':
      return state.submitting ? state : { ...state, selected: action.optionId, requestError: null }
    case 'selectDate': {
      const calendar = state.data?.calendar
      if (state.submitting || !calendar || calendarDateStatus(action.date, calendar) !== 'available') return state
      return { ...state, selectedDate: action.date, requestError: null }
    }
    case 'submitStart':
      return { ...state, submitting: true, requestError: null }
    case 'submitAccepted': {
      if (!state.data) return { ...state, submitting: false }
      const calendar = action.option.id === null
      const request = {
        option_id: action.option.id, start_date: action.option.start_date, requested_at: action.at,
        source: calendar ? 'calendar' as const : 'offer' as const, available: true,
      }
      return {
        ...state, submitting: false, requestError: null, data: { ...state.data, request },
        ...(calendar ? { selectedDate: action.option.start_date } : { selected: action.option.id }),
      }
    }
    case 'submitRejected':
      return { ...state, submitting: false, requestError: action.message }
    case 'submitSettled':
      return state.submitting ? { ...state, submitting: false } : state
  }
}

export type CustomerScheduleView = 'hidden' | 'loading' | 'error' | 'empty' | 'content'

// What to render. "empty" (an approved quote with nothing to choose yet) is a
// successful load and is shown distinctly from a loading failure.
export function customerScheduleView(state: CustomerScheduleState, quoteApproved: boolean): CustomerScheduleView {
  if (!state.data) {
    if (state.status === 'error') return 'error'
    if (state.status === 'loading') return quoteApproved ? 'loading' : 'hidden'
    return quoteApproved ? 'empty' : 'hidden'
  }
  if (state.data.offer || state.data.booking || state.data.calendar) return 'content'
  return quoteApproved ? 'empty' : 'hidden'
}

export function requestErrorMessage(code: string | undefined): string {
  return (code && PUBLIC_SCHEDULE_ERRORS[code]) || REQUEST_FAILED
}
