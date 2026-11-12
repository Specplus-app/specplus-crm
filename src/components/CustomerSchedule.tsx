import { useCallback, useEffect, useReducer, useRef } from 'react'
import { formatCurrency, supabase } from '../lib/supabase'
import {
  BOOK_FAILED, LOAD_FAILED, REQUEST_FAILED, customerScheduleReducer, customerScheduleView, initialCustomerSchedule,
  requestErrorMessage, type PublicSchedule,
} from '../lib/schedule'
import { isSafePaymentUrl, type PublicDeposit } from '../lib/deposits'
import { formatDateOnly } from '../lib/scheduleDates'
import CustomerDatePicker from './CustomerDatePicker'
import {
  AlertCircle, CalendarCheck, CalendarClock, CalendarDays, CalendarX, Check, CheckCircle2, ExternalLink, Loader2, MessageSquare,
  RefreshCw, Wallet,
} from 'lucide-react'

const longDate = (d: string) => formatDateOnly(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

// Production date on the customer's quote page. After approving the quote the
// customer books a start date from the shop's calendar (window and blocked
// days only, never other customers' jobs); the booking is confirmed at once,
// followed by the shop's deposit request if it has one. Shops can still offer
// specific dates (their own booking and history are unchanged).
export default function CustomerSchedule({ token, shopName, staffPreview, quoteApproved }: {
  token: string
  shopName: string
  staffPreview: boolean
  quoteApproved: boolean
}) {
  const [state, dispatch] = useReducer(customerScheduleReducer, initialCustomerSchedule)
  const loadSeq = useRef(0)

  // Never throws. Failures keep the last good data and show a retry.
  const load = useCallback(async () => {
    const id = ++loadSeq.current
    dispatch({ type: 'loadStart', id })
    try {
      const { data, error } = await supabase.rpc('get_public_schedule', { p_token: token })
      if (error) {
        console.error('Failed to load schedule:', error.message)
        dispatch({ type: 'loadFailure', id })
        return
      }
      dispatch({ type: 'loadSuccess', id, data: (data as PublicSchedule | null) ?? null })
    } catch (err) {
      console.error('Failed to load schedule:', err)
      dispatch({ type: 'loadFailure', id })
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  // "Book It": the server books the date immediately. A retry (or a second
  // click) for the same date returns the same booking, so after any failure
  // the refresh below shows whether it was booked.
  const bookDate = async () => {
    const date = state.selectedDate
    if (!state.data?.calendar || !date || state.submitting) return
    dispatch({ type: 'submitStart' })
    try {
      const { data, error } = await supabase.rpc('book_schedule_date', { p_token: token, p_start_date: date })
      const result = data as { ok: boolean; error?: string; start_date?: string } | null
      if (error) dispatch({ type: 'submitRejected', message: BOOK_FAILED })
      else if (result?.ok) dispatch({ type: 'bookAccepted', start_date: result.start_date ?? date })
      else dispatch({ type: 'submitRejected', message: requestErrorMessage(result?.error) || BOOK_FAILED })
    } catch {
      dispatch({ type: 'submitRejected', message: BOOK_FAILED })
    } finally {
      dispatch({ type: 'submitSettled' })
      // Loads the booking and any deposit details (or fresh availability).
      await load()
    }
  }

  // Choosing one of the shop's offered dates (the shop confirms it).
  const submit = async () => {
    const offered = state.data?.offer?.options.find((o) => o.id === state.selected)
    const option = offered && { id: offered.id, start_date: offered.start_date }
    if (!option || state.submitting) return
    dispatch({ type: 'submitStart' })
    try {
      const { data, error } = await supabase.rpc('request_schedule_date', { p_token: token, p_option_id: option.id })
      if (error) {
        dispatch({ type: 'submitRejected', message: REQUEST_FAILED })
        return
      }
      const result = data as { ok: boolean; error?: string } | null
      if (result?.ok) {
        dispatch({ type: 'submitAccepted', option, at: new Date().toISOString() })
      } else {
        dispatch({ type: 'submitRejected', message: requestErrorMessage(result?.error) })
      }
      // Pick up replaced options or the confirmed state; a failed refresh
      // keeps what is already shown.
      await load()
    } catch {
      dispatch({ type: 'submitRejected', message: REQUEST_FAILED })
    } finally {
      dispatch({ type: 'submitSettled' })
    }
  }

  const view = customerScheduleView(state, quoteApproved)
  if (view === 'hidden') return null

  const card = 'bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-6 mb-5'
  const title = (
    <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
      <CalendarDays size={15} className="text-cobalt-300" /> Production date
    </h2>
  )
  const retryButton = (
    <button onClick={load} disabled={state.status === 'loading'} className="flex items-center gap-1.5 text-xs font-semibold text-red-100 underline disabled:opacity-60">
      {state.status === 'loading' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Retry
    </button>
  )

  if (view === 'loading') {
    return (
      <div className={card} aria-busy="true">
        {title}
        <p className="flex items-center gap-2 text-sm text-slate-400 mt-2"><Loader2 size={14} className="animate-spin" /> Loading production dates…</p>
      </div>
    )
  }
  if (view === 'error') {
    return (
      <div className={card}>
        {title}
        <div className="flex items-center justify-between gap-3 text-sm text-red-200 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mt-2">
          <span className="flex items-center gap-2"><AlertCircle size={15} /> {LOAD_FAILED}</span>
          {retryButton}
        </div>
      </div>
    )
  }
  if (view === 'empty') {
    return (
      <div className={card}>
        {title}
        <p className="text-sm text-slate-400 mt-2">No production dates have been offered yet. {shopName} will share start dates here.</p>
        {state.status === 'loading' && <p className="flex items-center gap-2 text-xs text-slate-500 mt-2"><Loader2 size={12} className="animate-spin" /> Refreshing…</p>}
      </div>
    )
  }

  const { offer, request, booking } = state.data!
  const calendar = offer ? null : state.data!.calendar ?? null
  const deposit = booking ? state.data!.deposit ?? null : null
  const { selected, selectedDate, submitting } = state
  const requestUnavailable = request?.available === false
  const calendarRequest = request?.source === 'calendar' ? request : null

  return (
    <div className={card}>
      {title}

      {state.status === 'error' && (
        <div className="flex items-center justify-between gap-3 text-sm text-red-200 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mt-3">
          <span className="flex items-center gap-2"><AlertCircle size={15} /> Couldn't refresh production dates. Showing the last loaded details.</span>
          {retryButton}
        </div>
      )}

      {booking && (
        <div className="flex items-start gap-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mt-3 text-sm text-emerald-100" role="status">
          <CalendarCheck size={18} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Booked — your project starts {longDate(booking.start_date)}</p>
            <p className="text-emerald-200/80">
              {booking.estimated_ready_date
                ? `Estimated ready ${longDate(booking.estimated_ready_date)}`
                : `Estimated ready date: not yet provided. ${shopName} will add it once they've planned the work.`}
            </p>
          </div>
        </div>
      )}
      {deposit && <DepositCard deposit={deposit} shopName={shopName} />}

      {!booking && !offer && !calendar && state.data!.booking_unavailable && (
        <p className="flex items-start gap-2 text-sm text-slate-300 bg-white/5 border border-white/10 rounded-xl px-4 py-3 mt-3" role="status">
          <MessageSquare size={16} className="flex-shrink-0 mt-0.5 text-slate-400" />
          <span>Online booking isn't available right now. Send {shopName} a message below to arrange your start date.</span>
        </p>
      )}

      {offer && (
        <>
          <p className="text-sm text-slate-400 mt-3 mb-3">
            {offer.is_reschedule
              ? `${shopName} needs to move your start date. Choose one of the new dates below; your current date stays in place until the shop confirms.`
              : `Choose a production start date. ${shopName} will confirm it before it is booked.`}
          </p>
          {offer.note && <p className="text-sm text-slate-300 whitespace-pre-wrap bg-white/5 border border-white/10 rounded-xl px-3 py-2 mb-3">{offer.note}</p>}

          {request && <RequestStatus request={request} shopName={shopName} />}

          <div className="space-y-2" role="radiogroup" aria-label="Production start dates">
            {(offer.options ?? []).map((o) => {
              const active = selected === o.id
              const unavailable = o.available === false
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={staffPreview || submitting || unavailable}
                  onClick={() => dispatch({ type: 'select', optionId: o.id })}
                  className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors disabled:opacity-60 ${
                    active && !unavailable ? 'border-cobalt-400 bg-cobalt-500/15 text-white' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                  }`}
                >
                  <span className={unavailable ? 'line-through text-slate-400' : ''}>{longDate(o.start_date)}</span>
                  {unavailable ? <span className="text-xs text-slate-400">No longer available</span> : active && <Check size={16} className="text-cobalt-300" />}
                </button>
              )
            })}
          </div>

          {state.requestError && <p className="text-sm text-red-300 mt-3" role="alert">{state.requestError}</p>}
          {staffPreview ? (
            <p className="text-sm text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 mt-3">Staff preview — customers choose a date from their own link.</p>
          ) : (
            <button
              onClick={submit}
              disabled={!selected || submitting || (selected === request?.option_id && !requestUnavailable)}
              className="w-full flex items-center justify-center gap-2 mt-4 bg-cobalt-600 hover:bg-cobalt-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-5 py-3 transition-colors"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {request ? (selected === request.option_id && !requestUnavailable ? 'Date requested' : 'Change requested date') : 'Request this date'}
            </button>
          )}
        </>
      )}

      {calendar && (
        <>
          <p className="text-sm text-slate-400 mt-3 mb-3">
            Choose a production start date and book it. Your date is confirmed right away.
          </p>

          {/* A date request sent before instant booking: still with the shop. */}
          {calendarRequest && (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-3 text-sm text-amber-100" role="status">
              <CalendarClock size={18} className="flex-shrink-0 mt-0.5" />
              <p>
                You asked {shopName} to start {longDate(calendarRequest.start_date)}
                {requestUnavailable ? ', but that date is no longer available.' : '.'} You can book a date directly below instead.
              </p>
            </div>
          )}

          <CustomerDatePicker
            calendar={calendar}
            selected={selectedDate}
            requested={calendarRequest?.start_date ?? null}
            disabled={staffPreview || submitting}
            onSelect={(date) => dispatch({ type: 'selectDate', date })}
          />

          <p className="flex items-start gap-2 text-xs text-slate-400 mt-3">
            <MessageSquare size={13} className="flex-shrink-0 mt-0.5" />
            <span>Need a date after {longDate(calendar.latest)}, or one that isn't available? Send {shopName} a message below.</span>
          </p>

          {state.requestError && <p className="text-sm text-red-300 mt-3" role="alert">{state.requestError}</p>}
          {staffPreview ? (
            <p className="text-sm text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 mt-3">Staff preview — customers choose a date from their own link.</p>
          ) : (
            <button
              onClick={bookDate}
              disabled={!selectedDate || submitting}
              aria-busy={submitting}
              className="w-full flex items-center justify-center gap-2 mt-4 bg-cobalt-600 hover:bg-cobalt-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-5 py-3 transition-colors"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {submitting
                ? 'Booking…'
                : selectedDate
                  ? `Book It — ${formatDateOnly(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' })}`
                  : 'Select a start date'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// The shop's deposit request after booking. Payment happens on the shop's own
// payment page (or as its instructions say); SpecPlus doesn't process it, and
// it doesn't change the quote total. The shop marks it received.
function DepositCard({ deposit, shopName }: { deposit: PublicDeposit; shopName: string }) {
  const link = isSafePaymentUrl(deposit.payment_url) ? deposit.payment_url : null
  if (deposit.status === 'received') {
    return (
      <div className="flex items-start gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 mt-3 text-sm text-slate-200" role="status">
        <CheckCircle2 size={18} className="flex-shrink-0 mt-0.5 text-emerald-300" />
        <p><span className="font-semibold">Deposit received.</span> {shopName} has confirmed your deposit{deposit.amount != null ? ` of ${formatCurrency(deposit.amount)}` : ''}.</p>
      </div>
    )
  }
  return (
    <section className="bg-white/5 border border-white/10 rounded-xl px-4 py-4 mt-3 text-sm" aria-labelledby="deposit-title">
      <h3 id="deposit-title" className="font-semibold text-white flex items-center gap-2">
        <Wallet size={16} className="text-cobalt-300" />
        {deposit.amount != null ? `Deposit: ${formatCurrency(deposit.amount)}` : 'Deposit requested'}
      </h3>
      <p className="text-slate-400 mt-1">Your date is booked. {shopName} asks for a deposit to hold it.</p>
      {deposit.instructions && <p className="text-slate-200 whitespace-pre-wrap mt-2">{deposit.instructions}</p>}
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="w-full sm:w-auto inline-flex items-center justify-center gap-2 mt-3 bg-cobalt-600 hover:bg-cobalt-500 text-white font-semibold rounded-xl px-5 py-3 transition-colors"
        >
          Pay Deposit <ExternalLink size={15} aria-hidden="true" />
        </a>
      )}
      <p className="text-xs text-slate-500 mt-3">
        {link ? `Opens ${shopName}'s payment page in a new tab. ` : ''}
        Payments go directly to {shopName}, not SpecPlus, and don't change your quote total. {shopName} will mark the deposit as received.
      </p>
    </section>
  )
}

// The customer's pending request: awaiting confirmation, or no longer
// available because the shop blocked the date (choose another).
function RequestStatus({ request, shopName }: { request: { start_date: string; available?: boolean }; shopName: string }) {
  if (request.available === false) {
    return (
      <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 mb-3 text-sm text-red-100" role="status">
        <CalendarX size={18} className="flex-shrink-0 mt-0.5" />
        <p><span className="font-semibold">{shopName} is no longer available on {longDate(request.start_date)}.</span> Please choose another date.</p>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-3 text-sm text-amber-100" role="status">
      <CalendarClock size={18} className="flex-shrink-0 mt-0.5" />
      <p><span className="font-semibold">Date requested — awaiting shop confirmation.</span> You asked to start {longDate(request.start_date)}.</p>
    </div>
  )
}
