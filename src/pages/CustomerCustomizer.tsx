import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase, Vehicle, VehiclePart, PartGroup, PartPaintStyle, PartOption, Shop, formatCurrency, getHighlightColor, ShipSize, shipSizeRank, estimateLeadTimeDays, DEFAULT_LEAD_TIME_MULTIPLIER } from '../lib/supabase'
import { pickPartAtPoint } from '../lib/svgHit'
import CustomBuildFlow from '../components/CustomBuildFlow'
import { Shield, Car, ArrowLeft, ArrowRight, Check, Mail, Phone, User, MapPin, Send, CheckCircle2, AlertCircle, Layers, X, Palette, Plus, Clock, Calendar, PencilRuler, Hash, Minus, Hand, RotateCcw } from 'lucide-react'

type SelectedPart = {
  id: string
  name: string
  type: 'new' | 'send'
  price: number
  group_id?: string | null
  group_name?: string | null
  highlight_color?: string
  paint_style_id?: string | null
  paint_style_name?: string | null
  selected_options?: { id: string; name: string; price: number }[]
  ship_size?: ShipSize
  lead_time_days?: number
}

const STORAGE_BUCKET = 'vehicles'
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']

export default function CustomerCustomizer() {
  const { shopId } = useParams<{ shopId: string }>()
  const navigate = useNavigate()
  const [shop, setShop] = useState<Shop | null>(null)
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null)
  const [parts, setParts] = useState<VehiclePart[]>([])
  const [groups, setGroups] = useState<PartGroup[]>([])
  const [activeView, setActiveView] = useState<'front' | 'rear'>('front')
  const [selectedParts, setSelectedParts] = useState<Map<string, SelectedPart>>(new Map())
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerState, setCustomerState] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [paintCode, setPaintCode] = useState('')
  const [targetStartDate, setTargetStartDate] = useState('')
  const [entered, setEntered] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [fulfillmentMode, setFulfillmentMode] = useState<'local' | 'mail'>('local')
  const [shippingRates, setShippingRates] = useState<Record<ShipSize, number>>({ small: 0, medium: 0, large: 0, 'x-large': 0 })
  const [leadMultiplier, setLeadMultiplier] = useState<number>(DEFAULT_LEAD_TIME_MULTIPLIER)
  const [showCheckout, setShowCheckout] = useState(false)
  const [paintStyles, setPaintStyles] = useState<PartPaintStyle[]>([])
  const [partOptions, setPartOptions] = useState<PartOption[]>([])
  const [detailPart, setDetailPart] = useState<VehiclePart | null>(null)
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null)
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const movedRef = useRef(false)
  const [panMode, setPanMode] = useState(false)

  const clampZoom = (z: number) => Math.min(5, Math.max(1, z))
  const clampPan = (z: number, p: { x: number; y: number }) => {
    const el = viewportRef.current
    if (!el) return p
    const maxX = (el.clientWidth * (z - 1)) / 2
    const maxY = (el.clientHeight * (z - 1)) / 2
    return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) }
  }
  const applyZoom = (next: number) => {
    const z = clampZoom(next)
    setZoom(z)
    setPan((p) => (z === 1 ? { x: 0, y: 0 } : clampPan(z, p)))
  }

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  useEffect(() => {
    resetView()
    setPanMode(false)
  }, [activeView, selectedVehicle])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      setZoom((z) => {
        const nz = clampZoom(z - e.deltaY * 0.0025 * z)
        setPan((p) => (nz === 1 ? { x: 0, y: 0 } : clampPan(nz, p)))
        return nz
      })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [selectedVehicle, activeView])

  const onViewportPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    movedRef.current = false
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
      panStart.current = null
    } else if (pointers.current.size === 1 && (zoom > 1 || panMode)) {
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    }
  }
  const onViewportPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchStart.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      movedRef.current = true
      applyZoom(pinchStart.current.zoom * (dist / pinchStart.current.dist))
    } else if (panStart.current && pointers.current.size === 1) {
      const dx = e.clientX - panStart.current.x
      const dy = e.clientY - panStart.current.y
      if (Math.hypot(dx, dy) > 4) movedRef.current = true
      setPan(clampPan(zoom, { x: panStart.current.panX + dx, y: panStart.current.panY + dy }))
    }
  }
  const onViewportPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchStart.current = null
    if (pointers.current.size === 0) panStart.current = null
  }

  useEffect(() => {
    if (!shopId) return
    Promise.all([
      supabase.from('shops').select('id, name, logo_url, customizer_config').eq('id', shopId).maybeSingle(),
      supabase.from('vehicles').select('*').eq('shop_id', shopId).eq('status', 'published').order('created_at', { ascending: false }),
    ]).then(([shopRes, vehicleRes]) => {
      if (shopRes.data) {
        setShop(shopRes.data as Shop)
        const cfg = (shopRes.data as Shop).customizer_config as Record<string, unknown>
        const rates = cfg?.shipping_rates as Record<ShipSize, number> | undefined
        if (rates) setShippingRates(rates)
        const mult = cfg?.lead_time_multiplier as number | undefined
        if (typeof mult === 'number') setLeadMultiplier(mult)
      }
      if (vehicleRes.data) setVehicles(vehicleRes.data as Vehicle[])
      setLoading(false)
    })
  }, [shopId])

  const selectVehicle = useCallback(async (vehicle: Vehicle) => {
    setSelectedVehicle(vehicle)
    setSelectedParts(new Map())
    setActiveView('front')
    const [partsRes, groupsRes] = await Promise.all([
      supabase.from('vehicle_parts').select('*').eq('vehicle_id', vehicle.id).order('sort_order', { ascending: true }),
      supabase.from('part_groups').select('*').eq('vehicle_id', vehicle.id).order('sort_order', { ascending: true }),
    ])
    setParts(partsRes.data as VehiclePart[] ?? [])
    setGroups(groupsRes.data as PartGroup[] ?? [])
    const [stylesRes, optionsRes] = await Promise.all([
      supabase.from('part_paint_styles').select('*, vehicle_parts!inner(vehicle_id)').eq('vehicle_parts.vehicle_id', vehicle.id).order('sort_order', { ascending: true }),
      supabase.from('part_options').select('*, vehicle_parts!inner(vehicle_id)').eq('vehicle_parts.vehicle_id', vehicle.id).order('sort_order', { ascending: true }),
    ])
    setPaintStyles((stylesRes.data as PartPaintStyle[]) ?? [])
    setPartOptions((optionsRes.data as PartOption[]) ?? [])
  }, [])

  const getImageUrl = (path: string | null): string | null => {
    if (!path) return null
    return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl
  }

  const frontUrl = getImageUrl(selectedVehicle?.front_image_path ?? null)
  const rearUrl = getImageUrl(selectedVehicle?.rear_image_path ?? null)
  const currentImageUrl = activeView === 'front' ? frontUrl : rearUrl

  const partsForView = useMemo(
    () => parts.filter((p) => p.view === activeView).sort((a, b) => a.sort_order - b.sort_order),
    [parts, activeView]
  )

  const groupName = useCallback((groupId: string | null) => {
    if (!groupId) return null
    return groups.find((g) => g.id === groupId)?.name ?? null
  }, [groups])

  const handlePartClick = (part: VehiclePart) => {
    if (selectedParts.has(part.id)) {
      setSelectedParts((prev) => { const next = new Map(prev); next.delete(part.id); return next })
      return
    }
    setDetailPart(part)
  }

  const addPartToSelection = (part: VehiclePart, styleId: string | null, optionIds: string[], typeOverride?: 'new' | 'send') => {
    setSelectedParts((prev) => {
      const next = new Map(prev)
      const gName = groupName(part.group_id)
      const partStyles = paintStyles.filter((s) => s.part_id === part.id)
      const selectedOptions = optionIds.map((oid) => {
        const opt = partOptions.find((o) => o.id === oid)
        return { id: oid, name: opt?.name ?? '', price: opt?.price ?? 0 }
      })
      const optionsTotal = selectedOptions.reduce((sum, o) => sum + o.price, 0)
      const groupBoughtNew = part.group_id
        ? Array.from(prev.values()).some((p) => p.group_id === part.group_id && p.type === 'new')
        : false
      const type = groupBoughtNew ? 'send' : (typeOverride ?? (part.allow_send_parts && part.paint_price > 0 ? 'send' : 'new'))
      const style = styleId ? partStyles.find((s) => s.id === styleId) : null
      const paintPrice = style ? style.price : part.paint_price
      const basePrice = type === 'new' ? part.part_cost + paintPrice : paintPrice
      next.set(part.id, {
        id: part.id, name: part.name, type, price: basePrice + optionsTotal,
        group_id: part.group_id, group_name: gName, highlight_color: part.highlight_color,
        paint_style_id: styleId,
        paint_style_name: styleId ? partStyles.find((s) => s.id === styleId)?.name ?? null : null,
        selected_options: selectedOptions,
        ship_size: part.ship_size,
        lead_time_days: part.lead_time_days,
      })
      return next
    })
    setDetailPart(null)
  }

  const handleSwapType = (partId: string) => {
    setSelectedParts((prev) => {
      const next = new Map(prev)
      const existing = next.get(partId)
      if (!existing) return prev
      const part = parts.find((p) => p.id === partId)
      if (!part || !part.allow_send_parts) return prev
      const newType = existing.type === 'new' ? 'send' : 'new'
      if (newType === 'new' && existing.group_id && Array.from(prev.values())
        .some((p) => p.id !== partId && p.group_id === existing.group_id && p.type === 'new')) return prev
      const partStyles = paintStyles.filter((s) => s.part_id === partId)
      const style = existing.paint_style_id ? partStyles.find((s) => s.id === existing.paint_style_id) : null
      const paintPrice = style ? style.price : part.paint_price
      const newPrice = newType === 'new' ? part.part_cost + paintPrice : paintPrice
      const optionsTotal = (existing.selected_options ?? []).reduce((sum, o) => sum + o.price, 0)
      next.set(partId, { ...existing, type: newType, price: newPrice + optionsTotal })
      return next
    })
  }

  const selectedList = Array.from(selectedParts.values())
  const partsTotal = selectedList.reduce((sum, p) => sum + p.price, 0)

  const shippingTotal = useMemo(() => {
    if (fulfillmentMode !== 'mail') return 0
    const groupIds = new Set(selectedList.filter((p) => p.group_id).map((p) => p.group_id))
    let total = 0
    for (const gid of groupIds) {
      const groupParts = selectedList.filter((p) => p.group_id === gid)
      const largest = groupParts.reduce((max, p) => shipSizeRank(p.ship_size ?? 'medium') > shipSizeRank(max.ship_size ?? 'medium') ? p : max, groupParts[0])
      total += shippingRates[largest.ship_size ?? 'medium'] ?? 0
    }
    for (const p of selectedList.filter((p) => !p.group_id)) {
      total += shippingRates[p.ship_size ?? 'medium'] ?? 0
    }
    return total
  }, [selectedList, fulfillmentMode, shippingRates])

  const grandTotal = partsTotal + shippingTotal
  const leadTimeDays = estimateLeadTimeDays(selectedList.map((p) => p.lead_time_days ?? 0), leadMultiplier)

  const handleSubmit = async () => {
    if (!shopId || !selectedVehicle || selectedParts.size === 0) return
    setSubmitting(true)
    setError(null)

    const { error: insertError } = await supabase.from('leads').insert({
      shop_id: shopId,
      customer_name: customerName.trim(),
      customer_email: customerEmail.trim(),
      customer_phone: customerPhone.trim() || null,
      customer_state: customerState || null,
      customer_address: customerAddress.trim() || null,
      paint_code: paintCode.trim() || null,
      target_start_date: targetStartDate || null,
      vehicle_id: selectedVehicle.id,
      vehicle_name: selectedVehicle.name,
      fulfillment_mode: fulfillmentMode,
      selected_parts: selectedList,
      parts_total: partsTotal,
      shipping_total: shippingTotal,
      grand_total: grandTotal,
      estimated_lead_time_days: leadTimeDays,
      status: 'new',
    })

    if (insertError) {
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

  if (!shop) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-lg font-medium">Shop not found</p>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 px-4">
        <div className="bg-obsidian-900/60 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-3xl p-10 max-w-md mx-auto text-center shadow-glass-card relative overflow-hidden animate-scale-in">
          <div className="pointer-events-none absolute -top-16 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-emerald-500/10 blur-3xl" />
          <div className="relative">
            <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-6 shadow-[0_0_30px_rgba(16,185,129,0.2)] animate-check-pop">
              <CheckCircle2 size={32} />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2 tracking-tight">Quote Submitted!</h1>
            <p className="text-sm text-slate-400 mb-6 leading-relaxed">
              Thank you, {customerName.split(' ')[0]}! Your request is on its way to {shop.name}. Keep an eye on your inbox for their pricing.
            </p>
            <div className="bg-obsidian-950/60 border border-white/10 rounded-2xl p-4 text-left space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-cobalt-600/15 flex items-center justify-center flex-shrink-0">
                  <Mail size={16} className="text-cobalt-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">Confirmation sent to</p>
                  <p className="text-sm font-medium text-slate-100 truncate">{customerEmail}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
                  <Clock size={16} className="text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">Estimated response</p>
                  <p className="text-sm font-medium text-slate-100">Shop usually responds in &lt; 24 hours</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!entered) {
    return (
      <div className="dark-surface bg-obsidian-950 text-slate-100 min-h-screen relative overflow-hidden bg-radial-spotlight flex flex-col">
        <header className="border-b border-white/10 px-6 py-4 relative z-10">
          <div className="max-w-5xl mx-auto flex items-center gap-3">
            {shop.logo_url ? (
              <img src={shop.logo_url} alt={shop.name} className="h-8 w-auto rounded" />
            ) : (
              <div className="w-8 h-8 bg-cobalt-600 rounded-lg flex items-center justify-center">
                <Shield size={18} className="text-white" />
              </div>
            )}
            <div>
              <h1 className="text-sm font-bold text-slate-100">{shop.name}</h1>
              <p className="text-xs text-slate-500">Build your custom quote</p>
            </div>
          </div>
        </header>

        <div className="flex-1 flex items-center justify-center px-4 py-10 relative z-10">
          <form
            onSubmit={(e) => { e.preventDefault(); if (customerEmail.trim()) setEntered(true) }}
            className="w-full max-w-md bg-obsidian-900/60 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card p-8 animate-scale-in"
          >
            {shop.logo_url ? (
              <img src={shop.logo_url} alt={shop.name} className="h-20 w-auto max-w-[240px] object-contain mb-5 mx-auto" />
            ) : (
              <h1 className="text-lg font-bold mb-4 text-center text-slate-100">{shop.name}</h1>
            )}
            <h2 className="text-xl font-bold mb-1 text-white">Let's build your quote</h2>
            <p className="text-sm text-slate-400 mb-6">
              Enter your email and paint code to get started. We'll use these to prepare an accurate estimate.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Email *</label>
                <div className="relative">
                  <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    type="email" required value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
                    placeholder="you@email.com"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-widest mb-2">Paint Code</label>
                <div className="relative">
                  <Hash size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                  <input
                    type="text" value={paintCode}
                    onChange={(e) => setPaintCode(e.target.value)}
                    className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
                    placeholder="e.g. GAZ / Summit White"
                  />
                </div>
                <p className="text-xs text-slate-600 mt-1.5">Usually found on a sticker in the driver's door jamb.</p>
              </div>
            </div>

            <button
              type="submit"
              disabled={!customerEmail.trim()}
              className="w-full mt-6 bg-metallic-gradient text-white font-semibold text-sm rounded-xl py-3.5 shadow-glow-blue hover:brightness-110 active:scale-[0.99] disabled:opacity-60 disabled:hover:brightness-100 transition-all flex items-center justify-center gap-2 tracking-wide"
            >
              Start Building
              <ArrowRight size={16} />
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (customMode) {
    return (
      <CustomBuildFlow
        shop={shop}
        shopId={shopId!}
        initialEmail={customerEmail}
        initialPaintCode={paintCode}
        onBack={() => setCustomMode(false)}
      />
    )
  }

  return (
    <div className="dark-surface bg-obsidian-950 text-slate-100 min-h-screen relative overflow-hidden bg-radial-spotlight">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4 sticky top-0 z-20 bg-obsidian-950/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {shop.logo_url ? (
              <img src={shop.logo_url} alt={shop.name} className="h-8 w-auto rounded" />
            ) : (
              <div className="w-8 h-8 bg-cobalt-600 rounded-lg flex items-center justify-center">
                <Shield size={18} className="text-white" />
              </div>
            )}
            <div>
              <h1 className="text-sm font-bold text-slate-100">{shop.name}</h1>
              <p className="text-xs text-slate-500">Build your custom quote</p>
            </div>
          </div>
          {selectedParts.size > 0 && (
            <button
              onClick={() => setShowCheckout(true)}
              className="flex items-center gap-2 bg-metallic-gradient text-white text-sm font-semibold rounded-xl px-4 py-2 shadow-glow-blue hover:brightness-110 transition-all"
            >
              {selectedParts.size} {selectedParts.size === 1 ? 'part' : 'parts'} · {formatCurrency(grandTotal)}
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6 relative z-10">
        {/* Vehicle selection */}
        {!selectedVehicle ? (
          <>
            <h2 className="text-xl font-bold mb-1 text-white">Choose Your Vehicle</h2>
            <p className="text-sm text-slate-400 mb-6">Select a vehicle to start customizing</p>
            {vehicles.length === 0 ? (
              <div className="text-center py-12 mb-6">
                <Car size={40} className="mx-auto text-slate-700 mb-3" />
                <p className="text-slate-400 font-medium">No preset vehicles available yet</p>
                <p className="text-sm text-slate-500 mt-1">No problem — you can build a quote from photos of your own truck below.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {vehicles.map((vehicle) => (
                  <button
                    key={vehicle.id}
                    onClick={() => selectVehicle(vehicle)}
                    className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card overflow-hidden hover:border-cobalt-500/50 transition-all text-left group"
                  >
                    <div className="h-40 bg-obsidian-950/80 relative overflow-hidden">
                      {vehicle.front_image_path ? (
                        <img
                          src={getImageUrl(vehicle.front_image_path)!}
                          alt={vehicle.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Car size={32} className="text-slate-700" />
                        </div>
                      )}
                    </div>
                    <div className="p-4">
                      <h3 className="font-semibold text-slate-100">{vehicle.name}</h3>
                      <p className="text-xs text-slate-500 mt-1">Click to customize</p>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={() => setCustomMode(true)}
              className={`w-full text-left rounded-2xl border transition-all flex items-center gap-4 p-4 group ${
                vehicles.length === 0
                  ? 'bg-cobalt-600/10 border-cobalt-500/50 hover:border-cobalt-500'
                  : 'bg-obsidian-900/60 backdrop-blur-xl border-white/10 hover:border-cobalt-500/50 mt-4'
              }`}
            >
              <div className="w-12 h-12 rounded-xl bg-cobalt-600/20 flex items-center justify-center flex-shrink-0">
                <PencilRuler size={22} className="text-cobalt-400" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-slate-100">Don't see your truck? Build from your own photos</h3>
                <p className="text-sm text-slate-400 mt-0.5">
                  Upload photos of your vehicle, mark the parts you want done, and request a custom quote.
                </p>
              </div>
              <ArrowRight size={18} className="text-slate-500 group-hover:text-cobalt-400 transition-colors flex-shrink-0" />
            </button>
          </>
        ) : (
          <>
            {/* Back to vehicle list */}
            <button
              onClick={() => { setSelectedVehicle(null); setSelectedParts(new Map()) }}
              className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 mb-4 transition-colors"
            >
              <ArrowLeft size={16} />
              Choose different vehicle
            </button>

            <h2 className="text-xl font-bold mb-1 text-white">{selectedVehicle.name}</h2>
            <p className="text-sm text-slate-400 mb-4">Tap a part to add it to your build. Pinch or use the zoom buttons to get in close, then drag to move around.</p>

            {/* View toggle */}
            <div className="inline-flex bg-obsidian-900/80 p-1.5 rounded-xl border border-white/10 shadow-inner gap-1 mb-4">
              {(['front', 'rear'] as const).map((v) => {
                const hasImage = v === 'front' ? !!frontUrl : !!rearUrl
                if (!hasImage) return null
                return (
                  <button
                    key={v}
                    onClick={() => setActiveView(v)}
                    className={`capitalize px-4 py-2 rounded-lg text-xs tracking-wide transition-all ${
                      activeView === v ? 'bg-cobalt-600 text-white font-semibold shadow-glow-blue' : 'text-slate-400 hover:text-slate-200 font-medium'
                    }`}
                  >
                    {v} View
                  </button>
                )
              })}
            </div>

            {/* Vehicle image with SVG overlay */}
            {currentImageUrl ? (
              <div className="relative rounded-3xl bg-gradient-to-b from-white to-slate-200 p-6 shadow-2xl border border-white/20 overflow-hidden mb-6">
                <div className="pointer-events-none absolute inset-x-10 bottom-5 h-20 rounded-[50%] bg-black/40 blur-2xl" />
                <div
                  ref={viewportRef}
                  className="relative rounded-2xl overflow-hidden touch-none select-none"
                  style={{ cursor: panMode || zoom > 1 ? 'grab' : 'default' }}
                  onPointerDown={onViewportPointerDown}
                  onPointerMove={onViewportPointerMove}
                  onPointerUp={onViewportPointerUp}
                  onPointerLeave={onViewportPointerUp}
                  onPointerCancel={onViewportPointerUp}
                >
                <div
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: pointers.current.size > 0 ? 'none' : 'transform 0.15s ease-out',
                  }}
                >
                <img src={currentImageUrl} alt={`${activeView} view`} className="w-full h-auto block" draggable={false} />
                <svg
                  ref={svgRef}
                  className="absolute inset-0 w-full h-full"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  onClick={(e) => {
                    if (movedRef.current || panMode) return
                    const id = svgRef.current && pickPartAtPoint(svgRef.current, e.clientX, e.clientY)
                    const part = id ? partsForView.find((p) => p.id === id) : null
                    if (part) handlePartClick(part)
                  }}
                  onMouseMove={(e) => {
                    const id = svgRef.current ? pickPartAtPoint(svgRef.current, e.clientX, e.clientY) : null
                    setHoveredPartId(id)
                  }}
                  onMouseLeave={() => setHoveredPartId(null)}
                >
                  {partsForView.map((part) => {
                    const selected = selectedParts.get(part.id)
                    const hovered = hoveredPartId === part.id
                    const color = getHighlightColor(part.highlight_color)
                    return (
                      <g key={part.id}>
                        <path
                          data-part-id={part.id}
                          d={part.svg_path}
                          fill={selected ? color.fill : hovered ? 'rgba(59, 130, 246, 0.2)' : 'transparent'}
                          stroke={selected ? color.stroke : hovered ? 'rgb(96, 165, 250)' : 'transparent'}
                          strokeWidth="0.4"
                          vectorEffect="non-scaling-stroke"
                          className="cursor-pointer transition-colors"
                        />
                      </g>
                    )
                  })}
                </svg>
                </div>
                </div>

                {/* Zoom & pan controls */}
                <div className="absolute bottom-3 right-3 bg-obsidian-900/80 backdrop-blur-md border border-white/10 rounded-xl p-1.5 flex items-center gap-1 shadow-lg z-20">
                  <button
                    type="button"
                    onClick={() => applyZoom(zoom - 0.5)}
                    disabled={zoom <= 1}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Zoom out"
                  >
                    <Minus size={16} />
                  </button>
                  <span className="min-w-[3rem] text-center text-xs font-semibold text-slate-300 tabular-nums px-1">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => applyZoom(zoom + 0.5)}
                    disabled={zoom >= 5}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Zoom in"
                  >
                    <Plus size={16} />
                  </button>
                  <span className="w-px h-5 bg-white/10 mx-0.5" />
                  <button
                    type="button"
                    onClick={() => setPanMode((v) => !v)}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                      panMode ? 'bg-cobalt-600 text-white' : 'text-slate-200 hover:bg-white/10'
                    }`}
                    aria-label={panMode ? 'Switch to select mode' : 'Switch to pan mode'}
                    title={panMode ? 'Pan mode on \u2014 tap to select parts' : 'Pan mode off \u2014 tap parts to select'}
                  >
                    <Hand size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={resetView}
                    disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Reset view"
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-12 text-center mb-6">
                <Car size={32} className="mx-auto text-slate-700 mb-2" />
                <p className="text-sm text-slate-400">No {activeView} image available</p>
              </div>
            )}

            {/* Legend */}
            <div className="flex items-center gap-4 mb-4 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-blue-500/30 border border-blue-500/60"></span>
                Available
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-emerald-500/30 border border-emerald-500/90"></span>
                Selected
              </span>
            </div>

            {/* Selected parts list */}
            {selectedList.length > 0 && (
              <div className="bg-obsidian-900/60 backdrop-blur-xl border border-white/10 rounded-2xl p-6 shadow-glass-card mt-6 mb-4">
                <h3 className="text-sm font-semibold mb-3 text-slate-100">Your Build ({selectedList.length} {selectedList.length === 1 ? 'part' : 'parts'})</h3>
                <div className="space-y-4">
                  {(() => {
                    const allGroupIds = Array.from(new Set(selectedList.filter((p) => p.group_id).map((p) => p.group_id)))
                    const groupIsBuyNew = (gid: string | null | undefined) => selectedList.some((p) => p.group_id === gid && p.type === 'new')

                    const renderGroup = (gid: string | null | undefined) => {
                      const groupParts = selectedList.filter((p) => p.group_id === gid)
                      const gName = groupParts[0]?.group_name ?? 'Group'
                      return (
                        <div key={gid} className="border border-white/10 rounded-lg overflow-hidden">
                          <div className="bg-white/5 px-3 py-1.5 flex items-center gap-2">
                            <Layers size={12} className="text-slate-400" />
                            <span className="text-xs font-semibold text-slate-300">{gName}</span>
                          </div>
                          <div className="p-2 space-y-1.5">
                            {groupParts.map((part, idx) => {
                              const fullPart = parts.find((p) => p.id === part.id)
                              const first = idx === 0
                              return (
                                <div key={part.id} className="flex items-center justify-between bg-obsidian-950/60 border border-white/5 rounded-xl p-4">
                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`}></span>
                                    <span className="text-sm font-medium truncate text-slate-100">{part.name}</span>
                                    {first && fullPart?.allow_send_parts ? (
                                      <button
                                        onClick={() => handleSwapType(part.id)}
                                        className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                                          part.type === 'new' ? 'bg-blue-500/15 text-blue-300' : 'bg-emerald-500/15 text-emerald-300'
                                        }`}
                                      >
                                        {part.type === 'new' ? 'Buy New' : 'Paint Mine'}
                                      </button>
                                    ) : (
                                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/15 text-amber-300">
                                        Paint only
                                      </span>
                                    )}
                                    {!first && (
                                      <span className="text-xs text-slate-500 italic">already purchased</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    <span className="text-sm font-medium text-slate-200">{formatCurrency(part.price)}</span>
                                    <button
                                      onClick={() => handlePartClick(fullPart!)}
                                      className="text-slate-500 hover:text-red-400 transition-colors"
                                    >
                                      <span className="text-xs">Remove</span>
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    }

                    const renderUngrouped = (part: SelectedPart) => {
                      const fullPart = parts.find((p) => p.id === part.id)
                      return (
                        <div key={part.id} className="flex items-center justify-between bg-obsidian-950/60 border border-white/5 rounded-xl p-4">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`}></span>
                            <span className="text-sm font-medium truncate text-slate-100">{part.name}</span>
                            {fullPart?.allow_send_parts && (
                              <button
                                onClick={() => handleSwapType(part.id)}
                                className="text-xs px-3 py-1 rounded-full font-medium bg-cobalt-500/10 text-cobalt-400 border border-cobalt-500/30 hover:bg-cobalt-500/20 transition-colors"
                              >
                                Switch to {part.type === 'new' ? 'Paint Mine' : 'Buy New'}
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span className="text-sm font-medium text-slate-200">{formatCurrency(part.price)}</span>
                            <button
                              onClick={() => handlePartClick(fullPart!)}
                              className="text-slate-500 hover:text-red-400 transition-colors"
                            >
                              <span className="text-xs">Remove</span>
                            </button>
                          </div>
                        </div>
                      )
                    }

                    const buyNewGroups = allGroupIds.filter((gid) => groupIsBuyNew(gid))
                    const paintGroups = allGroupIds.filter((gid) => !groupIsBuyNew(gid))
                    const buyNewParts = selectedList.filter((p) => !p.group_id && p.type === 'new')
                    const paintParts = selectedList.filter((p) => !p.group_id && p.type === 'send')

                    const buyNewCount = buyNewParts.length + buyNewGroups.reduce((n, gid) => n + selectedList.filter((p) => p.group_id === gid).length, 0)
                    const paintCount = paintParts.length + paintGroups.reduce((n, gid) => n + selectedList.filter((p) => p.group_id === gid).length, 0)

                    return (
                      <>
                        {buyNewCount > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold uppercase tracking-wider text-blue-400">Buy New</span>
                              <span className="text-xs text-slate-500">({buyNewCount})</span>
                            </div>
                            {buyNewGroups.map((gid) => renderGroup(gid))}
                            {buyNewParts.map((part) => renderUngrouped(part))}
                          </div>
                        )}
                        {paintCount > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">Paint Mine</span>
                              <span className="text-xs text-slate-500">({paintCount})</span>
                            </div>
                            {paintGroups.map((gid) => renderGroup(gid))}
                            {paintParts.map((part) => renderUngrouped(part))}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
                <div className="flex items-center justify-between pt-3 mt-3 border-t border-white/10">
                  <span className="text-sm text-slate-400">Parts Total</span>
                  <span className="text-sm font-medium text-slate-200">{formatCurrency(partsTotal)}</span>
                </div>
                {fulfillmentMode === 'mail' && shippingTotal > 0 && (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-sm text-slate-400">Est. Shipping</span>
                    <span className="text-sm font-medium text-slate-200">{formatCurrency(shippingTotal)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between pt-2 mt-2 border-t border-white/10">
                  <span className="text-sm text-slate-400">Total</span>
                  <span className="text-lg font-bold text-white">{formatCurrency(grandTotal)}</span>
                </div>
                {leadTimeDays > 0 && (
                  <div className="flex items-center gap-2 mt-3 rounded-lg bg-white/5 border border-white/10 px-3 py-2">
                    <Clock size={15} className="text-cobalt-400 flex-shrink-0" />
                    <span className="text-xs text-slate-300">
                      Estimated lead time: <span className="font-semibold text-white">{leadTimeDays} {leadTimeDays === 1 ? 'day' : 'days'}</span>
                    </span>
                  </div>
                )}
                <button
                  onClick={() => setShowCheckout(true)}
                  className="w-full mt-4 bg-metallic-gradient text-white font-bold text-sm tracking-wide rounded-xl py-4 shadow-glow-blue shadow-lg hover:brightness-110 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
                >
                  Submit Quote Request
                  <ArrowRight size={16} />
                </button>
              </div>
            )}

            {/* Available parts hint */}
            {partsForView.length > 0 && selectedList.length === 0 && (
              <p className="text-sm text-slate-500 text-center">
                {partsForView.length} parts available on this view — click the highlighted areas on the image to add them.
              </p>
            )}
          </>
        )}
      </div>

      {/* Part detail modal */}
      {detailPart && (() => {
        const groupBoughtNew = !!detailPart.group_id && Array.from(selectedParts.values())
          .some((p) => p.group_id === detailPart.group_id && p.type === 'new')
        return (
          <PartDetailModal
            parts={[detailPart]}
            allPaintStyles={paintStyles}
            allPartOptions={partOptions}
            imageUrl={getImageUrl}
            allowTypeChoice={detailPart.allow_send_parts && detailPart.paint_price > 0 && !groupBoughtNew}
            paintOnlyReason={groupBoughtNew ? 'You already chose to buy a new part in this set, so this part only needs the paint fee.' : null}
            onConfirm={(selections) => {
              selections.forEach((sel) => {
                addPartToSelection(detailPart, sel.styleId, sel.optionIds, sel.type)
              })
            }}
            onClose={() => setDetailPart(null)}
          />
        )
      })()}

      {/* Checkout modal */}
      {showCheckout && (
        <CheckoutModal
          shop={shop}
          selectedParts={selectedList}
          partsTotal={partsTotal}
          shippingTotal={shippingTotal}
          total={grandTotal}
          leadTimeDays={leadTimeDays}
          customerName={customerName}
          customerEmail={customerEmail}
          customerPhone={customerPhone}
          customerState={customerState}
          customerAddress={customerAddress}
          paintCode={paintCode}
          targetStartDate={targetStartDate}
          fulfillmentMode={fulfillmentMode}
          onNameChange={setCustomerName}
          onEmailChange={setCustomerEmail}
          onPhoneChange={setCustomerPhone}
          onStateChange={setCustomerState}
          onAddressChange={setCustomerAddress}
          onTargetStartDateChange={setTargetStartDate}
          onFulfillmentChange={setFulfillmentMode}
          onSubmit={handleSubmit}
          onClose={() => setShowCheckout(false)}
          submitting={submitting}
          error={error}
        />
      )}
    </div>
  )
}

type PartSelection = {
  partId: string
  styleId: string | null
  optionIds: string[]
  type: 'new' | 'send'
}

type PartConfigState = {
  styleId: string | null
  optionIds: Set<string>
  type: 'new' | 'send'
}

function PartDetailModal({
  parts, allPaintStyles, allPartOptions, imageUrl, onConfirm, onClose, allowTypeChoice, paintOnlyReason
}: {
  parts: VehiclePart[]
  allPaintStyles: PartPaintStyle[]
  allPartOptions: PartOption[]
  imageUrl: (path: string | null) => string | null
  onConfirm: (selections: PartSelection[]) => void
  onClose: () => void
  allowTypeChoice: boolean
  paintOnlyReason?: string | null
}) {
  const [configs, setConfigs] = useState<Record<string, PartConfigState>>(() => {
    const initial: Record<string, PartConfigState> = {}
    parts.forEach((part) => {
      const partStyles = allPaintStyles.filter((s) => s.part_id === part.id)
      initial[part.id] = {
        styleId: partStyles.length > 0 ? partStyles[0].id : null,
        optionIds: new Set(),
        type: paintOnlyReason
          ? 'send'
          : allowTypeChoice
            ? (part.allow_send_parts && part.paint_price > 0 ? 'send' : 'new')
            : 'new',
      }
    })
    return initial
  })

  const partTotals = parts.map((part) => {
    const cfg = configs[part.id]
    const partStyles = allPaintStyles.filter((s) => s.part_id === part.id)
    const stylePrice = cfg?.styleId ? partStyles.find((s) => s.id === cfg.styleId)?.price ?? part.paint_price : part.paint_price
    const partOpts = allPartOptions.filter((o) => o.part_id === part.id)
    const optionsTotal = Array.from(cfg?.optionIds ?? []).reduce((sum, oid) => {
      const opt = partOpts.find((o) => o.id === oid)
      return sum + (opt?.price ?? 0)
    }, 0)
    const paintTotal = cfg?.type === 'new' ? part.part_cost + stylePrice : stylePrice
    return { part, total: paintTotal + optionsTotal }
  })

  const grandPartTotal = partTotals.reduce((sum, pt) => sum + pt.total, 0)

  const updateConfig = (partId: string, patch: Partial<PartConfigState>) => {
    setConfigs((prev) => ({ ...prev, [partId]: { ...prev[partId], ...patch } }))
  }

  const toggleOption = (partId: string, optionId: string) => {
    setConfigs((prev) => {
      const cfg = prev[partId]
      const next = new Set(cfg.optionIds)
      if (next.has(optionId)) next.delete(optionId)
      else next.add(optionId)
      return { ...prev, [partId]: { ...cfg, optionIds: next } }
    })
  }

  const handleConfirm = () => {
    const selections: PartSelection[] = parts.map((part) => {
      const cfg = configs[part.id]
      return {
        partId: part.id,
        styleId: cfg.styleId,
        optionIds: Array.from(cfg.optionIds),
        type: cfg.type,
      }
    })
    onConfirm(selections)
  }

  const title = parts.length > 1
    ? (parts[0].group_id ? allPaintStyles[0]?.name ?? parts[0].name : parts[0].name)
    : parts[0].name

  return (
    <div className="dark-surface fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-obsidian-900/80 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card w-full max-w-lg max-h-[90vh] overflow-y-auto animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Palette size={18} className="text-cobalt-400" />
            {parts.length > 1 ? `${parts.length} parts selected` : parts[0].name}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-5">
          {parts.map((part, partIdx) => {
            const cfg = configs[part.id]
            const partStyles = allPaintStyles.filter((s) => s.part_id === part.id)
            const partOpts = allPartOptions.filter((o) => o.part_id === part.id)
            const stylePrice = cfg?.styleId ? partStyles.find((s) => s.id === cfg.styleId)?.price ?? part.paint_price : part.paint_price
            const isFirst = partIdx === 0
            return (
              <div key={part.id} className={parts.length > 1 ? 'border border-white/10 rounded-xl p-4 space-y-4' : 'space-y-4'}>
                {parts.length > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-white">{part.name}</span>
                    {!isFirst && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-900/40 text-amber-400">
                        Paint only
                      </span>
                    )}
                  </div>
                )}

                {partStyles.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Choose Paint Style</label>
                    <div className="grid grid-cols-2 gap-3">
                      {partStyles.map((style) => (
                        <button
                          key={style.id}
                          onClick={() => updateConfig(part.id, { styleId: style.id })}
                          className={`text-left rounded-xl border overflow-hidden transition-all ${
                            cfg?.styleId === style.id
                              ? 'border-cobalt-500 ring-1 ring-cobalt-500'
                              : 'border-white/10 hover:border-white/20'
                          }`}
                        >
                          {style.image_path ? (
                            <img src={imageUrl(style.image_path)!} alt={style.name} className="w-full h-24 object-cover" />
                          ) : (
                            <div className="w-full h-24 bg-obsidian-950/80 flex items-center justify-center">
                              <Palette size={20} className="text-slate-600" />
                            </div>
                          )}
                          <div className="p-2">
                            <p className="text-sm font-medium text-white truncate">{style.name}</p>
                            <p className="text-xs text-slate-400">{formatCurrency(style.price)}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {isFirst && !allowTypeChoice && paintOnlyReason && (
                  <div className="rounded-lg border border-amber-900/40 bg-amber-900/20 p-3">
                    <p className="text-xs font-semibold text-amber-400 mb-1">Paint fee only</p>
                    <p className="text-xs text-amber-200/80">{paintOnlyReason}</p>
                  </div>
                )}

                {isFirst && allowTypeChoice && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Buy New or Paint Mine?</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => updateConfig(part.id, { type: 'new' })}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                          cfg?.type === 'new' ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-950/80 border border-white/10 text-slate-400'
                        }`}
                      >
                        Buy New
                        <span className="block text-xs font-normal opacity-80 mt-0.5">{formatCurrency(part.part_cost + stylePrice)}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => updateConfig(part.id, { type: 'send' })}
                        className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                          cfg?.type === 'send' ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-950/80 border border-white/10 text-slate-400'
                        }`}
                      >
                        Paint Mine
                        <span className="block text-xs font-normal opacity-80 mt-0.5">{formatCurrency(stylePrice)}</span>
                      </button>
                    </div>
                  </div>
                )}

                {partOpts.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Add-On Options</label>
                    <div className="space-y-2">
                      {partOpts.map((option) => {
                        const checked = cfg?.optionIds.has(option.id) ?? false
                        return (
                          <button
                            key={option.id}
                            onClick={() => toggleOption(part.id, option.id)}
                            className={`w-full flex items-start gap-3 rounded-lg border p-3 transition-all text-left ${
                              checked
                                ? 'border-cobalt-500 bg-cobalt-600/10'
                                : 'border-white/10 hover:border-white/20'
                            }`}
                          >
                            <div className={`w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 mt-0.5 ${
                              checked ? 'bg-cobalt-600 border-cobalt-600' : 'border-slate-600'
                            }`}>
                              {checked && <Check size={12} className="text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-white">{option.name}</p>
                                <p className="text-sm text-slate-400">+{formatCurrency(option.price)}</p>
                              </div>
                              {option.description && (
                                <p className="text-xs text-slate-500 mt-0.5">{option.description}</p>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          <div className="flex items-center justify-between pt-3 border-t border-white/10">
            <div>
              <p className="text-xs text-slate-500">Total for {parts.length > 1 ? `${parts.length} parts` : 'this part'}</p>
              <p className="text-xl font-bold text-white">{formatCurrency(grandPartTotal)}</p>
            </div>
            <button
              onClick={handleConfirm}
              className="bg-metallic-gradient text-white font-semibold text-sm rounded-xl px-5 py-2.5 shadow-glow-blue hover:brightness-110 transition-all flex items-center gap-2"
            >
              <Plus size={16} />
              Add to Build
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CheckoutModal({
  shop, selectedParts, partsTotal, shippingTotal, total, leadTimeDays,
  customerName, customerEmail, customerPhone, customerState, customerAddress, paintCode, targetStartDate, fulfillmentMode,
  onNameChange, onEmailChange, onPhoneChange, onStateChange, onAddressChange, onTargetStartDateChange, onFulfillmentChange,
  onSubmit, onClose, submitting, error,
}: {
  shop: Shop
  selectedParts: SelectedPart[]
  partsTotal: number
  shippingTotal: number
  total: number
  leadTimeDays: number
  customerName: string
  customerEmail: string
  customerPhone: string
  customerState: string
  customerAddress: string
  paintCode: string
  targetStartDate: string
  fulfillmentMode: 'local' | 'mail'
  onNameChange: (v: string) => void
  onEmailChange: (v: string) => void
  onPhoneChange: (v: string) => void
  onStateChange: (v: string) => void
  onAddressChange: (v: string) => void
  onTargetStartDateChange: (v: string) => void
  onFulfillmentChange: (v: 'local' | 'mail') => void
  onSubmit: () => void
  onClose: () => void
  submitting: boolean
  error: string | null
}) {
  return (
    <div className="dark-surface fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4" onClick={onClose}>
      <div className="bg-obsidian-900/90 backdrop-blur-2xl border border-white/10 border-t-white/20 rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 relative animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">Submit Quote Request</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors">
            <span className="text-xl">✕</span>
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg px-3 py-2 mb-4">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Summary */}
        <div className="bg-white/5 border border-white/10 rounded-xl p-3 mb-4">
          <p className="text-xs text-slate-500 mb-2">Build Summary</p>
          {(() => {
            const groupIsBuyNew = (gid: string | null | undefined) => selectedParts.some((p) => p.group_id === gid && p.type === 'new')

            const renderGroup = (gid: string | null | undefined) => {
              const groupParts = selectedParts.filter((p) => p.group_id === gid)
              const gName = groupParts[0]?.group_name ?? 'Group'
              return (
                <div key={gid} className="py-1">
                  <p className="text-xs font-semibold text-slate-400 mb-1">{gName}</p>
                  {groupParts.map((part, idx) => (
                    <div key={part.id} className="py-0.5">
                      <div className="flex justify-between text-sm ml-2">
                        <span className="text-slate-300">
                          {part.name}
                          <span className="text-slate-500"> ({idx === 0 ? (part.type === 'new' ? 'Buy New' : 'Paint Mine') : 'Paint only'})</span>
                        </span>
                        <span className="text-slate-300">{formatCurrency(part.price)}</span>
                      </div>
                      {part.paint_style_name && (
                        <p className="text-xs text-slate-500 ml-4">Style: {part.paint_style_name}</p>
                      )}
                      {part.selected_options && part.selected_options.length > 0 && (
                        <ul className="text-xs text-slate-500 ml-4">
                          {part.selected_options.map((opt) => (
                            <li key={opt.id}>+ {opt.name} (+{formatCurrency(opt.price)})</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )
            }

            const renderUngrouped = (part: SelectedPart) => (
              <div key={part.id} className="py-0.5">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-300">{part.name}</span>
                  <span className="text-slate-300">{formatCurrency(part.price)}</span>
                </div>
                {part.paint_style_name && (
                  <p className="text-xs text-slate-500 ml-4">Style: {part.paint_style_name}</p>
                )}
                {part.selected_options && part.selected_options.length > 0 && (
                  <ul className="text-xs text-slate-500 ml-4">
                    {part.selected_options.map((opt) => (
                      <li key={opt.id}>+ {opt.name} (+{formatCurrency(opt.price)})</li>
                    ))}
                  </ul>
                )}
              </div>
            )

            const allGroupIds = Array.from(new Set(selectedParts.filter((p) => p.group_id).map((p) => p.group_id)))
            const buyNewGroups = allGroupIds.filter((gid) => groupIsBuyNew(gid))
            const paintGroups = allGroupIds.filter((gid) => !groupIsBuyNew(gid))
            const buyNewParts = selectedParts.filter((p) => !p.group_id && p.type === 'new')
            const paintParts = selectedParts.filter((p) => !p.group_id && p.type === 'send')

            const hasBuyNew = buyNewGroups.length > 0 || buyNewParts.length > 0
            const hasPaint = paintGroups.length > 0 || paintParts.length > 0

            return (
              <>
                {hasBuyNew && (
                  <div className="pb-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-blue-400 mb-1">Buy New</p>
                    {buyNewGroups.map((gid) => renderGroup(gid))}
                    {buyNewParts.map((part) => renderUngrouped(part))}
                  </div>
                )}
                {hasPaint && (
                  <div className="pt-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-1">Paint Mine</p>
                    {paintGroups.map((gid) => renderGroup(gid))}
                    {paintParts.map((part) => renderUngrouped(part))}
                  </div>
                )}
              </>
            )
          })()}
          <div className="flex justify-between font-bold pt-2 mt-1 border-t border-white/10">
            <span className="text-white">Parts Total</span>
            <span className="text-white">{formatCurrency(partsTotal)}</span>
          </div>
          {fulfillmentMode === 'mail' && shippingTotal > 0 && (
            <div className="flex justify-between text-sm pt-2">
              <span className="text-slate-400">Est. Shipping</span>
              <span className="text-slate-300">{formatCurrency(shippingTotal)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold pt-2 mt-1 border-t border-white/10">
            <span className="text-white">Total</span>
            <span className="text-white">{formatCurrency(total)}</span>
          </div>
          {leadTimeDays > 0 && (
            <div className="flex items-center gap-2 pt-2 text-sm">
              <Clock size={14} className="text-cobalt-400 flex-shrink-0" />
              <span className="text-slate-400">Estimated lead time:</span>
              <span className="text-slate-200 font-medium">{leadTimeDays} {leadTimeDays === 1 ? 'day' : 'days'}</span>
            </div>
          )}
        </div>

        {/* Form */}
        <div className="space-y-3">
          {paintCode.trim() && (
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <Hash size={14} className="text-cobalt-400 flex-shrink-0" />
              <span className="text-xs text-slate-400">Paint code:</span>
              <span className="text-xs font-medium text-slate-200">{paintCode}</span>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Full Name *</label>
            <div className="relative">
              <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" value={customerName} onChange={(e) => onNameChange(e.target.value)} required
                className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
                placeholder="John Smith" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Email *</label>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="email" value={customerEmail} onChange={(e) => onEmailChange(e.target.value)} required
                className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
                placeholder="you@email.com" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Address</label>
            <div className="relative">
              <MapPin size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" value={customerAddress} onChange={(e) => onAddressChange(e.target.value)}
                className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
                placeholder="Street, City, ZIP" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Phone</label>
              <div className="relative">
                <Phone size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input type="tel" value={customerPhone} onChange={(e) => onPhoneChange(e.target.value)}
                  className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
                  placeholder="(555) 123-4567" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">State</label>
              <div className="relative">
                <MapPin size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <select value={customerState} onChange={(e) => onStateChange(e.target.value)}
                  className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all appearance-none cursor-pointer">
                  <option value="">--</option>
                  {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Target Start Date</label>
            <div className="relative">
              <Calendar size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="date" value={targetStartDate} onChange={(e) => onTargetStartDateChange(e.target.value)}
                className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Fulfillment</label>
            <div className="grid grid-cols-2 gap-2 bg-obsidian-950 p-1.5 rounded-xl border border-white/10">
              <button type="button" onClick={() => onFulfillmentChange('local')}
                className={`rounded-lg py-2.5 text-xs transition-all ${
                  fulfillmentMode === 'local' ? 'bg-cobalt-600 text-white font-semibold shadow-glow-blue' : 'text-slate-400 hover:text-slate-200 font-medium'
                }`}>
                Local Drop-off
              </button>
              <button type="button" onClick={() => onFulfillmentChange('mail')}
                className={`rounded-lg py-2.5 text-xs transition-all ${
                  fulfillmentMode === 'mail' ? 'bg-cobalt-600 text-white font-semibold shadow-glow-blue' : 'text-slate-400 hover:text-slate-200 font-medium'
                }`}>
                Mail-Order DIY
              </button>
            </div>
          </div>
          <button
            onClick={onSubmit}
            disabled={submitting || !customerName.trim() || !customerEmail.trim()}
            className="w-full bg-metallic-gradient text-white font-semibold text-sm rounded-xl py-3 shadow-glow-blue hover:brightness-110 active:scale-[0.99] disabled:opacity-50 disabled:hover:brightness-100 transition-all flex items-center justify-center gap-2"
          >
            <Send size={16} />
            {submitting ? 'Submitting…' : `Submit to ${shop.name}`}
          </button>
        </div>
      </div>
    </div>
  )
}
