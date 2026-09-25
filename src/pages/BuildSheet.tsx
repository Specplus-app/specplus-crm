import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase, BuildSheet as BuildSheetRecord, PartEntry, formatCurrency, getHighlightColor } from '../lib/supabase'
import { AlertCircle, Layers, Clock, Package, Palette, X } from 'lucide-react'

type EnlargedPhoto = { url: string; label: string; view: 'front' | 'rear' } | null

function PhotoLabels({ boxes }: { boxes: PartEntry[] }) {
  return (
    <>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {boxes.filter((p) => p.box!.points && p.box!.points!.length >= 3).map((p) => {
          const color = p.type === 'new' ? 'rgb(96,165,250)' : 'rgb(52,211,153)'
          return (
            <polygon
              key={p.id}
              points={p.box!.points!.map((pt) => `${pt.x},${pt.y}`).join(' ')}
              fill="rgba(255,255,255,0.10)"
              stroke={color}
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>
      {boxes.filter((p) => !(p.box!.points && p.box!.points!.length >= 3)).map((p) => {
        const color = p.type === 'new' ? 'rgb(96,165,250)' : 'rgb(52,211,153)'
        return (
          <div
            key={p.id}
            className="absolute pointer-events-none"
            style={{
              left: `${p.box!.x}%`, top: `${p.box!.y}%`,
              width: `${p.box!.w}%`, height: `${p.box!.h}%`,
              backgroundColor: 'rgba(255,255,255,0.10)',
              border: `2px solid ${color}`,
            }}
          />
        )
      })}
      {boxes.map((p) => (
        <span
          key={`lbl-${p.id}`}
          className="absolute whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-obsidian-950/90 text-white border border-white/10 pointer-events-none"
          style={{ left: `${p.box!.x}%`, top: `${Math.max(0, p.box!.y)}%`, transform: 'translateY(-115%)' }}
        >
          {p.name}{p.price > 0 ? ` \u00b7 ${formatCurrency(p.price)}` : ''}
        </span>
      ))}
    </>
  )
}

export default function BuildSheet() {
  const { id } = useParams<{ id: string }>()
  const [sheet, setSheet] = useState<BuildSheetRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [enlarged, setEnlarged] = useState<EnlargedPhoto>(null)

  useEffect(() => {
    if (!id) {
      setLoading(false)
      return
    }
    supabase
      .from('build_sheets')
      .select('*')
      .eq('id', id)
      .maybeSingle()
      .then(({ data }) => {
        setSheet(data as BuildSheetRecord | null)
        setLoading(false)
      })
  }, [id])

  if (loading) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight">
        <div className="w-9 h-9 border-[3px] border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!sheet) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 px-4">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-lg font-medium">Build sheet not found</p>
          <p className="text-sm text-slate-500 mt-1">This link may have expired or been removed.</p>
        </div>
      </div>
    )
  }

  const parts: PartEntry[] = Array.isArray(sheet.selected_parts) ? sheet.selected_parts : []
  const vehicleLine = [sheet.vehicle_year, sheet.vehicle_make, sheet.vehicle_model, sheet.vehicle_trim]
    .filter(Boolean).join(' ') || sheet.vehicle_name

  const photos = ([['Front 3/4', 'front', sheet.front_image_url], ['Rear', 'rear', sheet.rear_image_url]] as const)
    .filter(([, , url]) => !!url)

  const groupIsBuyNew = (gid: string | null | undefined) => parts.some((p) => p.group_id === gid && p.type === 'new')
  const allGroupIds = Array.from(new Set(parts.filter((p) => p.group_id).map((p) => p.group_id)))
  const buyNewGroups = allGroupIds.filter((gid) => groupIsBuyNew(gid))
  const paintGroups = allGroupIds.filter((gid) => !groupIsBuyNew(gid))
  const buyNewParts = parts.filter((p) => !p.group_id && p.type === 'new')
  const paintParts = parts.filter((p) => !p.group_id && p.type === 'send')
  const buyNewCount = buyNewParts.length + buyNewGroups.reduce((n, gid) => n + parts.filter((p) => p.group_id === gid).length, 0)
  const paintCount = paintParts.length + paintGroups.reduce((n, gid) => n + parts.filter((p) => p.group_id === gid).length, 0)

  const renderPartBody = (part: PartEntry) => (
    <>
      {part.paint_style_name && <p className="text-xs text-slate-400 mt-0.5 ml-5">Paint style: {part.paint_style_name}</p>}
      {part.selected_options && part.selected_options.length > 0 && (
        <ul className="text-xs text-slate-400 mt-0.5 ml-5 space-y-0.5">
          {part.selected_options.map((opt) => (
            <li key={opt.id}>+ {opt.name} ({formatCurrency(opt.price)})</li>
          ))}
        </ul>
      )}
    </>
  )

  const renderGroup = (gid: string | null | undefined) => {
    const groupParts = parts.filter((p) => p.group_id === gid)
    const gName = groupParts[0]?.group_name ?? 'Group'
    return (
      <div key={gid} className="border border-white/10 rounded-xl overflow-hidden">
        <div className="bg-white/5 px-3 py-1.5 flex items-center gap-2 border-b border-white/10">
          <Layers size={12} className="text-slate-400" />
          <span className="text-xs font-semibold text-slate-300">{gName}</span>
        </div>
        <div className="p-2 space-y-2">
          {groupParts.map((part, idx) => (
            <div key={part.id} className="py-1">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`} />
                  <span className="text-sm text-slate-200 truncate">{part.name}</span>
                  {idx !== 0 && <span className="text-xs text-slate-500 italic">already purchased</span>}
                </div>
                <span className="text-sm font-medium text-white flex-shrink-0">{idx !== 0 ? '—' : formatCurrency(part.price)}</span>
              </div>
              {renderPartBody(part)}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderUngrouped = (part: PartEntry) => (
    <div key={part.id} className="py-2 border-b border-white/5 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`} />
          <span className="text-sm text-slate-200 truncate">{part.name}</span>
        </div>
        <span className="text-sm font-medium text-white flex-shrink-0">{formatCurrency(part.price)}</span>
      </div>
      {renderPartBody(part)}
    </div>
  )

  return (
    <div className="dark-surface min-h-screen bg-obsidian-950 bg-radial-spotlight text-slate-100">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          {sheet.shop_logo_url ? (
            <img src={sheet.shop_logo_url} alt={sheet.shop_name} className="h-11 w-11 rounded-xl object-cover border border-white/10" />
          ) : (
            <div className="h-11 w-11 rounded-xl bg-metallic-gradient border border-white/10 flex items-center justify-center">
              <Package size={20} className="text-slate-300" />
            </div>
          )}
          <div>
            {sheet.shop_name && <p className="text-sm font-semibold text-white leading-tight">{sheet.shop_name}</p>}
            <p className="text-xs text-slate-400">Build Sheet</p>
          </div>
        </div>

        {/* Vehicle */}
        <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-6 mb-5">
          <p className="text-xs uppercase tracking-wider text-cobalt-300 font-semibold mb-1">Prepared for {sheet.customer_name}</p>
          <h1 className="text-2xl font-bold text-white">{vehicleLine}</h1>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm text-slate-400">
            {sheet.paint_code && <span className="flex items-center gap-1.5"><Palette size={13} /> Paint code: {sheet.paint_code}</span>}
            <span className="flex items-center gap-1.5"><Package size={13} /> {sheet.fulfillment_mode === 'mail' ? 'Mail-Order DIY' : 'Local Drop-off'}</span>
            {sheet.estimated_lead_time_days > 0 && (
              <span className="flex items-center gap-1.5"><Clock size={13} /> Est. {sheet.estimated_lead_time_days} {sheet.estimated_lead_time_days === 1 ? 'day' : 'days'}</span>
            )}
          </div>
        </div>

        {/* Labeled photos */}
        {photos.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            {photos.map(([label, view, url]) => {
              const boxes = parts.filter((p) => p.box && p.box.view === view)
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setEnlarged({ url: url as string, label, view })}
                  className="group text-left"
                >
                  <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/20 select-none">
                    <img src={url as string} alt={label} className="w-full h-auto block transition-transform duration-300 group-hover:scale-[1.02]" />
                    <PhotoLabels boxes={boxes} />
                  </div>
                  <span className="text-xs text-slate-400 mt-1.5 inline-block">{label} — tap to enlarge</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Itemized build */}
        {parts.length > 0 && (
          <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-6 mb-5">
            <h2 className="text-sm font-semibold text-white mb-4">Build Details ({parts.length} {parts.length === 1 ? 'part' : 'parts'})</h2>
            <div className="space-y-5">
              {buyNewCount > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-cobalt-300">Buy New</span>
                    <span className="text-xs text-slate-500">({buyNewCount})</span>
                  </div>
                  <div className="space-y-2">
                    {buyNewGroups.map((gid) => renderGroup(gid))}
                    {buyNewParts.map((part) => renderUngrouped(part))}
                  </div>
                </div>
              )}
              {paintCount > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-300">Paint Mine</span>
                    <span className="text-xs text-slate-500">({paintCount})</span>
                  </div>
                  <div className="space-y-2">
                    {paintGroups.map((gid) => renderGroup(gid))}
                    {paintParts.map((part) => renderUngrouped(part))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Pricing */}
        <div className="bg-metallic-gradient rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-6">
          <h2 className="text-sm font-semibold text-white mb-3">Pricing Summary</h2>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-slate-300">
              <span>Parts &amp; Labor</span>
              <span className="font-medium text-white">{formatCurrency(sheet.parts_total)}</span>
            </div>
            <div className="flex justify-between text-slate-300">
              <span>Shipping</span>
              <span className="font-medium text-white">{formatCurrency(sheet.shipping_total)}</span>
            </div>
            <div className="flex justify-between text-white font-bold text-lg pt-3 mt-1 border-t border-white/10">
              <span>Grand Total</span>
              <span>{formatCurrency(sheet.grand_total)}</span>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 mt-8">
          Questions about this build? Reply to the email that brought you here.
        </p>
      </div>

      {/* Enlarged photo */}
      {enlarged && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setEnlarged(null)}>
          <div className="relative max-w-4xl w-full max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-white">{enlarged.label}</span>
              <button
                onClick={() => setEnlarged(null)}
                className="flex items-center gap-1.5 text-white/80 hover:text-white text-sm font-medium bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5 transition-colors"
              >
                <X size={15} /> Close
              </button>
            </div>
            <div className="relative rounded-xl overflow-hidden select-none bg-black">
              <img src={enlarged.url} alt={enlarged.label} className="w-full h-auto block" />
              <PhotoLabels boxes={parts.filter((p) => p.box && p.box.view === enlarged.view)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
