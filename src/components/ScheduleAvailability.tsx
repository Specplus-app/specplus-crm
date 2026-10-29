import { useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  BOOKING_WINDOW_CHOICES, bookingWindowLabel, blockedRanges, runAvailabilityAction, setBookingWindow, setDatesBlocked,
  validateBlockRange, type ShopAvailability,
} from '../lib/shopAvailability'
import { formatDateOnly, formatDateRange, todayDateOnly } from '../lib/scheduleDates'
import { AlertCircle, Ban, CalendarRange, Loader2, RefreshCw, Unlock } from 'lucide-react'

const VISIBLE_RANGES = 8

// Schedule page: how far ahead customers can request a start date, and the
// dates the shop has blocked. Existing jobs never block a date; the shop
// blocks days when it is full. Every change is checked again by the database.
export default function ScheduleAvailability({ shopId, readOnly, availability, loading, error, onChanged }: {
  shopId: string
  readOnly: boolean
  availability: ShopAvailability | null
  loading: boolean
  error: string | null
  onChanged: () => Promise<void> | void
}) {
  const today = todayDateOnly()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // Which control is saving: 'window', 'block', 'unblock' or 'range:<start>'.
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  // Entered dates stay in the form unless the save succeeds, and the
  // controls are always released, even if the save or refresh throws.
  const run = async (key: string, action: () => Promise<{ error: string | null }>) => {
    if (busy) return false
    setBusy(key)
    setActionError(null)
    try {
      const result = await runAvailabilityAction(action, onChanged)
      setActionError(result.error)
      return result.ok
    } finally {
      setBusy(null)
    }
  }

  const changeWindow = (days: number) => run('window', () => setBookingWindow(supabase, shopId, days))

  const changeBlocked = async (blocked: boolean) => {
    const problem = validateBlockRange(from, to, today)
    if (problem) {
      setActionError(problem)
      return
    }
    const ok = await run(blocked ? 'block' : 'unblock', () => setDatesBlocked(supabase, shopId, from, to || from, blocked))
    if (ok) {
      setFrom('')
      setTo('')
    }
  }

  const ranges = availability ? blockedRanges(availability.blockedDates) : []
  const shown = showAll ? ranges : ranges.slice(0, VISIBLE_RANGES)
  const windowDays = availability?.bookingWindowDays
  const choices = windowDays && !BOOKING_WINDOW_CHOICES.some((c) => c.days === windowDays)
    ? [...BOOKING_WINDOW_CHOICES, { days: windowDays, label: bookingWindowLabel(windowDays) }].sort((a, b) => a.days - b.days)
    : BOOKING_WINDOW_CHOICES
  const disabled = readOnly || !availability || !!busy
  const input = 'w-full min-w-0 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 [color-scheme:dark] focus:outline-none focus:border-cobalt-400 disabled:opacity-60'
  const btn = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <section className="rounded-xl border border-white/10 bg-obsidian-900/40 p-4 mb-5" aria-labelledby="availability-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="availability-title" className="text-sm font-semibold text-white flex items-center gap-2">
            <CalendarRange size={15} className="text-cobalt-400" /> Customer booking
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            After approving a quote, customers can request a start date from tomorrow through the booking window below, on any day you haven't blocked.
            Requests aren't booked until you confirm them on the lead. Existing jobs don't block days, so block dates when you're full.
          </p>
        </div>
        <button type="button" onClick={() => onChanged()} disabled={loading} className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/10 disabled:opacity-50" aria-label="Refresh availability" title="Refresh availability">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 text-xs text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mt-3">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          {availability ? `Couldn't refresh availability (${error}). Showing the last loaded settings.` : `Couldn't load availability (${error}).`}
        </p>
      )}
      {actionError && (
        <p className="flex items-start gap-1.5 text-xs text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mt-3" role="alert">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" /> {actionError}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] mt-4">
        <div>
          <label htmlFor="booking-window" className="block text-xs font-semibold text-slate-300 mb-1">Booking window</label>
          <div className="flex items-center gap-2">
            <select
              id="booking-window"
              value={windowDays ?? ''}
              onChange={(e) => changeWindow(Number(e.target.value))}
              disabled={disabled}
              className={input}
            >
              {!availability && <option value="">Loading…</option>}
              {choices.map((c) => <option key={c.days} value={c.days} className="bg-obsidian-900">{c.label} ahead</option>)}
            </select>
            {busy === 'window' && <Loader2 size={15} className="animate-spin text-slate-400 shrink-0" />}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">Customers who need a later date are asked to message you through their quote.</p>
        </div>

        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-300 mb-1">Block or unblock dates</p>
          <div className="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 items-end">
            <label className="min-w-0">
              <span className="block text-[11px] text-slate-500 mb-0.5">From</span>
              <input type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); setActionError(null) }} disabled={disabled} className={input} />
            </label>
            <label className="min-w-0">
              <span className="block text-[11px] text-slate-500 mb-0.5">To <span className="text-slate-600">(optional)</span></span>
              <input type="date" min={from || today} value={to} onChange={(e) => { setTo(e.target.value); setActionError(null) }} disabled={disabled} className={input} />
            </label>
            <button type="button" onClick={() => changeBlocked(true)} disabled={disabled || !from} className={`${btn} bg-red-500/20 text-red-100 border border-red-500/40 hover:bg-red-500/30`}>
              {busy === 'block' ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} Block
            </button>
            <button type="button" onClick={() => changeBlocked(false)} disabled={disabled || !from} className={`${btn} bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10`}>
              {busy === 'unblock' ? <Loader2 size={14} className="animate-spin" /> : <Unlock size={14} />} Unblock
            </button>
          </div>

          <div className="mt-3">
            {!availability ? (
              loading && <div className="h-6 w-48 bg-white/5 rounded animate-pulse" />
            ) : ranges.length === 0 ? (
              <p className="text-xs text-slate-500">No blocked dates. Every day in the booking window can be requested.</p>
            ) : (
              <>
                <p className="text-[11px] text-slate-500 mb-1.5">Blocked ({availability.blockedDates.length} {availability.blockedDates.length === 1 ? 'day' : 'days'})</p>
                <ul className="flex flex-wrap gap-1.5">
                  {shown.map((r) => {
                    const key = `range:${r.start}`
                    const label = r.start === r.end ? formatDateOnly(r.start, { weekday: 'short', month: 'short', day: 'numeric' }) : formatDateRange(r.start, r.end)
                    return (
                      <li key={r.start} className="inline-flex items-center gap-1 text-xs rounded-md border border-red-500/30 bg-red-500/10 text-red-100 pl-2 pr-1 py-0.5">
                        {label}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => run(key, () => setDatesBlocked(supabase, shopId, r.start, r.end, false))}
                            disabled={!!busy}
                            className="p-0.5 rounded hover:bg-red-500/20 disabled:opacity-50"
                            aria-label={`Unblock ${label}`}
                            title="Unblock"
                          >
                            {busy === key ? <Loader2 size={12} className="animate-spin" /> : <Unlock size={12} />}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {ranges.length > VISIBLE_RANGES && (
                  <button type="button" onClick={() => setShowAll(!showAll)} className="text-[11px] text-slate-400 hover:text-slate-200 underline mt-1.5">
                    {showAll ? 'Show fewer' : `Show all ${ranges.length}`}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {readOnly && <p className="text-xs text-slate-500 mt-3">Availability is read-only while your account is inactive.</p>}
    </section>
  )
}
