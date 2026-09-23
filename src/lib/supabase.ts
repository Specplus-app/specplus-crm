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
  logo_url: string | null
  contact_email: string
  phone: string | null
  address: string | null
  subscription_status: 'trial' | 'active' | 'suspended' | 'cancelled'
  subscription_tier: 'starter' | 'pro' | 'enterprise'
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

export type LeadStatus = 'new' | 'contacted' | 'quoted' | 'scheduled' | 'completed' | 'archived'

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
  created_at: string
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

export const LEAD_STATUSES: { value: LeadStatus; label: string; color: string }[] = [
  { value: 'new', label: 'New', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'contacted', label: 'Contacted', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  { value: 'quoted', label: 'Quoted', color: 'bg-purple-100 text-purple-700 border-purple-200' },
  { value: 'scheduled', label: 'Scheduled', color: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  { value: 'completed', label: 'Completed', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  { value: 'archived', label: 'Archived', color: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
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
