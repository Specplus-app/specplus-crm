import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  detectSessionInUrl: true,
  },
})

export type Profile = {
  id: string
  shop_id: string | null
  email: string
  full_name: string
  role: 'admin' | 'shop_user'
  created_at: string
}

export type Shop = {
  id: string
  name: string
  slug: string
  logo_url: string | null
  contact_email: string
  phone: string | null
  address: string | null
  subscription_status: 'trial' | 'trialing' | 'active' | 'suspended' | 'cancelled'
  subscription_tier: 'basic' | 'pro'
  trial_ends_at: string
  is_lifetime_free: boolean
  customizer_config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type Lead = {
  id: string
  shop_id: string
  customer_name: string
  customer_email: string
  customer_phone: string | null
  customer_state: string | null
  customer_address: string | null
  paint_code: string | null
  target_start_date: string | null
  vehicle_id: string
  vehicle_name: string
  vehicle_year: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_trim: string | null
  fulfillment_mode: 'local' | 'mail'
  selected_parts: PartEntry[]
  parts_total: number
  shipping_total: number
  grand_total: number
  estimated_lead_time_days: number
  status: LeadStatus
  notes: string | null
  front_image_url: string | null
  rear_image_url: string | null
  is_custom: boolean
  submitted_at: string
  updated_at: string
}

export type BuildSheet = {
  id: string
  lead_id: string | null
  shop_id: string | null
  shop_name: string
  shop_logo_url: string | null
  customer_name: string
  customer_email: string
  vehicle_name: string
  vehicle_year: string | null
  vehicle_make: string | null
  vehicle_model: string | null
  vehicle_trim: string | null
  paint_code: string | null
  fulfillment_mode: 'local' | 'mail'
  is_custom: boolean
  front_image_url: string | null
  rear_image_url: string | null
  selected_parts: PartEntry[]
  parts_total: number
  shipping_total: number
  grand_total: number
  estimated_lead_time_days: number
  created_at: string
  updated_at: string
}

export type CustomPartBox = {
  view: 'front' | 'rear'
  x: number
  y: number
  w: number
  h: number
  points?: { x: number; y: number }[]
}

export type PartEntry = {
  id: string
  name: string
  type: 'new' | 'send'
  price: number
  group_id?: string | null
  group_name?: string | null
  highlight_color?: string
  paint_style_id?: string | null
  paint_style_name?: string | null
  selected_options?: { id: string; name: string; price: number }[]
  notes?: string | null
  reference_image_path?: string | null
  box?: CustomPartBox | null
  svg_path?: string | null
  alt_view_svg_path?: string | null
  view?: 'front' | 'rear'
  part_cost?: number | null
  paint_price?: number | null
  ship_size?: ShipSize
  lead_time_days?: number
  priced?: boolean
}

export type PartGroup = {
  id: string
  vehicle_id: string
  name: string
  sort_order: number
  created_at: string
}

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'quoting'
  | 'quote_sent'
  | 'viewed'
  | 'approved'
  | 'scheduling'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'declined'
  | 'lost'
  | 'archived'

export type QuoteStatus = 'draft' | 'sent' | 'viewed' | 'approved' | 'declined'

export type QuoteLineItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
}

export type Quote = {
  id: string
  lead_id: string
  shop_id: string
  revision_number: number
  supersedes_quote_id: string | null
  superseded_at: string | null
  public_token: string
  status: QuoteStatus
  selected_parts: PartEntry[]
  custom_line_items: QuoteLineItem[]
  parts_total: number
  custom_lines_total: number
  shipping_total: number
  discount_amount: number
  tax_rate: number
  tax_total: number
  grand_total: number
  estimated_lead_time_days: number
  customer_notes: string | null
  internal_notes: string | null
  expires_at: string | null
  front_image_url: string | null
  rear_image_url: string | null
  sent_at: string | null
  first_viewed_at: string | null
  last_viewed_at: string | null
  view_count: number
  approved_at: string | null
  declined_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// Customer-safe shape returned by the get_public_quote RPC. Never includes
// internal notes, ids or customer contact details.
export type PublicQuote = {
  revision_number: number
  status: Exclude<QuoteStatus, 'draft'>
  is_superseded: boolean
  is_expired: boolean
  sent_at: string | null
  expires_at: string | null
  approved_at: string | null
  declined_at: string | null
  selected_parts: PartEntry[]
  custom_line_items: QuoteLineItem[]
  parts_total: number
  custom_lines_total: number
  shipping_total: number
  discount_amount: number
  tax_rate: number
  tax_total: number
  grand_total: number
  estimated_lead_time_days: number
  customer_notes: string | null
  front_image_url: string | null
  rear_image_url: string | null
  customer_name: string
  vehicle: {
    name: string
    year: string | null
    make: string | null
    model: string | null
    trim: string | null
    paint_code: string | null
    fulfillment_mode: 'local' | 'mail'
    is_custom: boolean
  }
  shop: {
    name: string
    logo_url: string | null
    contact_email: string | null
    phone: string | null
  }
  viewer_is_staff: boolean
}

export type LeadEventType =
  | 'lead_created'
  | 'status_changed'
  | 'quote_created'
  | 'quote_revised'
  | 'quote_sent'
  | 'quote_viewed'
  | 'quote_approved'
  | 'quote_declined'

export type LeadEventActorType = 'customer' | 'shop_user' | 'admin' | 'system'

export type LeadEvent = {
  id: string
  lead_id: string
  shop_id: string
  quote_id: string | null
  // Later phases add more event types; unknown ones still render generically.
  event_type: LeadEventType | (string & {})
  actor_type: LeadEventActorType
  actor_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type LeadNote = {
  id: string
  lead_id: string
  author_id: string
  body: string
  created_at: string
  author_name?: string
}

export type Vehicle = {
  id: string
  shop_id: string | null
  name: string
  year: number | null
  make: string | null
  model: string | null
  status: 'draft' | 'published'
  front_image_path: string | null
  rear_image_path: string | null
  is_template: boolean
  template_source_id: string | null
  created_at: string
  updated_at: string
}

export type ShipSize = 'small' | 'medium' | 'large' | 'x-large'

export type VehiclePart = {
  id: string
  vehicle_id: string
  name: string
  view: 'front' | 'rear'
  svg_path: string
  part_cost: number
  paint_price: number
  allow_send_parts: boolean
  lead_time_days: number
  sort_order: number
  parent_part_id: string | null
  group_id: string | null
  highlight_color: string
  ship_size: ShipSize
  external_url: string | null
  alt_view_svg_path: string | null
  created_at: string
}

export function partShapeForView(
  part: { view?: 'front' | 'rear'; svg_path?: string | null; alt_view_svg_path?: string | null },
  view: 'front' | 'rear',
): string | null {
  if (part.view === view) return part.svg_path || null
  return part.alt_view_svg_path || null
}

export function shapedPartsOnView<
  T extends { view?: 'front' | 'rear'; svg_path?: string | null; alt_view_svg_path?: string | null },
>(parts: T[], view: 'front' | 'rear'): T[] {
  return parts.flatMap((p) => {
    const shape = partShapeForView(p, view)
    return shape ? [{ ...p, svg_path: shape, view }] : []
  })
}

export const SHIP_SIZES: { value: ShipSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'x-large', label: 'X-Large' },
]

export const SHIP_SIZE_ORDER: ShipSize[] = ['small', 'medium', 'large', 'x-large']

export function shipSizeRank(size: ShipSize): number {
  return SHIP_SIZE_ORDER.indexOf(size)
}

export type PartPaintStyle = {
  id: string
  part_id: string
  name: string
  image_path: string | null
  price: number
  sort_order: number
  created_at: string
}

export type PartOption = {
  id: string
  part_id: string
  name: string
  description: string | null
  price: number
  sort_order: number
  created_at: string
}

export type HighlightColor = 'green' | 'blue' | 'orange' | 'pink' | 'teal'

export const HIGHLIGHT_COLORS: { value: HighlightColor; label: string; fill: string; stroke: string; dot: string }[] = [
  { value: 'green', label: 'Green', fill: 'rgba(34, 197, 94, 0.3)', stroke: 'rgba(34, 197, 94, 0.9)', dot: 'bg-emerald-500' },
  { value: 'blue', label: 'Blue', fill: 'rgba(59, 130, 246, 0.3)', stroke: 'rgba(59, 130, 246, 0.9)', dot: 'bg-blue-500' },
  { value: 'orange', label: 'Orange', fill: 'rgba(249, 115, 22, 0.3)', stroke: 'rgba(249, 115, 22, 0.9)', dot: 'bg-orange-500' },
  { value: 'pink', label: 'Pink', fill: 'rgba(236, 72, 153, 0.3)', stroke: 'rgba(236, 72, 153, 0.9)', dot: 'bg-pink-500' },
  { value: 'teal', label: 'Teal', fill: 'rgba(20, 184, 166, 0.3)', stroke: 'rgba(20, 184, 166, 0.9)', dot: 'bg-teal-500' },
]

export function getHighlightColor(color: string) {
  return HIGHLIGHT_COLORS.find((c) => c.value === color) ?? HIGHLIGHT_COLORS[0]
}

// Rough top-left anchor for a part's highlight shape (drawn in a 0..100 viewBox),
// used to place its name/price label near the shape.
export function svgPathAnchor(d: string): { x: number; y: number } {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  let minX = Infinity
  let minY = Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i])
    minY = Math.min(minY, nums[i + 1])
  }
  if (minX === Infinity) return { x: 2, y: 6 }
  return { x: minX, y: Math.max(0, minY) }
}

export const LEAD_STATUSES: { value: LeadStatus; label: string; color: string; dotColor: string }[] = [
  { value: 'new', label: 'New', color: 'bg-blue-100 text-blue-700 border-blue-200', dotColor: 'bg-blue-500' },
  { value: 'contacted', label: 'Contacted', color: 'bg-amber-100 text-amber-700 border-amber-200', dotColor: 'bg-amber-500' },
  { value: 'quoting', label: 'Quoting', color: 'bg-violet-100 text-violet-700 border-violet-200', dotColor: 'bg-violet-500' },
  { value: 'quote_sent', label: 'Quote Sent', color: 'bg-purple-100 text-purple-700 border-purple-200', dotColor: 'bg-purple-500' },
  { value: 'viewed', label: 'Viewed', color: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200', dotColor: 'bg-fuchsia-500' },
  { value: 'approved', label: 'Approved', color: 'bg-emerald-100 text-emerald-700 border-emerald-200', dotColor: 'bg-emerald-500' },
  { value: 'scheduling', label: 'Scheduling', color: 'bg-sky-100 text-sky-700 border-sky-200', dotColor: 'bg-sky-500' },
  { value: 'scheduled', label: 'Scheduled', color: 'bg-cyan-100 text-cyan-700 border-cyan-200', dotColor: 'bg-cyan-500' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-indigo-100 text-indigo-700 border-indigo-200', dotColor: 'bg-indigo-500' },
  { value: 'completed', label: 'Completed', color: 'bg-green-100 text-green-700 border-green-200', dotColor: 'bg-green-600' },
  { value: 'declined', label: 'Declined', color: 'bg-red-100 text-red-700 border-red-200', dotColor: 'bg-red-500' },
  { value: 'lost', label: 'Lost', color: 'bg-rose-100 text-rose-700 border-rose-200', dotColor: 'bg-rose-400' },
  { value: 'archived', label: 'Archived', color: 'bg-zinc-100 text-zinc-500 border-zinc-200', dotColor: 'bg-zinc-400' },
]

export function getStatusMeta(status: LeadStatus) {
  return LEAD_STATUSES.find((s) => s.value === status) ?? LEAD_STATUSES[0]
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)
}

// Lead time is driven by the slowest part, since work runs largely in parallel.
// Each additional part adds only a small fraction of its own lead time to
// account for the extra handling, rather than stacking full days on top.
export const DEFAULT_LEAD_TIME_MULTIPLIER = 0.15

export function estimateLeadTimeDays(days: number[], multiplier: number = DEFAULT_LEAD_TIME_MULTIPLIER): number {
  if (days.length === 0) return 0
  const sorted = [...days].sort((a, b) => b - a)
  const longest = sorted[0]
  const extra = sorted.slice(1).reduce((sum, d) => sum + d, 0) * multiplier
  return longest + Math.ceil(extra)
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
