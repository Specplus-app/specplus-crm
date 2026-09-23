import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase, Vehicle, VehiclePart, formatCurrency, getHighlightColor } from '../lib/supabase'
import { pickPartAtPoint } from '../lib/svgHit'
import { Car, AlertCircle, Plus, Minus, Hand, RotateCcw, ExternalLink } from 'lucide-react'

const STORAGE_BUCKET = 'vehicles'

type Tooltip = { x: number; y: number; name: string; price: number; hasLink: boolean }

export default function VehicleEmbed() {
  const { vehicleId } = useParams<{ vehicleId: string }>()
  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [parts, setParts] = useState<VehiclePart[]>([])
  const [activeView, setActiveView] = useState<'front' | 'rear'>('front')
  const [loading, setLoading] = useState(true)
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panMode, setPanMode] = useState(false)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null)
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)
  const movedRef = useRef(false)

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
    if (!vehicleId) {
      setLoading(false)
      return
    }
    supabase
      .from('vehicles')
      .select('*')
      .eq('id', vehicleId)
      .eq('status', 'published')
      .maybeSingle()
      .then(async ({ data }) => {
        if (data) {
          setVehicle(data as Vehicle)
          const { data: partData } = await supabase
            .from('vehicle_parts')
            .select('*')
            .eq('vehicle_id', vehicleId)
            .order('sort_order', { ascending: true })
          setParts((partData as VehiclePart[]) ?? [])
        }
        setLoading(false)
      })
  }, [vehicleId])

  useEffect(() => {
    resetView()
    setPanMode(false)
    setTooltip(null)
    setHoveredPartId(null)
  }, [activeView])

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
  }, [vehicle, activeView])

  const getImageUrl = (path: string | null): string | null => {
    if (!path) return null
    return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl
  }

  const frontUrl = getImageUrl(vehicle?.front_image_path ?? null)
  const rearUrl = getImageUrl(vehicle?.rear_image_path ?? null)
  const currentImageUrl = activeView === 'front' ? frontUrl : rearUrl

  const partsForView = useMemo(
    () => parts.filter((p) => p.view === activeView).sort((a, b) => a.sort_order - b.sort_order),
    [parts, activeView]
  )

  const partPrice = (p: VehiclePart) => (p.part_cost + p.paint_price) || p.paint_price || p.part_cost

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

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (movedRef.current || panMode) return
    const id = svgRef.current && pickPartAtPoint(svgRef.current, e.clientX, e.clientY)
    const part = id ? partsForView.find((p) => p.id === id) : null
    if (part?.external_url) {
      window.open(part.external_url, '_blank', 'noopener,noreferrer')
    }
  }

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    const id = svgRef.current ? pickPartAtPoint(svgRef.current, e.clientX, e.clientY) : null
    setHoveredPartId(id)
    if (id) {
      const part = partsForView.find((p) => p.id === id)
      if (part) {
        setTooltip({ x: e.clientX, y: e.clientY, name: part.name, price: partPrice(part), hasLink: !!part.external_url })
        return
      }
    }
    setTooltip(null)
  }

  if (loading) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight">
        <div className="w-9 h-9 border-[3px] border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!vehicle) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 px-4">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-lg font-medium">Vehicle not available</p>
          <p className="text-sm text-slate-500 mt-1">This vehicle may have been unpublished or removed.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="dark-surface min-h-screen bg-obsidian-950 bg-radial-spotlight text-slate-100 flex flex-col">
      <div className="flex-1 w-full max-w-4xl mx-auto px-4 py-5 flex flex-col">
        {/* View toggle */}
        {frontUrl && rearUrl && (
          <div className="inline-flex self-start bg-obsidian-900/80 p-1.5 rounded-xl border border-white/10 shadow-inner gap-1 mb-4">
            {(['front', 'rear'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setActiveView(v)}
                className={`capitalize px-4 py-2 rounded-lg text-xs tracking-wide transition-all ${
                  activeView === v ? 'bg-cobalt-600 text-white font-semibold shadow-glow-blue' : 'text-slate-400 hover:text-slate-200 font-medium'
                }`}
              >
                {v} View
              </button>
            ))}
          </div>
        )}

        {currentImageUrl ? (
          <div className="relative rounded-3xl bg-gradient-to-b from-white to-slate-200 p-4 sm:p-6 shadow-2xl border border-white/20 overflow-hidden">
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
                <img src={currentImageUrl} alt={`${vehicle.name} ${activeView} view`} className="w-full h-auto block" draggable={false} />
                <svg
                  ref={svgRef}
                  className="absolute inset-0 w-full h-full"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  onClick={handleCanvasClick}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseLeave={() => { setHoveredPartId(null); setTooltip(null) }}
                >
                  {partsForView.map((part) => {
                    const hovered = hoveredPartId === part.id
                    const color = getHighlightColor(part.highlight_color)
                    return (
                      <path
                        key={part.id}
                        data-part-id={part.id}
                        d={part.svg_path}
                        fill={hovered ? color.fill : 'transparent'}
                        stroke={hovered ? color.stroke : 'transparent'}
                        strokeWidth="0.4"
                        vectorEffect="non-scaling-stroke"
                        className={`transition-colors ${part.external_url ? 'cursor-pointer' : 'cursor-default'}`}
                      />
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
                aria-label="Toggle pan mode"
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
          <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-12 text-center">
            <Car size={32} className="mx-auto text-slate-700 mb-2" />
            <p className="text-sm text-slate-400">No image available for this vehicle</p>
          </div>
        )}

        {partsForView.length > 0 && (
          <p className="text-xs text-slate-500 text-center mt-4">
            Hover a highlighted area to see the part. Click a linked part to shop it.
          </p>
        )}
      </div>

      {/* Hover tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full"
          style={{ left: tooltip.x, top: tooltip.y - 12 }}
        >
          <div className="bg-obsidian-900/90 backdrop-blur-xl border border-white/10 border-t-white/20 rounded-xl px-3 py-2 shadow-glass-card whitespace-nowrap">
            <p className="text-sm font-semibold text-white">{tooltip.name}</p>
            <div className="flex items-center gap-2 mt-0.5">
              {tooltip.price > 0 && (
                <span className="text-xs text-cobalt-300 font-medium">From {formatCurrency(tooltip.price)}</span>
              )}
              {tooltip.hasLink && (
                <span className="flex items-center gap-1 text-[11px] text-slate-400">
                  <ExternalLink size={11} />
                  Click to shop
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
