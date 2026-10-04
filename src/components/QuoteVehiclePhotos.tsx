import { useState } from 'react'
import { PartEntry, formatCurrency, getHighlightColor, shapedPartsOnView, svgPathAnchor } from '../lib/supabase'
import { X } from 'lucide-react'

type View = 'front' | 'rear'

function anchorFor(p: PartEntry): { x: number; y: number } {
  if (p.box) return { x: p.box.x, y: Math.max(0, p.box.y) }
  if (p.svg_path) return svgPathAnchor(p.svg_path)
  return { x: 2, y: 6 }
}

// Parts drawn on one photo: custom-build boxes/polygons for that view, plus
// template highlight shapes (including cross-view shapes) for the rest.
export function partsOnView(parts: PartEntry[], view: View): PartEntry[] {
  return [...parts.filter((p) => p.box?.view === view), ...shapedPartsOnView(parts.filter((p) => !p.box), view)]
}

export function QuotePartOverlays({ parts }: { parts: PartEntry[] }) {
  return (
    <>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {parts.filter((p) => p.svg_path).map((p) => {
          const c = getHighlightColor(p.highlight_color ?? 'green')
          return (
            <path
              key={`svg-${p.id}`}
              d={p.svg_path ?? ''}
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
        {parts.map((p) => {
          const points = p.box?.points
          if (!points || points.length < 3) return null
          const color = p.type === 'new' ? 'rgb(96,165,250)' : 'rgb(52,211,153)'
          return (
            <polygon
              key={`poly-${p.id}`}
              points={points.map((pt) => `${pt.x},${pt.y}`).join(' ')}
              fill="rgba(255,255,255,0.10)"
              stroke={color}
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>
      {parts.map((p) => {
        const box = p.box
        if (!box || (box.points && box.points.length >= 3)) return null
        const color = p.type === 'new' ? 'rgb(96,165,250)' : 'rgb(52,211,153)'
        return (
          <div
            key={`box-${p.id}`}
            className="absolute pointer-events-none"
            style={{
              left: `${box.x}%`, top: `${box.y}%`,
              width: `${box.w}%`, height: `${box.h}%`,
              backgroundColor: 'rgba(255,255,255,0.10)',
              border: `2px solid ${color}`,
            }}
          />
        )
      })}
      {parts.map((p) => {
        const anchor = anchorFor(p)
        return (
          <span
            key={`lbl-${p.id}`}
            className="absolute whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-950/90 text-white border border-white/10 pointer-events-none"
            style={{ left: `${anchor.x}%`, top: `${anchor.y}%`, transform: 'translateY(-115%)' }}
          >
            {p.name}{p.price > 0 ? ` · ${formatCurrency(p.price)}` : ''}
          </span>
        )
      })}
    </>
  )
}

export default function QuoteVehiclePhotos({
  parts,
  frontUrl,
  rearUrl,
  theme = 'dark',
}: {
  parts: PartEntry[]
  frontUrl: string | null
  rearUrl: string | null
  theme?: 'dark' | 'light'
}) {
  const [enlarged, setEnlarged] = useState<{ url: string; label: string; view: View } | null>(null)
  const photos: { label: string; view: View; url: string }[] = []
  if (frontUrl) photos.push({ label: 'Front 3/4', view: 'front', url: frontUrl })
  if (rearUrl) photos.push({ label: 'Rear', view: 'rear', url: rearUrl })

  if (photos.length === 0) return null

  const frame = theme === 'dark' ? 'border-white/10 bg-black/20' : 'border-zinc-200 bg-zinc-50'
  const caption = theme === 'dark' ? 'text-slate-400' : 'text-zinc-500'

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {photos.map(({ label, view, url }) => (
          <button key={label} type="button" onClick={() => setEnlarged({ url, label, view })} className="group text-left">
            <div className={`relative rounded-2xl overflow-hidden border select-none ${frame}`}>
              <img src={url} alt={label} className="w-full h-auto block transition-transform duration-300 group-hover:scale-[1.02]" />
              <QuotePartOverlays parts={partsOnView(parts, view)} />
            </div>
            <span className={`text-xs mt-1.5 inline-block ${caption}`}>{label} — tap to enlarge</span>
          </button>
        ))}
      </div>

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
              <QuotePartOverlays parts={partsOnView(parts, enlarged.view)} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
