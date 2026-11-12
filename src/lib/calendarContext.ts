// Shop calendar context shared by the Production Schedule page and the
// lead's "Offer dates" / "Confirm schedule" dialogs. Unit tested (the loader
// takes the Supabase client as a parameter).
// The calendar shows workload only: overlapping jobs are allowed, days are
// never labeled available or full, and offered dates reserve nothing.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DateOnly } from './scheduleDates'

export type CalendarLead = { id: string; customer_name: string; vehicle_name: string; fulfillment_mode: 'local' | 'mail'; status: string }

// Confirmed booking (schedule_reservations, active). A customer booking has
// no estimated-ready date (null) until staff set one; it then covers only its
// start date.
export type CalendarJob = {
  id: string
  lead_id: string
  start_date: DateOnly
  estimated_ready_date: DateOnly | null
  lead: CalendarLead | null
}

// Customer's requested start date awaiting shop confirmation (schedule_requests, pending).
export type CalendarRequest = { id: string; lead_id: string; start_date: DateOnly; requested_at: string; lead: CalendarLead | null }

export const CALENDAR_LEAD_FIELDS = 'id, customer_name, vehicle_name, fulfillment_mode, status'

export const MAX_OFFER_DATES = 10

export type JobPosition = 'Starts' | 'Ready' | 'In shop'

// Where a confirmed job is on a given day of its start-to-ready range.
export function jobPosition(job: { start_date: DateOnly; estimated_ready_date: DateOnly | null }, day: DateOnly): JobPosition {
  return job.start_date === day ? 'Starts' : job.estimated_ready_date === day ? 'Ready' : 'In shop'
}

// Pending requests by their requested start date (they cover only that day).
export function requestsByDay<T extends { start_date: DateOnly }>(requests: T[], days: DateOnly[]): Map<DateOnly, T[]> {
  const map = new Map<DateOnly, T[]>()
  for (const day of days) map.set(day, requests.filter((r) => r.start_date === day))
  return map
}

export type DayDetails<J, R> = { jobs: (J & { position: JobPosition })[]; requests: R[] }

// Everything on one day: confirmed jobs whose range covers it (starts first,
// then by start date) and requests for that start date.
export function dayDetails<J extends { start_date: DateOnly; estimated_ready_date: DateOnly | null }, R extends { start_date: DateOnly }>(
  day: DateOnly,
  jobs: J[],
  requests: R[],
): DayDetails<J, R> {
  const order: Record<JobPosition, number> = { Starts: 0, 'In shop': 1, Ready: 2 }
  return {
    jobs: jobs
      .filter((j) => j.start_date <= day && day <= (j.estimated_ready_date ?? j.start_date))
      .map((j) => ({ ...j, position: jobPosition(j, day) }))
      .sort((a, b) => order[a.position] - order[b.position] || a.start_date.localeCompare(b.start_date)),
    requests: requests.filter((r) => r.start_date === day),
  }
}

// Adds or removes one offered start date. Selections stay sorted and unique;
// past dates and an 11th date are refused with the same messages as
// validateOfferDates (which the dialog still runs before sending).
export function toggleOfferDate(selected: DateOnly[], day: DateOnly, today: DateOnly): { dates: DateOnly[]; error: string | null } {
  if (selected.includes(day)) return { dates: selected.filter((d) => d !== day), error: null }
  if (day < today) return { dates: selected, error: 'Start dates cannot be in the past.' }
  if (selected.length >= MAX_OFFER_DATES) return { dates: selected, error: `Offer at most ${MAX_OFFER_DATES} start dates.` }
  return { dates: [...selected, day].sort(), error: null }
}

export type CalendarLoadResult = { data: { jobs: CalendarJob[]; pending: CalendarRequest[] } | null; error: string | null }

// One shop's confirmed jobs overlapping [rangeStart, rangeEnd] (including
// jobs spanning into or out of the range) and the customer date requests
// still awaiting confirmation within it. Staff-only: RLS limits both tables
// to the signed-in user's shop (admins: any shop).
export async function loadShopCalendar(client: SupabaseClient, shopId: string, rangeStart: DateOnly, rangeEnd: DateOnly): Promise<CalendarLoadResult> {
  try {
    const [jobsRes, pendingRes] = await Promise.all([
      client.from('schedule_reservations')
        .select(`id, lead_id, start_date, estimated_ready_date, lead:leads(${CALENDAR_LEAD_FIELDS})`)
        .eq('shop_id', shopId)
        .eq('status', 'active')
        .lte('start_date', rangeEnd)
        // Ends in or after the range; an unestimated booking ends on its start.
        .or(`estimated_ready_date.gte.${rangeStart},and(estimated_ready_date.is.null,start_date.gte.${rangeStart})`)
        .order('start_date', { ascending: true }),
      client.from('schedule_requests')
        .select(`id, lead_id, start_date, requested_at, lead:leads(${CALENDAR_LEAD_FIELDS})`)
        .eq('shop_id', shopId)
        .eq('status', 'pending')
        .gte('start_date', rangeStart)
        .lte('start_date', rangeEnd)
        .order('start_date', { ascending: true }),
    ])
    if (jobsRes.error || pendingRes.error) return { data: null, error: (jobsRes.error ?? pendingRes.error)!.message }
    return {
      data: {
        jobs: (jobsRes.data ?? []) as unknown as CalendarJob[],
        pending: (pendingRes.data ?? []) as unknown as CalendarRequest[],
      },
      error: null,
    }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Network error' }
  }
}

// Day shading for the staff calendars (Schedule page and the lead's
// scheduling dialogs). It only describes workload; it never changes what can
// be booked, and nothing is blocked automatically.
//   blocked: the shop blocked the day (takes precedence)
//   busy:    one or more confirmed jobs cover the day (start to estimated ready)
//   open:    no confirmed jobs
//   unknown: jobs or blocked dates aren't loaded, so no color is claimed
// Pending customer requests never affect the shade.
export type DayShade = 'open' | 'busy' | 'blocked' | 'unknown'

export function dayShade(confirmedJobs: number | null, blocked: boolean | null): DayShade {
  if (confirmedJobs === null || blocked === null) return 'unknown'
  if (blocked) return 'blocked'
  return confirmedJobs > 0 ? 'busy' : 'open'
}

// Shades for every day shown. jobsByDay comes from scheduleDates.jobsByDay
// (confirmed jobs on every day of their inclusive range); either input is
// null while it is loading or after it failed to load. Blocked dates are only
// loaded from `blockedFrom` on, so earlier days stay neutral.
export function dayShades(
  days: readonly DateOnly[],
  jobsByDay: Map<DateOnly, unknown[]> | null,
  blockedDates: ReadonlySet<DateOnly> | null,
  blockedFrom: DateOnly,
): Map<DateOnly, DayShade> {
  return new Map(days.map((d) => [
    d,
    dayShade(
      jobsByDay ? (jobsByDay.get(d)?.length ?? 0) : null,
      blockedDates && d >= blockedFrom ? blockedDates.has(d) : null,
    ),
  ]))
}

export const DAY_SHADE_LABELS: Record<Exclude<DayShade, 'unknown'>, string> = {
  open: 'No confirmed jobs',
  busy: 'Jobs scheduled',
  blocked: 'Unavailable',
}

// Subtle backgrounds and borders for the dark Schedule page and the light
// lead dialogs, kept apart so a selection can replace just the border.
// 'unknown' is the neutral style each calendar already used.
export type DayShadeStyle = { border: string; bg: string }
export const DAY_SHADE_CLASSES: Record<'dark' | 'light', Record<DayShade, DayShadeStyle>> = {
  dark: {
    open: { border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.08]' },
    busy: { border: 'border-amber-400/40', bg: 'bg-amber-400/[0.11]' },
    blocked: { border: 'border-red-500/45', bg: 'bg-red-500/[0.14]' },
    unknown: { border: 'border-white/10', bg: 'bg-obsidian-900/40' },
  },
  light: {
    open: { border: 'border-emerald-200', bg: 'bg-emerald-50/70' },
    busy: { border: 'border-amber-200', bg: 'bg-amber-50' },
    blocked: { border: 'border-red-200', bg: 'bg-red-50' },
    unknown: { border: 'border-zinc-200', bg: 'bg-white' },
  },
}

export function dayShadeClass(theme: 'dark' | 'light', shade: DayShade | undefined): string {
  const style = DAY_SHADE_CLASSES[theme][shade ?? 'unknown']
  return `${style.border} ${style.bg}`
}

// The day whose details may be shown: only a day inside the displayed grid,
// whose rows are the ones loaded. A day left over from another month is
// dropped, so it can never be paired with this range's data and look empty.
export function inspectableDay(day: DateOnly | null, gridDays: readonly DateOnly[]): DateOnly | null {
  if (!day || gridDays.length === 0) return null
  return day >= gridDays[0] && day <= gridDays[gridDays.length - 1] ? day : null
}
