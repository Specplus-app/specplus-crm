import { useMemo, useState } from 'react'
import { calendarDateStatus, type PublicCalendar } from '../lib/customerScheduleState'
import { addMonths, formatDateOnly, formatMonth, isSameMonth, monthGridDays, startOfMonth } from '../lib/scheduleDates'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

// Month calendar on the customer's quote page. Only days inside the shop's
// booking window that it hasn't blocked can be picked. It shows nothing about
// other customers' jobs.
export default function CustomerDatePicker({ calendar, selected, requested, disabled, onSelect }: {
  calendar: PublicCalendar
  selected: string | null
  // The customer's pending requested date, if any.
  requested: string | null
  disabled: boolean
  onSelect: (day: string) => void
}) {
  const first = startOfMonth(calendar.earliest)
  const last = startOfMonth(calendar.latest)
  const [month, setMonth] = useState(() => {
    const start = startOfMonth(selected ?? requested ?? calendar.earliest)
    return start < first || start > last ? first : start
  })
  // Keep the shown month inside the window when it changes after a refresh.
  const shown = month < first ? first : month > last ? last : month
  const days = useMemo(() => monthGridDays(shown), [shown])
  const navBtn = 'p-2 rounded-lg border border-white/10 text-slate-200 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed'

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <button type="button" onClick={() => setMonth(addMonths(shown, -1))} disabled={shown <= first} className={navBtn} aria-label="Previous month">
          <ChevronLeft size={16} />
        </button>
        <p className="text-sm font-semibold text-white" aria-live="polite">{formatMonth(shown)}</p>
        <button type="button" onClick={() => setMonth(addMonths(shown, 1))} disabled={shown >= last} className={navBtn} aria-label="Next month">
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1" role="group" aria-label={`Start dates, ${formatMonth(shown)}`}>
        {WEEKDAYS.map((w, i) => <div key={i} className="text-[11px] font-semibold text-slate-500 text-center py-1" aria-hidden="true">{w}</div>)}
        {days.map((day) => {
          if (!isSameMonth(day, shown)) return <div key={day} aria-hidden="true" />
          const status = calendarDateStatus(day, calendar)
          const isSelected = day === selected
          const isRequested = day === requested
          const label = `${formatDateOnly(day, { weekday: 'long', month: 'long', day: 'numeric' })}${
            status === 'blocked' ? ', unavailable' : status === 'outside' ? ', not bookable' : ''}${isRequested ? ', your requested date' : ''}`
          return (
            <button
              key={day}
              type="button"
              disabled={disabled || status !== 'available'}
              onClick={() => onSelect(day)}
              aria-pressed={isSelected}
              aria-label={label}
              className={[
                'relative h-10 sm:h-11 rounded-lg text-sm font-medium transition-colors min-w-0',
                isSelected
                  ? 'bg-cobalt-600 text-white ring-2 ring-cobalt-300'
                  : status === 'available'
                    ? 'bg-white/5 border border-white/10 text-slate-100 hover:bg-white/15'
                    : status === 'blocked'
                      ? 'text-slate-600 line-through'
                      : 'text-slate-700',
                disabled && status === 'available' && !isSelected ? 'opacity-60' : '',
              ].join(' ')}
            >
              {Number(day.slice(8))}
              {isRequested && !isSelected && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-amber-300" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 mt-2">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-white/5 border border-white/10" /> Available</span>
        <span className="flex items-center gap-1"><span className="text-slate-600 line-through">12</span> Unavailable</span>
        {requested && <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-300" /> Your request</span>}
      </div>
    </div>
  )
}
