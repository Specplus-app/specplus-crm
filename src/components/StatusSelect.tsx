import { LeadStatus, WorkflowStatus, WORKFLOW_STATUSES, getWorkflowMeta, workflowStatusFor } from '../lib/supabase'

type Props = {
  // Raw leads.status; automatic quote states are shown as their workflow stage.
  status: LeadStatus
  onChange: (status: WorkflowStatus) => void
  size?: 'sm' | 'md'
  disabled?: boolean
}

export default function StatusSelect({ status, onChange, size = 'md', disabled = false }: Props) {
  const workflow = workflowStatusFor(status)
  const current = getWorkflowMeta(workflow)
  const sizeClasses = size === 'sm' ? 'text-xs px-2.5 py-1' : 'text-sm px-3 py-1.5'

  return (
    <div className="relative inline-block">
      <select
        value={workflow}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as WorkflowStatus)}
        aria-label="Workflow status"
        className={`appearance-none rounded-full border border-zinc-300 bg-white font-medium text-zinc-700 pr-8 pl-7 ${sizeClasses} ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-zinc-400'} focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 transition-all`}
      >
        {WORKFLOW_STATUSES.map((s) => (
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
