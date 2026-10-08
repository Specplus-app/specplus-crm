import { supabase, Lead, LeadEvent, LeadStatus, LEAD_STATUSES, PartEntry, Quote, QuoteLineItem, QuoteStatus } from './supabase'
import { ensureDraftQuote, initialQuoteValues, type EnsureDraftResult } from './quoteRules'
import { formatDateOnly, isDateOnly } from './scheduleDates'

// Customer quote links always point at the public quotes domain, matching the
// shop customizer link on the dashboard. Use this for anything a customer
// receives (copied links, emails).
export const PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'

// Approved SpecPlus Vercel preview deployments. Only hostnames ending exactly
// with this suffix are trusted, not arbitrary *.vercel.app domains.
const PREVIEW_HOST_SUFFIX = '-spec-plus.vercel.app'

export function customerQuoteUrl(token: string): string {
  // On a PR preview, customer links must point at that preview so testers can
  // follow them before the frontend reaches production.
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && window.location.hostname.endsWith(PREVIEW_HOST_SUFFIX)) {
    return `${window.location.origin}/q/${token}`
  }
  return `${PUBLIC_QUOTE_ORIGIN}/q/${token}`
}

export const MESSAGE_MAX_LENGTH = 5000

// Staff previews open on the current app origin, where the CRM session exists,
// so the public RPCs recognize the signed-in shop user and do not count the
// visit as a customer view.
export function staffPreviewUrl(token: string): string {
  return `${window.location.origin}/q/${token}`
}

export const QUOTE_STATUS_META: Record<QuoteStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'bg-zinc-100 text-zinc-600 border-zinc-200' },
  sent: { label: 'Sent', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  viewed: { label: 'Viewed', color: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200' },
  approved: { label: 'Approved', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  declined: { label: 'Declined', color: 'bg-red-100 text-red-700 border-red-200' },
}

// Pricing, pricing completeness and draft rules live in quoteRules (pure, unit
// tested) and are re-exported here for existing imports.
export {
  round2, lineItemTotal, calculateQuoteTotals, partNeedsPrice, partsNeedingPrice,
  initialQuoteValues, leadBuildDiffersFromQuote,
} from './quoteRules'
export type { QuoteTotals } from './quoteRules'

// Expiration is a calendar date that remains valid through the end of that day
// (UTC, matching the database's current_date check).
export function isQuoteExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const today = new Date().toISOString().slice(0, 10)
  return expiresAt < today
}

export function formatQuoteDate(date: string): string {
  // Date-only values are rendered as calendar dates, never shifted by timezone.
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function newLineItem(): QuoteLineItem {
  return { id: randomId(), description: '', quantity: 1, unit_price: 0 }
}

// Per-tab identifier used to deduplicate customer views of a quote.
export function quoteViewSessionId(token: string): string {
  const key = `specplus.quote-view.${token}`
  try {
    const existing = sessionStorage.getItem(key)
    if (existing && existing.length >= 8) return existing
    const id = randomId()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return randomId()
  }
}

// ---------------------------------------------------------------------------
// Creating quotes
// ---------------------------------------------------------------------------

const customUploadUrl = (path: string | null): string | null =>
  path ? supabase.storage.from('customer-uploads').getPublicUrl(path).data.publicUrl : null

const vehicleImageUrl = (path: string | null): string | null =>
  path ? supabase.storage.from('vehicles').getPublicUrl(path).data.publicUrl : null

// Builds the visual snapshot for a quote the same way the build sheet does:
// custom builds use the customer's uploaded photos (box/polygon data is kept on
// each part), template vehicles use the vehicle images plus each selected
// part's current highlight shape. Part prices always come from the lead.
export async function leadVisualSnapshot(lead: Lead): Promise<{
  selected_parts: PartEntry[]
  front_image_url: string | null
  rear_image_url: string | null
}> {
  const parts: PartEntry[] = Array.isArray(lead.selected_parts) ? lead.selected_parts : []
  let frontUrl = customUploadUrl(lead.front_image_url)
  let rearUrl = customUploadUrl(lead.rear_image_url)
  let snapshotParts = parts.map((p) => ({ ...p }))

  if (!frontUrl && !rearUrl && lead.vehicle_id) {
    const [{ data: vehicle }, { data: vehicleParts }] = await Promise.all([
      supabase.from('vehicles').select('front_image_path, rear_image_path').eq('id', lead.vehicle_id).maybeSingle(),
      supabase.from('vehicle_parts').select('id, svg_path, alt_view_svg_path, view').eq('vehicle_id', lead.vehicle_id),
    ])
    frontUrl = vehicleImageUrl(vehicle?.front_image_path ?? null)
    rearUrl = vehicleImageUrl(vehicle?.rear_image_path ?? null)
    const shapeById = new Map((vehicleParts ?? []).map((v) => [v.id, v]))
    snapshotParts = snapshotParts.map((p) => {
      if (p.box) return p
      const shape = shapeById.get(p.id)
      return shape?.svg_path
        ? { ...p, svg_path: shape.svg_path, alt_view_svg_path: shape.alt_view_svg_path, view: shape.view as 'front' | 'rear' }
        : p
    })
  }

  return { selected_parts: snapshotParts, front_image_url: frontUrl, rear_image_url: rearUrl }
}

type CreateResult = { quote: Quote | null; error: string | null }

// Snapshot the lead's configuration into a new draft quote. The lead itself is
// never modified by quote pricing.
export async function createInitialQuote(lead: Lead): Promise<CreateResult> {
  const visual = await leadVisualSnapshot(lead)
  const initial = initialQuoteValues(lead)
  const { data, error } = await supabase
    .from('quotes')
    .insert({
      lead_id: lead.id,
      selected_parts: visual.selected_parts,
      custom_line_items: [],
      shipping_total: initial.shipping_total,
      discount_amount: 0,
      tax_rate: 0,
      estimated_lead_time_days: initial.estimated_lead_time_days,
      front_image_url: visual.front_image_url,
      rear_image_url: visual.rear_image_url,
    })
    .select('*')
    .single()
  if (error) return { quote: null, error: error.message }
  return { quote: data as Quote, error: null }
}

// A revision is a new draft that copies the previous quote's commercial
// snapshot. The previous quote stays untouched until the revision is sent.
export async function createQuoteRevision(previous: Quote): Promise<CreateResult> {
  const { data, error } = await supabase
    .from('quotes')
    .insert({
      lead_id: previous.lead_id,
      supersedes_quote_id: previous.id,
      selected_parts: previous.selected_parts,
      custom_line_items: previous.custom_line_items,
      shipping_total: previous.shipping_total,
      discount_amount: previous.discount_amount,
      tax_rate: previous.tax_rate,
      estimated_lead_time_days: previous.estimated_lead_time_days,
      customer_notes: previous.customer_notes,
      internal_notes: previous.internal_notes,
      expires_at: null,
      front_image_url: previous.front_image_url,
      rear_image_url: previous.rear_image_url,
    })
    .select('*')
    .single()
  if (error) return { quote: null, error: error.message }
  return { quote: data as Quote, error: null }
}

// Opens the lead's draft quote, reusing an existing one rather than creating a
// duplicate. `revise` creates a new revision when the latest quote was sent.
export async function openDraftQuote(lead: Lead, options: { revise: boolean }): Promise<EnsureDraftResult> {
  return ensureDraftQuote({
    listQuotes: async () => {
      const { data, error } = await supabase.from('quotes').select('*').eq('lead_id', lead.id)
      return { quotes: ((data ?? []) as Quote[]).map(normalizeQuote), error: error?.message ?? null }
    },
    createInitial: () => createInitialQuote(lead),
    createRevision: (previous) => createQuoteRevision(previous),
  }, options)
}

// Numeric columns can arrive from PostgREST as strings; normalize once.
export function normalizeQuote(row: Quote): Quote {
  const num = (v: unknown) => Number(v) || 0
  return {
    ...row,
    selected_parts: Array.isArray(row.selected_parts) ? row.selected_parts : [],
    custom_line_items: Array.isArray(row.custom_line_items) ? row.custom_line_items : [],
    parts_total: num(row.parts_total),
    custom_lines_total: num(row.custom_lines_total),
    shipping_total: num(row.shipping_total),
    discount_amount: num(row.discount_amount),
    tax_rate: num(row.tax_rate),
    tax_total: num(row.tax_total),
    grand_total: num(row.grand_total),
  }
}

// ---------------------------------------------------------------------------
// Audit timeline
// ---------------------------------------------------------------------------

const eventDate = (value: unknown): string => (isDateOnly(value) ? formatDateOnly(value, { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

function statusLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Unknown'
  return LEAD_STATUSES.find((s) => s.value === (value as LeadStatus))?.label ?? value
}

export function describeLeadEvent(event: LeadEvent): string {
  const m = event.metadata ?? {}
  const rev = typeof m.revision_number === 'number' ? `Quote #${m.revision_number}` : 'Quote'
  switch (event.event_type) {
    case 'lead_created':
      return 'Lead submitted'
    case 'status_changed':
      return `Status changed from ${statusLabel(m.from)} to ${statusLabel(m.to)}`
    case 'quote_created':
      return `${rev} created`
    case 'quote_revised':
      return typeof m.previous_revision_number === 'number'
        ? `${rev} created as a revision of Quote #${m.previous_revision_number}`
        : `${rev} created as a revision`
    case 'quote_sent':
      return `${rev} sent`
    case 'quote_viewed':
      return m.first_view === false && typeof m.view_count === 'number'
        ? `Customer viewed ${rev} again (view ${m.view_count})`
        : `Customer viewed ${rev}`
    case 'quote_approved':
      return `Customer approved ${rev}`
    case 'quote_declined':
      return `Customer declined ${rev}`
    case 'quote_message_added':
      return m.sender_type === 'customer'
        ? `Customer sent a message on ${rev}`
        : `Shop replied on ${rev}`
    case 'schedule_options_sent': {
      const dates = Array.isArray(m.start_dates) ? m.start_dates.filter(isDateOnly).map((d) => formatDateOnly(d, { month: 'short', day: 'numeric' })) : []
      return `${m.reschedule ? 'New production dates' : 'Production dates'} offered${dates.length ? `: ${dates.join(', ')}` : ''}`
    }
    case 'schedule_date_requested':
      return `Customer requested a production start of ${eventDate(m.start_date)}${m.changed_choice ? ' (changed choice)' : ''}`
    case 'schedule_confirmed':
      return m.rescheduled
        ? `Schedule moved from ${eventDate(m.previous_start_date)}–${eventDate(m.previous_estimated_ready_date)} to ${eventDate(m.start_date)}–${eventDate(m.estimated_ready_date)}`
        : `Schedule confirmed: start ${eventDate(m.start_date)}, ready ${eventDate(m.estimated_ready_date)}`
    case 'schedule_cancelled':
      return `Schedule cancelled (was ${eventDate(m.start_date)}–${eventDate(m.estimated_ready_date)})`
    case 'schedule_options_invalidated':
      return `${rev} replaced outstanding date options; fresh dates are needed after approval`
    default: {
      const text = event.event_type.replace(/_/g, ' ')
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
  }
}
