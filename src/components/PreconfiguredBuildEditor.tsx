import { useEffect, useMemo, useState } from 'react'
import { Lead, PartEntry, PartGroup, VehiclePart, formatCurrency, supabase } from '../lib/supabase'
import { Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react'

type Props = {
  lead: Lead
  readOnly: boolean
  onSave: (parts: PartEntry[]) => Promise<boolean>
}

export default function PreconfiguredBuildEditor({ lead, readOnly, onSave }: Props) {
  const [open, setOpen] = useState(false)
  const [parts, setParts] = useState<PartEntry[]>([])
  const [catalog, setCatalog] = useState<VehiclePart[]>([])
  const [groups, setGroups] = useState<PartGroup[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [saving, setSaving] = useState(false)
  const [addId, setAddId] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setParts((Array.isArray(lead.selected_parts) ? lead.selected_parts : []).map((p) => ({ ...p })))
    setAddId('')
    setError(null)
    setLoadingCatalog(true)
    Promise.all([
      supabase.from('vehicle_parts').select('*').eq('vehicle_id', lead.vehicle_id).order('sort_order', { ascending: true }),
      supabase.from('part_groups').select('*').eq('vehicle_id', lead.vehicle_id).order('sort_order', { ascending: true }),
    ]).then(([partsRes, groupsRes]) => {
      if (partsRes.error || groupsRes.error) {
        setError('Could not load the configured parts for this vehicle.')
      } else {
        setCatalog((partsRes.data ?? []) as VehiclePart[])
        setGroups((groupsRes.data ?? []) as PartGroup[])
      }
      setLoadingCatalog(false)
    })
  }, [open, lead])

  const selectedIds = useMemo(() => new Set(parts.map((p) => p.id)), [parts])
  const available = catalog.filter((p) => !selectedIds.has(p.id))

  const updatePart = (id: string, patch: Partial<PartEntry>) => {
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const addPart = () => {
    const part = catalog.find((p) => p.id === addId)
    if (!part) return
    const group = groups.find((g) => g.id === part.group_id)
    const groupBoughtNew = !!part.group_id && parts.some((p) => p.group_id === part.group_id && p.type === 'new')
    const type: 'new' | 'send' = groupBoughtNew
      ? 'send'
      : (part.allow_send_parts && part.paint_price > 0 ? 'send' : 'new')
    const price = type === 'new' ? part.part_cost + part.paint_price : part.paint_price

    setParts((prev) => [...prev, {
      id: part.id,
      name: part.name,
      type,
      price,
      group_id: part.group_id,
      group_name: group?.name ?? null,
      highlight_color: part.highlight_color,
      ship_size: part.ship_size,
      lead_time_days: part.lead_time_days,
      part_cost: part.part_cost,
      paint_price: part.paint_price,
      priced: true,
    }])
    setAddId('')
  }

  const save = async () => {
    if (saving) return
    const cleaned = parts.map((p) => ({
      ...p,
      name: p.name.trim(),
      price: Math.max(0, Number(p.price) || 0),
      priced: true,
    }))
    if (cleaned.some((p) => !p.name)) {
      setError('Every build item needs a name.')
      return
    }
    setSaving(true)
    setError(null)
    const ok = await onSave(cleaned)
    setSaving(false)
    if (ok) setOpen(false)
    else setError('Could not save the build changes. Please try again.')
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={readOnly}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Pencil size={13} />
        Edit build
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => !saving && setOpen(false)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <div>
            <h2 className="text-lg font-bold text-zinc-900">Edit customer build</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Changes update this lead's working build and totals.</p>
          </div>
          <button type="button" onClick={() => !saving && setOpen(false)} className="text-zinc-400 hover:text-zinc-600 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="space-y-2">
            {parts.length === 0 ? (
              <p className="text-sm text-zinc-500 bg-zinc-50 border border-zinc-200 rounded-lg p-4 text-center">No parts in this build yet.</p>
            ) : parts.map((part) => (
              <div key={part.id} className="grid grid-cols-1 sm:grid-cols-[1fr_130px_130px_auto] gap-2 items-center border border-zinc-200 rounded-lg p-3">
                <input
                  value={part.name}
                  onChange={(e) => updatePart(part.id, { name: e.target.value })}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
                  aria-label="Part name"
                />
                <select
                  value={part.type}
                  onChange={(e) => updatePart(part.id, { type: e.target.value as 'new' | 'send', highlight_color: e.target.value === 'new' ? 'blue' : 'green' })}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
                  aria-label="Part type"
                >
                  <option value="new">Buy New</option>
                  <option value="send">Paint Mine</option>
                </select>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={Number(part.price) || 0}
                    onChange={(e) => updatePart(part.id, { price: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-full bg-zinc-50 border border-zinc-200 rounded-lg pl-7 pr-3 py-2 text-sm focus:outline-none focus:border-brand-500"
                    aria-label="Part price"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setParts((prev) => prev.filter((p) => p.id !== part.id))}
                  className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Remove part"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>

          <div className="border-t border-zinc-100 pt-4">
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Add configured part</label>
            {loadingCatalog ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 size={15} className="animate-spin" /> Loading parts…</div>
            ) : (
              <div className="flex gap-2">
                <select
                  value={addId}
                  onChange={(e) => setAddId(e.target.value)}
                  className="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
                >
                  <option value="">{available.length ? 'Choose a part…' : 'All configured parts are already included'}</option>
                  {available.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.name} · {formatCurrency(part.part_cost + part.paint_price)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addPart}
                  disabled={!addId}
                  className="inline-flex items-center gap-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                >
                  <Plus size={15} />
                  Add
                </button>
              </div>
            )}
          </div>

          {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex items-center justify-between gap-3 pt-4 border-t border-zinc-100">
            <p className="text-sm text-zinc-500">{parts.length} {parts.length === 1 ? 'part' : 'parts'} · {formatCurrency(parts.reduce((sum, p) => sum + (Number(p.price) || 0), 0))}</p>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              Save build
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
