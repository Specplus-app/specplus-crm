// Run with: npm.cmd test (Node's built-in test runner, TypeScript type stripping).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateQuoteTotals, ensureDraftQuote, initialQuoteValues, leadBuildDiffersFromQuote, partNeedsPrice,
  partsNeedingPrice, type DraftDeps,
} from '../src/lib/quoteRules.ts'
import type { PartEntry, Quote, QuoteStatus } from '../src/lib/supabase.ts'

// A preconfigured build as the customizer stores it (no `priced` flag): a
// buy-new group lead part, a paint-only follow-on in the same group, a paint
// style with an option, and a legitimate $0 item.
const preconfiguredParts: PartEntry[] = [
  { id: 'bumper', name: 'Front bumper', type: 'new', price: 650, group_id: 'g1', group_name: 'Bumper set',
    paint_style_id: 's1', paint_style_name: 'Gloss', selected_options: [{ id: 'o1', name: 'Sensor holes', price: 50 }] },
  { id: 'valance', name: 'Valance', type: 'send', price: 120, group_id: 'g1', group_name: 'Bumper set' },
  { id: 'cap', name: 'Tow hook cap', type: 'send', price: 0 },
]

const customParts: PartEntry[] = [
  { id: 'a1', name: 'Fender', type: 'send', price: 0 },
  { id: 'a2', name: 'Hood', type: 'send', price: 0, priced: true },
  { id: 'a3', name: 'Door', type: 'send', price: 300, priced: true },
]

function quote(partial: Partial<Quote> & { id: string; revision_number: number; status: QuoteStatus }): Quote {
  return { selected_parts: [], custom_line_items: [], ...partial } as Quote
}

test('preconfigured parts are priced even without the custom `priced` flag', () => {
  assert.deepEqual(partsNeedingPrice(preconfiguredParts, false), [])
  assert.equal(partNeedsPrice({ id: 'x', name: 'Free item', type: 'send', price: 0 }, false), false)
  // Only an explicit false marks a preconfigured part as unpriced.
  assert.equal(partNeedsPrice({ id: 'x', name: 'X', type: 'send', price: 0, priced: false }, false), true)
})

test('custom areas keep their unpriced warning; priced $0 areas are allowed', () => {
  assert.deepEqual(partsNeedingPrice(customParts, true).map((p) => p.id), ['a1'])
  // Shop-added build items on a custom quote are always priced.
  assert.equal(partNeedsPrice({ id: 'n', name: 'Added', type: 'new', price: 0, priced: true }, true), false)
})

test('quote totals keep group, option and zero-priced lines plus labor and shipping', () => {
  const totals = calculateQuoteTotals({
    selected_parts: preconfiguredParts,
    custom_line_items: [{ id: 'l1', description: 'Removal/install labor', quantity: 2, unit_price: 75.5 }],
    discount_amount: 20,
    tax_rate: 7,
    shipping_total: 85,
  })
  assert.equal(totals.parts_total, 770)
  assert.equal(totals.custom_lines_total, 151)
  assert.equal(totals.taxable_subtotal, 901)
  assert.equal(totals.tax_total, 63.07)
  assert.equal(totals.grand_total, 1049.07)
})

test('initial values come from the saved lead, including configured shipping', () => {
  assert.deepEqual(initialQuoteValues({ shipping_total: 85.004, estimated_lead_time_days: 11.6 }), {
    shipping_total: 85, estimated_lead_time_days: 12,
  })
  // Missing or invalid values never become negative.
  assert.deepEqual(initialQuoteValues({ shipping_total: -5, estimated_lead_time_days: NaN }), {
    shipping_total: 0, estimated_lead_time_days: 0,
  })
})

test('build edits on preconfigured leads are detected; display-only data is ignored', () => {
  const lead = { is_custom: false, selected_parts: preconfiguredParts }
  const snapshot = preconfiguredParts.map((p) => ({ ...p, svg_path: 'M0 0', view: 'front' as const }))
  assert.equal(leadBuildDiffersFromQuote(lead, { selected_parts: [...snapshot].reverse() }), false)

  const repriced = preconfiguredParts.map((p) => (p.id === 'valance' ? { ...p, price: 140 } : p))
  assert.equal(leadBuildDiffersFromQuote({ ...lead, selected_parts: repriced }, { selected_parts: snapshot }), true)
  const removed = preconfiguredParts.slice(0, 2)
  assert.equal(leadBuildDiffersFromQuote({ ...lead, selected_parts: removed }, { selected_parts: snapshot }), true)
  const optionChanged = preconfiguredParts.map((p) => (p.id === 'bumper' ? { ...p, selected_options: [] } : p))
  assert.equal(leadBuildDiffersFromQuote({ ...lead, selected_parts: optionChanged }, { selected_parts: snapshot }), true)
})

test('custom leads never report a build difference (areas are priced in the quote)', () => {
  const priced = customParts.map((p) => ({ ...p, price: 100, priced: true }))
  assert.equal(leadBuildDiffersFromQuote({ is_custom: true, selected_parts: customParts }, { selected_parts: priced }), false)
})

function fakeStore(initial: Quote[]) {
  const quotes = [...initial]
  const calls = { initial: 0, revision: 0 }
  const deps: DraftDeps = {
    listQuotes: async () => ({ quotes: [...quotes], error: null }),
    createInitial: async () => {
      calls.initial++
      if (quotes.length > 0) return { quote: null, error: 'This lead already has a quote; create a revision instead' }
      const q = quote({ id: `q${quotes.length + 1}`, revision_number: 1, status: 'draft' })
      quotes.push(q)
      return { quote: q, error: null }
    },
    createRevision: async (previous) => {
      calls.revision++
      if (quotes.some((q) => q.status === 'draft')) return { quote: null, error: 'duplicate key value violates unique constraint' }
      const q = quote({ id: `q${quotes.length + 1}`, revision_number: previous.revision_number + 1, status: 'draft' })
      quotes.push(q)
      return { quote: q, error: null }
    },
  }
  return { quotes, calls, deps }
}

test('opening a quote creates one draft and then reuses it', async () => {
  const store = fakeStore([])
  const first = await ensureDraftQuote(store.deps, { revise: false })
  assert.equal(first.created, true)
  const again = await ensureDraftQuote(store.deps, { revise: false })
  assert.equal(again.created, false)
  assert.equal(again.quote?.id, first.quote?.id)
  const reviseClick = await ensureDraftQuote(store.deps, { revise: true })
  assert.equal(reviseClick.quote?.id, first.quote?.id, 'an open draft is reused even from Revise')
  assert.equal(store.quotes.length, 1)
  assert.equal(store.calls.initial, 1)
})

test('revise creates a new revision from a sent or approved quote; open never does', async () => {
  for (const status of ['sent', 'approved'] as const) {
    const store = fakeStore([quote({ id: 'q1', revision_number: 1, status })])
    const opened = await ensureDraftQuote(store.deps, { revise: false })
    assert.equal(opened.quote?.id, 'q1', 'the sent quote is shown, not changed')
    assert.equal(opened.created, false)
    const revised = await ensureDraftQuote(store.deps, { revise: true })
    assert.equal(revised.created, true)
    assert.equal(revised.quote?.revision_number, 2)
    assert.equal(store.quotes.length, 2)
  }
})

test('a concurrent request that already created the draft is reused, not reported as an error', async () => {
  const store = fakeStore([])
  const racing: DraftDeps = {
    ...store.deps,
    createInitial: async () => {
      // Another tab inserted the draft between our list and insert.
      store.quotes.push(quote({ id: 'other-tab', revision_number: 1, status: 'draft' }))
      return { quote: null, error: 'This lead already has a quote; create a revision instead' }
    },
  }
  const result = await ensureDraftQuote(racing, { revise: false })
  assert.equal(result.error, null)
  assert.equal(result.quote?.id, 'other-tab')
})

test('real create failures are reported', async () => {
  const store = fakeStore([])
  const failing: DraftDeps = { ...store.deps, createInitial: async () => ({ quote: null, error: 'permission denied' }) }
  const result = await ensureDraftQuote(failing, { revise: false })
  assert.equal(result.quote, null)
  assert.equal(result.error, 'permission denied')
  const listFails: DraftDeps = { ...store.deps, listQuotes: async () => ({ quotes: [], error: 'network' }) }
  assert.equal((await ensureDraftQuote(listFails, { revise: false })).error, 'network')
})
