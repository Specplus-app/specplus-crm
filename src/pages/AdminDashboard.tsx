import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, Shop, Profile, formatCurrency, formatDate } from '../lib/supabase'
import { Search, Plus, Building2, Users, Mail, Phone, ChevronRight, X } from 'lucide-react'

type ShopWithStats = Shop & {
  user_count?: number
  lead_count?: number
}

export default function AdminDashboard() {
  const navigate = useNavigate()
  const [shops, setShops] = useState<ShopWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)

  const loadShops = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('shops')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) {
      console.error('Failed to load shops:', error.message)
    } else {
      const shopList = data as Shop[]
      const withStats = await Promise.all(
        shopList.map(async (shop) => {
          const [{ count: userCount }, { count: leadCount }] = await Promise.all([
            supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('shop_id', shop.id),
            supabase.from('leads').select('*', { count: 'exact', head: true }).eq('shop_id', shop.id),
          ])
          return { ...shop, user_count: userCount ?? 0, lead_count: leadCount ?? 0 }
        })
      )
      setShops(withStats)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadShops()
  }, [loadShops])

  const filtered = search.trim()
    ? shops.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()) || s.contact_email.toLowerCase().includes(search.toLowerCase()))
    : shops

  const tierColors: Record<string, string> = {
    starter: 'bg-zinc-100 text-zinc-600',
    pro: 'bg-blue-100 text-blue-700',
    enterprise: 'bg-emerald-100 text-emerald-700',
  }
  const statusColors: Record<string, string> = {
    trial: 'bg-amber-100 text-amber-700',
    active: 'bg-emerald-100 text-emerald-700',
    suspended: 'bg-red-100 text-red-700',
    cancelled: 'bg-zinc-100 text-zinc-500',
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Shops</h1>
            <p className="text-sm text-slate-400 mt-1">Manage shop subscriptions and users</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-cobalt-600 hover:bg-cobalt-500 text-white shadow-glow-blue border border-cobalt-400/20 text-sm font-medium rounded-xl px-4 py-2.5 transition-colors"
          >
            <Plus size={16} />
            Add Shop
          </button>
        </div>

        <div className="relative mb-4 bg-obsidian-900/60 border border-white/10 rounded-xl focus-within:border-cobalt-500/50 focus-within:ring-1 focus-within:ring-cobalt-500/50 transition-all">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search shops…"
            className="w-full bg-transparent text-slate-200 placeholder-slate-500 rounded-xl pl-10 pr-3 py-2 text-sm focus:outline-none"
          />
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-zinc-200 p-4 animate-pulse">
                <div className="h-5 bg-zinc-100 rounded w-1/4 mb-3" />
                <div className="h-3 bg-zinc-100 rounded w-1/3 mb-2" />
                <div className="h-3 bg-zinc-100 rounded w-1/5" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Building2 size={40} className="mx-auto text-zinc-300 mb-3" />
            <p className="text-zinc-500 font-medium">No shops yet</p>
            <p className="text-sm text-zinc-400 mt-1">Click "Add Shop" to create your first subscription</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((shop) => (
              <div
                key={shop.id}
                onClick={() => navigate(`/admin/shops/${shop.id}`)}
                className="bg-obsidian-900/40 rounded-2xl border border-white/10 p-4 hover:border-white/20 shadow-glass-card transition-all cursor-pointer group"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold text-slate-200 truncate">{shop.name}</h3>
                      <ChevronRight size={16} className="text-slate-500 group-hover:text-slate-300 transition-colors flex-shrink-0" />
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <Mail size={12} />
                        {shop.contact_email}
                      </span>
                      {shop.phone && (
                        <span className="flex items-center gap-1">
                          <Phone size={12} />
                          {shop.phone}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Users size={12} />
                        {shop.user_count} {shop.user_count === 1 ? 'user' : 'users'}
                      </span>
                      <span>·</span>
                      <span>{shop.lead_count} leads</span>
                      <span>·</span>
                      <span>Since {formatDate(shop.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${tierColors[shop.subscription_tier]}`}>
                      {shop.subscription_tier}
                    </span>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColors[shop.subscription_status]}`}>
                      {shop.subscription_status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateShopModal onClose={() => setShowCreateModal(false)} onCreated={loadShops} />
      )}
    </div>
  )
}

function CreateShopModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [tier, setTier] = useState('starter')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error } = await supabase.from('shops').insert({
      name: name.trim(),
      contact_email: email.trim(),
      phone: phone.trim() || null,
      subscription_tier: tier,
      subscription_status: 'trial',
    })
    if (error) {
      setError(error.message)
      setSubmitting(false)
    } else {
      onCreated()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="dark-surface bg-obsidian-900/90 backdrop-blur-md border border-white/10 rounded-2xl shadow-glass-card w-full max-w-md p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-slate-100">Add New Shop</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors">
            <X size={20} />
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Shop Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full bg-obsidian-950 border border-white/10 text-slate-200 placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-cobalt-500/50 focus:ring-1 focus:ring-cobalt-500/50 transition-all"
              placeholder="Fast Headlights"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Contact Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-obsidian-950 border border-white/10 text-slate-200 placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-cobalt-500/50 focus:ring-1 focus:ring-cobalt-500/50 transition-all"
              placeholder="owner@shop.com"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Phone (optional)</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full bg-obsidian-950 border border-white/10 text-slate-200 placeholder-slate-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-cobalt-500/50 focus:ring-1 focus:ring-cobalt-500/50 transition-all"
              placeholder="(555) 123-4567"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Subscription Tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              className="w-full bg-obsidian-950 border border-white/10 text-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-cobalt-500/50 focus:ring-1 focus:ring-cobalt-500/50 transition-all"
            >
              <option value="starter">Starter</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-cobalt-600 hover:bg-cobalt-500 disabled:opacity-50 text-white shadow-glow-blue border border-cobalt-400/20 font-semibold text-sm rounded-xl py-2.5 transition-colors"
          >
            {submitting ? 'Creating…' : 'Create Shop'}
          </button>
        </form>
      </div>
    </div>
  )
}
