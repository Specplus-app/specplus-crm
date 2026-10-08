import { useCallback, useEffect, useReducer, useRef } from 'react'
import { supabase } from '../lib/supabase'
import {
  LOAD_FAILED, REQUEST_FAILED, customerScheduleReducer, customerScheduleView, initialCustomerSchedule,
  requestErrorMessage, type PublicSchedule,
} from '../lib/schedule'
import { formatDateOnly } from '../lib/scheduleDates'
import { AlertCircle, CalendarCheck, CalendarClock, CalendarDays, Check, Loader2, RefreshCw } from 'lucide-react'

const longDate = (d: string) => formatDateOnly(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

// Production date choice on the customer's quote page. Shows only this
// project's active options, its own pending request and its own booking.
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

  const submit = async () => {
    const option = state.data?.offer?.options.find((o) => o.id === state.selected)
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
  const { selected, submitting } = state

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
        <div className="flex items-start gap-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mt-3 text-sm text-emerald-100">
          <CalendarCheck size={18} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Scheduled to start {longDate(booking.start_date)}</p>
            <p className="text-emerald-200/80">Estimated ready {longDate(booking.estimated_ready_date)}</p>
          </div>
        </div>
      )}

      {offer && (
        <>
          <p className="text-sm text-slate-400 mt-3 mb-3">
            {offer.is_reschedule
              ? `${shopName} needs to move your start date. Choose one of the new dates below; your current date stays in place until the shop confirms.`
              : `Choose a production start date. ${shopName} will confirm it before it is booked.`}
          </p>
          {offer.note && <p className="text-sm text-slate-300 whitespace-pre-wrap bg-white/5 border border-white/10 rounded-xl px-3 py-2 mb-3">{offer.note}</p>}

          {request && (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-3 text-sm text-amber-100">
              <CalendarClock size={18} className="flex-shrink-0 mt-0.5" />
              <p><span className="font-semibold">Date requested — awaiting shop confirmation.</span> You asked to start {longDate(request.start_date)}.</p>
            </div>
          )}

          <div className="space-y-2" role="radiogroup" aria-label="Production start dates">
            {(offer.options ?? []).map((o) => {
              const active = selected === o.id
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={staffPreview || submitting}
                  onClick={() => dispatch({ type: 'select', optionId: o.id })}
                  className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors disabled:opacity-60 ${
                    active ? 'border-cobalt-400 bg-cobalt-500/15 text-white' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'
                  }`}
                >
                  {longDate(o.start_date)}
                  {active && <Check size={16} className="text-cobalt-300" />}
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
              disabled={!selected || submitting || selected === request?.option_id}
              className="w-full flex items-center justify-center gap-2 mt-4 bg-cobalt-600 hover:bg-cobalt-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-5 py-3 transition-colors"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              {request ? (selected === request.option_id ? 'Date requested' : 'Change requested date') : 'Request this date'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
