import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, Lead, LeadNote, LeadStatus, PartEntry, ShipSize, formatCurrency, formatDate, formatDateTime, getHighlightColor, svgPathAnchor, estimateLeadTimeDays, DEFAULT_LEAD_TIME_MULTIPLIER } from '../lib/supabase'
import StatusSelect from '../components/StatusSelect'
import { useShopBilling } from '../lib/billing'
import ShopCustomPricingModal from '../components/ShopCustomPricingModal'
import LeadQuoteCard from '../components/LeadQuoteCard'
import LeadTimeline from '../components/LeadTimeline'
import LeadQuoteConversation from '../components/LeadQuoteConversation'
import PreconfiguredBuildEditor from '../components/PreconfiguredBuildEditor'
import { ArrowLeft, ArrowRight, Mail, Phone, MapPin, Calendar, DollarSign, Package, Send, User, Clock, Layers, Palette, Image as ImageIcon, Pencil, PencilRuler, type LucideIcon } from 'lucide-react'

const customUploadUrl = (path: string | null): string | null =>
  path ? supabase.storage.from('customer-uploads').getPublicUrl(path).data.publicUrl : null

const vehicleImageUrl = (path: string | null): string | null =>
  path ? supabase.storage.from('vehicles').getPublicUrl(path).data.publicUrl : null

const DEFAULT_SHIP_RATES: Record<ShipSize, number> = { small: 0, medium: 0, large: 0, 'x-large': 0 }

const PRECONFIGURED_NEXT_STEP: Partial<Record<LeadStatus, { status: LeadStatus; label: string }>> = {
  new: { status: 'contacted', label: 'Move to Contacted' },
  contacted: { status: 'scheduling', label: 'Move to Scheduling' },
  scheduling: { status: 'scheduled', label: 'Move to Scheduled' },
  scheduled: { status: 'in_progress', label: 'Start Work' },
  in_progress: { status: 'completed', label: 'Mark Completed' },
}

function PhotoOverlays({ boxes, onPick }: { boxes: PartEntry[]; onPick: (p: PartEntry) => void }) {
  return (
    <>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {boxes.filter((p) => p.box!.points && p.box!.points!.length >= 3).map((p) => {
          const priced = !!p.priced
          const color = p.type === 'new' ? 'rgb(59,130,246)' : 'rgb(16,185,129)'
          return (
            <polygon
              key={p.id}
              points={p.box!.points!.map((pt) => `${pt.x},${pt.y}`).join(' ')}
              fill={priced ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.12)'}
              stroke={color}
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
              className="cursor-pointer"
              onClick={() => onPick(p)}
            >
              <title>{`${p.name} — click to price`}</title>
            </polygon>
          )
        })}
      </svg>
      {boxes.filter((p) => !(p.box!.points && p.box!.points!.length >= 3)).map((p) => {
        const priced = !!p.priced
        const color = p.type === 'new' ? 'rgb(59,130,246)' : 'rgb(16,185,129)'
        return (
          <button
            key={p.id}
            onClick={() => onPick(p)}
            title={`${p.name} — click to price`}
            className="absolute"
            style={{
              left: `${p.box!.x}%`, top: `${p.box!.y}%`,
              width: `${p.box!.w}%`, height: `${p.box!.h}%`,
              backgroundColor: priced ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.12)',
              border: `2px solid ${color}`,
            }}
          />
        )
      })}
      {boxes.map((p) => {
        const priced = !!p.priced
        return (
          <button
            key={`lbl-${p.id}`}
            onClick={() => onPick(p)}
            className="absolute whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-900/90 text-white hover:bg-zinc-900 transition-colors"
            style={{ left: `${p.box!.x}%`, top: `${Math.max(0, p.box!.y)}%`, transform: 'translateY(-115%)' }}
          >
            {p.name}{priced ? ` · ${formatCurrency(p.price)}` : ''}
          </button>
        )
      })}
    </>
  )
}

function TemplateOverlays({ parts }: { parts: PartEntry[] }) {
  return (
    <>
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {parts.map((p) => {
          const c = getHighlightColor(p.highlight_color ?? 'green')
          return (
            <path
              key={p.id}
              d={p.svg_path!}
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth={0.4}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>
      {parts.map((p) => {
        const a = svgPathAnchor(p.svg_path!)
        return (
          <span
            key={`lbl-${p.id}`}
            className="absolute whitespace-nowrap text-[10px] font-semibold px-1.5 py-0.5 rounded bg-zinc-900/90 text-white pointer-events-none"
            style={{ left: `${a.x}%`, top: `${a.y}%`, transform: 'translateY(-115%)' }}
          >
            {p.name}{p.price > 0 ? ` \u00b7 ${formatCurrency(p.price)}` : ''}
          </span>
        )
      })}
    </>
  )
}

export default function LeadDetailPage() {
  const { leadId } = useParams<{ leadId: string }>()
  const { profile } = useAuth()
  const { readOnly } = useShopBilling()
  const navigate = useNavigate()
  const [lead, setLead] = useState<Lead | null>(null)
  const [notes, setNotes] = useState<LeadNote[]>([])
  const [newNote, setNewNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [submittingNote, setSubmittingNote] = useState(false)
  const [shipRates, setShipRates] = useState<Record<ShipSize, number>>(DEFAULT_SHIP_RATES)
  const [leadMultiplier, setLeadMultiplier] = useState<number>(DEFAULT_LEAD_TIME_MULTIPLIER)
  const [pricingItem, setPricingItem] = useState<PartEntry | null>(null)
  const [savingPrice, setSavingPrice] = useState(false)
  const [enlarged, setEnlarged] = useState<{ url: string; label: string; view: 'front' | 'rear' } | null>(null)
  const [templateImages, setTemplateImages] = useState<{ front: string | null; rear: string | null }>({ front: null, rear: null })
  const [partShapes, setPartShapes] = useState<Map<string, { svg_path: string | null; alt_view_svg_path: string | null; view: 'front' | 'rear' }>>(new Map())
  const [editingPreconfiguredBuild, setEditingPreconfiguredBuild] = useState(false)

  const loadLead = useCallback(async () => {
    if (!leadId) return
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .maybeSingle()
    if (error) {
      console.error('Failed to load lead:', error.message)
    } else {
      setLead(data as Lead | null)
    }
    setLoading(false)
  }, [leadId])

  const loadNotes = useCallback(async () => {
    if (!leadId) return
    const { data, error } = await supabase
      .from('lead_notes')
      .select('*, author:profiles!lead_notes_author_id_fkey(full_name)')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('Failed to load notes:', error.message)
    } else {
      setNotes((data ?? []).map((n: Record<string, unknown>) => ({
        id: n.id as string,
        lead_id: n.lead_id as string,
        author_id: n.author_id as string,
        body: n.body as string,
        created_at: n.created_at as string,
        author_name: (n.author as { full_name?: string })?.full_name ?? 'Unknown',
      })))
    }
  }, [leadId])

  useEffect(() => {
    loadLead()
    loadNotes()
  }, [loadLead, loadNotes])

  useEffect(() => {
    if (!profile?.shop_id) return
    supabase.from('shops').select('customizer_config').eq('id', profile.shop_id).maybeSingle()
      .then(({ data }) => {
        const cfg = (data?.customizer_config ?? {}) as Record<string, unknown>
        const rates = cfg.shipping_rates as Record<ShipSize, number> | undefined
        if (rates) setShipRates({ ...DEFAULT_SHIP_RATES, ...rates })
        const mult = cfg.lead_time_multiplier as number | undefined
        if (typeof mult === 'number') setLeadMultiplier(mult)
      })
  }, [profile?.shop_id])

  // For pre-configured vehicles the customer uploads no photos, so load the
  // vehicle template images and each part's highlight shape to display them.
  useEffect(() => {
    const uploaded = customUploadUrl(lead?.front_image_url ?? null) || customUploadUrl(lead?.rear_image_url ?? null)
    if (!lead || uploaded || !lead.vehicle_id) return
    let active = true
    ;(async () => {
      const [{ data: vehicle }, { data: vehicleParts }] = await Promise.all([
        supabase.from('vehicles').select('front_image_path, rear_image_path').eq('id', lead.vehicle_id).maybeSingle(),
        supabase.from('vehicle_parts').select('id, svg_path, alt_view_svg_path, view').eq('vehicle_id', lead.vehicle_id),
      ])
      if (!active) return
      setTemplateImages({
        front: vehicleImageUrl(vehicle?.front_image_path ?? null),
        rear: vehicleImageUrl(vehicle?.rear_image_path ?? null),
      })
      setPartShapes(new Map((vehicleParts ?? []).map((v) => [v.id, { svg_path: v.svg_path, alt_view_svg_path: v.alt_view_svg_path, view: v.view as 'front' | 'rear' }])))
    })()
    return () => { active = false }
  }, [lead])

  const handleSavePrice = async (updated: PartEntry) => {
    if (!lead) return
    setSavingPrice(true)
    const parts = (Array.isArray(lead.selected_parts) ? lead.selected_parts : []).map((p) =>
      p.id === updated.id ? updated : p
    )
    const partsTotal = parts.reduce((sum, p) => sum + (p.price || 0), 0)
    const shippingTotal = lead.fulfillment_mode === 'mail'
      ? parts.reduce((sum, p) => sum + (shipRates[p.ship_size ?? 'medium'] ?? 0), 0)
      : 0
    const leadTime = estimateLeadTimeDays(parts.map((p) => p.lead_time_days ?? 0), leadMultiplier)
    const grandTotal = partsTotal + shippingTotal
    const { error } = await supabase.from('leads').update({
      selected_parts: parts,
      parts_total: partsTotal,
      shipping_total: shippingTotal,
      grand_total: grandTotal,
      estimated_lead_time_days: leadTime,
    }).eq('id', lead.id)
    setSavingPrice(false)
    if (error) {
      console.error('Failed to save price:', error.message)
      return
    }
    setLead({
      ...lead,
      selected_parts: parts,
      parts_total: partsTotal,
      shipping_total: shippingTotal,
      grand_total: grandTotal,
      estimated_lead_time_days: leadTime,
    })
    setPricingItem(null)
  }

  const handleStatusChange = async (status: LeadStatus) => {
    if (!lead) return
    setLead({ ...lead, status })
    const { error } = await supabase.from('leads').update({ status }).eq('id', lead.id)
    if (error) {
      console.error('Failed to update status:', error.message)
      loadLead()
    }
  }

  const handleAddNote = async () => {
    if (!newNote.trim() || !leadId || !profile) return
    setSubmittingNote(true)
    const { data, error } = await supabase
      .from('lead_notes')
      .insert({ lead_id: leadId, author_id: profile.id, body: newNote.trim() })
      .select('*, author:profiles!lead_notes_author_id_fkey(full_name)')
      .single()
    if (error) {
      console.error('Failed to add note:', error.message)
    } else {
      setNotes((prev) => [{
        id: data.id,
        lead_id: data.lead_id,
        author_id: data.author_id,
        body: data.body,
        created_at: data.created_at,
        author_name: (data.author as { full_name?: string })?.full_name ?? 'Unknown',
      }, ...prev])
      setNewNote('')
    }
    setSubmittingNote(false)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-zinc-300 border-t-brand-500 rounded-full animate-spin" />
      </div>
    )
  }

  if (!lead) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 font-medium">Lead not found</p>
          <button onClick={() => navigate('/dashboard')} className="text-sm text-brand-600 hover:underline mt-2">
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  const parts: PartEntry[] =
    Array.isArray(lead.selected_parts) ? lead.selected_parts : []

  const enrichedParts: PartEntry[] = parts.map((p) => {
    if (p.box) return p
    const shape = partShapes.get(p.id)
    return shape?.svg_path ? { ...p, svg_path: shape.svg_path, alt_view_svg_path: shape.alt_view_svg_path, view: shape.view } : p
  })
  const hasTemplatePhotos = !lead.is_custom && (templateImages.front || templateImages.rear)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-4xl mx-auto">
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 mb-4 transition-colors"
        >
          <ArrowLeft size={16} />
          Back to leads
        </button>

        {/* Header */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl font-bold text-zinc-900">{lead.customer_name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-sm text-zinc-500">{lead.vehicle_name}</p>
                {lead.is_custom && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5">
                    <PencilRuler size={11} /> Custom build
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Workflow</span>
              <StatusSelect status={lead.status} isCustom={lead.is_custom} onChange={handleStatusChange} disabled={readOnly} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <InfoRow icon={Mail} label="Email" value={lead.customer_email} />
            {lead.customer_phone && <InfoRow icon={Phone} label="Phone" value={lead.customer_phone} />}
            {lead.customer_address && <InfoRow icon={MapPin} label="Address" value={lead.customer_address} />}
            {lead.customer_state && <InfoRow icon={MapPin} label="State" value={lead.customer_state} />}
            {lead.paint_code && <InfoRow icon={Palette} label="Paint Code" value={lead.paint_code} />}
            {lead.target_start_date && <InfoRow icon={Calendar} label="Target Start" value={formatDate(lead.target_start_date)} />}
            <InfoRow icon={Calendar} label="Submitted" value={formatDateTime(lead.submitted_at)} />
            <InfoRow icon={Package} label="Fulfillment" value={lead.fulfillment_mode === 'local' ? 'Local Drop-off' : 'Mail-Order DIY'} />
            {lead.estimated_lead_time_days > 0 && (
              <InfoRow icon={Clock} label="Est. Lead Time" value={`${lead.estimated_lead_time_days} ${lead.estimated_lead_time_days === 1 ? 'day' : 'days'}`} />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-5 pt-5 border-t border-zinc-100">
            <a
              href={`mailto:${lead.customer_email}?subject=${encodeURIComponent(`Your ${lead.vehicle_name} request`)}`}
              className="flex items-center gap-2 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              <Mail size={15} />
              Email customer
            </a>
            {lead.customer_phone && (
              <a
                href={`tel:${lead.customer_phone}`}
                className="flex items-center gap-2 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                <Phone size={15} />
                Call {lead.customer_phone}
              </a>
            )}
            {!lead.is_custom && PRECONFIGURED_NEXT_STEP[lead.status] && (
              <button
                onClick={() => handleStatusChange(PRECONFIGURED_NEXT_STEP[lead.status]!.status)}
                disabled={readOnly}
                className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                {PRECONFIGURED_NEXT_STEP[lead.status]!.label}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Customer photos (custom builds) */}
        {lead.is_custom && (customUploadUrl(lead.front_image_url) || customUploadUrl(lead.rear_image_url)) && (
          <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
            <h2 className="text-sm font-semibold text-zinc-900 mb-1 flex items-center gap-2">
              <ImageIcon size={16} className="text-zinc-400" />
              Customer Photos
            </h2>
            <p className="text-xs text-zinc-500 mb-3">Click a highlighted area to set its pricing.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([['Front 3/4', 'front', lead.front_image_url], ['Rear', 'rear', lead.rear_image_url]] as const).map(([label, view, path]) => {
                const url = customUploadUrl(path)
                if (!url) return null
                const boxes = parts.filter((p) => p.box && p.box.view === view)
                return (
                  <div key={label}>
                    <div className="relative rounded-lg overflow-hidden border border-zinc-200 select-none">
                      <img src={url} alt={label} className="w-full h-auto block" />
                      <PhotoOverlays boxes={boxes} onPick={setPricingItem} />
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-zinc-500">{label}</span>
                      <button onClick={() => setEnlarged({ url, label, view })} className="text-xs text-brand-600 hover:underline">Enlarge</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Vehicle photos with selected-part highlights (pre-configured builds) */}
        {hasTemplatePhotos && (
          <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
            <h2 className="text-sm font-semibold text-zinc-900 mb-1 flex items-center gap-2">
              <ImageIcon size={16} className="text-zinc-400" />
              Selected Parts
            </h2>
            <p className="text-xs text-zinc-500 mb-3">The areas the customer chose, highlighted on the vehicle.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([['Front 3/4', 'front', templateImages.front], ['Rear', 'rear', templateImages.rear]] as const).map(([label, view, url]) => {
                if (!url) return null
                const shapes = enrichedParts.filter((p) => p.svg_path && p.view === view)
                return (
                  <div key={label}>
                    <div className="relative rounded-lg overflow-hidden border border-zinc-200 select-none">
                      <img src={url} alt={label} className="w-full h-auto block" />
                      <TemplateOverlays parts={shapes} />
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-zinc-500">{label}</span>
                      <button onClick={() => setEnlarged({ url, label, view })} className="text-xs text-brand-600 hover:underline">Enlarge</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Pricing summary */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
          <h2 className="text-sm font-semibold text-zinc-900 mb-3 flex items-center gap-2">
            <DollarSign size={16} className="text-zinc-400" />
            Pricing Summary
          </h2>
          {lead.is_custom && parts.some((p) => !p.priced) && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
              {parts.filter((p) => !p.priced).length} of {parts.length} parts still need pricing. Click a highlighted area on the customer photos, or a part below, to set its price.
            </p>
          )}
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between text-zinc-600">
              <span>Parts & Labor</span>
              <span className="font-medium">{formatCurrency(lead.parts_total)}</span>
            </div>
            <div className="flex justify-between text-zinc-600">
              <span>Shipping</span>
              <span className="font-medium">{formatCurrency(lead.shipping_total)}</span>
            </div>
            <div className="flex justify-between text-zinc-900 font-bold pt-2 border-t border-zinc-100">
              <span>Grand Total</span>
              <span>{formatCurrency(lead.grand_total)}</span>
            </div>
          </div>
        </div>

        {/* Selected parts */}
        {parts.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <h2 className="text-sm font-semibold text-zinc-900">Build Details ({parts.length} {parts.length === 1 ? 'part' : 'parts'})</h2>
              {!lead.is_custom && !readOnly && (
                <button
                  onClick={() => setEditingPreconfiguredBuild(true)}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg px-3 py-1.5 transition-colors"
                >
                  <Pencil size={14} />
                  Edit build
                </button>
              )}
            </div>
            {(() => {
              const groupIsBuyNew = (gid: string | null | undefined) => parts.some((p) => p.group_id === gid && p.type === 'new')

              const renderPartBody = (part: PartEntry) => (
                <>
                  {part.paint_style_name && (
                    <p className="text-xs text-zinc-500 mt-0.5 ml-5">Paint style: {part.paint_style_name}</p>
                  )}
                  {part.notes && (
                    <p className="text-xs text-zinc-600 mt-0.5 ml-5 whitespace-pre-wrap">{part.notes}</p>
                  )}
                  {part.reference_image_path && customUploadUrl(part.reference_image_path) && (
                    <a
                      href={customUploadUrl(part.reference_image_path)!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline mt-0.5 ml-5"
                    >
                      <ImageIcon size={12} /> View reference photo
                    </a>
                  )}
                  {part.selected_options && part.selected_options.length > 0 && (
                    <ul className="text-xs text-zinc-500 mt-0.5 ml-5 space-y-0.5">
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
                  <div key={gid} className="border border-zinc-200 rounded-lg overflow-hidden">
                    <div className="bg-zinc-50 px-3 py-1.5 flex items-center gap-2 border-b border-zinc-100">
                      <Layers size={12} className="text-zinc-400" />
                      <span className="text-xs font-semibold text-zinc-600">{gName}</span>
                    </div>
                    <div className="p-2 space-y-2">
                      {groupParts.map((part, idx) => (
                        <div key={part.id} className="py-1">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`}></span>
                              <span className="text-sm text-zinc-700 truncate">{part.name}</span>
                              {idx !== 0 && <span className="text-xs text-zinc-400 italic">already purchased</span>}
                            </div>
                            <span className="text-sm font-medium text-zinc-900 flex-shrink-0">{lead.is_custom ? '—' : formatCurrency(part.price)}</span>
                          </div>
                          {renderPartBody(part)}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              }

              const renderUngrouped = (part: PartEntry) => (
                <div key={part.id} className="py-2 border-b border-zinc-100 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`}></span>
                      <span className="text-sm text-zinc-700 truncate">{part.name}</span>
                    </div>
                    {lead.is_custom ? (
                      readOnly ? (
                        <span className="text-sm font-medium text-zinc-900 flex-shrink-0">{part.priced ? formatCurrency(part.price) : '—'}</span>
                      ) : (
                      <button
                        onClick={() => setPricingItem(part)}
                        className={`text-sm font-medium flex-shrink-0 rounded-md px-2.5 py-1 transition-colors ${
                          part.priced
                            ? 'text-zinc-900 hover:bg-zinc-100'
                            : 'text-brand-600 bg-brand-50 hover:bg-brand-100'
                        }`}
                      >
                        {part.priced ? formatCurrency(part.price) : 'Set price'}
                      </button>
                      )
                    ) : (
                      <span className="text-sm font-medium text-zinc-900 flex-shrink-0">{formatCurrency(part.price)}</span>
                    )}
                  </div>
                  {renderPartBody(part)}
                </div>
              )

              const allGroupIds = Array.from(new Set(parts.filter((p) => p.group_id).map((p) => p.group_id)))
              const buyNewGroups = allGroupIds.filter((gid) => groupIsBuyNew(gid))
              const paintGroups = allGroupIds.filter((gid) => !groupIsBuyNew(gid))
              const buyNewParts = parts.filter((p) => !p.group_id && p.type === 'new')
              const paintParts = parts.filter((p) => !p.group_id && p.type === 'send')

              const buyNewCount = buyNewParts.length + buyNewGroups.reduce((n, gid) => n + parts.filter((p) => p.group_id === gid).length, 0)
              const paintCount = paintParts.length + paintGroups.reduce((n, gid) => n + parts.filter((p) => p.group_id === gid).length, 0)

              return (
                <div className="space-y-5">
                  {buyNewCount > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-blue-600">Buy New</span>
                        <span className="text-xs text-zinc-400">({buyNewCount})</span>
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
                        <span className="text-xs font-bold uppercase tracking-wider text-emerald-600">Paint Mine</span>
                        <span className="text-xs text-zinc-400">({paintCount})</span>
                      </div>
                      <div className="space-y-2">
                        {paintGroups.map((gid) => renderGroup(gid))}
                        {paintParts.map((part) => renderUngrouped(part))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}

        {/* Only custom-upload leads need a separate customer quote; preconfigured
            leads already carry the instant price the customer saw. */}
        {lead.is_custom && <LeadQuoteCard lead={lead} readOnly={readOnly} />}
        {lead.is_custom && <LeadQuoteConversation lead={lead} readOnly={readOnly} />}

        <LeadTimeline leadId={lead.id} refreshKey={lead.status} />

        {/* Notes section */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6">
          <h2 className="text-sm font-semibold text-zinc-900 mb-4">Internal Notes</h2>

          <div className="flex gap-2 mb-4">
            <textarea
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder={readOnly ? 'Notes are read-only while your trial is expired' : 'Add a note about this lead…'}
              rows={2}
              disabled={readOnly}
              className="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors resize-none disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <button
              onClick={handleAddNote}
              disabled={!newNote.trim() || submittingNote || readOnly}
              className="self-end bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              <Send size={14} />
              Add
            </button>
          </div>

          {notes.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-4">No notes yet</p>
          ) : (
            <div className="space-y-3">
              {notes.map((note) => (
                <div key={note.id} className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="w-6 h-6 bg-zinc-200 rounded-full flex items-center justify-center">
                      <User size={12} className="text-zinc-500" />
                    </div>
                    <span className="text-xs font-medium text-zinc-700">{note.author_name}</span>
                    <span className="text-xs text-zinc-400">{formatDateTime(note.created_at)}</span>
                  </div>
                  <p className="text-sm text-zinc-600 pl-8">{note.body}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {editingPreconfiguredBuild && !lead.is_custom && (
        <PreconfiguredBuildEditor
          lead={lead}
          shipRates={shipRates}
          leadMultiplier={leadMultiplier}
          onClose={() => setEditingPreconfiguredBuild(false)}
          onSaved={(updated) => {
            setLead(updated)
            setEditingPreconfiguredBuild(false)
          }}
        />
      )}

      {pricingItem && (
        <ShopCustomPricingModal
          item={pricingItem}
          onClose={() => { if (!savingPrice) setPricingItem(null) }}
          onSave={handleSavePrice}
        />
      )}

      {enlarged && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setEnlarged(null)}
        >
          <div className="relative max-w-4xl w-full max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-white">{enlarged.label}</span>
              <button
                onClick={() => setEnlarged(null)}
                className="text-white/80 hover:text-white text-sm font-medium bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5 transition-colors"
              >
                Close
              </button>
            </div>
            <div className="relative rounded-lg overflow-hidden select-none bg-black">
              <img src={enlarged.url} alt={enlarged.label} className="w-full h-auto block" />
              <PhotoOverlays boxes={parts.filter((p) => p.box && p.box.view === enlarged.view)} onPick={setPricingItem} />
              <TemplateOverlays parts={enrichedParts.filter((p) => p.svg_path && p.view === enlarged.view)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon size={14} className="text-zinc-400 flex-shrink-0" />
      <div>
        <p className="text-xs text-zinc-400">{label}</p>
        <p className="text-sm text-zinc-700">{value}</p>
      </div>
    </div>
  )
}
