import { LeadStatus } from '../lib/supabase'

type Props = {
  status: LeadStatus
  onChange: (status: LeadStatus) => void
  size?: 'sm' | 'md'
}

const STATUS_OPTIONS: { value: LeadStatus; label: string; dotColor: string }[] = [
  { value: 'new', label: 'New', dotColor: 'bg-blue-500' },
  { value: 'contacted', label: 'Contacted', dotColor: 'bg-amber-500' },
  { value: 'quoted', label: 'Quoted', dotColor: 'bg-purple-500' },
  { value: 'scheduled', label: 'Scheduled', dotColor: 'bg-cyan-500' },
  { value: 'completed', label: 'Completed', dotColor: 'bg-emerald-500' },
  { value: 'archived', label: 'Archived', dotColor: 'bg-zinc-400' },
]

export default function StatusSelect({ status, onChange, size = 'md' }: Props) {
  const current = STATUS_OPTIONS.find((s) => s.value === status) ?? STATUS_OPTIONS[0]
  const sizeClasses = size === 'sm' ? 'text-xs px-2.5 py-1' : 'text-sm px-3 py-1.5'

  return (
    <div className="relative inline-block">
      <select
        value={status}
        onChange={(e) => onChange(e.target.value as LeadStatus)}
        className={`appearance-none rounded-full border border-zinc-300 bg-white font-medium text-zinc-700 pr-8 pl-7 ${sizeClasses} cursor-pointer hover:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 transition-all`}
      >
        {STATUS_OPTIONS.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
      <span className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full ${current.dotColor}`} />
      <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  )
}
