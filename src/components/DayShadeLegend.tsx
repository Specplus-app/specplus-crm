import { DAY_SHADE_LABELS, dayShadeClass } from '../lib/calendarContext'

// Legend for the staff calendars' day shading (see dayShade).
export default function DayShadeLegend({ theme, className = '' }: { theme: 'dark' | 'light'; className?: string }) {
  const text = theme === 'dark' ? 'text-slate-400' : 'text-zinc-500'
  return (
    <ul className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] ${text} ${className}`} aria-label="Day colors">
      {(['open', 'busy', 'blocked'] as const).map((shade) => (
        <li key={shade} className="flex items-center gap-1.5">
          <span className={`w-3 h-3 rounded border ${dayShadeClass(theme, shade)}`} aria-hidden="true" />
          {DAY_SHADE_LABELS[shade]}
        </li>
      ))}
    </ul>
  )
}
