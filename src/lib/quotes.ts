import { supabase, Lead, LeadEvent, LeadStatus, LEAD_STATUSES, PartEntry, Quote, QuoteLineItem, QuoteStatus } from './supabase'

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

// ---------------------------------------------------------------------------
// Pricing. Mirrors the database calculation in quotes_before_write(), which is
// authoritative; this copy only drives the live totals in the editor.
// ---------------------------------------------------------------------------

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

const nonNegative = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

export function lineItemTotal(item: Pick<QuoteLineItem, 'quantity' | 'unit_price'>): number {
  return round2(nonNegative(item.quantity) * nonNegative(item.unit_price))
}

export type QuoteTotals = {
  parts_total: number
  custom_lines_total: number
  discount_amount: number
  taxable_subtotal: number
  tax_total: number
  shipping_total: number
  grand_total: number
}

export function calculateQuoteTotals(input: {
  selected_parts: PartEntry[]
  custom_line_items: QuoteLineItem[]
  discount_amount: number
  tax_rate: number
  shipping_total: number
}): QuoteTotals {
  const parts_total = round2(input.selected_parts.reduce((sum, p) => sum + nonNegative(p.price), 0))
  const custom_lines_total = round2(input.custom_line_items.reduce((sum, item) => sum + lineItemTotal(item), 0))
  const discount_amount = round2(nonNegative(input.discount_amount))
  const shipping_total = round2(nonNegative(input.shipping_total))
  const taxRate = Math.min(100, nonNegative(input.tax_rate))
  const taxable_subtotal = Math.max(0, round2(parts_total + custom_lines_total - discount_amount))
  const tax_total = round2((taxable_subtotal * taxRate) / 100)
  const grand_total = round2(taxable_subtotal + tax_total + shipping_total)
  return { parts_total, custom_lines_total, discount_amount, taxable_subtotal, tax_total, shipping_total, grand_total }
}

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
// part's current highlight shape.
async function leadVisualSnapshot(lead: Lead): Promise<{
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
  const { data, error } = await supabase
    .from('quotes')
    .insert({
      lead_id: lead.id,
      selected_parts: visual.selected_parts,
      custom_line_items: [],
      shipping_total: Math.max(0, Number(lead.shipping_total) || 0),
      discount_amount: 0,
      tax_rate: 0,
      estimated_lead_time_days: Math.max(0, Math.round(Number(lead.estimated_lead_time_days) || 0)),
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
    default: {
      const text = event.event_type.replace(/_/g, ' ')
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
  }
}
