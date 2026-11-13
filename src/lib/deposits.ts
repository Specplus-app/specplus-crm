// Optional deposits requested after a booking. SpecPlus never processes
// payments: the shop's own payment page (an external https link) or its
// instructions do, and staff mark receipt by hand. The database
// (20261111120000_add_instant_booking_and_deposits.sql) validates everything
// again; these helpers keep the forms and displays consistent. No runtime
// imports, so it is unit tested.

export type DepositStatus = 'not_required' | 'awaiting' | 'received'

export const DEPOSIT_STATUS_LABELS: Record<DepositStatus, string> = {
  not_required: 'Not required',
  awaiting: 'Awaiting deposit',
  received: 'Received',
}

// A lead's deposit row (lead_deposits), as staff read it.
export type LeadDeposit = {
  lead_id: string
  requested: boolean
  payment_url: string | null
  amount: number | null
  instructions: string | null
  // 'quote': copied from the booked quote's deposit request; 'staff': set on
  // the lead; 'shop_default': an earlier booking under the retired shop-wide
  // defaults.
  source: 'shop_default' | 'staff' | 'quote'
  received_at: string | null
  received_by: string | null
}

// What the customer's quote link shows after booking.
export type PublicDeposit = {
  status: 'awaiting' | 'received'
  amount: number | null
  payment_url: string | null
  instructions: string | null
}

export const DEPOSIT_INSTRUCTIONS_MAX = 1000
export const DEPOSIT_AMOUNT_MAX = 1_000_000

export function depositStatus(deposit: Pick<LeadDeposit, 'requested' | 'received_at'> | null | undefined): DepositStatus {
  if (!deposit || !deposit.requested) return 'not_required'
  return deposit.received_at ? 'received' : 'awaiting'
}

// Same rule as deposit_url_is_safe(): https only, a dotted hostname and
// optional port, no user:password@ credentials, and no whitespace, control
// characters, quotes, backticks, backslashes or angle brackets.
// eslint-disable-next-line no-control-regex
const SAFE_URL_RE = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]{1,5})?([/?#][^\s\x00-\x1f\x7f<>"'`\\]*)?$/

export function isSafePaymentUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 2000 && SAFE_URL_RE.test(value)
}

// Dollars and cents, e.g. "150" or "150.50" ("$" and thousands commas are
// accepted). Blank means no fixed amount.
export function parseDepositAmount(text: string): { amount: number | null; error: string | null } {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '')
  if (!cleaned) return { amount: null, error: null }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { amount: null, error: 'Enter an amount in dollars and cents, like 150 or 150.50.' }
  const amount = Number(cleaned)
  if (amount < 0.01 || amount > DEPOSIT_AMOUNT_MAX) return { amount: null, error: 'Enter an amount between $0.01 and $1,000,000.' }
  return { amount, error: null }
}

export type DepositDraft = { payment_url: string; amount: string; instructions: string }
export type DepositErrors = Partial<Record<keyof DepositDraft, string>>

export const draftFromDeposit = (d: { payment_url: string | null; amount: number | null; instructions: string | null } | null | undefined): DepositDraft => ({
  payment_url: d?.payment_url ?? '',
  amount: d?.amount != null ? d.amount.toFixed(2) : '',
  instructions: d?.instructions ?? '',
})

// Validates the deposit form. With `needsDetails`, a link or instructions are
// required (an enabled shop default, or a requested lead deposit).
export function validateDepositDraft(draft: DepositDraft, needsDetails: boolean): {
  errors: DepositErrors
  values: { payment_url: string | null; amount: number | null; instructions: string | null }
} {
  const errors: DepositErrors = {}
  const url = draft.payment_url.trim()
  const instructions = draft.instructions.trim()
  if (url && !isSafePaymentUrl(url)) errors.payment_url = 'Enter a secure payment link starting with https:// (no spaces or sign-in details).'
  const parsed = parseDepositAmount(draft.amount)
  if (parsed.error) errors.amount = parsed.error
  if (instructions.length > DEPOSIT_INSTRUCTIONS_MAX) errors.instructions = `Keep instructions under ${DEPOSIT_INSTRUCTIONS_MAX} characters.`
  if (needsDetails && !url && !instructions) errors.payment_url = 'Add a payment link or payment instructions.'
  return { errors, values: { payment_url: url || null, amount: parsed.amount, instructions: instructions || null } }
}

// The deposit request set while completing a quote (quotes.deposit_*). Off
// by default. When on, this quote's own payment link is required (https);
// amount and instructions are optional. The database and the send-quote
// function check the same rules again.
export type QuoteDepositColumns = {
  deposit_requested: boolean
  deposit_payment_url: string | null
  deposit_amount: number | null
  deposit_instructions: string | null
}

export const QUOTE_DEPOSIT_LINK_REQUIRED = "Add this quote's payment link (https://), or turn off the deposit request."

export function validateQuoteDeposit(requested: boolean, draft: DepositDraft): { errors: DepositErrors; values: QuoteDepositColumns } {
  if (!requested) {
    return { errors: {}, values: { deposit_requested: false, deposit_payment_url: null, deposit_amount: null, deposit_instructions: null } }
  }
  const { errors, values } = validateDepositDraft(draft, false)
  if (!values.payment_url && !errors.payment_url) errors.payment_url = QUOTE_DEPOSIT_LINK_REQUIRED
  return {
    errors,
    values: { deposit_requested: true, deposit_payment_url: values.payment_url, deposit_amount: values.amount, deposit_instructions: values.instructions },
  }
}
