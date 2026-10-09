// Calendar-date helpers for date-only production scheduling. Values are
// 'YYYY-MM-DD' strings (Postgres DATE). All arithmetic runs in UTC on
// midnight values, so a date never shifts with the viewer's timezone.

export type DateOnly = string

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDateOnly(value: unknown): value is DateOnly {
  if (typeof value !== 'string') return false
  const m = DATE_RE.exec(value)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === value
}

function toUtc(date: DateOnly): number {
  const m = DATE_RE.exec(date)
  if (!m) throw new Error(`Invalid date: ${date}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function fromUtc(ms: number): DateOnly {
  return new Date(ms).toISOString().slice(0, 10)
}

export function addDays(date: DateOnly, days: number): DateOnly {
  return fromUtc(toUtc(date) + days * DAY_MS)
}

export function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS)
}

// "Today" as the viewer's local calendar date.
export function todayDateOnly(now: Date = new Date()): DateOnly {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Weeks run Monday through Sunday.
export function startOfWeek(date: DateOnly): DateOnly {
  const weekday = new Date(toUtc(date)).getUTCDay() // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7))
}

export function weekDays(weekStart: DateOnly): DateOnly[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

// Inclusive overlap of [start, end] with [rangeStart, rangeEnd].
export function overlaps(start: DateOnly, end: DateOnly, rangeStart: DateOnly, rangeEnd: DateOnly): boolean {
  return start <= rangeEnd && end >= rangeStart
}

export function isOnDay(start: DateOnly, end: DateOnly, day: DateOnly): boolean {
  return start <= day && day <= end
}

export function formatDateOnly(
  date: DateOnly,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
): string {
  if (!isDateOnly(date)) return date
  return new Date(toUtc(date)).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' })
}

export function formatDateRange(start: DateOnly, end: DateOnly): string {
  if (start === end) return formatDateOnly(start, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${formatDateOnly(start, { month: 'short', day: 'numeric' })} – ${formatDateOnly(end, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

export type AgendaJob = { start_date: DateOnly; estimated_ready_date: DateOnly }

// Confirmed jobs active on each day of the week (multi-day jobs appear on
// every day they span; overlaps are allowed).
export function jobsByDay<T extends AgendaJob>(jobs: T[], days: DateOnly[]): Map<DateOnly, T[]> {
  const map = new Map<DateOnly, T[]>()
  for (const day of days) {
    map.set(day, jobs.filter((j) => isOnDay(j.start_date, j.estimated_ready_date, day)))
  }
  return map
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

export function startOfMonth(date: DateOnly): DateOnly {
  toUtc(date)
  return `${date.slice(0, 7)}-01`
}

// First day of the month `months` away from the month containing `date`.
export function addMonths(date: DateOnly, months: number): DateOnly {
  toUtc(date)
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}-01`
}

export function endOfMonth(date: DateOnly): DateOnly {
  return addDays(addMonths(date, 1), -1)
}

export function isSameMonth(a: DateOnly, b: DateOnly): boolean {
  return a.slice(0, 7) === b.slice(0, 7)
}

// Whole Monday–Sunday weeks covering the month (4 to 6 rows), including
// the leading/trailing days of the neighbouring months shown in the grid.
export function monthGridDays(date: DateOnly): DateOnly[] {
  const start = startOfWeek(startOfMonth(date))
  const end = addDays(startOfWeek(endOfMonth(date)), 6)
  return Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i))
}

export type CalendarView = 'week' | 'month'

// Every date the calendar displays for a view around `focus`.
export function calendarDays(view: CalendarView, focus: DateOnly): DateOnly[] {
  return view === 'week' ? weekDays(startOfWeek(focus)) : monthGridDays(focus)
}

// Prev/Next: a week or a calendar month at a time.
export function shiftFocus(view: CalendarView, focus: DateOnly, step: number): DateOnly {
  return view === 'week' ? addDays(startOfWeek(focus), 7 * step) : addMonths(focus, step)
}

export function formatMonth(date: DateOnly): string {
  return formatDateOnly(startOfMonth(date), { month: 'long', year: 'numeric' })
}
