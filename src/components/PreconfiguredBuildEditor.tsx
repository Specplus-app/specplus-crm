import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Save, Trash2, X } from 'lucide-react'
import {
  estimateLeadTimeDays,
  formatCurrency,
  Lead,
  PartEntry,
  PartGroup,
  ShipSize,
  shipSizeRank,
  supabase,
  VehiclePart,
} from '../lib/supabase'

export default function PreconfiguredBuildEditor({
  lead,
  shipRates,
  leadMultiplier,
  onClose,
  onSaved,
}: {
  lead: Lead
  shipRates: Record<ShipSize, number>
  leadMultiplier: number
  onClose: () => void
  onSaved: (updated: Lead) => void
}) {
  const [parts, setParts] = useState<PartEntry[]>(() =>
    (Array.isArray(lead.selected_parts) ? lead.selected_parts : []).map((p) => ({ ...p }))
  )
  const [catalog, setCatalog] = useState<VehiclePart[]>([])
  const [groups, setGroups] = useState<PartGroup[]>([])
  const [addPartId, setAddPartId] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([
      supabase.from('vehicle_parts').select('*').eq('vehicle_id', lead.vehicle_id).order('sort_order', { ascending: true }),
      supabase.from('part_groups').select('*').eq('vehicle_id', lead.vehicle_id).order('sort_order', { ascending: true }),
    ]).then(([partsRes, groupsRes]) => {
      if (!active) return
      if (partsRes.error || groupsRes.error) {
        setError('Could not load the vehicle build options.')
      } else {
        setCatalog((partsRes.data ?? []) as VehiclePart[])
        setGroups((groupsRes.data ?? []) as PartGroup[])
      }
      setLoadingCatalog(false)
    })
    return () => { active = false }
  }, [lead.vehicle_id])

  const groupNames = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups]
  )

  const availableParts = useMemo(
    () => catalog.filter((p) => !parts.some((selected) => selected.id === p.id)),
    [catalog, parts]
  )

  const updatePart = (id: string, patch: Partial<PartEntry>) => {
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const addPart = () => {
    const source = catalog.find((p) => p.id === addPartId)
    if (!source) return

    const groupAlreadyBoughtNew = source.group_id
      ? parts.some((p) => p.group_id === source.group_id && p.type === 'new')
      : false
    const type: 'new' | 'send' = groupAlreadyBoughtNew
      ? 'send'
      : source.allow_send_parts && source.paint_price > 0
        ? 'send'
        : 'new'
    const price = type === 'new'
      ? Number(source.part_cost || 0) + Number(source.paint_price || 0)
      : Number(source.paint_price || 0)

    setParts((prev) => [...prev, {
      id: source.id,
      name: source.name,
      type,
      price,
      group_id: source.group_id,
      group_name: source.group_id ? groupNames.get(source.group_id) ?? null : null,
      highlight_color: source.highlight_color,
      ship_size: source.ship_size,
      lead_time_days: source.lead_time_days,
      priced: true,
    }])
    setAddPartId('')
  }

  const calculateShipping = (nextParts: PartEntry[]) => {
    if (lead.fulfillment_mode !== 'mail') return 0

    const groupIds = Array.from(new Set(nextParts.filter((p) => p.group_id).map((p) => p.group_id!)))
    let total = 0

    for (const groupId of groupIds) {
      const groupParts = nextParts.filter((p) => p.group_id === groupId)
      if (groupParts.length === 0) continue
      const largest = groupParts.reduce((max, part) =>
        shipSizeRank(part.ship_size ?? 'medium') > shipSizeRank(max.ship_size ?? 'medium') ? part : max
      )
      total += shipRates[largest.ship_size ?? 'medium'] ?? 0
    }

    for (const part of nextParts.filter((p) => !p.group_id)) {
      total += shipRates[part.ship_size ?? 'medium'] ?? 0
    }

    return total
  }

  const save = async () => {
    if (saving) return
    if (parts.length === 0) {
      setError('Keep at least one part on the build.')
      return
    }

    setSaving(true)
    setError(null)

    const normalized = parts.map((p) => ({
      ...p,
      name: p.name.trim() || 'Part',
      price: Math.max(0, Number(p.price) || 0),
      priced: true,
    }))
    const partsTotal = normalized.reduce((sum, p) => sum + p.price, 0)
    const shippingTotal = calculateShipping(normalized)
    const grandTotal = partsTotal + shippingTotal
    const estimatedLeadTimeDays = estimateLeadTimeDays(
      normalized.map((p) => p.lead_time_days ?? 0),
      leadMultiplier,
    )

    const { data, error: saveError } = await supabase
      .from('leads')
      .update({
        selected_parts: normalized,
        parts_total: partsTotal,
        shipping_total: shippingTotal,
        grand_total: grandTotal,
        estimated_lead_time_days: estimatedLeadTimeDays,
      })
      .eq('id', lead.id)
      .select('*')
      .single()

    setSaving(false)
    if (saveError || !data) {
      setError(saveError?.message ?? 'Could not save the build.')
      return
    }

    onSaved(data as Lead)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <div>
            <h2 className="text-lg font-bold text-zinc-900">Edit Build</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Add, remove, or adjust the parts on this preconfigured submission.</p>
          </div>
          <button onClick={onClose} disabled={saving} className="text-zinc-400 hover:text-zinc-600 disabled:opacity-40 transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="space-y-2">
            {parts.map((part) => (
              <div key={part.id} className="border border-zinc-200 rounded-xl p-3">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px_130px_auto] gap-2 items-end">
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Part</label>
                    <input
                      value={part.name}
                      onChange={(e) => updatePart(part.id, { name: e.target.value })}
                      className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Type</label>
                    <select
                      value={part.type}
                      onChange={(e) => updatePart(part.id, {
                        type: e.target.value as 'new' | 'send',
                        highlight_color: e.target.value === 'new' ? 'blue' : 'green',
                      })}
                      className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                    >
                      <option value="new">Buy New</option>
                      <option value="send">Paint Mine</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">Price</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={Number(part.price) || 0}
                      onChange={(e) => updatePart(part.id, { price: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  <button
                    onClick={() => setParts((prev) => prev.filter((p) => p.id !== part.id))}
                    className="h-10 w-10 inline-flex items-center justify-center rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    title="Remove part"
                    aria-label={`Remove ${part.name}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {part.selected_options && part.selected_options.length > 0 && (
                  <p className="text-xs text-zinc-500 mt-2">
                    Customer options: {part.selected_options.map((option) => option.name).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-zinc-100 pt-4">
            <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Add vehicle part</label>
            {loadingCatalog ? (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <Loader2 size={15} className="animate-spin" /> Loading parts…
              </div>
            ) : availableParts.length > 0 ? (
              <div className="flex gap-2">
                <select
                  value={addPartId}
                  onChange={(e) => setAddPartId(e.target.value)}
                  className="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                >
                  <option value="">Choose a part…</option>
                  {availableParts.map((part) => (
                    <option key={part.id} value={part.id}>{part.name}</option>
                  ))}
                </select>
                <button
                  onClick={addPart}
                  disabled={!addPartId}
                  className="inline-flex items-center gap-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  <Plus size={15} /> Add
                </button>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">All available vehicle parts are already on this build.</p>
            )}
          </div>

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex items-center justify-between gap-3 pt-4 border-t border-zinc-100">
            <div>
              <p className="text-xs text-zinc-500">Parts total</p>
              <p className="text-lg font-bold text-zinc-900">{formatCurrency(parts.reduce((sum, p) => sum + (Number(p.price) || 0), 0))}</p>
            </div>
            <div className="flex gap-2">
              <button onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-zinc-200 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={save} disabled={saving || parts.length === 0} className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm font-semibold transition-colors">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                Save Build
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
