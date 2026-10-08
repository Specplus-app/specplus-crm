import { supabase } from './supabase'
import type {
  LeadScheduleState, QuoteSummary, ScheduleOffer, ScheduleRequest, ScheduleReservation,
} from './scheduleRules'

export * from './scheduleRules'

// Customer-safe shape returned by get_public_schedule.
export type PublicSchedule = {
  can_request: boolean
  offer: { note: string | null; is_reschedule: boolean; options: { id: string; start_date: string }[] } | null
  request: { option_id: string; start_date: string; requested_at: string } | null
  booking: { start_date: string; estimated_ready_date: string } | null
}

export const PUBLIC_SCHEDULE_ERRORS: Record<string, string> = {
  options_replaced: 'These dates were replaced by the shop. Please choose from the current options.',
  superseded: 'This quote has been revised. Please use the latest quote link from the shop.',
  quote_not_approved: 'Approve the current quote before choosing a date.',
  invalid_option: 'That date is not available for this project.',
  date_passed: 'That date has passed. Please choose another date or message the shop.',
  not_available: 'Dates can no longer be chosen for this project. Please message the shop.',
  staff_preview: 'You are signed in as shop staff. Customers choose dates from their own link.',
  rate_limited: 'Too many changes in a short time. Please wait a few minutes and try again.',
  not_found: 'Quote not found.',
}

type Result<T> = { data: T | null; error: string | null }

export async function loadLeadSchedule(leadId: string): Promise<Result<LeadScheduleState>> {
  const [stateRes, offersRes, optionsRes, requestsRes, reservationsRes, quotesRes] = await Promise.all([
    supabase.from('lead_schedule_states').select('version').eq('lead_id', leadId).maybeSingle(),
    supabase.from('schedule_offers').select('*').eq('lead_id', leadId).in('status', ['draft', 'active']),
    supabase.from('schedule_offer_options').select('id, offer_id, start_date').eq('lead_id', leadId),
    supabase.from('schedule_requests').select('*').eq('lead_id', leadId).eq('status', 'pending'),
    supabase.from('schedule_reservations').select('*').eq('lead_id', leadId).order('confirmed_at', { ascending: false }),
    supabase.from('quotes').select('id, revision_number, status, superseded_at, grand_total, estimated_lead_time_days').eq('lead_id', leadId)
      .order('revision_number', { ascending: false }).limit(1),
  ])
  const failed = [stateRes, offersRes, optionsRes, requestsRes, reservationsRes, quotesRes].find((r) => r.error)
  if (failed?.error) return { data: null, error: failed.error.message }

  const options = (optionsRes.data ?? []) as { id: string; offer_id: string; start_date: string }[]
  const withOptions = (row: Record<string, unknown>): ScheduleOffer => ({
    ...(row as unknown as ScheduleOffer),
    options: options.filter((o) => o.offer_id === row.id).map(({ id, start_date }) => ({ id, start_date }))
      .sort((a, b) => a.start_date.localeCompare(b.start_date)),
  })
  const offers = ((offersRes.data ?? []) as Record<string, unknown>[]).map(withOptions)
  const reservations = (reservationsRes.data ?? []) as ScheduleReservation[]
  const quote = ((quotesRes.data ?? []) as QuoteSummary[])[0] ?? null

  return {
    data: {
      version: Number(stateRes.data?.version ?? 0),
      draftOffer: offers.find((o) => o.status === 'draft') ?? null,
      activeOffer: offers.find((o) => o.status === 'active') ?? null,
      pendingRequest: ((requestsRes.data ?? []) as ScheduleRequest[])[0] ?? null,
      reservation: reservations.find((r) => r.status === 'active') ?? null,
      pastReservations: reservations.filter((r) => r.status !== 'active'),
      currentQuote: quote ? { ...quote, grand_total: Number(quote.grand_total) || 0 } : null,
    },
    error: null,
  }
}

export async function createScheduleOffer(leadId: string, version: number, dates: string[], note: string): Promise<Result<{ offer_id: string }>> {
  const { data, error } = await supabase.rpc('create_schedule_offer', {
    p_lead_id: leadId, p_expected_version: version, p_start_dates: dates, p_customer_note: note.trim() || null,
  })
  if (error) return { data: null, error: error.message }
  return { data: data as { offer_id: string }, error: null }
}

// Emails the customer and, only after the email is accepted, activates the
// draft options (send-schedule-options Edge Function).
export async function sendScheduleOptions(offerId: string): Promise<Result<{ quote_url: string }>> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  try {
    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-schedule-options`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ offerId }),
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok) return { data: null, error: json?.error ?? 'Could not send the date options. Please try again.' }
    return { data: json, error: null }
  } catch {
    return { data: null, error: 'Network error while sending the date options.' }
  }
}

export async function confirmSchedule(requestId: string, version: number, readyDate: string, notes: string): Promise<Result<{ reservation_id: string }>> {
  const { data, error } = await supabase.rpc('confirm_schedule', {
    p_request_id: requestId, p_expected_version: version, p_estimated_ready_date: readyDate, p_internal_notes: notes.trim() || null,
  })
  if (error) return { data: null, error: error.message }
  return { data: data as { reservation_id: string }, error: null }
}

export async function cancelSchedule(leadId: string, version: number, reason: string): Promise<Result<{ version: number }>> {
  const { data, error } = await supabase.rpc('cancel_schedule', {
    p_lead_id: leadId, p_expected_version: version, p_reason: reason.trim() || null,
  })
  if (error) return { data: null, error: error.message }
  return { data: data as { version: number }, error: null }
}
