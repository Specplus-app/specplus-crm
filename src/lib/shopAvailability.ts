// Shop availability for customer calendar requests: the rolling booking
// window and blocked dates (Schedule page). The database functions in
// 20261028120000_add_customer_calendar_scheduling.sql are authoritative; the
// pure helpers here only shape the UI. No runtime imports, so it is unit
// tested (the loaders take the Supabase client as a parameter).
// Existing jobs never block a date; the shop decides when it is full.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DateOnly } from './scheduleDates'

const DAY_MS = 24 * 60 * 60 * 1000
const utc = (d: DateOnly) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))
const nextDay = (d: DateOnly) => new Date(utc(d) + DAY_MS).toISOString().slice(0, 10)
const daysBetween = (from: DateOnly, to: DateOnly) => Math.round((utc(to) - utc(from)) / DAY_MS)

// Same default as schedule_booking_window_days() for shops without settings.
export const DEFAULT_BOOKING_WINDOW_DAYS = 60
export const MIN_BOOKING_WINDOW_DAYS = 7
export const MAX_BOOKING_WINDOW_DAYS = 365
export const MAX_BLOCK_RANGE_DAYS = 366

export const BOOKING_WINDOW_CHOICES: { days: number; label: string }[] = [
  { days: 14, label: '2 weeks' },
  { days: 30, label: '1 month' },
  { days: 60, label: '2 months' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
]

export function bookingWindowLabel(days: number): string {
  return BOOKING_WINDOW_CHOICES.find((c) => c.days === days)?.label ?? `${days} days`
}

export type ShopAvailability = { bookingWindowDays: number; blockedDates: DateOnly[] }

export type BlockedRange = { start: DateOnly; end: DateOnly }

// Groups sorted, unique blocked dates into consecutive ranges for display.
export function blockedRanges(dates: readonly DateOnly[]): BlockedRange[] {
  const sorted = Array.from(new Set(dates)).sort()
  const ranges: BlockedRange[] = []
  for (const d of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && nextDay(last.end) === d) last.end = d
    else ranges.push({ start: d, end: d })
  }
  return ranges
}

// Checks the Block/Unblock form before calling the database (which re-checks).
export function validateBlockRange(start: string, end: string, today: DateOnly): string | null {
  if (!start) return 'Choose a date.'
  const last = end || start
  if (last < start) return 'The end date must be on or after the start date.'
  if (daysBetween(start, last) >= MAX_BLOCK_RANGE_DAYS) return 'Choose a range of one year or less.'
  if (last < today) return 'Past dates cannot be changed.'
  return null
}

type Result<T> = { data: T | null; error: string | null }

// The shop's window and its blocked dates from `from` on. Staff-only: RLS
// limits both tables to the signed-in user's shop (admins: any shop).
export async function loadShopAvailability(client: SupabaseClient, shopId: string, from: DateOnly): Promise<Result<ShopAvailability>> {
  try {
    const [settingsRes, blockedRes] = await Promise.all([
      client.from('shop_schedule_settings').select('booking_window_days').eq('shop_id', shopId).maybeSingle(),
      client.from('shop_blocked_dates').select('blocked_date').eq('shop_id', shopId).gte('blocked_date', from)
        .order('blocked_date', { ascending: true }).limit(1000),
    ])
    if (settingsRes.error || blockedRes.error) return { data: null, error: (settingsRes.error ?? blockedRes.error)!.message }
    const days = Number((settingsRes.data as { booking_window_days?: number } | null)?.booking_window_days)
    return {
      data: {
        bookingWindowDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_BOOKING_WINDOW_DAYS,
        blockedDates: ((blockedRes.data ?? []) as { blocked_date: DateOnly }[]).map((r) => r.blocked_date),
      },
      error: null,
    }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Network error' }
  }
}

export async function setBookingWindow(client: SupabaseClient, shopId: string, days: number): Promise<Result<{ booking_window_days: number }>> {
  const { data, error } = await client.rpc('set_schedule_booking_window', { p_shop_id: shopId, p_days: days })
  if (error) return { data: null, error: error.message }
  return { data: data as { booking_window_days: number }, error: null }
}

export async function setDatesBlocked(client: SupabaseClient, shopId: string, start: DateOnly, end: DateOnly, blocked: boolean): Promise<Result<{ changed: number }>> {
  const { data, error } = await client.rpc('set_schedule_dates_blocked', { p_shop_id: shopId, p_start: start, p_end: end, p_blocked: blocked })
  if (error) return { data: null, error: error.message }
  return { data: data as { changed: number }, error: null }
}
