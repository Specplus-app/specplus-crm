import { useEffect, useState } from 'react'
import { supabase, LeadEvent, formatDateTime } from '../lib/supabase'
import { describeLeadEvent } from '../lib/quotes'
import { Activity, CheckCircle2, Eye, FilePlus2, Inbox, RefreshCw, Send, Shuffle, XCircle, type LucideIcon } from 'lucide-react'

const EVENT_ICONS: Record<string, { icon: LucideIcon; color: string }> = {
  lead_created: { icon: Inbox, color: 'text-blue-600 bg-blue-50 border-blue-200' },
  status_changed: { icon: Shuffle, color: 'text-zinc-600 bg-zinc-50 border-zinc-200' },
  quote_created: { icon: FilePlus2, color: 'text-violet-600 bg-violet-50 border-violet-200' },
  quote_revised: { icon: RefreshCw, color: 'text-violet-600 bg-violet-50 border-violet-200' },
  quote_sent: { icon: Send, color: 'text-purple-600 bg-purple-50 border-purple-200' },
  quote_viewed: { icon: Eye, color: 'text-fuchsia-600 bg-fuchsia-50 border-fuchsia-200' },
  quote_approved: { icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  quote_declined: { icon: XCircle, color: 'text-red-600 bg-red-50 border-red-200' },
}

const DEFAULT_ICON = { icon: Activity, color: 'text-zinc-600 bg-zinc-50 border-zinc-200' }

// Immutable, system-recorded history for a lead. Shop-written notes live in a
// separate section on purpose.
export default function LeadTimeline({ leadId, refreshKey }: { leadId: string; refreshKey?: string }) {
  const [events, setEvents] = useState<LeadEvent[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data, error } = await supabase
        .from('lead_events')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(200)
      if (!active) return
      if (error) {
        console.error('Failed to load activity:', error.message)
        setLoading(false)
        return
      }
      const rows = (data ?? []) as LeadEvent[]
      setEvents(rows)
      setLoading(false)

      const actorIds = Array.from(new Set(rows.map((e) => e.actor_id).filter((id): id is string => !!id)))
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
        if (!active) return
        setNames(new Map((profiles ?? []).map((p) => [p.id as string, (p.full_name as string) || (p.email as string)])))
      }
    })()
    return () => { active = false }
  }, [leadId, refreshKey])

  const actorLabel = (e: LeadEvent): string | null => {
    switch (e.actor_type) {
      case 'customer':
        return 'Customer'
      case 'shop_user':
        return (e.actor_id && names.get(e.actor_id)) || 'Shop team'
      case 'admin':
        return (e.actor_id && names.get(e.actor_id)) || 'SpecPlus admin'
      default:
        return null
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
      <h2 className="text-sm font-semibold text-zinc-900 mb-4 flex items-center gap-2">
        <Activity size={16} className="text-zinc-400" />
        Activity
      </h2>
      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => <div key={i} className="h-8 bg-zinc-100 rounded-lg animate-pulse" />)}
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-zinc-400 text-center py-4">No activity recorded yet</p>
      ) : (
        <ol className="relative">
          {events.map((e, idx) => {
            const { icon: Icon, color } = EVENT_ICONS[e.event_type] ?? DEFAULT_ICON
            const actor = actorLabel(e)
            return (
              <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                {idx < events.length - 1 && <span className="absolute left-[13px] top-7 bottom-0 w-px bg-zinc-200" />}
                <span className={`relative z-10 w-7 h-7 rounded-full border flex items-center justify-center flex-shrink-0 ${color}`}>
                  <Icon size={13} />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm text-zinc-800">{describeLeadEvent(e)}</p>
                  <p className="text-xs text-zinc-400">
                    {formatDateTime(e.created_at)}
                    {actor ? ` · ${actor}` : ''}
                    {e.metadata?.backfilled === true ? ' · recorded before activity tracking' : ''}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
