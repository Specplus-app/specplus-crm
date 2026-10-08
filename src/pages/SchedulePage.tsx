import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, getWorkflowMeta, workflowStatusFor } from '../lib/supabase'
import {
  addDays, formatDateOnly, formatDateRange, jobsByDay, startOfWeek, todayDateOnly, weekDays, type DateOnly,
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

// Weekly production agenda: confirmed jobs (including multi-day jobs that
// span into the week; overlaps are allowed) and, separately, customer date
// requests that still await shop confirmation.
export default function SchedulePage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [weekStart, setWeekStart] = useState<DateOnly>(() => startOfWeek(todayDateOnly()))
  const [jobs, setJobs] = useState<AgendaJob[]>([])
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const days = useMemo(() => weekDays(weekStart), [weekStart])
  const weekEnd = days[6]
  const today = todayDateOnly()

  const load = useCallback(async () => {
    if (!profile?.shop_id) return
    setLoading(true)
    setError(null)
    const [jobsRes, pendingRes] = await Promise.all([
      supabase.from('schedule_reservations')
        .select(`id, lead_id, start_date, estimated_ready_date, lead:leads(${LEAD_FIELDS})`)
        .eq('shop_id', profile.shop_id)
        .eq('status', 'active')
        .lte('start_date', weekEnd)
        .gte('estimated_ready_date', weekStart)
        .order('start_date', { ascending: true }),
      supabase.from('schedule_requests')
        .select(`id, lead_id, start_date, requested_at, lead:leads(${LEAD_FIELDS})`)
        .eq('shop_id', profile.shop_id)
        .eq('status', 'pending')
        .gte('start_date', weekStart)
        .lte('start_date', weekEnd)
        .order('start_date', { ascending: true }),
    ])
    if (jobsRes.error || pendingRes.error) {
      setError((jobsRes.error ?? pendingRes.error)!.message)
    } else {
      setJobs((jobsRes.data ?? []) as unknown as AgendaJob[])
      setPending((pendingRes.data ?? []) as unknown as PendingRequest[])
    }
    setLoading(false)
  }, [profile?.shop_id, weekStart, weekEnd])

  useEffect(() => {
    load()
  }, [load])

  const byDay = useMemo(() => jobsByDay(jobs, days), [jobs, days])
  const open = (leadId: string) => navigate(`/dashboard/leads/${leadId}`)
  const navBtn = 'flex items-center gap-1 text-sm font-medium text-slate-200 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 transition-colors'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2"><CalendarDays size={20} className="text-cobalt-400" /> Production Schedule</h1>
            <p className="text-sm text-slate-400 mt-0.5">{formatDateRange(weekStart, weekEnd)}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))} className={navBtn} aria-label="Previous week"><ChevronLeft size={15} /> Prev</button>
            <button onClick={() => setWeekStart(startOfWeek(todayDateOnly()))} className={navBtn}>Today</button>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))} className={navBtn} aria-label="Next week">Next <ChevronRight size={15} /></button>
          </div>
        </div>

        {error && (
          <div className="flex items-start justify-between gap-2 text-sm text-red-200 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-4">
            <span className="flex items-center gap-2"><AlertCircle size={15} /> Could not load the schedule: {error}</span>
            <button onClick={load} className="underline">Retry</button>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-7 gap-2">
            {days.map((d) => <div key={d} className="h-32 bg-white/5 rounded-xl animate-pulse" />)}
          </div>
        ) : (
          <>
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

            {jobs.length === 0 && pending.length === 0 && !error && (
              <p className="text-sm text-slate-500 text-center mt-6">Nothing is scheduled this week.</p>
            )}

            <section className="mt-6">
              <h2 className="text-sm font-semibold text-amber-200 flex items-center gap-2 mb-2">
                <CalendarClock size={15} /> Awaiting shop confirmation ({pending.length})
              </h2>
              <p className="text-xs text-slate-500 mb-2">Dates customers requested for this week. Not booked until confirmed on the lead.</p>
              {pending.length === 0 ? (
                <p className="text-xs text-slate-600">No pending date requests this week.</p>
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
