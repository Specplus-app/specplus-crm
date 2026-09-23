import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, Vehicle, formatDate, SHIP_SIZES, ShipSize, DEFAULT_LEAD_TIME_MULTIPLIER } from '../lib/supabase'
import { Plus, Car, Edit3, Trash2, Eye, EyeOff, ChevronRight, X, Truck, Save, Clock, Image as ImageIcon, Upload, Code, Copy, Check } from 'lucide-react'

type VehicleWithParts = Vehicle & { part_count?: number }

export default function ShopVehicles() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [vehicles, setVehicles] = useState<VehicleWithParts[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [embedVehicle, setEmbedVehicle] = useState<Vehicle | null>(null)
  const [shippingRates, setShippingRates] = useState<Record<ShipSize, number>>({ small: 15, medium: 25, large: 40, 'x-large': 60 })
  const [leadMultiplierPct, setLeadMultiplierPct] = useState<number>(Math.round(DEFAULT_LEAD_TIME_MULTIPLIER * 100))
  const [ratesLoading, setRatesLoading] = useState(true)
  const [ratesSaving, setRatesSaving] = useState(false)
  const [ratesSaved, setRatesSaved] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)

  const loadVehicles = useCallback(async () => {
    if (!profile?.shop_id) return
    setLoading(true)
    const { data, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('shop_id', profile.shop_id)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('Failed to load vehicles:', error.message)
    } else {
      const vehicleList = data as Vehicle[]
      const withCounts = await Promise.all(
        vehicleList.map(async (v) => {
          const { count } = await supabase
            .from('vehicle_parts')
            .select('*', { count: 'exact', head: true })
            .eq('vehicle_id', v.id)
          return { ...v, part_count: count ?? 0 }
        })
      )
      setVehicles(withCounts)
    }
    setLoading(false)
  }, [profile?.shop_id])

  useEffect(() => {
    loadVehicles()
  }, [loadVehicles])

  useEffect(() => {
    if (!profile?.shop_id) return
    supabase.from('shops').select('customizer_config, logo_url').eq('id', profile.shop_id).maybeSingle().then((res) => {
      if (res.data?.customizer_config) {
        const cfg = res.data.customizer_config as Record<string, unknown>
        const rates = cfg.shipping_rates as Record<ShipSize, number> | undefined
        if (rates) setShippingRates(rates)
        const mult = cfg.lead_time_multiplier as number | undefined
        if (typeof mult === 'number') setLeadMultiplierPct(Math.round(mult * 100))
      }
      setLogoUrl((res.data?.logo_url as string | null) ?? null)
      setRatesLoading(false)
    })
  }, [profile?.shop_id])

  const handleSaveRates = async () => {
    if (!profile?.shop_id) return
    setRatesSaving(true)
    const { data } = await supabase.from('shops').select('customizer_config').eq('id', profile.shop_id).maybeSingle()
    const existing = (data?.customizer_config as Record<string, unknown>) ?? {}
    await supabase.from('shops').update({ customizer_config: { ...existing, shipping_rates: shippingRates, lead_time_multiplier: leadMultiplierPct / 100 } }).eq('id', profile.shop_id)
    setRatesSaving(false)
    setRatesSaved(true)
    setTimeout(() => setRatesSaved(false), 2000)
  }

  const handleLogoUpload = async (file: File) => {
    if (!profile?.shop_id) return
    setLogoError(null)
    if (!file.type.startsWith('image/')) {
      setLogoError('Please choose an image file.')
      return
    }
    if (file.size > 3 * 1024 * 1024) {
      setLogoError('Logo must be under 3 MB.')
      return
    }
    setLogoUploading(true)
    const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
    const path = `shop-${profile.shop_id}/logo-${Date.now()}.${ext}`
    const { error: uploadError } = await supabase.storage.from('shop-logos').upload(path, file, { upsert: true })
    if (uploadError) {
      setLogoError('Upload failed. Please try again.')
      setLogoUploading(false)
      return
    }
    const publicUrl = supabase.storage.from('shop-logos').getPublicUrl(path).data.publicUrl
    const { error: updateError } = await supabase.from('shops').update({ logo_url: publicUrl }).eq('id', profile.shop_id)
    if (updateError) {
      setLogoError('Could not save your logo. Please try again.')
      setLogoUploading(false)
      return
    }
    setLogoUrl(publicUrl)
    setLogoUploading(false)
  }

  const handleRemoveLogo = async () => {
    if (!profile?.shop_id) return
    setLogoUploading(true)
    const { error } = await supabase.from('shops').update({ logo_url: null }).eq('id', profile.shop_id)
    if (!error) setLogoUrl(null)
    setLogoUploading(false)
  }

  const handleTogglePublish = async (vehicle: Vehicle) => {
    const newStatus = vehicle.status === 'published' ? 'draft' : 'published'
    const { error } = await supabase
      .from('vehicles')
      .update({ status: newStatus })
      .eq('id', vehicle.id)
    if (error) {
      console.error('Failed to update status:', error.message)
    } else {
      setVehicles((prev) => prev.map((v) => v.id === vehicle.id ? { ...v, status: newStatus } : v))
    }
  }

  const handleDelete = async (vehicle: Vehicle) => {
    if (!confirm(`Delete "${vehicle.name}"? This will also delete all traced parts for this vehicle.`)) return
    // Delete storage images
    if (vehicle.front_image_path) {
      await supabase.storage.from('vehicles').remove([vehicle.front_image_path])
    }
    if (vehicle.rear_image_path) {
      await supabase.storage.from('vehicles').remove([vehicle.rear_image_path])
    }
    const { error } = await supabase.from('vehicles').delete().eq('id', vehicle.id)
    if (error) {
      console.error('Failed to delete:', error.message)
    } else {
      setVehicles((prev) => prev.filter((v) => v.id !== vehicle.id))
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">Vehicles</h1>
            <p className="text-sm text-zinc-500 mt-1">Upload vehicle photos, trace parts, and publish for customers</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-colors"
          >
            <Plus size={16} />
            Add Vehicle
          </button>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-white rounded-xl border border-zinc-200 p-4 animate-pulse">
                <div className="h-5 bg-zinc-100 rounded w-1/4 mb-3" />
                <div className="h-3 bg-zinc-100 rounded w-1/3" />
              </div>
            ))}
          </div>
        ) : vehicles.length === 0 ? (
          <div className="text-center py-16">
            <Car size={40} className="mx-auto text-zinc-300 mb-3" />
            <p className="text-zinc-500 font-medium">No vehicles yet</p>
            <p className="text-sm text-zinc-400 mt-1">Click "Add Vehicle" to upload a photo and start tracing parts</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {vehicles.map((vehicle) => (
              <div key={vehicle.id} className="bg-white rounded-xl border border-zinc-200 overflow-hidden hover:shadow-md transition-shadow">
                {/* Thumbnail */}
                <div className="h-40 bg-zinc-100 relative overflow-hidden">
                  {vehicle.front_image_path ? (
                    <img
                      src={supabase.storage.from('vehicles').getPublicUrl(vehicle.front_image_path).data.publicUrl}
                      alt={vehicle.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Car size={32} className="text-zinc-300" />
                    </div>
                  )}
                  <div className="absolute top-2 right-2">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                      vehicle.status === 'published'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-zinc-100 text-zinc-500'
                    }`}>
                      {vehicle.status === 'published' ? 'Published' : 'Draft'}
                    </span>
                  </div>
                </div>

                {/* Info */}
                <div className="p-4">
                  <h3 className="font-semibold text-zinc-900">{vehicle.name}</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {vehicle.part_count} {vehicle.part_count === 1 ? 'part' : 'parts'} traced
                    {' · '}Created {formatDate(vehicle.created_at)}
                  </p>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => navigate(`/dashboard/vehicles/${vehicle.id}`)}
                      className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      <Edit3 size={14} />
                      Edit
                    </button>
                    <button
                      onClick={() => handleTogglePublish(vehicle)}
                      className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      {vehicle.status === 'published' ? <EyeOff size={14} /> : <Eye size={14} />}
                      {vehicle.status === 'published' ? 'Unpublish' : 'Publish'}
                    </button>
                    <button
                      onClick={() => setEmbedVehicle(vehicle)}
                      className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-700 bg-zinc-100 hover:bg-zinc-200 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      <Code size={14} />
                      Embed on Website
                    </button>
                    <button
                      onClick={() => handleDelete(vehicle)}
                      className="flex items-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-lg px-3 py-1.5 transition-colors ml-auto"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Branding / Logo */}
        <div className="mt-8 bg-white rounded-xl border border-zinc-200 p-5">
          <div className="flex items-center gap-2 mb-1">
            <ImageIcon size={18} className="text-zinc-500" />
            <h2 className="text-lg font-bold text-zinc-900">Shop Logo</h2>
          </div>
          <p className="text-sm text-zinc-500 mb-4">
            Upload your logo. It appears on your customer building page and here in your dashboard.
          </p>
          <div className="flex items-center gap-5">
            <div className="w-28 h-28 rounded-xl border border-zinc-200 bg-zinc-50 flex items-center justify-center overflow-hidden flex-shrink-0">
              {logoUrl ? (
                <img src={logoUrl} alt="Shop logo" className="w-full h-full object-contain" />
              ) : (
                <ImageIcon size={28} className="text-zinc-300" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <label className={`flex items-center gap-2 text-sm font-medium rounded-lg px-4 py-2 transition-colors cursor-pointer ${
                  logoUploading ? 'bg-zinc-100 text-zinc-400 cursor-not-allowed' : 'bg-zinc-900 hover:bg-zinc-800 text-white'
                }`}>
                  <Upload size={14} />
                  {logoUploading ? 'Uploading…' : logoUrl ? 'Replace Logo' : 'Upload Logo'}
                  <input
                    type="file"
                    accept="image/*"
                    disabled={logoUploading}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) handleLogoUpload(file)
                      e.target.value = ''
                    }}
                  />
                </label>
                {logoUrl && !logoUploading && (
                  <button
                    onClick={handleRemoveLogo}
                    className="flex items-center gap-1.5 text-sm font-medium text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-lg px-3 py-2 transition-colors"
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-2">PNG or JPG, up to 3 MB. A transparent PNG looks best.</p>
              {logoError && <p className="text-sm text-red-600 mt-1">{logoError}</p>}
            </div>
          </div>
        </div>

        {/* Shipping Rates Config */}
        <div className="mt-8 bg-white rounded-xl border border-zinc-200 p-5">
          <div className="flex items-center gap-2 mb-1">
            <Truck size={18} className="text-zinc-500" />
            <h2 className="text-lg font-bold text-zinc-900">Shipping Rates</h2>
          </div>
          <p className="text-sm text-zinc-500 mb-4">
            Set the shipping cost for each part size. Customers choosing mail-order will see these estimates when building their quote.
          </p>
          {ratesLoading ? (
            <div className="h-24 animate-pulse bg-zinc-100 rounded-lg" />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {SHIP_SIZES.map((s) => (
                  <div key={s.value}>
                    <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">{s.label}</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">$</span>
                      <input
                        type="number" min="0" step="0.01" value={shippingRates[s.value]}
                        onChange={(e) => setShippingRates((prev) => ({ ...prev, [s.value]: parseFloat(e.target.value) || 0 }))}
                        className="w-full bg-zinc-50 border border-zinc-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 pt-5 border-t border-zinc-200">
                <div className="flex items-center gap-2 mb-1">
                  <Clock size={18} className="text-zinc-500" />
                  <h3 className="text-base font-bold text-zinc-900">Lead Time Buildup</h3>
                </div>
                <p className="text-sm text-zinc-500 mb-4">
                  A build's lead time starts from its slowest part. Each additional part adds a small share of its own lead time on top. Lower this if your shop processes parts faster.
                </p>
                <div className="max-w-[200px]">
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Extra Part Buildup</label>
                  <div className="relative">
                    <input
                      type="number" min="0" max="100" step="1" value={leadMultiplierPct}
                      onChange={(e) => setLeadMultiplierPct(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
                      className="w-full bg-zinc-50 border border-zinc-200 rounded-lg pl-3 pr-8 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-sm">%</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={handleSaveRates}
                  disabled={ratesSaving}
                  className="flex items-center gap-2 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  <Save size={14} />
                  {ratesSaving ? 'Saving…' : 'Save Settings'}
                </button>
                {ratesSaved && <span className="text-sm text-emerald-600 font-medium">Saved!</span>}
              </div>
            </>
          )}
        </div>
      </div>

      {showCreateModal && profile?.shop_id && (
        <CreateVehicleModal
          shopId={profile.shop_id}
          onClose={() => setShowCreateModal(false)}
          onCreated={(newId) => navigate(`/dashboard/vehicles/${newId}`)}
        />
      )}

      {embedVehicle && (
        <EmbedModal vehicle={embedVehicle} onClose={() => setEmbedVehicle(null)} />
      )}
    </div>
  )
}

function CreateVehicleModal({ shopId, onClose, onCreated }: { shopId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [year, setYear] = useState('')
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { data, error } = await supabase.from('vehicles').insert({
      shop_id: shopId,
      name: name.trim(),
      year: year ? parseInt(year) : null,
      make: make.trim() || null,
      model: model.trim() || null,
      status: 'draft',
    }).select('id').single()
    if (error) {
      setError(error.message)
      setSubmitting(false)
    } else {
      onCreated(data.id)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-zinc-900">Add New Vehicle</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Display Name *</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)} required
              className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              placeholder="2024 GMC Sierra 2500 HD"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Year</label>
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="2024" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Make</label>
              <input type="text" value={make} onChange={(e) => setMake(e.target.value)}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="GMC" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">Model</label>
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)}
                className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                placeholder="Sierra" />
            </div>
          </div>
          <button type="submit" disabled={submitting}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold text-sm rounded-lg py-2.5 transition-colors">
            {submitting ? 'Creating…' : 'Create Vehicle'}
          </button>
        </form>
      </div>
    </div>
  )
}

function EmbedModal({ vehicle, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const snippet = `<iframe src="https://app.specplus.app/embed/vehicle/${vehicle.id}" width="100%" height="600px" style="border:none; border-radius:12px; overflow:hidden;"></iframe>`

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = snippet
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="dark-surface fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-obsidian-900/80 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card w-full max-w-lg p-6 animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Code size={18} className="text-cobalt-400" />
            Embed on Your Website
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Paste this code into any page (Shopify, WordPress, plain HTML) to show
          <span className="text-slate-200 font-medium"> {vehicle.name} </span>
          as an interactive, shoppable image.
        </p>

        {vehicle.status !== 'published' && (
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm rounded-lg px-3 py-2 mb-4">
            <EyeOff size={16} className="flex-shrink-0 mt-0.5" />
            <span>This vehicle is a draft. Publish it first, or the embed will appear empty to visitors.</span>
          </div>
        )}

        <div className="relative">
          <pre className="bg-obsidian-950/80 border border-white/10 rounded-xl p-4 pr-4 text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
{snippet}
          </pre>
        </div>

        <button
          onClick={handleCopy}
          className="w-full mt-4 bg-metallic-gradient text-white font-semibold text-sm rounded-xl py-3 shadow-glow-blue hover:brightness-110 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? 'Copied!' : 'Copy Code'}
        </button>
      </div>
    </div>
  )
}
