import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { PUBLIC_SCHEDULE_ERRORS, type PublicSchedule } from '../lib/schedule'
import { formatDateOnly } from '../lib/scheduleDates'
import { CalendarCheck, CalendarClock, CalendarDays, Check, Loader2 } from 'lucide-react'

const longDate = (d: string) => formatDateOnly(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

// Production date choice on the customer's quote page. Shows only this
// project's active options, its own pending request and its own booking.
export default function CustomerSchedule({ token, shopName, staffPreview }: { token: string; shopName: string; staffPreview: boolean }) {
  const [schedule, setSchedule] = useState<PublicSchedule | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.rpc('get_public_schedule', { p_token: token })
    if (loadError) {
      console.error('Failed to load schedule:', loadError.message)
      return
    }
    const next = (data as PublicSchedule | null) ?? null
    setSchedule(next)
    setSelected(next?.request?.option_id ?? null)
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  if (!schedule || (!schedule.offer && !schedule.booking)) return null

  const submit = async () => {
    if (!selected || submitting) return
    setSubmitting(true)
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('request_schedule_date', { p_token: token, p_option_id: selected })
    setSubmitting(false)
    if (rpcError) {
      setError('Your date could not be sent. Please try again.')
      return
    }
    const result = data as { ok: boolean; error?: string } | null
    if (!result?.ok) setError(PUBLIC_SCHEDULE_ERRORS[result?.error ?? ''] ?? 'Your date could not be sent. Please try again.')
    await load()
  }

  const { offer, request, booking } = schedule
  const card = 'bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-6 mb-5'

  return (
    <div className={card}>
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <CalendarDays size={15} className="text-cobalt-300" /> Production date
      </h2>

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
                  onClick={() => setSelected(o.id)}
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

          {error && <p className="text-sm text-red-300 mt-3">{error}</p>}
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
