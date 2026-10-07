import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, Lead, LeadStatus, QuoteStatus, WorkflowStatus, getWorkflowMeta, formatCurrency, formatDate } from '../lib/supabase'
import { QUOTE_STATUS_META } from '../lib/quotes'
import StatusSelect from '../components/StatusSelect'
import { useShopBilling } from '../lib/billing'
import { LoadingScreen } from '../components/LoadingScreen'
import { Search, Inbox, Send, ThumbsUp, Clock, CheckCircle2, Mail, Phone, MapPin, ChevronRight, ChevronDown, MessageSquare, Link2, Copy, Check, ExternalLink, PartyPopper, X, type LucideIcon } from 'lucide-react'

const PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'

type WorkflowFilter = WorkflowStatus | 'all'

const PRIMARY_FILTERS: WorkflowFilter[] = ['all', 'new', 'contacted', 'quoting', 'scheduling', 'scheduled', 'in_progress', 'completed']
const MORE_FILTERS: WorkflowStatus[] = ['lost', 'archived']

const filterLabel = (f: WorkflowFilter) => (f === 'all' ? 'All' : getWorkflowMeta(f).label)

const QUOTE_BADGE_COLORS: Record<QuoteStatus, string> = {
  draft: 'text-slate-300 bg-white/5 border-white/15',
  sent: 'text-purple-200 bg-purple-500/10 border-purple-500/30',
  viewed: 'text-fuchsia-200 bg-fuchsia-500/10 border-fuchsia-500/30',
  approved: 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30',
  declined: 'text-red-200 bg-red-500/10 border-red-500/30',
}

// Keeps each `.in()` request URL comfortably short; still one query per batch,
// never one per lead.
const QUOTE_LOOKUP_BATCH = 150

export default function ShopDashboard() {
  const { profile, profileLoading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { readOnly } = useShopBilling()
  const [showWelcome, setShowWelcome] = useState(Boolean((location.state as { welcome?: boolean } | null)?.welcome))
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<WorkflowFilter>('all')
  const [moreOpen, setMoreOpen] = useState(false)
  const [latestQuotes, setLatestQuotes] = useState<Map<string, QuoteStatus>>(new Map())
  const [messageCounts, setMessageCounts] = useState<Map<string, number>>(new Map())
  const [search, setSearch] = useState('')
  const [copied, setCopied] = useState(false)
  const [shopSlug, setShopSlug] = useState<string | null>(null)

  const customerLink = profile?.shop_id
    ? shopSlug
      ? `${PUBLIC_QUOTE_ORIGIN}/${shopSlug}`
      : `${PUBLIC_QUOTE_ORIGIN}/customize/${profile.shop_id}`
    : ''

  const copyLink = async () => {
    if (!customerLink) return
    try {
      await navigator.clipboard.writeText(customerLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  useEffect(() => {
    if (!profile?.shop_id) {
      setShopSlug(null)
      return
    }

    let active = true
    supabase
      .from('shops')
      .select('slug')
      .eq('id', profile.shop_id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          console.error('Failed to load shop slug:', error.message)
          setShopSlug(null)
        } else {
          setShopSlug((data?.slug as string | null) ?? null)
        }
      })

    return () => { active = false }
  }, [profile?.shop_id])

  useEffect(() => {
    if (showWelcome) {
      // Drop the router state so a refresh doesn't re-trigger the banner.
      navigate(location.pathname, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadLeads = useCallback(async () => {
    if (!profile?.shop_id) return
    setLoading(true)
    let query = supabase
      .from('leads')
      .select('*')
      .eq('shop_id', profile.shop_id)
      .order('submitted_at', { ascending: false })
    if (statusFilter !== 'all') {
      // Workflow stages cover several raw statuses (e.g. Quoting includes
      // quote_sent/viewed/declined).
      query = query.in('status', getWorkflowMeta(statusFilter).rawStatuses)
    }
    const { data, error } = await query
    if (error) {
      console.error('Failed to load leads:', error.message)
      setLoading(false)
      return
    }
    const rows = (data ?? []) as Lead[]

    // Latest quote per lead, batched (no per-lead queries).
    const latest = new Map<string, QuoteStatus>()
    const ids = rows.map((l) => l.id)
    const batches: string[][] = []
    for (let i = 0; i < ids.length; i += QUOTE_LOOKUP_BATCH) batches.push(ids.slice(i, i + QUOTE_LOOKUP_BATCH))
    const results = await Promise.all(batches.map((batch) =>
      supabase
        .from('quotes')
        .select('lead_id, status, revision_number')
        .in('lead_id', batch)
        .order('revision_number', { ascending: false })
    ))
    for (const { data: quoteRows, error: quoteError } of results) {
      if (quoteError) {
        console.error('Failed to load quotes:', quoteError.message)
        continue
      }
      for (const q of (quoteRows ?? []) as { lead_id: string; status: QuoteStatus }[]) {
        if (!latest.has(q.lead_id)) latest.set(q.lead_id, q.status)
      }
    }

    // Quote conversation message counts, batched the same way.
    const counts = new Map<string, number>()
    const messageBatches: string[][] = []
    for (let i = 0; i < ids.length; i += QUOTE_LOOKUP_BATCH) messageBatches.push(ids.slice(i, i + QUOTE_LOOKUP_BATCH))
    const messageResults = await Promise.all(messageBatches.map((batch) =>
      supabase.from('quote_messages').select('lead_id').in('lead_id', batch)
    ))
    for (const { data: messageRows, error: messageError } of messageResults) {
      if (messageError) {
        console.error('Failed to load message counts:', messageError.message)
        continue
      }
      for (const m of (messageRows ?? []) as { lead_id: string }[]) {
        counts.set(m.lead_id, (counts.get(m.lead_id) ?? 0) + 1)
      }
    }

    setLeads(rows)
    setLatestQuotes(latest)
    setMessageCounts(counts)
    setLoading(false)
  }, [profile?.shop_id, statusFilter])

  useEffect(() => {
    loadLeads()
  }, [loadLeads])

  const handleStatusChange = async (leadId: string, status: LeadStatus) => {
    setLeads((prev) => prev.map((l) => l.id === leadId ? { ...l, status } : l))
    const { error } = await supabase.from('leads').update({ status }).eq('id', leadId)
    if (error) {
      console.error('Failed to update status:', error.message)
      loadLeads()
    }
  }

  const filtered = search.trim()
    ? leads.filter((l) =>
        l.customer_name.toLowerCase().includes(search.toLowerCase()) ||
        l.customer_email.toLowerCase().includes(search.toLowerCase()) ||
        l.vehicle_name.toLowerCase().includes(search.toLowerCase())
      )
    : leads

  if (profileLoading || !profile) return <LoadingScreen />

  if (!profile?.shop_id) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-2xl mx-auto">
          <div className="mt-10 text-center bg-obsidian-900/40 rounded-2xl border border-white/10 p-10">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-cobalt-500/15 ring-1 ring-cobalt-500/30 flex items-center justify-center mb-4">
              <Inbox size={26} className="text-cobalt-300" />
            </div>
            <h1 className="text-2xl font-bold text-slate-100">
              Welcome{profile?.full_name ? `, ${profile.full_name}` : ''}
            </h1>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">
              Your account isn't linked to a shop yet. Once your shop is set up you'll see your
              customer leads and shareable customizer link right here.
            </p>
            <p className="text-xs text-slate-500 mt-4">
              Reach out to your SpecPlus administrator to finish setting up your shop.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const stats = {
    total: leads.length,
    new: leads.filter((l) => l.status === 'new').length,
    // Based on each lead's latest quote, so these stay accurate after the shop
    // moves the workflow on (e.g. an approved quote on a Scheduled job).
    awaiting: leads.filter((l) => {
      const q = latestQuotes.get(l.id)
      return q === 'sent' || q === 'viewed'
    }).length,
    approved: leads.filter((l) => latestQuotes.get(l.id) === 'approved').length,
    completed: leads.filter((l) => l.status === 'completed').length,
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-100">Leads</h1>
          <p className="text-sm text-slate-400 mt-1">Customer submissions from your vehicle customizer</p>
        </div>

        {showWelcome && (
          <div className="flex items-start gap-3 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 mb-6 animate-fade-in">
            <PartyPopper size={20} className="text-emerald-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-emerald-200">Welcome to SpecPlus{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}!</h2>
              <p className="text-xs text-emerald-300/80 mt-1 leading-relaxed">
                Your shop account is ready. Share your customer link below to start collecting quote requests, then add your vehicles to build them out.
              </p>
            </div>
            <button
              onClick={() => setShowWelcome(false)}
              className="text-emerald-300/70 hover:text-emerald-200 transition-colors"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Shareable customer link */}
        <div className="bg-obsidian-900/50 border border-white/10 rounded-2xl p-4 mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Link2 size={16} className="text-cobalt-400" />
            <h2 className="text-sm font-semibold text-slate-100">Your customer link</h2>
          </div>
          <p className="text-xs text-slate-400 mb-3">
            Share this link with customers so they can build a quote. It opens your vehicle customizer.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              readOnly
              value={customerLink}
              onFocus={(e) => e.target.select()}
              className="flex-1 bg-obsidian-950/80 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono focus:outline-none focus:border-cobalt-500/50"
            />
            <div className="flex gap-2">
              <button
                onClick={copyLink}
                className="flex items-center justify-center gap-2 bg-cobalt-600 hover:bg-cobalt-500 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a
                href={customerLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 bg-obsidian-900/60 border border-white/10 hover:bg-white/5 text-slate-300 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                <ExternalLink size={16} />
                Open
              </a>
            </div>
          </div>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <StatCard icon={Inbox} label="Total Leads" value={stats.total} color="text-slate-300 bg-white/5" />
          <StatCard icon={Clock} label="New" value={stats.new} color="text-blue-300 bg-blue-500/10" />
          <StatCard icon={Send} label="Awaiting Response" value={stats.awaiting} color="text-fuchsia-300 bg-fuchsia-500/10" />
          <StatCard icon={ThumbsUp} label="Approved" value={stats.approved} color="text-amber-300 bg-amber-500/10" />
          <StatCard icon={CheckCircle2} label="Completed" value={stats.completed} color="text-emerald-300 bg-emerald-500/10" />
        </div>

        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or vehicle…"
              className="w-full bg-obsidian-900/60 border border-white/10 text-slate-200 placeholder-slate-500 rounded-lg pl-10 pr-3 py-2 text-sm focus:outline-none focus:border-cobalt-500/50 focus:ring-1 focus:ring-cobalt-500/50 transition-all"
            />
          </div>
          <div className="flex gap-1.5 items-start">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {PRIMARY_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    statusFilter === f
                      ? 'bg-cobalt-600 text-white border border-cobalt-500/50 shadow-glow-blue'
                      : 'bg-obsidian-900/60 text-slate-400 border border-white/10 hover:bg-white/5'
                  }`}
                >
                  {filterLabel(f)}
                </button>
              ))}
            </div>
            <div className="relative flex-shrink-0">
              <button
                onClick={() => setMoreOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  MORE_FILTERS.includes(statusFilter as WorkflowStatus)
                    ? 'bg-cobalt-600 text-white border border-cobalt-500/50 shadow-glow-blue'
                    : 'bg-obsidian-900/60 text-slate-400 border border-white/10 hover:bg-white/5'
                }`}
              >
                {MORE_FILTERS.includes(statusFilter as WorkflowStatus) ? filterLabel(statusFilter) : 'More'}
                <ChevronDown size={14} />
              </button>
              {moreOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                  <div role="menu" className="absolute right-0 mt-1 z-20 min-w-[9rem] bg-obsidian-900 border border-white/10 rounded-lg shadow-lg shadow-black/40 py-1">
                    {MORE_FILTERS.map((f) => (
                      <button
                        key={f}
                        role="menuitem"
                        onClick={() => { setStatusFilter(f); setMoreOpen(false) }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                          statusFilter === f ? 'text-white bg-cobalt-600/30' : 'text-slate-300 hover:bg-white/5'
                        }`}
                      >
                        {filterLabel(f)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Lead list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-obsidian-900/40 rounded-2xl border border-white/10 p-4 animate-pulse">
                <div className="h-4 bg-white/10 rounded w-1/3 mb-3" />
                <div className="h-3 bg-white/10 rounded w-1/2 mb-2" />
                <div className="h-3 bg-white/10 rounded w-1/4" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Inbox size={40} className="mx-auto text-slate-600 mb-3" />
            <p className="text-slate-300 font-medium">No leads yet</p>
            <p className="text-sm text-slate-500 mt-1">Customer submissions will appear here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((lead) => (
              <div
                key={lead.id}
                onClick={() => navigate(`/dashboard/leads/${lead.id}`)}
                className="bg-obsidian-900/40 rounded-2xl border border-white/10 p-4 hover:border-white/20 transition-all cursor-pointer group"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-slate-100 truncate">{lead.customer_name}</h3>
                      <ChevronRight size={16} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0" />
                      {latestQuotes.has(lead.id) && (
                        <span className={`text-[11px] font-medium border rounded-md px-1.5 py-0.5 whitespace-nowrap flex-shrink-0 ${QUOTE_BADGE_COLORS[latestQuotes.get(lead.id)!]}`}>
                          Quote: {QUOTE_STATUS_META[latestQuotes.get(lead.id)!].label}
                        </span>
                      )}
                      {(messageCounts.get(lead.id) ?? 0) > 0 && (
                        <span className="flex items-center gap-1 text-[11px] font-medium border rounded-md px-1.5 py-0.5 whitespace-nowrap flex-shrink-0 text-sky-200 bg-sky-500/10 border-sky-500/30">
                          <MessageSquare size={11} />
                          {messageCounts.get(lead.id)} {messageCounts.get(lead.id) === 1 ? 'message' : 'messages'}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-400 truncate">{lead.vehicle_name}</p>
                    <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <Mail size={12} />
                        {lead.customer_email}
                      </span>
                      {lead.customer_phone && (
                        <span className="flex items-center gap-1">
                          <Phone size={12} />
                          {lead.customer_phone}
                        </span>
                      )}
                      {lead.customer_state && (
                        <span className="flex items-center gap-1">
                          <MapPin size={12} />
                          {lead.customer_state}
                        </span>
                      )}
                      <span>·</span>
                      <span>{formatDate(lead.submitted_at)}</span>
                      <span>·</span>
                      <span className="font-medium text-slate-300">{formatCurrency(lead.grand_total)}</span>
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <StatusSelect status={lead.status} isCustom={lead.is_custom} onChange={(s) => handleStatusChange(lead.id, s)} size="sm" disabled={readOnly} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: { icon: LucideIcon; label: string; value: number; color: string }) {
  return (
    <div className="bg-obsidian-900/40 rounded-2xl border border-white/10 shadow-lg backdrop-blur-sm p-4">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
          <Icon size={20} />
        </div>
        <div>
          <p className="text-2xl font-bold text-slate-100">{value}</p>
          <p className="text-xs text-slate-400">{label}</p>
        </div>
      </div>
    </div>
  )
}
