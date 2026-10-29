import { useMemo, useState } from 'react'
import { useShopCalendar } from '../lib/useShopCalendar'
import { useShopAvailability } from '../lib/useShopAvailability'
import { dayDetails, inspectableDay, requestsByDay } from '../lib/calendarContext'
import {
  addDays, addMonths, formatDateOnly, formatDateRange, formatMonth, isOnDay, isSameMonth, jobsByDay, monthGridDays, startOfMonth,
  todayDateOnly, type DateOnly,
} from '../lib/scheduleDates'
import { AlertCircle, Ban, Check, ChevronLeft, ChevronRight, Loader2, Minus, Plus, RefreshCw } from 'lucide-react'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export type CalendarMode =
  // Offer dates: staff pick several start dates.
  | { kind: 'offer'; selected: DateOnly[]; onToggle: (day: DateOnly) => void }
  // Confirm schedule: the booking being confirmed, start to estimated ready.
  | { kind: 'confirm'; start: DateOnly; ready: DateOnly | null; onSetReady: (day: DateOnly) => void }

// The shop's production calendar inside the lead's scheduling dialogs:
// confirmed jobs across their whole start-to-ready range and, separately,
// customer date requests still awaiting confirmation. Shows workload only
// (overlaps are allowed; no day is labeled available or full). Staff-only:
// the data is limited to the lead's shop by RLS and never reaches customers.
export default function ScheduleContextCalendar({ shopId, leadId, mode, initialFocus }: {
  shopId: string
  leadId: string
  mode: CalendarMode
  initialFocus: DateOnly
}) {
  const today = todayDateOnly()
  const [month, setMonth] = useState<DateOnly>(() => startOfMonth(initialFocus))
  // The inspected day. Cleared on month navigation; offered dates and notes
  // live in the dialog, so they are unaffected.
  const [inspected, setDay] = useState<DateOnly | null>(initialFocus)
  const days = useMemo(() => monthGridDays(month), [month])
  // Loads when the dialog opens (fresh data each time) and on month changes.
  const cal = useShopCalendar(shopId, days[0], days[days.length - 1])
  // Blocked dates (Schedule page). The database refuses offering or
  // confirming them; shown here so staff see it first.
  const availability = useShopAvailability(shopId, addDays(today, -1))
  const blocked = useMemo(() => new Set(availability.data?.blockedDates ?? []), [availability.data])
  const refreshAll = () => { cal.refresh(); availability.refresh() }
  const jobsOn = useMemo(() => jobsByDay(cal.jobs, days), [cal.jobs, days])
  const requestsOn = useMemo(() => requestsByDay(cal.pending, days), [cal.pending, days])
  // Only a day inside the displayed range, paired with that range's rows.
  const day = inspectableDay(inspected, days)
  const details = day && cal.loaded ? dayDetails(day, cal.jobs, cal.pending) : null

  const goMonth = (step: number) => {
    setMonth(addMonths(month, step))
    setDay(null)
  }
  const navBtn = 'p-1.5 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 disabled:opacity-50'

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-sm font-semibold text-zinc-900">{formatMonth(month)}</p>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => goMonth(-1)} className={navBtn} aria-label="Previous month"><ChevronLeft size={15} /></button>
          <button type="button" onClick={() => { setMonth(startOfMonth(today)); setDay(today) }} className="px-2 py-1 text-xs font-medium rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50">Today</button>
          <button type="button" onClick={() => goMonth(1)} className={navBtn} aria-label="Next month"><ChevronRight size={15} /></button>
          <button type="button" onClick={refreshAll} disabled={cal.loading} className={navBtn} aria-label="Refresh calendar" title="Refresh calendar">
            {cal.loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          </button>
        </div>
      </div>

      <Legend mode={mode.kind} />

      {availability.error && !availability.data && (
        <p className="text-[11px] text-amber-700 mb-2">Couldn't load blocked dates, so they aren't marked here. Sending or confirming still checks them.</p>
      )}
      {cal.error && (
        <div className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2 mb-2">
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">
            {cal.loaded
              ? `Couldn't refresh the calendar (${cal.error}). Showing the last loaded data.`
              : `Couldn't load the shop calendar (${cal.error}). Existing bookings aren't shown, so this doesn't mean the days are open.`}
          </span>
          <button type="button" onClick={cal.refresh} className="underline font-medium">Retry</button>
        </div>
      )}

      {!cal.loaded ? (
        // Never draw a failed or pending load as an empty schedule.
        <div className="grid grid-cols-7 gap-1" aria-busy={cal.loading}>
          {days.map((d) => <div key={d} className={`h-11 sm:h-12 rounded-lg bg-zinc-100 ${cal.loading ? 'animate-pulse' : ''}`} />)}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1" role="group" aria-label={`Shop calendar, ${formatMonth(month)}`}>
          {WEEKDAYS.map((w, i) => <div key={i} className="text-[10px] font-semibold text-zinc-400 text-center">{w}</div>)}
          {days.map((d) => {
            const jobCount = jobsOn.get(d)?.length ?? 0
            const requestCount = requestsOn.get(d)?.length ?? 0
            const offered = mode.kind === 'offer' && mode.selected.includes(d)
            const proposed = mode.kind === 'confirm' && isOnDay(mode.start, mode.ready && mode.ready >= mode.start ? mode.ready : mode.start, d)
            const focused = d === day
            const past = d < today
            const isBlocked = blocked.has(d)
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDay(d)}
                aria-pressed={focused}
                aria-label={`${formatDateOnly(d, { weekday: 'long', month: 'long', day: 'numeric' })}: ${jobCount} confirmed ${jobCount === 1 ? 'job' : 'jobs'}, ${requestCount} pending ${requestCount === 1 ? 'request' : 'requests'}${isBlocked ? ', blocked' : ''}${offered ? ', offered' : ''}${proposed ? ', this booking' : ''}`}
                className={[
                  'relative h-11 sm:h-12 rounded-lg border text-left px-1 py-0.5 transition-colors min-w-0',
                  offered ? 'border-brand-500 bg-brand-50' : proposed ? 'border-emerald-400 bg-emerald-50' : isBlocked ? 'border-red-200 bg-red-50 hover:bg-red-100' : 'border-zinc-200 bg-white hover:bg-zinc-50',
                  focused ? 'ring-2 ring-zinc-900/70' : '',
                  isSameMonth(d, month) ? '' : 'opacity-40',
                  past && !offered && !proposed ? 'bg-zinc-50 text-zinc-400' : '',
                ].join(' ')}
              >
                <span className={`text-[11px] font-semibold ${d === today ? 'text-brand-600' : 'text-zinc-700'}`}>{Number(d.slice(8))}</span>
                {offered && <Check size={11} className="absolute top-0.5 right-0.5 text-brand-600" />}
                {isBlocked && !offered && <Ban size={10} className="absolute top-0.5 right-0.5 text-red-500" />}
                <span className="absolute bottom-0.5 left-0.5 right-0.5 flex items-center gap-0.5 overflow-hidden">
                  {jobCount > 0 && (
                    <span className="text-[9px] leading-none font-semibold rounded bg-zinc-700 text-white px-1 py-0.5" title={`${jobCount} confirmed`}>{jobCount}</span>
                  )}
                  {requestCount > 0 && (
                    <span className="text-[9px] leading-none font-semibold rounded border border-dashed border-amber-500 bg-amber-50 text-amber-800 px-1 py-[1px]" title={`${requestCount} pending`}>{requestCount}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {!day && <p className="text-xs text-zinc-500 mt-3">Select a day to see its jobs and pending requests.</p>}
      {day && (
        <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-zinc-900">{formatDateOnly(day, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            <DayAction mode={mode} day={day} today={today} blocked={blocked.has(day)} />
          </div>
          {blocked.has(day) && (
            <p className="flex items-center gap-1 text-[11px] text-red-700 mt-1"><Ban size={11} /> Blocked on your Schedule page. Customers can't request it, and it can't be offered or confirmed until it's unblocked.</p>
          )}
          {!details ? (
            <p className="text-xs text-zinc-500 mt-2">{cal.loading ? 'Loading this day…' : 'The calendar isn\'t loaded, so this day\'s jobs aren\'t shown.'}</p>
          ) : details.jobs.length === 0 && details.requests.length === 0 ? (
            <p className="text-xs text-zinc-500 mt-2">No confirmed jobs or pending requests on this day.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {details.jobs.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">Confirmed ({details.jobs.length})</p>
                  <ul className="space-y-1">
                    {details.jobs.map((j) => (
                      <li key={j.id} className="flex items-start justify-between gap-2 rounded-lg bg-white border border-zinc-200 px-2.5 py-1.5">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-zinc-900 truncate">
                            {j.lead?.customer_name ?? 'Lead'}{j.lead_id === leadId && <span className="ml-1.5 text-[10px] font-semibold text-brand-600">This lead (current booking)</span>}
                          </p>
                          <p className="text-[11px] text-zinc-500 truncate">{j.lead?.vehicle_name}{j.lead?.fulfillment_mode === 'mail' ? ' · Mail-order' : ''}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-[11px] font-medium text-zinc-700">{j.position}</p>
                          <p className="text-[10px] text-zinc-500">{formatDateRange(j.start_date, j.estimated_ready_date)}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {details.requests.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-1">Pending requests — not booked ({details.requests.length})</p>
                  <ul className="space-y-1">
                    {details.requests.map((r) => (
                      <li key={r.id} className="rounded-lg border border-dashed border-amber-400 bg-amber-50/60 px-2.5 py-1.5">
                        <p className="text-xs font-medium text-zinc-900 truncate">
                          {r.lead?.customer_name ?? 'Lead'}{r.lead_id === leadId && <span className="ml-1.5 text-[10px] font-semibold text-brand-600">This lead</span>}
                        </p>
                        <p className="text-[11px] text-amber-800 truncate">{r.lead?.vehicle_name} · requested start, awaiting confirmation</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Legend({ mode }: { mode: CalendarMode['kind'] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500 mb-2">
      <span className="flex items-center gap-1"><span className="rounded bg-zinc-700 text-white px-1 font-semibold">2</span> Confirmed jobs</span>
      <span className="flex items-center gap-1"><span className="rounded border border-dashed border-amber-500 bg-amber-50 text-amber-800 px-1 font-semibold">1</span> Pending requests</span>
      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded border border-red-200 bg-red-50" /> Blocked</span>
      {mode === 'offer'
        ? <span className="flex items-center gap-1"><span className="w-3 h-3 rounded border border-brand-500 bg-brand-50" /> Offered (not reserved)</span>
        : <span className="flex items-center gap-1"><span className="w-3 h-3 rounded border border-emerald-400 bg-emerald-50" /> This booking</span>}
    </div>
  )
}

function DayAction({ mode, day, today, blocked }: { mode: CalendarMode; day: DateOnly; today: DateOnly; blocked: boolean }) {
  const btn = 'inline-flex items-center gap-1 text-xs font-medium rounded-lg px-2.5 py-1.5 transition-colors'
  if (mode.kind === 'offer') {
    const selected = mode.selected.includes(day)
    if (!selected && day < today) return <span className="text-[11px] text-zinc-400">Past date</span>
    if (!selected && blocked) return <span className="text-[11px] text-red-600">Blocked</span>
    return selected ? (
      <button type="button" onClick={() => mode.onToggle(day)} className={`${btn} border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100`}>
        <Minus size={12} /> Remove from offer
      </button>
    ) : (
      <button type="button" onClick={() => mode.onToggle(day)} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>
        <Plus size={12} /> Offer this start date
      </button>
    )
  }
  if (day < mode.start || day === mode.ready) return null
  return (
    <button type="button" onClick={() => mode.onSetReady(day)} className={`${btn} border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50`}>
      Set as estimated ready
    </button>
  )
}
