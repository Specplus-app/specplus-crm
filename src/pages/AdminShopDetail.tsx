import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, Shop, Profile, Lead, formatCurrency, formatDate, formatDateTime } from '../lib/supabase'

async function getAdminToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('No active session')
  return session.access_token
}
import { ArrowLeft, Building2, Users, Mail, Phone, MapPin, Plus, X, UserCog, LogOut, Shield, Inbox, AlertCircle, Car } from 'lucide-react'

export default function AdminShopDetail() {
  const { shopId } = useParams<{ shopId: string }>()
  const { profile: adminProfile } = useAuth()
  const navigate = useNavigate()
  const [shop, setShop] = useState<Shop | null>(null)
  const [users, setUsers] = useState<Profile[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddUser, setShowAddUser] = useState(false)
  const [impersonating, setImpersonating] = useState(false)
  const [impersonateError, setImpersonateError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!shopId) return
    const [shopRes, usersRes, leadsRes] = await Promise.all([
      supabase.from('shops').select('*').eq('id', shopId).maybeSingle(),
      supabase.from('profiles').select('*').eq('shop_id', shopId).order('created_at', { ascending: false }),
      supabase.from('leads').select('*').eq('shop_id', shopId).order('submitted_at', { ascending: false }).limit(10),
    ])
    if (shopRes.data) setShop(shopRes.data as Shop)
    if (usersRes.data) setUsers(usersRes.data as Profile[])
    if (leadsRes.data) setLeads(leadsRes.data as Lead[])
    setLoading(false)
  }, [shopId])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleUpdateShop = async (updates: Partial<Shop>) => {
    if (!shop) return
    const { error } = await supabase.from('shops').update(updates).eq('id', shop.id)
    if (error) {
      console.error('Failed to update shop:', error.message)
    } else {
      setShop({ ...shop, ...updates })
    }
  }

  const handleImpersonate = async (targetUser: Profile) => {
    if (!adminProfile) return
    setImpersonating(true)
    setImpersonateError(null)
    try {
      const token = await getAdminToken()
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-impersonate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            target_user_id: targetUser.id,
          }),
        }
      )
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? `Failed to impersonate (${response.status})`)
      }
      const result = await response.json() as { access_token?: string; refresh_token?: string }
      if (!result.access_token || !result.refresh_token) {
        throw new Error('Invalid response from server')
      }
      const { error: setSessionError } = await supabase.auth.setSession({
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      })
      if (setSessionError) throw setSessionError
      navigate('/dashboard')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to impersonate user'
      console.error('Impersonation failed:', msg)
      setImpersonateError(msg)
    }
    setImpersonating(false)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-zinc-300 border-t-brand-500 rounded-full animate-spin" />
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 font-medium">Shop not found</p>
          <button onClick={() => navigate('/admin')} className="text-sm text-brand-600 hover:underline mt-2">
            Back to shops
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-5xl mx-auto">
        <button
          onClick={() => navigate('/admin')}
          className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 mb-4 transition-colors"
        >
          <ArrowLeft size={16} />
          Back to shops
        </button>

        {/* Shop header */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-zinc-100 rounded-xl flex items-center justify-center">
                <Building2 size={24} className="text-zinc-500" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-zinc-900">{shop.name}</h1>
                <p className="text-sm text-zinc-500">Since {formatDate(shop.created_at)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={shop.subscription_tier}
                onChange={(e) => handleUpdateShop({ subscription_tier: e.target.value as Shop['subscription_tier'] })}
                className="bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-1.5 text-sm font-medium focus:outline-none focus:border-brand-500"
              >
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="enterprise">Enterprise</option>
              </select>
              <select
                value={shop.subscription_status}
                onChange={(e) => handleUpdateShop({ subscription_status: e.target.value as Shop['subscription_status'] })}
                className="bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-1.5 text-sm font-medium focus:outline-none focus:border-brand-500"
              >
                <option value="trial">Trial</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-zinc-100">
            <div className="flex items-center gap-2 text-sm">
              <Mail size={14} className="text-zinc-400" />
              <span className="text-zinc-600">{shop.contact_email}</span>
            </div>
            {shop.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone size={14} className="text-zinc-400" />
                <span className="text-zinc-600">{shop.phone}</span>
              </div>
            )}
            {shop.address && (
              <div className="flex items-center gap-2 text-sm">
                <MapPin size={14} className="text-zinc-400" />
                <span className="text-zinc-600">{shop.address}</span>
              </div>
            )}
          </div>

          {/* Customer links */}
          <div className="flex flex-wrap gap-2 pt-4 mt-4 border-t border-zinc-100">
            <a
              href={`${window.location.origin}/customize/${shop.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg px-3 py-1.5 transition-colors"
            >
              <Car size={14} />
              Open Customer Customizer
            </a>
            <a
              href={`${window.location.origin}/lead/${shop.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors"
            >
              <Mail size={14} />
              Open Lead Form
            </a>
          </div>
        </div>

        {/* Users section */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
              <Users size={16} className="text-zinc-400" />
              Users ({users.length})
            </h2>
            <button
              onClick={() => setShowAddUser(true)}
              className="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 font-medium"
            >
              <Plus size={14} />
              Add User
            </button>
          </div>

          {impersonateError && (
            <div className="mb-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{impersonateError}</span>
            </div>
          )}
          {users.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-4">No users yet. Click "Add User" to create a login for this shop.</p>
          ) : (
            <div className="space-y-2">
              {users.map((user) => (
                <div key={user.id} className="flex items-center justify-between p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 bg-zinc-200 rounded-full flex items-center justify-center text-sm font-semibold text-zinc-600 flex-shrink-0">
                      {user.full_name?.[0]?.toUpperCase() ?? user.email[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-900 truncate">
                        {user.full_name || '(No name)'}
                      </p>
                      <p className="text-xs text-zinc-500 truncate">{user.email}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleImpersonate(user)}
                    disabled={impersonating}
                    className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-brand-600 bg-white border border-zinc-200 hover:border-brand-300 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
                  >
                    <UserCog size={14} />
                    {impersonating ? 'Loading…' : 'Impersonate'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent leads */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6">
          <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2 mb-4">
            <Inbox size={16} className="text-zinc-400" />
            Recent Leads ({leads.length})
          </h2>
          {leads.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-4">No leads yet</p>
          ) : (
            <div className="space-y-2">
              {leads.map((lead) => (
                <div key={lead.id} className="flex items-center justify-between p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{lead.customer_name}</p>
                    <p className="text-xs text-zinc-500 truncate">{lead.vehicle_name} · {formatDate(lead.submitted_at)}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-zinc-400">{lead.status}</span>
                    <span className="text-sm font-medium text-zinc-700">{formatCurrency(lead.grand_total)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showAddUser && (
        <AddUserModal shopId={shop.id} onClose={() => setShowAddUser(false)} onAdded={loadData} />
      )}
    </div>
  )
}

// AddUserModal is a separate component rendered conditionally
function AddUserModal({ shopId, onClose, onAdded }: { shopId: string; onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('No active session')
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-create-user`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            email: email.trim(),
            password,
            full_name: fullName.trim(),
            shop_id: shopId,
          }),
        }
      )
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error((err as { error?: string }).error ?? `Failed to create user (${response.status})`)
      }
      onAdded()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user')
    }
    setSubmitting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-zinc-900">Add Shop User</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="John Smith"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="user@shop.com"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="Min 6 characters"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors"
          >
            {submitting ? 'Creating…' : 'Create User'}
          </button>
        </form>
      </div>
    </div>
  )
}
