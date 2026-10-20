// Quote follow-ups: a shop message posted to the existing quote conversation
// (send_quote_follow_up). The server enforces every rule here; these helpers
// only decide what the lead page shows.
import type { QuoteStatus } from './supabase'

export const FOLLOW_UP_COOLDOWN_MS = 24 * 60 * 60 * 1000

type QuoteLike = { status: QuoteStatus; superseded_at: string | null; expires_at: string | null }

export type FollowUpAvailability =
  | { available: true }
  | { available: false; reason: 'not_sent' | 'responded' | 'superseded' | 'expired' }
  | { available: false; reason: 'cooldown'; nextAllowedAt: Date }

// Mirrors the server: sent or viewed, current, unexpired, and no follow-up on
// this lead in the last 24 hours. A quote is valid through its expiry date.
export function followUpAvailability(
  quote: QuoteLike,
  lastFollowUpAt: string | null,
  now: Date = new Date(),
): FollowUpAvailability {
  if (quote.status === 'approved' || quote.status === 'declined') return { available: false, reason: 'responded' }
  if (quote.status !== 'sent' && quote.status !== 'viewed') return { available: false, reason: 'not_sent' }
  if (quote.superseded_at) return { available: false, reason: 'superseded' }
  if (quote.expires_at && quote.expires_at < now.toISOString().slice(0, 10)) return { available: false, reason: 'expired' }
  if (lastFollowUpAt) {
    const next = new Date(new Date(lastFollowUpAt).getTime() + FOLLOW_UP_COOLDOWN_MS)
    if (next.getTime() > now.getTime()) return { available: false, reason: 'cooldown', nextAllowedAt: next }
  }
  return { available: true }
}

export function followUpPrefill(customerName: string | null, vehicleName: string | null): string {
  const first = (customerName ?? '').trim().split(/\s+/)[0]
  const vehicle = (vehicleName ?? '').trim()
  return [
    `Hi ${first || 'there'},`,
    '',
    `Just checking in on your quote${vehicle ? ` for your ${vehicle}` : ''}. Do you have any questions, or would you like any changes? You can reply right here on your quote.`,
    '',
    'Thanks!',
  ].join('\n')
}

// Shape returned by send_quote_follow_up.
export type FollowUpResult =
  | { ok: true; duplicate: boolean; message_id: string; created_at: string; alert: 'queued' | 'no_customer_email' | 'not_queued' | 'already_handled' }
  | { ok: false; error: 'invalid_message' }
  | { ok: false; error: 'not_eligible'; reason: string }
  | { ok: false; error: 'cooldown'; last_follow_up_at: string; next_allowed_at: string }

export type FollowUpOutcome = { posted: boolean; message: string; alertWarning?: string }

// Posting the message and alerting the customer are reported separately: the
// message is in the conversation even when no email alert could be queued.
export function describeFollowUpResult(result: FollowUpResult, formatTime: (iso: string) => string): FollowUpOutcome {
  if (result.ok) {
    if (result.alert === 'queued') return { posted: true, message: 'Follow-up posted to the conversation. The customer will get an email alert with their quote link.' }
    if (result.alert === 'already_handled') return { posted: true, message: 'This follow-up was already posted to the conversation.' }
    return {
      posted: true,
      message: 'Follow-up posted to the conversation.',
      alertWarning: result.alert === 'no_customer_email'
        ? "No email alert was sent because this lead doesn't have a valid customer email. The customer will see the message when they open their quote."
        : "The email alert couldn't be queued right now. The customer will see the message when they open their quote.",
    }
  }
  switch (result.error) {
    case 'invalid_message':
      return { posted: false, message: 'Write a message between 1 and 5000 characters.' }
    case 'cooldown':
      return { posted: false, message: `A follow-up was already sent in the last 24 hours. You can follow up again after ${formatTime(result.next_allowed_at)}.` }
    case 'not_eligible':
      return { posted: false, message: notEligibleMessage(result.reason) }
  }
}

function notEligibleMessage(reason: string): string {
  switch (reason) {
    case 'expired':
      return 'This quote has expired. Revise the quote to send the customer new terms.'
    case 'superseded':
      return 'This quote has been revised. Follow up on the current quote.'
    case 'approved':
    case 'declined':
      return 'The customer has already responded to this quote.'
    default:
      return 'Only sent quotes can be followed up.'
  }
}
