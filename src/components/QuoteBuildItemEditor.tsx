import { useRef, useState } from 'react'
import { CustomPartBox, PartEntry, formatCurrency } from '../lib/supabase'
import { QuotePartOverlays, partsOnView } from './QuoteVehiclePhotos'
import { Check, Square, Spline, Undo2, X } from 'lucide-react'

type View = 'front' | 'rear'
type Point = { x: number; y: number }

function newPartId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function boundsFromPoints(pts: Point[]) {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
}

// Adds a shop-defined build item to a draft quote, including its highlighted
// area on the customer's photo. Uses the same CustomPartBox shape (box, or
// outline with points, in 0..100 photo coordinates) as customer custom builds,
// so the quote photos and the public quote page render it unchanged.
export default function QuoteBuildItemEditor({
  frontUrl,
  rearUrl,
  existingParts,
  onCancel,
  onAdd,
}: {
  frontUrl: string | null
  rearUrl: string | null
  existingParts: PartEntry[]
  onCancel: () => void
  onAdd: (part: PartEntry) => void
}) {
  const views: { view: View; label: string; url: string }[] = []
  if (frontUrl) views.push({ view: 'front', label: 'Front 3/4', url: frontUrl })
  if (rearUrl) views.push({ view: 'rear', label: 'Rear', url: rearUrl })
  const hasPhotos = views.length > 0

  const [name, setName] = useState('')
  const [type, setType] = useState<'new' | 'send'>('send')
  const [priceText, setPriceText] = useState('')
  const [notes, setNotes] = useState('')
  const [activeView, setActiveView] = useState<View>(views[0]?.view ?? 'front')
  const [mode, setMode] = useState<'box' | 'outline'>('box')
  const [area, setArea] = useState<CustomPartBox | null>(null)
  const [draftBox, setDraftBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [outline, setOutline] = useState<Point[]>([])
  const [error, setError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<Point | null>(null)

  const activeUrl = views.find((v) => v.view === activeView)?.url ?? null
  const price = Math.max(0, parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0)

  const pointFromEvent = (clientX: number, clientY: number): Point => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const x = ((clientX - rect.left) / rect.width) * 100
    const y = ((clientY - rect.top) / rect.height) * 100
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) }
  }

  const resetDrawing = () => {
    setArea(null)
    setDraftBox(null)
    setOutline([])
    dragStart.current = null
  }

  const finishOutline = (pts: Point[]) => {
    if (pts.length < 3) return
    setArea({ view: activeView, ...boundsFromPoints(pts), points: pts })
    setOutline([])
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (area) return
    e.preventDefault()
    const p = pointFromEvent(e.clientX, e.clientY)
    if (mode === 'outline') {
      if (outline.length >= 3) {
        const first = outline[0]
        if (Math.abs(p.x - first.x) < 4 && Math.abs(p.y - first.y) < 4) {
          finishOutline(outline)
          return
        }
      }
      setOutline((prev) => [...prev, p])
      return
    }
    overlayRef.current?.setPointerCapture(e.pointerId)
    dragStart.current = p
    setDraftBox({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (mode !== 'box' || !dragStart.current) return
    const p = pointFromEvent(e.clientX, e.clientY)
    const s = dragStart.current
    setDraftBox({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) })
  }

  const onPointerUp = () => {
    if (mode !== 'box' || !dragStart.current) return
    dragStart.current = null
    const d = draftBox
    setDraftBox(null)
    if (!d || d.w < 2 || d.h < 2) return
    setArea({ view: activeView, x: d.x, y: d.y, w: d.w, h: d.h })
  }

  const handleAdd = () => {
    if (!name.trim()) {
      setError('Give this item a name.')
      return
    }
    if (hasPhotos && !area) {
      setError('Highlight the area on the customer photo.')
      return
    }
    onAdd({
      id: newPartId(),
      name: name.trim().slice(0, 120),
      type,
      price,
      priced: true,
      highlight_color: type === 'new' ? 'blue' : 'green',
      notes: notes.trim() || null,
      box: area,
    })
  }

  const areaColor = type === 'new' ? 'rgb(96,165,250)' : 'rgb(52,211,153)'
  const inputCls = 'w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors'
  const toggleCls = (active: boolean) =>
    `flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-1.5 border transition-colors ${
      active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
    }`

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-lg font-bold text-zinc-900">Add Build Item</h2>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-600 transition-colors" aria-label="Close"><X size={20} /></button>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-5 gap-5">
          {/* Details */}
          <div className="md:col-span-2 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-zinc-600 mb-1">Item name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Fender flares" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-600 mb-1">Type</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setType('send')} className={toggleCls(type === 'send')}>Paint customer part</button>
                <button type="button" onClick={() => setType('new')} className={toggleCls(type === 'new')}>Buy new</button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-600 mb-1">Price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400 pointer-events-none">$</span>
                <input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" placeholder="0" className={`${inputCls} pl-6`} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-600 mb-1">Notes <span className="font-normal text-zinc-400">(shop only)</span></label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={1000} placeholder="Not shown to the customer." className={`${inputCls} resize-none`} />
            </div>
          </div>

          {/* Area */}
          <div className="md:col-span-3">
            <label className="block text-xs font-semibold text-zinc-600 mb-1">Highlight area</label>
            {!hasPhotos ? (
              <p className="text-sm text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
                This quote has no customer photos, so the item will be listed without a highlighted area.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {views.map((v) => (
                    <button key={v.view} type="button" onClick={() => { if (v.view !== activeView) { setActiveView(v.view); resetDrawing() } }} className={toggleCls(activeView === v.view)}>
                      {v.label}
                    </button>
                  ))}
                  <span className="w-px h-5 bg-zinc-200 mx-1" />
                  <button type="button" onClick={() => { setMode('box'); resetDrawing() }} className={toggleCls(mode === 'box')}><Square size={13} /> Box</button>
                  <button type="button" onClick={() => { setMode('outline'); resetDrawing() }} className={toggleCls(mode === 'outline')}><Spline size={13} /> Outline</button>
                </div>

                <div className="relative rounded-lg overflow-hidden border border-zinc-200 bg-zinc-50 select-none">
                  {activeUrl && <img src={activeUrl} alt={activeView} className="w-full h-auto block pointer-events-none" draggable={false} />}
                  {/* Existing quote items for context */}
                  <QuotePartOverlays parts={partsOnView(existingParts, activeView)} />
                  <div
                    ref={overlayRef}
                    className={`absolute inset-0 ${area ? '' : 'cursor-crosshair'}`}
                    style={{ touchAction: 'none' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                      {area?.points && area.points.length >= 3 && (
                        <polygon points={area.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(255,255,255,0.18)" stroke={areaColor} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
                      )}
                      {outline.length > 0 && (
                        <polyline points={outline.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={areaColor} strokeWidth={0.6} strokeDasharray="2 1" vectorEffect="non-scaling-stroke" />
                      )}
                      {outline.map((p, i) => (
                        <circle key={i} cx={p.x} cy={p.y} r={i === 0 ? 1.2 : 0.8} fill={areaColor} />
                      ))}
                    </svg>
                    {area && !(area.points && area.points.length >= 3) && (
                      <div className="absolute pointer-events-none" style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.w}%`, height: `${area.h}%`, backgroundColor: 'rgba(255,255,255,0.18)', border: `2px solid ${areaColor}` }} />
                    )}
                    {draftBox && (
                      <div className="absolute pointer-events-none" style={{ left: `${draftBox.x}%`, top: `${draftBox.y}%`, width: `${draftBox.w}%`, height: `${draftBox.h}%`, border: `2px dashed ${areaColor}` }} />
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
                  <p className="text-xs text-zinc-500">
                    {area
                      ? `Area set on the ${activeView === 'front' ? 'front' : 'rear'} photo.`
                      : mode === 'box'
                        ? 'Drag on the photo to draw a box over the area.'
                        : 'Click around the area to drop points, then click the first point or Finish outline.'}
                  </p>
                  <div className="flex gap-2">
                    {mode === 'outline' && !area && outline.length > 0 && (
                      <button type="button" onClick={() => setOutline((prev) => prev.slice(0, -1))} className={toggleCls(false)}><Undo2 size={13} /> Undo point</button>
                    )}
                    {mode === 'outline' && !area && outline.length >= 3 && (
                      <button type="button" onClick={() => finishOutline(outline)} className={toggleCls(false)}><Check size={13} /> Finish outline</button>
                    )}
                    {(area || outline.length > 0) && (
                      <button type="button" onClick={resetDrawing} className={toggleCls(false)}>Redraw</button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 p-5 border-t border-zinc-100">
          <span className="text-sm text-zinc-600">{name.trim() ? `${name.trim()} · ${formatCurrency(price)}` : 'New build item'}</span>
          <div className="flex items-center gap-2">
            {error && <span className="text-sm text-red-600">{error}</span>}
            <button onClick={onCancel} className="bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors">Cancel</button>
            <button onClick={handleAdd} className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors">Add to Quote</button>
          </div>
        </div>
      </div>
    </div>
  )
}
