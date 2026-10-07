// Pure quote rules shared by the staff quote screens. This module has no
// runtime imports so it can be unit tested without a Supabase client.
import type { Lead, PartEntry, Quote, QuoteLineItem } from './supabase'

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

// ---------------------------------------------------------------------------
// Pricing completeness
// ---------------------------------------------------------------------------

// Custom-build areas arrive unpriced and the shop prices each one (`priced:
// true`). Preconfigured parts already carry the configured price the customer
// saw and never set the flag, so they count as priced — including legitimate
// $0 items. Only an explicit `priced: false` marks one as unpriced.
export function partNeedsPrice(part: PartEntry, isCustomLead: boolean): boolean {
  return isCustomLead ? !part.priced : part.priced === false
}

export function partsNeedingPrice(parts: PartEntry[], isCustomLead: boolean): PartEntry[] {
  return parts.filter((p) => partNeedsPrice(p, isCustomLead))
}

// ---------------------------------------------------------------------------
// Draft defaults and build changes
// ---------------------------------------------------------------------------

// Commercial starting values a new quote takes from the saved lead. Prices
// come from the lead snapshot, never from the current catalog; shipping is the
// configured estimate stored with the lead, for the shop to review.
export function initialQuoteValues(lead: Pick<Lead, 'shipping_total' | 'estimated_lead_time_days'>): {
  shipping_total: number
  estimated_lead_time_days: number
} {
  return {
    shipping_total: round2(Math.max(0, Number(lead.shipping_total) || 0)),
    estimated_lead_time_days: Math.max(0, Math.round(Number(lead.estimated_lead_time_days) || 0)),
  }
}

// Order-independent fingerprint of the commercial content of a build. Display
// data (highlight shapes, images, notes) is deliberately excluded.
export function buildSignature(parts: PartEntry[]): string {
  const rows = (Array.isArray(parts) ? parts : []).map((p) => JSON.stringify([
    p.id,
    (p.name ?? '').trim(),
    p.type,
    round2(Number(p.price) || 0),
    p.group_id ?? null,
    p.paint_style_id ?? null,
    (p.selected_options ?? []).map((o) => [o.id, round2(Number(o.price) || 0)]),
  ]))
  return rows.sort().join('|')
}

// True when a preconfigured lead's saved build no longer matches a quote's
// parts, e.g. after "Edit build". Custom leads are excluded: their areas are
// priced inside the quote, so the lead and quote differ by design.
export function leadBuildDiffersFromQuote(
  lead: Pick<Lead, 'is_custom' | 'selected_parts'>,
  quote: Pick<Quote, 'selected_parts'>,
): boolean {
  if (lead.is_custom) return false
  return buildSignature(lead.selected_parts) !== buildSignature(quote.selected_parts)
}

// ---------------------------------------------------------------------------
// Opening a draft without creating duplicates
// ---------------------------------------------------------------------------

type CreateResult = { quote: Quote | null; error: string | null }

export type DraftDeps = {
  listQuotes: () => Promise<{ quotes: Quote[]; error: string | null }>
  createInitial: () => Promise<CreateResult>
  createRevision: (previous: Quote) => Promise<CreateResult>
}

export type EnsureDraftResult = {
  quote: Quote | null
  created: boolean
  error: string | null
}

const latestOf = (quotes: Quote[]): Quote | null =>
  quotes.reduce<Quote | null>((best, q) => (!best || q.revision_number > best.revision_number ? q : best), null)

// Returns the lead's open draft, creating one only when none exists. With
// `revise`, a sent/approved latest quote gets a new revision; without it, the
// existing latest quote is returned untouched (sent quotes are never edited).
// If a concurrent request (double click, second tab) wins the race, its draft
// is reused instead of reporting an error.
export async function ensureDraftQuote(deps: DraftDeps, options: { revise: boolean }): Promise<EnsureDraftResult> {
  const first = await deps.listQuotes()
  if (first.error) return { quote: null, created: false, error: first.error }

  const existingDraft = first.quotes.find((q) => q.status === 'draft')
  if (existingDraft) return { quote: existingDraft, created: false, error: null }

  const latest = latestOf(first.quotes)
  if (latest && !options.revise) return { quote: latest, created: false, error: null }

  const result = latest ? await deps.createRevision(latest) : await deps.createInitial()
  if (result.quote) return { quote: result.quote, created: true, error: null }

  const retry = await deps.listQuotes()
  const racedDraft = retry.error ? undefined : retry.quotes.find((q) => q.status === 'draft')
  if (racedDraft) return { quote: racedDraft, created: false, error: null }

  return { quote: null, created: false, error: result.error ?? 'Could not create the quote.' }
}
