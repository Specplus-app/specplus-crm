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
