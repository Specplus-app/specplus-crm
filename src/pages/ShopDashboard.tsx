import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, Lead, LeadStatus, formatCurrency, formatDate } from '../lib/supabase'
import StatusSelect from '../components/StatusSelect'
import { Search, Inbox, TrendingUp, Clock, CheckCircle2, Mail, Phone, MapPin, ChevronRight, Link2, Copy, Check, ExternalLink, type LucideIcon } from 'lucide-react'

const STATUS_FILTERS: { value: LeadStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'quoted', label: 'Quoted' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
]

export default function ShopDashboard() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<LeadStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [copied, setCopied] = useState(false)

  const customerLink = profile?.shop_id ? `${window.location.origin}/customize/${profile.shop_id}` : ''

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

  const loadLeads = useCallback(async () => {
    if (!profile?.shop_id) return
    setLoading(true)
    let query = supabase
      .from('leads')
      .select('*')
      .eq('shop_id', profile.shop_id)
      .order('submitted_at', { ascending: false })
    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter)
    }
    const { data, error } = await query
    if (error) {
      console.error('Failed to load leads:', error.message)
    } else {
      setLeads((data ?? []) as Lead[])
    }
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

  const stats = {
    total: leads.length,
    new: leads.filter((l) => l.status === 'new').length,
    active: leads.filter((l) => ['contacted', 'quoted', 'scheduled'].includes(l.status)).length,
    completed: leads.filter((l) => l.status === 'completed').length,
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-100">Leads</h1>
          <p className="text-sm text-slate-400 mt-1">Customer submissions from your vehicle customizer</p>
        </div>

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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard icon={Inbox} label="Total Leads" value={stats.total} color="text-slate-300 bg-white/5" />
          <StatCard icon={Clock} label="New" value={stats.new} color="text-blue-300 bg-blue-500/10" />
          <StatCard icon={TrendingUp} label="Active" value={stats.active} color="text-amber-300 bg-amber-500/10" />
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
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  statusFilter === f.value
                    ? 'bg-cobalt-600 text-white border border-cobalt-500/50 shadow-glow-blue'
                    : 'bg-obsidian-900/60 text-slate-400 border border-white/10 hover:bg-white/5'
                }`}
              >
                {f.label}
              </button>
            ))}
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
                    <StatusSelect status={lead.status} onChange={(s) => handleStatusChange(lead.id, s)} size="sm" />
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
