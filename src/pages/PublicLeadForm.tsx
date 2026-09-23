import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase, Shop, formatCurrency } from '../lib/supabase'
import { Shield, CheckCircle2, Mail, Phone, MapPin, User, Car, Send, AlertCircle } from 'lucide-react'

const VEHICLES = [
  { id: 'gmc-sierra-2500-2024', name: '2024 GMC Sierra 2500 HD' },
]

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']

const labelClass = 'text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2 block'
const inputClass = 'w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all duration-200'
const inputWithIconClass = 'w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all duration-200'
const iconClass = 'absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none'

export default function PublicLeadForm() {
  const { shopId } = useParams<{ shopId: string }>()
  const [shop, setShop] = useState<Shop | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerState, setCustomerState] = useState('')
  const [vehicleId, setVehicleId] = useState(VEHICLES[0].id)
  const [fulfillmentMode, setFulfillmentMode] = useState<'local' | 'mail'>('local')
  const [partsTotal, setPartsTotal] = useState(0)
  const [shippingTotal, setShippingTotal] = useState(0)

  useEffect(() => {
    if (!shopId) return
    supabase.from('shops').select('*').eq('id', shopId).maybeSingle().then(({ data, error }) => {
      if (error || !data) {
        setError('Shop not found')
      } else {
        setShop(data as Shop)
      }
      setLoading(false)
    })
  }, [shopId])

  const grandTotal = partsTotal + shippingTotal

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!shopId) return
    setSubmitting(true)
    setError(null)

    const { error } = await supabase.from('leads').insert({
      shop_id: shopId,
      customer_name: customerName.trim(),
      customer_email: customerEmail.trim(),
      customer_phone: customerPhone.trim() || null,
      customer_state: customerState || null,
      vehicle_id: vehicleId,
      vehicle_name: VEHICLES.find((v) => v.id === vehicleId)?.name ?? vehicleId,
      fulfillment_mode: fulfillmentMode,
      selected_parts: [],
      parts_total: partsTotal,
      shipping_total: shippingTotal,
      grand_total: grandTotal,
      status: 'new',
    })

    if (error) {
      setError('Failed to submit. Please try again.')
      setSubmitting(false)
    } else {
      setSubmitted(true)
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight">
        <div className="w-9 h-9 border-[3px] border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (error && !shop) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 p-4">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-lg font-medium">{error}</p>
          <p className="text-sm text-slate-500 mt-1">This shop link may be invalid.</p>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 p-4">
        <div className="bg-obsidian-900/70 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card p-8 w-full max-w-md text-center animate-scale-in">
          <div className="w-16 h-16 bg-emerald-500/10 ring-1 ring-emerald-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={32} className="text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-2">Request Submitted</h1>
          <p className="text-slate-400">
            Thank you, {customerName.split(' ')[0]}! {shop?.name} will contact you at {customerEmail} shortly.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="dark-surface bg-obsidian-950 min-h-screen text-slate-100 flex items-center justify-center p-4 relative overflow-hidden bg-radial-spotlight">
      <div className="bg-obsidian-900/70 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card p-8 w-full max-w-md relative z-10">
        {/* Shop identity */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="bg-obsidian-950/80 border border-white/10 p-4 rounded-xl shadow-inner mb-4">
            {shop?.logo_url ? (
              <img src={shop.logo_url} alt={shop.name} className="h-12 w-auto max-w-[180px] object-contain" />
            ) : (
              <Shield size={32} className="text-cobalt-400" />
            )}
          </div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">{shop?.name}</p>
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1 mt-1">Request a Quote</h1>
          <p className="text-sm text-slate-400">Fill out the form and {shop?.name} will get back to you with a detailed quote.</p>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-xl px-3 py-2.5 mb-5">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className={labelClass}>Full Name</label>
            <div className="relative">
              <User size={16} className={iconClass} />
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                required
                className={inputWithIconClass}
                placeholder="John Smith"
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Email</label>
            <div className="relative">
              <Mail size={16} className={iconClass} />
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                required
                className={inputWithIconClass}
                placeholder="you@email.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Phone</label>
              <div className="relative">
                <Phone size={16} className={iconClass} />
                <input
                  type="tel"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  className={inputWithIconClass}
                  placeholder="(555) 123-4567"
                />
              </div>
            </div>
            <div>
              <label className={labelClass}>State</label>
              <div className="relative">
                <MapPin size={16} className={iconClass} />
                <select
                  value={customerState}
                  onChange={(e) => setCustomerState(e.target.value)}
                  className={`${inputWithIconClass} appearance-none cursor-pointer`}
                >
                  <option value="">Select</option>
                  {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          </div>

          <div>
            <label className={labelClass}>Vehicle</label>
            <div className="relative">
              <Car size={16} className={iconClass} />
              <select
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
                className={`${inputWithIconClass} appearance-none cursor-pointer`}
              >
                {VEHICLES.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass}>Fulfillment</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFulfillmentMode('local')}
                className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  fulfillmentMode === 'local'
                    ? 'bg-cobalt-600 text-white shadow-glow-blue'
                    : 'bg-obsidian-950/80 border border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
                }`}
              >
                Local Drop-off
              </button>
              <button
                type="button"
                onClick={() => setFulfillmentMode('mail')}
                className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                  fulfillmentMode === 'mail'
                    ? 'bg-cobalt-600 text-white shadow-glow-blue'
                    : 'bg-obsidian-950/80 border border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
                }`}
              >
                Mail-Order DIY
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>Parts ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={partsTotal || ''}
                onChange={(e) => setPartsTotal(parseFloat(e.target.value) || 0)}
                className={inputClass}
                placeholder="0"
              />
            </div>
            <div>
              <label className={labelClass}>Ship ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={shippingTotal || ''}
                onChange={(e) => setShippingTotal(parseFloat(e.target.value) || 0)}
                className={inputClass}
                placeholder="0"
              />
            </div>
            <div>
              <label className={labelClass}>Total</label>
              <div className="bg-obsidian-950/80 border border-white/10 rounded-xl px-3 py-3 text-sm font-bold text-white">
                {formatCurrency(grandTotal)}
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-metallic-gradient text-white font-semibold py-3.5 px-6 rounded-xl shadow-glow-blue hover:brightness-110 active:scale-[0.99] transition-all duration-200 flex items-center justify-center gap-2 text-sm tracking-wide disabled:opacity-60 disabled:hover:brightness-100"
          >
            <Send size={16} />
            {submitting ? 'Submitting…' : 'Submit Request'}
          </button>
        </form>
      </div>
    </div>
  )
}
