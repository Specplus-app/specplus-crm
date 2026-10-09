import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { agendaKey, agendaReducer, initialAgenda } from '../lib/agendaState'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, getWorkflowMeta, workflowStatusFor } from '../lib/supabase'
import {
  calendarDays, formatDateOnly, formatDateRange, formatMonth, isSameMonth, jobsByDay, shiftFocus, startOfMonth,
  todayDateOnly, type CalendarView, type DateOnly,
} from '../lib/scheduleDates'
import { AlertCircle, CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Package, Truck } from 'lucide-react'

type LeadInfo = { id: string; customer_name: string; vehicle_name: string; fulfillment_mode: 'local' | 'mail'; status: string }

type AgendaJob = {
  id: string
  lead_id: string
  start_date: DateOnly
  estimated_ready_date: DateOnly
  lead: LeadInfo | null
}

type PendingRequest = { id: string; lead_id: string; start_date: DateOnly; requested_at: string; lead: LeadInfo | null }

const LEAD_FIELDS = 'id, customer_name, vehicle_name, fulfillment_mode, status'

// Production calendar (Month or Week): confirmed jobs on every date they
// cover (including jobs spanning into or out of the range; overlaps are
// allowed) and, separately, customer date requests that still await shop
// confirmation.
export default function SchedulePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [view, setView] = useState<CalendarView>('month')
  // Any date inside the week/month on screen; switching views keeps it.
  const [focus, setFocus] = useState<DateOnly>(() => todayDateOnly())
  const [agenda, dispatch] = useReducer(
    agendaReducer<AgendaJob, PendingRequest>,
    undefined,
    () => initialAgenda<AgendaJob, PendingRequest>(),
  )
  const loadSeq = useRef(0)

  const days = useMemo(() => calendarDays(view, focus), [view, focus])
  const rangeStart = days[0]
  const rangeEnd = days[days.length - 1]
  const today = todayDateOnly()
  const shopId = profile?.shop_id ?? null
  const viewKey = shopId ? agendaKey(shopId, rangeStart, rangeEnd) : null

  const load = useCallback(async () => {
    if (!shopId) return
    const id = ++loadSeq.current
    dispatch({ type: 'loadStart', id, key: agendaKey(shopId, rangeStart, rangeEnd) })
    try {
      const [jobsRes, pendingRes] = await Promise.all([
        supabase.from('schedule_reservations')
          .select(`id, lead_id, start_date, estimated_ready_date, lead:leads(${LEAD_FIELDS})`)
          .eq('shop_id', shopId)
          .eq('status', 'active')
          .lte('start_date', rangeEnd)
          .gte('estimated_ready_date', rangeStart)
          .order('start_date', { ascending: true }),
        supabase.from('schedule_requests')
          .select(`id, lead_id, start_date, requested_at, lead:leads(${LEAD_FIELDS})`)
          .eq('shop_id', shopId)
          .eq('status', 'pending')
          .gte('start_date', rangeStart)
          .lte('start_date', rangeEnd)
          .order('start_date', { ascending: true }),
      ])
      if (jobsRes.error || pendingRes.error) {
        dispatch({ type: 'loadFailure', id, error: (jobsRes.error ?? pendingRes.error)!.message })
        return
      }
      dispatch({
        type: 'loadSuccess',
        id,
        jobs: (jobsRes.data ?? []) as unknown as AgendaJob[],
        pending: (pendingRes.data ?? []) as unknown as PendingRequest[],
      })
    } catch (err) {
      dispatch({ type: 'loadFailure', id, error: err instanceof Error ? err.message : 'Network error' })
    }
  }, [shopId, rangeStart, rangeEnd])

  // Only rows loaded for the shop and date range on screen are ever shown.
  const current = agenda.key === viewKey
  const jobs = current ? agenda.jobs : []
  const pending = current ? agenda.pending : []
  const loading = !current || agenda.status === 'loading'
  const loaded = current && agenda.loaded
  const error = current ? agenda.error : null

  useEffect(() => {
    load()
  }, [load])

  const byDay = useMemo(() => jobsByDay(jobs, days), [jobs, days])
  const open = (leadId: string) => navigate(`/dashboard/leads/${leadId}`)
  const openWeek = (day: DateOnly) => { setView('week'); setFocus(day) }
  const unit = view === 'week' ? 'week' : 'month'
  const navBtn = 'flex items-center gap-1 text-sm font-medium text-slate-200 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 transition-colors'
  const toggleBtn = (active: boolean) => `px-3 py-1.5 text-sm font-medium transition-colors ${active ? 'bg-cobalt-500/20 text-cobalt-200' : 'text-slate-300 hover:bg-white/10'}`

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2"><CalendarDays size={20} className="text-cobalt-400" /> Production Schedule</h1>
            <p className="text-sm text-slate-400 mt-0.5">{view === 'week' ? formatDateRange(rangeStart, rangeEnd) : formatMonth(focus)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-white/10 overflow-hidden bg-white/5" role="group" aria-label="Calendar view">
              <button onClick={() => setView('month')} className={toggleBtn(view === 'month')} aria-pressed={view === 'month'}>Month</button>
              <button onClick={() => setView('week')} className={toggleBtn(view === 'week')} aria-pressed={view === 'week'}>Week</button>
            </div>
            <button onClick={() => setFocus(shiftFocus(view, focus, -1))} className={navBtn} aria-label={`Previous ${unit}`}><ChevronLeft size={15} /> Prev</button>
            <button onClick={() => setFocus(todayDateOnly())} className={navBtn}>Today</button>
            <button onClick={() => setFocus(shiftFocus(view, focus, 1))} className={navBtn} aria-label={`Next ${unit}`}>Next <ChevronRight size={15} /></button>
          </div>
        </div>

        {error && (
          <div className="flex items-start justify-between gap-2 text-sm text-red-200 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-4">
            <span className="flex items-center gap-2"><AlertCircle size={15} /> Could not load the schedule: {error}</span>
            <button onClick={load} className="underline">Retry</button>
          </div>
        )}

        {!loaded ? (
          loading && (
            <div className={`grid gap-2 ${view === 'week' ? 'grid-cols-1 lg:grid-cols-7' : 'grid-cols-7'}`} aria-busy="true">
              {days.map((d) => <div key={d} className={`${view === 'week' ? 'h-32' : 'h-14 md:h-24'} bg-white/5 rounded-xl animate-pulse`} />)}
            </div>
          )
        ) : (
          <>
            {view === 'month' ? (
              <MonthGrid days={days} focus={focus} today={today} byDay={byDay} onOpen={open} onOpenWeek={openWeek} />
            ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2">
              {days.map((day) => {
                const dayJobs = byDay.get(day) ?? []
                const isToday = day === today
                return (
                  <section key={day} className={`rounded-xl border p-2.5 min-h-[8rem] ${isToday ? 'border-cobalt-500/60 bg-cobalt-500/5' : 'border-white/10 bg-obsidian-900/40'}`}>
                    <header className="flex items-baseline justify-between mb-2">
                      <span className={`text-xs font-semibold ${isToday ? 'text-cobalt-300' : 'text-slate-300'}`}>
                        {formatDateOnly(day, { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                      <span className="text-[11px] text-slate-500">{dayJobs.length} {dayJobs.length === 1 ? 'job' : 'jobs'}</span>
                    </header>
                    {dayJobs.length === 0 ? (
                      <p className="text-[11px] text-slate-600">No confirmed jobs</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {dayJobs.map((job) => (
                          <li key={job.id}>
                            <JobCard job={job} day={day} onOpen={() => open(job.lead_id)} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
            )}

            {jobs.length === 0 && pending.length === 0 && !error && (
              <p className="text-sm text-slate-500 text-center mt-6">Nothing is scheduled this {unit}.</p>
            )}

            <section className="mt-6">
              <h2 className="text-sm font-semibold text-amber-200 flex items-center gap-2 mb-2">
                <CalendarClock size={15} /> Awaiting shop confirmation ({pending.length})
              </h2>
              <p className="text-xs text-slate-500 mb-2">Dates customers requested within the dates shown. Not booked until confirmed on the lead.</p>
              {pending.length === 0 ? (
                <p className="text-xs text-slate-600">No pending date requests for these dates.</p>
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {pending.map((p) => (
                    <li key={p.id}>
                      <button onClick={() => open(p.lead_id)} className="w-full text-left rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10 px-3 py-2 transition-colors">
                        <p className="text-xs font-semibold text-amber-200">Requested {formatDateOnly(p.start_date, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                        <p className="text-sm text-slate-100 truncate">{p.lead?.customer_name ?? 'Lead'}</p>
                        <p className="text-xs text-slate-400 truncate">{p.lead?.vehicle_name}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function JobCard({ job, day, onOpen }: { job: AgendaJob; day: DateOnly; onOpen: () => void }) {
  const lead = job.lead
  const stage = getWorkflowMeta(workflowStatusFor(lead?.status ?? 'scheduled'))
  const position = job.start_date === day ? 'Starts' : job.estimated_ready_date === day ? 'Ready' : 'In shop'
  return (
    <button onClick={onOpen} className="w-full text-left rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 px-2 py-1.5 transition-colors">
      <p className="text-xs font-semibold text-slate-100 truncate">{lead?.customer_name ?? 'Lead'}</p>
      <p className="text-[11px] text-slate-400 truncate">{lead?.vehicle_name}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[10px] text-slate-400">
        <span className="flex items-center gap-1"><span className={`w-1.5 h-1.5 rounded-full ${stage.dotColor}`} />{stage.label}</span>
        <span className="flex items-center gap-1">
          {lead?.fulfillment_mode === 'mail' ? <Truck size={10} /> : <Package size={10} />}
          {lead?.fulfillment_mode === 'mail' ? 'Mail-order' : 'Local'}
        </span>
        <span>{position}</span>
      </div>
      <p className="text-[10px] text-slate-500 mt-0.5">{formatDateRange(job.start_date, job.estimated_ready_date)}</p>
    </button>
  )
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_CHIPS = 3

// Month view. md+ screens get a 7-column grid of clickable job chips ("+N
// more" and the day number open that week). Narrow screens keep the grid
// for orientation with a per-day job count, plus a day-by-day list of the
// month's jobs using the full cards.
function MonthGrid({ days, focus, today, byDay, onOpen, onOpenWeek }: {
  days: DateOnly[]
  focus: DateOnly
  today: DateOnly
  byDay: Map<DateOnly, AgendaJob[]>
  onOpen: (leadId: string) => void
  onOpenWeek: (day: DateOnly) => void
}) {
  const month = startOfMonth(focus)
  const busyDays = days.filter((d) => isSameMonth(d, month) && (byDay.get(d)?.length ?? 0) > 0)
  return (
    <>
      <div className="grid grid-cols-7 gap-1 md:gap-2">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="text-[11px] font-semibold text-slate-500 text-center md:text-left md:px-1">{w}</div>
        ))}
        {days.map((day) => {
          const dayJobs = byDay.get(day) ?? []
          const isToday = day === today
          return (
            <section
              key={day}
              className={`min-w-0 rounded-lg md:rounded-xl border p-1 md:p-1.5 min-h-[3.25rem] md:min-h-[7rem] ${isToday ? 'border-cobalt-500/60 bg-cobalt-500/5' : 'border-white/10 bg-obsidian-900/40'} ${isSameMonth(day, month) ? '' : 'opacity-50'}`}
            >
              <header className="flex items-center justify-between">
                <button
                  onClick={() => onOpenWeek(day)}
                  className={`text-xs font-semibold rounded px-1 hover:bg-white/10 ${isToday ? 'text-cobalt-300' : 'text-slate-300'}`}
                  aria-label={`Open week of ${formatDateOnly(day, { weekday: 'long', month: 'long', day: 'numeric' })}`}
                >
                  {Number(day.slice(8))}
                </button>
                {dayJobs.length > 0 && (
                  <span className="hidden md:inline text-[10px] text-slate-500">{dayJobs.length} {dayJobs.length === 1 ? 'job' : 'jobs'}</span>
                )}
              </header>
              {dayJobs.length > 0 && (
                <span className="md:hidden block text-center mt-1 text-[10px] font-semibold text-cobalt-300">{dayJobs.length}</span>
              )}
              <ul className="hidden md:block space-y-1 mt-1">
                {dayJobs.slice(0, MAX_CHIPS).map((job) => (
                  <li key={job.id}>
                    <MonthJobChip job={job} day={day} onOpen={() => onOpen(job.lead_id)} />
                  </li>
                ))}
                {dayJobs.length > MAX_CHIPS && (
                  <li>
                    <button onClick={() => onOpenWeek(day)} className="text-[10px] text-slate-400 hover:text-slate-200 px-1">
                      +{dayJobs.length - MAX_CHIPS} more
                    </button>
                  </li>
                )}
              </ul>
            </section>
          )
        })}
      </div>

      <div className="md:hidden mt-4 space-y-3">
        {busyDays.map((day) => (
          <section key={day}>
            <h3 className={`text-xs font-semibold mb-1.5 ${day === today ? 'text-cobalt-300' : 'text-slate-300'}`}>
              {formatDateOnly(day, { weekday: 'short', month: 'short', day: 'numeric' })}
            </h3>
            <ul className="space-y-1.5">
              {byDay.get(day)!.map((job) => (
                <li key={job.id}>
                  <JobCard job={job} day={day} onOpen={() => onOpen(job.lead_id)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}

function MonthJobChip({ job, day, onOpen }: { job: AgendaJob; day: DateOnly; onOpen: () => void }) {
  const lead = job.lead
  const stage = getWorkflowMeta(workflowStatusFor(lead?.status ?? 'scheduled'))
  const position = job.start_date === day ? 'Starts' : job.estimated_ready_date === day ? 'Ready' : 'In shop'
  return (
    <button
      onClick={onOpen}
      title={`${lead?.customer_name ?? 'Lead'} · ${lead?.vehicle_name ?? ''} · ${position} · ${formatDateRange(job.start_date, job.estimated_ready_date)}`}
      className="w-full flex items-center gap-1 text-left rounded-md border border-white/10 bg-white/5 hover:bg-white/10 px-1.5 py-0.5 transition-colors"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stage.dotColor}`} />
      <span className="text-[11px] text-slate-100 truncate">{lead?.customer_name ?? 'Lead'}</span>
      {job.start_date === day && <span className="ml-auto shrink-0 text-[9px] text-cobalt-300">Start</span>}
    </button>
  )
}
