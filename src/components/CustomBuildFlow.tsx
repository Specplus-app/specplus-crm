import { useState, useRef, useCallback, useEffect } from 'react'
import { supabase, Shop, CustomPartBox } from '../lib/supabase'
import {
  Shield, ArrowLeft, ArrowRight, Upload, X, Plus, Send, User, Mail, Phone, MapPin, Calendar,
  Palette, Image as ImageIcon, AlertCircle, CheckCircle2, Trash2, Pencil, Car, Hash, Minus, RotateCcw,
} from 'lucide-react'

const BUCKET = 'customer-uploads'
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

type CustomItem = {
  id: string
  name: string
  type: 'new' | 'send'
  notes: string
  reference_image_path: string | null
  box: CustomPartBox
}

function publicUrl(path: string | null): string | null {
  if (!path) return null
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

async function uploadImage(shopId: string, file: File): Promise<string | null> {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${shopId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false })
  if (error) return null
  return path
}

export default function CustomBuildFlow({
  shop, shopId, initialEmail, initialPaintCode, onBack,
}: {
  shop: Shop
  shopId: string
  initialEmail: string
  initialPaintCode: string
  onBack: () => void
}) {
  const [frontPath, setFrontPath] = useState<string | null>(null)
  const [rearPath, setRearPath] = useState<string | null>(null)
  const [uploadingView, setUploadingView] = useState<'front' | 'rear' | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'front' | 'rear'>('front')
  const [items, setItems] = useState<CustomItem[]>([])

  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [pendingBox, setPendingBox] = useState<CustomPartBox | null>(null)
  const [editingItem, setEditingItem] = useState<CustomItem | null>(null)
  const [drawMode, setDrawMode] = useState<'box' | 'outline'>('box')
  const [outlinePoints, setOutlinePoints] = useState<{ x: number; y: number }[]>([])
  const drawStart = useRef<{ x: number; y: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null)
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isTracing, setIsTracing] = useState(false)
  const clampZoom = (z: number) => Math.min(5, Math.max(1, z))

  const [showCheckout, setShowCheckout] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [email, setEmail] = useState(initialEmail)
  const [phone, setPhone] = useState('')
  const [state, setState] = useState('')
  const [address, setAddress] = useState('')
  const [paintCode, setPaintCode] = useState(initialPaintCode)
  const [targetStartDate, setTargetStartDate] = useState('')
  const [fulfillmentMode, setFulfillmentMode] = useState<'local' | 'mail'>('local')
  const [vehicleYear, setVehicleYear] = useState('')
  const [vehicleMake, setVehicleMake] = useState('')
  const [vehicleModel, setVehicleModel] = useState('')
  const [vehicleTrim, setVehicleTrim] = useState('')

  const activePath = activeView === 'front' ? frontPath : rearPath
  const activeUrl = publicUrl(activePath)
  const viewItems = items.filter((it) => it.box.view === activeView)

  const clampPan = (x: number, y: number, z: number) => {
    const vp = viewportRef.current
    if (!vp) return { x, y }
    const w = vp.clientWidth
    const h = vp.clientHeight
    return {
      x: Math.max(w - w * z, Math.min(0, x)),
      y: Math.max(h - h * z, Math.min(0, y)),
    }
  }

  const zoomToPoint = (nz: number, clientX: number, clientY: number) => {
    const vp = viewportRef.current
    if (!vp) return
    const rect = vp.getBoundingClientRect()
    const cx = clientX - rect.left
    const cy = clientY - rect.top
    setZoom((prevZoom) => {
      const z = clampZoom(nz)
      setPan((prev) => {
        const contentX = (cx - prev.x) / prevZoom
        const contentY = (cy - prev.y) / prevZoom
        return clampPan(cx - contentX * z, cy - contentY * z, z)
      })
      return z
    })
  }

  const zoomByButton = (delta: number) => {
    const vp = viewportRef.current
    if (!vp) { setZoom((z) => clampZoom(z + delta)); return }
    const rect = vp.getBoundingClientRect()
    zoomToPoint(zoom + delta, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomToPoint(zoom - e.deltaY * 0.0025 * zoom, e.clientX, e.clientY)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoom, pan, activeUrl])

  const handleUpload = async (view: 'front' | 'rear', file: File | undefined) => {
    if (!file) return
    setUploadError(null)
    if (!file.type.startsWith('image/')) { setUploadError('Please choose an image file.'); return }
    if (file.size > MAX_UPLOAD_BYTES) { setUploadError('Image is too large (max 10MB).'); return }
    setUploadingView(view)
    const path = await uploadImage(shopId, file)
    setUploadingView(null)
    if (!path) { setUploadError('Upload failed. Please try again.'); return }
    if (view === 'front') { setFrontPath(path); setActiveView('front') }
    else { setRearPath(path) }
    resetView()
    setIsTracing(false)
  }

  const pointFromEvent = useCallback((clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const x = ((clientX - rect.left) / rect.width) * 100
    const y = ((clientY - rect.top) / rect.height) * 100
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) }
  }, [])

  const boundsFromPoints = (pts: { x: number; y: number }[]) => {
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
  }

  const finishOutline = () => {
    if (outlinePoints.length < 3) return
    const b = boundsFromPoints(outlinePoints)
    setPendingBox({ view: activeView, ...b, points: outlinePoints })
    setOutlinePoints([])
    setIsTracing(false)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!activeUrl) return
    overlayRef.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values())
      pinchRef.current = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), zoom }
      drawStart.current = null
      panStart.current = null
      setDraft(null)
      return
    }
    if (isTracing) {
      e.preventDefault()
      const p = pointFromEvent(e.clientX, e.clientY)
      if (drawMode === 'outline') {
        if (outlinePoints.length >= 3) {
          const first = outlinePoints[0]
          if (Math.abs(p.x - first.x) < 4 && Math.abs(p.y - first.y) < 4) {
            finishOutline()
            return
          }
        }
        setOutlinePoints((prev) => [...prev, p])
        return
      }
      drawStart.current = p
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 })
      return
    }
    panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchRef.current && pointers.current.size >= 2) {
      const pts = Array.from(pointers.current.values())
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const midX = (pts[0].x + pts[1].x) / 2
      const midY = (pts[0].y + pts[1].y) / 2
      zoomToPoint(pinchRef.current.zoom * (dist / pinchRef.current.dist), midX, midY)
      return
    }
    if (isTracing && drawMode === 'box' && drawStart.current) {
      const p = pointFromEvent(e.clientX, e.clientY)
      const s = drawStart.current
      setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) })
      return
    }
    if (!isTracing && panStart.current) {
      const dx = e.clientX - panStart.current.x
      const dy = e.clientY - panStart.current.y
      setPan(clampPan(panStart.current.panX + dx, panStart.current.panY + dy, zoom))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    if (pointers.current.size === 0) panStart.current = null
    if (isTracing && drawMode === 'box' && drawStart.current) {
      const d = draft
      drawStart.current = null
      if (!d || d.w < 2 || d.h < 2) { setDraft(null); return }
      setPendingBox({ view: activeView, x: d.x, y: d.y, w: d.w, h: d.h })
      setDraft(null)
      setIsTracing(false)
    }
  }

  const addItem = (partial: { name: string; type: 'new' | 'send'; notes: string; reference_image_path: string | null }) => {
    if (editingItem) {
      setItems((prev) => prev.map((it) => it.id === editingItem.id ? { ...it, ...partial } : it))
      setEditingItem(null)
    } else if (pendingBox) {
      setItems((prev) => [...prev, { id: crypto.randomUUID(), box: pendingBox, ...partial }])
    }
    setPendingBox(null)
  }

  const removeItem = (id: string) => setItems((prev) => prev.filter((it) => it.id !== id))

  const handleSubmit = async () => {
    if (!name.trim() || !email.trim() || items.length === 0) return
    if (!vehicleYear.trim() || !vehicleMake.trim() || !vehicleModel.trim()) return
    setSubmitting(true)
    setSubmitError(null)
    const composedName = [vehicleYear.trim(), vehicleMake.trim(), vehicleModel.trim(), vehicleTrim.trim()]
      .filter(Boolean)
      .join(' ')
    const { error } = await supabase.from('leads').insert({
      shop_id: shopId,
      customer_name: name.trim(),
      customer_email: email.trim(),
      customer_phone: phone.trim() || null,
      customer_state: state || null,
      customer_address: address.trim() || null,
      paint_code: paintCode.trim() || null,
      target_start_date: targetStartDate || null,
      vehicle_id: 'custom',
      vehicle_name: composedName || 'Custom Build',
      vehicle_year: vehicleYear.trim() || null,
      vehicle_make: vehicleMake.trim() || null,
      vehicle_model: vehicleModel.trim() || null,
      vehicle_trim: vehicleTrim.trim() || null,
      fulfillment_mode: fulfillmentMode,
      is_custom: true,
      front_image_url: frontPath,
      rear_image_url: rearPath,
      selected_parts: items.map((it) => ({
        id: it.id,
        name: it.name,
        type: it.type,
        price: 0,
        priced: false,
        highlight_color: it.type === 'new' ? 'blue' : 'green',
        notes: it.notes.trim() || null,
        reference_image_path: it.reference_image_path,
        box: it.box,
      })),
      parts_total: 0,
      shipping_total: 0,
      grand_total: 0,
      estimated_lead_time_days: 0,
      status: 'new',
    })
    setSubmitting(false)
    if (error) setSubmitError('Failed to submit. Please try again.')
    else setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 px-4">
        <div className="bg-obsidian-900/60 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card p-8 max-w-md text-center animate-scale-in">
          <div className="w-16 h-16 bg-emerald-500/10 ring-1 ring-emerald-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={32} className="text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2">Request Submitted!</h1>
          <p className="text-slate-400">
            Thank you, {name.split(' ')[0]}! {shop.name} will review your custom build and send you a price quote at {email}.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="dark-surface bg-obsidian-950 text-slate-100 min-h-screen relative overflow-hidden bg-radial-spotlight">
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
              <p className="text-xs text-slate-500">Custom build from your photos</p>
            </div>
          </div>
          {items.length > 0 && (
            <button
              onClick={() => setShowCheckout(true)}
              className="flex items-center gap-2 bg-metallic-gradient text-white text-sm font-semibold rounded-xl px-4 py-2 shadow-glow-blue hover:brightness-110 transition-all"
            >
              {items.length} {items.length === 1 ? 'part' : 'parts'} · Request Quote
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6 relative z-10">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-300 mb-4 transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>

        <h2 className="text-xl font-bold mb-1 text-white">Build from your own photos</h2>
        <p className="text-sm text-slate-400 mb-6">
          Upload a front 3/4 and a rear photo of your truck, then draw a box over each area you want done.
        </p>

        {uploadError && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg px-3 py-2 mb-4">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{uploadError}</span>
          </div>
        )}

        {/* Upload cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          {(['front', 'rear'] as const).map((view) => {
            const path = view === 'front' ? frontPath : rearPath
            const url = publicUrl(path)
            return (
              <div key={view} className="bg-obsidian-900/60 backdrop-blur-xl border border-white/10 border-t-white/20 shadow-glass-card rounded-2xl overflow-hidden">
                <div className="px-4 py-2.5 border-b border-white/10 flex items-center justify-between">
                  <span className="text-sm font-semibold capitalize text-slate-100">{view === 'front' ? 'Front 3/4' : 'Rear'} photo</span>
                  {url && (
                    <label className="text-xs text-cobalt-400 hover:text-cobalt-300 cursor-pointer">
                      Replace
                      <input type="file" accept="image/*" className="hidden"
                        onChange={(e) => handleUpload(view, e.target.files?.[0])} />
                    </label>
                  )}
                </div>
                {url ? (
                  <img src={url} alt={`${view} view`} className="w-full h-40 object-cover" />
                ) : (
                  <label className="flex flex-col items-center justify-center h-40 cursor-pointer hover:bg-white/5 transition-colors">
                    {uploadingView === view ? (
                      <div className="w-6 h-6 border-2 border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
                    ) : (
                      <>
                        <Upload size={22} className="text-slate-600 mb-2" />
                        <span className="text-sm text-slate-400">Tap to upload</span>
                        <span className="text-xs text-slate-600 mt-0.5">{view === 'front' ? 'Required' : 'Optional'}</span>
                      </>
                    )}
                    <input type="file" accept="image/*" className="hidden"
                      onChange={(e) => handleUpload(view, e.target.files?.[0])} />
                  </label>
                )}
              </div>
            )
          })}
        </div>

        {/* Draw area */}
        {(frontPath || rearPath) && (
          <>
            <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
              <div className="flex items-center gap-2">
                {(['front', 'rear'] as const).map((v) => {
                  const has = v === 'front' ? !!frontPath : !!rearPath
                  if (!has) return null
                  return (
                    <button
                      key={v}
                      onClick={() => { setActiveView(v); setOutlinePoints([]); setDraft(null); setIsTracing(false); resetView() }}
                      className={`px-4 py-2 rounded-xl text-sm font-medium capitalize transition-all ${
                        activeView === v ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-900/60 border border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
                      }`}
                    >
                      {v} View
                    </button>
                  )
                })}
              </div>
              {activeUrl && (
                <div className="flex items-center gap-2 flex-wrap">
                  {isTracing ? (
                    <>
                      <div className="flex items-center gap-1 bg-obsidian-900/60 border border-white/10 rounded-lg p-1">
                        {(['box', 'outline'] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => { setDrawMode(m); setOutlinePoints([]); setDraft(null) }}
                            className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                              drawMode === m ? 'bg-cobalt-600 text-white' : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {m === 'box' ? 'Box' : 'Trace Outline'}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => { setIsTracing(false); setOutlinePoints([]); setDraft(null) }}
                        className="px-3 py-2 rounded-xl text-xs font-medium bg-obsidian-900/60 border border-white/10 text-slate-300 hover:bg-white/5 transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => { setIsTracing(true); setDraft(null); setOutlinePoints([]) }}
                      className="flex items-center gap-1.5 bg-metallic-gradient text-white text-sm font-semibold rounded-xl px-4 py-2 shadow-glow-blue hover:brightness-110 transition-all"
                    >
                      <Plus size={16} />
                      Trace New Part
                    </button>
                  )}
                </div>
              )}
            </div>

            {activeUrl ? (
              <div ref={viewportRef} className="relative bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 overflow-hidden mb-2 select-none" style={{ touchAction: 'none' }}>
                <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'top left' }}>
                <img src={activeUrl} alt={`${activeView} view`} className="w-full h-auto block pointer-events-none" draggable={false} />
                <div
                  ref={overlayRef}
                  className={`absolute inset-0 touch-none ${isTracing ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {viewItems.filter((it) => it.box.points && it.box.points.length >= 3).map((it) => {
                      const isNew = it.type === 'new'
                      const color = isNew ? 'rgb(59,130,246)' : 'rgb(16,185,129)'
                      const fill = isNew ? 'rgba(59,130,246,0.25)' : 'rgba(16,185,129,0.25)'
                      return (
                        <polygon
                          key={it.id}
                          points={it.box.points!.map((p) => `${p.x},${p.y}`).join(' ')}
                          fill={fill}
                          stroke={color}
                          strokeWidth={0.5}
                          vectorEffect="non-scaling-stroke"
                        />
                      )
                    })}
                    {outlinePoints.length > 0 && (
                      <polyline
                        points={outlinePoints.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill={outlinePoints.length >= 3 ? 'rgba(255,255,255,0.12)' : 'none'}
                        stroke="white"
                        strokeWidth={0.5}
                        strokeDasharray="2 1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </svg>

                  {viewItems.map((it) => (
                    <span
                      key={`lbl-${it.id}`}
                      className="absolute whitespace-nowrap text-[11px] font-semibold px-1.5 py-0.5 rounded bg-obsidian-950/90 text-white border border-white/20 pointer-events-none"
                      style={{ left: `${it.box.x}%`, top: `${Math.max(0, it.box.y)}%`, transform: 'translateY(-115%)' }}
                    >
                      {it.name}
                    </span>
                  ))}

                  {viewItems.filter((it) => !(it.box.points && it.box.points.length >= 3)).map((it) => {
                    const isNew = it.type === 'new'
                    return (
                      <div
                        key={it.id}
                        className="absolute rounded-sm pointer-events-none"
                        style={{
                          left: `${it.box.x}%`, top: `${it.box.y}%`,
                          width: `${it.box.w}%`, height: `${it.box.h}%`,
                          backgroundColor: isNew ? 'rgba(59,130,246,0.25)' : 'rgba(16,185,129,0.25)',
                          border: `2px solid ${isNew ? 'rgb(59,130,246)' : 'rgb(16,185,129)'}`,
                        }}
                      />
                    )
                  })}

                  {outlinePoints.map((p, i) => (
                    <span
                      key={`pt-${i}`}
                      className={`absolute rounded-full -translate-x-1/2 -translate-y-1/2 ${i === 0 ? 'w-3.5 h-3.5 bg-white ring-2 ring-cobalt-500' : 'w-2.5 h-2.5 bg-white'}`}
                      style={{ left: `${p.x}%`, top: `${p.y}%` }}
                    />
                  ))}

                  {draft && (
                    <div
                      className="absolute rounded-sm border-2 border-dashed border-white/80 bg-white/10 pointer-events-none"
                      style={{ left: `${draft.x}%`, top: `${draft.y}%`, width: `${draft.w}%`, height: `${draft.h}%` }}
                    />
                  )}
                </div>
                </div>

                <div className="absolute bottom-3 right-3 bg-obsidian-900/80 backdrop-blur-md border border-white/10 rounded-xl p-1.5 flex items-center gap-1 shadow-lg z-20">
                  <button
                    type="button"
                    onClick={() => zoomByButton(-0.5)}
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
                    onClick={() => zoomByButton(0.5)}
                    disabled={zoom >= 5}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-200 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Zoom in"
                  >
                    <Plus size={16} />
                  </button>
                  <span className="w-px h-5 bg-white/10 mx-0.5" />
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
              <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-12 text-center mb-2">
                <ImageIcon size={28} className="mx-auto text-slate-700 mb-2" />
                <p className="text-sm text-slate-400">Upload a {activeView} photo to draw on it.</p>
              </div>
            )}

            {activeUrl && isTracing && drawMode === 'outline' && (
              <div className="flex items-center justify-center gap-2 mb-2">
                <button
                  onClick={() => setOutlinePoints((prev) => prev.slice(0, -1))}
                  disabled={outlinePoints.length === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-obsidian-900/60 border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-40 transition-colors"
                >
                  Undo point
                </button>
                <button
                  onClick={() => setOutlinePoints([])}
                  disabled={outlinePoints.length === 0}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-obsidian-900/60 border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-40 transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={finishOutline}
                  disabled={outlinePoints.length < 3}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-cobalt-600 text-white hover:bg-cobalt-500 disabled:opacity-40 transition-colors"
                >
                  Finish outline
                </button>
              </div>
            )}

            {activeUrl && (
              <p className="text-xs text-slate-500 text-center mb-6">
                {!isTracing
                  ? 'Pinch or scroll to zoom, drag to move around. Tap "Trace New Part" to mark a part.'
                  : drawMode === 'box'
                    ? 'Drag on the photo to draw a box over a part you want done.'
                    : 'Tap around the part to drop points, then tap the first point (or "Finish outline") to close the shape.'}
              </p>
            )}
          </>
        )}

        {/* Items list */}
        {items.length > 0 && (
          <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-4">
            <h3 className="text-sm font-semibold mb-3 text-slate-100">Your Parts ({items.length})</h3>
            <div className="space-y-2">
              {items.map((it) => (
                <div key={it.id} className="flex items-start justify-between gap-3 bg-white/5 rounded-lg p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate text-slate-100">{it.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${it.type === 'new' ? 'bg-blue-500/15 text-blue-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                        {it.type === 'new' ? 'Buy New' : 'Paint Mine'}
                      </span>
                      <span className="text-xs text-slate-500 capitalize">{it.box.view} view</span>
                    </div>
                    {it.notes && <p className="text-xs text-slate-400 mt-1">{it.notes}</p>}
                    {it.reference_image_path && (
                      <a href={publicUrl(it.reference_image_path)!} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-cobalt-400 hover:text-cobalt-300 mt-1">
                        <ImageIcon size={12} /> Reference photo
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => { setEditingItem(it); setActiveView(it.box.view) }}
                      className="p-1.5 text-slate-500 hover:text-slate-200 transition-colors" title="Edit">
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => removeItem(it.id)}
                      className="p-1.5 text-slate-500 hover:text-red-400 transition-colors" title="Remove">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowCheckout(true)}
              className="w-full mt-3 bg-metallic-gradient text-white font-semibold text-sm rounded-xl py-2.5 shadow-glow-blue hover:brightness-110 transition-all flex items-center justify-center gap-2"
            >
              Request Quote
              <ArrowRight size={16} />
            </button>
          </div>
        )}
      </div>

      {(pendingBox || editingItem) && (
        <CustomPartModal
          shopId={shopId}
          initial={editingItem}
          onCancel={() => { setPendingBox(null); setEditingItem(null) }}
          onConfirm={addItem}
        />
      )}

      {showCheckout && (
        <CustomCheckoutModal
          shop={shop}
          itemCount={items.length}
          name={name} email={email} phone={phone} state={state} address={address}
          paintCode={paintCode} targetStartDate={targetStartDate} fulfillmentMode={fulfillmentMode}
          vehicleYear={vehicleYear} vehicleMake={vehicleMake} vehicleModel={vehicleModel} vehicleTrim={vehicleTrim}
          onName={setName} onEmail={setEmail} onPhone={setPhone} onState={setState} onAddress={setAddress}
          onTargetStartDate={setTargetStartDate} onFulfillment={setFulfillmentMode}
          onVehicleYear={setVehicleYear} onVehicleMake={setVehicleMake} onVehicleModel={setVehicleModel} onVehicleTrim={setVehicleTrim}
          onSubmit={handleSubmit} onClose={() => setShowCheckout(false)}
          submitting={submitting} error={submitError}
        />
      )}
    </div>
  )
}

function CustomPartModal({
  shopId, initial, onCancel, onConfirm,
}: {
  shopId: string
  initial: CustomItem | null
  onCancel: () => void
  onConfirm: (v: { name: string; type: 'new' | 'send'; notes: string; reference_image_path: string | null }) => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<'new' | 'send'>(initial?.type ?? 'send')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [refPath, setRefPath] = useState<string | null>(initial?.reference_image_path ?? null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRef = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return }
    if (file.size > MAX_UPLOAD_BYTES) { setError('Image is too large (max 10MB).'); return }
    setUploading(true)
    const path = await uploadImage(shopId, file)
    setUploading(false)
    if (!path) { setError('Upload failed. Please try again.'); return }
    setRefPath(path)
  }

  const refUrl = publicUrl(refPath)

  return (
    <div className="dark-surface fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-obsidian-900/80 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card w-full max-w-lg max-h-[90vh] overflow-y-auto animate-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Palette size={18} className="text-cobalt-400" />
            {initial ? 'Edit part' : 'Describe this part'}
          </h2>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Part name *</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all"
              placeholder="e.g. Front bumper" autoFocus />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Buy New or Paint Mine?</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setType('new')}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${type === 'new' ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-950/80 border border-white/10 text-slate-400'}`}>
                Buy New
              </button>
              <button type="button" onClick={() => setType('send')}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${type === 'send' ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-950/80 border border-white/10 text-slate-400'}`}>
                Paint Mine
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">What would you like done?</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all resize-none"
              placeholder="Describe the finish, color, damage, or anything the shop should know." />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Reference photo (optional)</label>
            {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
            {refUrl ? (
              <div className="relative">
                <img src={refUrl} alt="Reference" className="w-full h-40 object-cover rounded-lg border border-white/10" />
                <button onClick={() => setRefPath(null)}
                  className="absolute top-2 right-2 bg-obsidian-950/80 hover:bg-obsidian-950 text-white rounded-full p-1.5 transition-colors">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center h-28 border border-dashed border-white/15 rounded-lg cursor-pointer hover:bg-white/5 transition-colors">
                {uploading ? (
                  <div className="w-5 h-5 border-2 border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
                ) : (
                  <>
                    <ImageIcon size={20} className="text-slate-600 mb-1.5" />
                    <span className="text-xs text-slate-400">Add a reference photo</span>
                  </>
                )}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleRef(e.target.files?.[0])} />
              </label>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
            <button onClick={onCancel} className="px-4 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button
              onClick={() => onConfirm({ name: name.trim(), type, notes, reference_image_path: refPath })}
              disabled={!name.trim() || uploading}
              className="bg-metallic-gradient text-white font-semibold text-sm rounded-xl px-5 py-2.5 shadow-glow-blue hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100 transition-all flex items-center gap-2"
            >
              <Plus size={16} />
              {initial ? 'Save' : 'Add Part'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CustomCheckoutModal({
  shop, itemCount, name, email, phone, state, address, paintCode, targetStartDate, fulfillmentMode,
  vehicleYear, vehicleMake, vehicleModel, vehicleTrim,
  onName, onEmail, onPhone, onState, onAddress, onTargetStartDate, onFulfillment,
  onVehicleYear, onVehicleMake, onVehicleModel, onVehicleTrim,
  onSubmit, onClose, submitting, error,
}: {
  shop: Shop
  itemCount: number
  name: string; email: string; phone: string; state: string; address: string
  paintCode: string; targetStartDate: string; fulfillmentMode: 'local' | 'mail'
  vehicleYear: string; vehicleMake: string; vehicleModel: string; vehicleTrim: string
  onName: (v: string) => void; onEmail: (v: string) => void; onPhone: (v: string) => void
  onState: (v: string) => void; onAddress: (v: string) => void; onTargetStartDate: (v: string) => void
  onFulfillment: (v: 'local' | 'mail') => void
  onVehicleYear: (v: string) => void; onVehicleMake: (v: string) => void
  onVehicleModel: (v: string) => void; onVehicleTrim: (v: string) => void
  onSubmit: () => void; onClose: () => void; submitting: boolean; error: string | null
}) {
  const vehicleReady = !!vehicleYear.trim() && !!vehicleMake.trim() && !!vehicleModel.trim()
  return (
    <div className="dark-surface fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-obsidian-900/80 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-2xl shadow-glass-card w-full max-w-md p-6 animate-scale-in max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">Request Your Quote</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 transition-colors"><X size={20} /></button>
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-300 text-sm rounded-lg px-3 py-2 mb-4">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="bg-white/5 border border-white/10 rounded-xl p-3 mb-4 flex items-start gap-2">
          <Palette size={15} className="text-cobalt-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-slate-300">
            You're requesting a quote for <span className="font-semibold text-white">{itemCount} {itemCount === 1 ? 'part' : 'parts'}</span>.
            {' '}{shop.name} will review your photos and notes and send you pricing.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
              <Car size={13} /> Your Vehicle *
            </label>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={vehicleYear} onChange={(e) => onVehicleYear(e.target.value)} required placeholder="Year"
                className="bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
              <input type="text" value={vehicleMake} onChange={(e) => onVehicleMake(e.target.value)} required placeholder="Make"
                className="bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
              <input type="text" value={vehicleModel} onChange={(e) => onVehicleModel(e.target.value)} required placeholder="Model"
                className="bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
              <input type="text" value={vehicleTrim} onChange={(e) => onVehicleTrim(e.target.value)} placeholder="Trim (optional)"
                className="bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl px-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
            </div>
          </div>
          {paintCode.trim() && (
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <Hash size={14} className="text-cobalt-400 flex-shrink-0" />
              <span className="text-xs text-slate-400">Paint code:</span>
              <span className="text-xs font-medium text-slate-200">{paintCode}</span>
            </div>
          )}
          <Field label="Full Name *" icon={User}>
            <input type="text" value={name} onChange={(e) => onName(e.target.value)} required placeholder="John Smith"
              className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
          </Field>
          <Field label="Email *" icon={Mail}>
            <input type="email" value={email} onChange={(e) => onEmail(e.target.value)} required placeholder="you@email.com"
              className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
          </Field>
          <Field label="Address" icon={MapPin}>
            <input type="text" value={address} onChange={(e) => onAddress(e.target.value)} placeholder="Street, City, ZIP"
              className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" icon={Phone}>
              <input type="tel" value={phone} onChange={(e) => onPhone(e.target.value)} placeholder="(555) 123-4567"
                className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 placeholder-slate-600 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
            </Field>
            <Field label="State" icon={MapPin}>
              <select value={state} onChange={(e) => onState(e.target.value)}
                className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all appearance-none cursor-pointer">
                <option value="">--</option>
                {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Target Start Date" icon={Calendar}>
            <input type="date" value={targetStartDate} onChange={(e) => onTargetStartDate(e.target.value)}
              className="w-full bg-obsidian-950/80 border border-white/10 text-slate-100 rounded-xl pl-11 pr-4 py-3 focus:outline-none focus:border-cobalt-500/50 focus:ring-2 focus:ring-cobalt-500/20 transition-all" />
          </Field>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Fulfillment</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => onFulfillment('local')}
                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${fulfillmentMode === 'local' ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-950/80 border border-white/10 text-slate-400'}`}>
                Local Drop-off
              </button>
              <button type="button" onClick={() => onFulfillment('mail')}
                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${fulfillmentMode === 'mail' ? 'bg-cobalt-600 text-white shadow-glow-blue' : 'bg-obsidian-950/80 border border-white/10 text-slate-400'}`}>
                Mail-Order DIY
              </button>
            </div>
          </div>
          <button
            onClick={onSubmit}
            disabled={submitting || !name.trim() || !email.trim() || !vehicleReady}
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

function Field({ label, icon: Icon, children }: { label: string; icon: typeof User; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">{label}</label>
      <div className="relative">
        <Icon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        {children}
      </div>
    </div>
  )
}
