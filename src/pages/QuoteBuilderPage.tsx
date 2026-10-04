import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase, Lead, PartEntry, Quote, QuoteLineItem, formatCurrency, formatDateTime } from '../lib/supabase'
import { useShopBilling } from '../lib/billing'
import {
  QUOTE_STATUS_META, calculateQuoteTotals, createInitialQuote, createQuoteRevision, formatQuoteDate,
  isQuoteExpired, lineItemTotal, newLineItem, normalizeQuote, customerQuoteUrl, staffPreviewUrl,
} from '../lib/quotes'
import QuoteVehiclePhotos from '../components/QuoteVehiclePhotos'
import QuoteBuildItemEditor from '../components/QuoteBuildItemEditor'
import {
  AlertCircle, ArrowLeft, Check, Copy, ExternalLink, FileText, Loader2, Lock, Plus, RefreshCw, Save, Send, Trash2,
} from 'lucide-react'

type DraftForm = {
  selected_parts: PartEntry[]
  custom_line_items: QuoteLineItem[]
  shipping_total: number
  discount_amount: number
  tax_rate: number
  estimated_lead_time_days: number
  customer_notes: string
  internal_notes: string
  expires_at: string
}

function formFromQuote(q: Quote): DraftForm {
  return {
    selected_parts: q.selected_parts.map((p) => ({ ...p, price: Number(p.price) || 0 })),
    custom_line_items: q.custom_line_items.map((i) => ({ ...i })),
    shipping_total: q.shipping_total,
    discount_amount: q.discount_amount,
    tax_rate: q.tax_rate,
    estimated_lead_time_days: q.estimated_lead_time_days,
    customer_notes: q.customer_notes ?? '',
    internal_notes: q.internal_notes ?? '',
    expires_at: q.expires_at ?? '',
  }
}

type Message = { type: 'success' | 'error'; text: string } | null

export default function QuoteBuilderPage() {
  const { leadId } = useParams<{ leadId: string }>()
  const navigate = useNavigate()
  const { readOnly } = useShopBilling()
  const [lead, setLead] = useState<Lead | null>(null)
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<DraftForm | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'create' | 'save' | 'send' | 'revise' | null>(null)
  const [message, setMessage] = useState<Message>(null)
  const [copied, setCopied] = useState(false)
  const [addingItem, setAddingItem] = useState(false)

  const loadAll = useCallback(async (selectId?: string) => {
    if (!leadId) return
    const [leadRes, quotesRes] = await Promise.all([
      supabase.from('leads').select('*').eq('id', leadId).maybeSingle(),
      supabase.from('quotes').select('*').eq('lead_id', leadId).order('revision_number', { ascending: false }),
    ])
    if (leadRes.error) console.error('Failed to load lead:', leadRes.error.message)
    if (quotesRes.error) console.error('Failed to load quotes:', quotesRes.error.message)
    setLead((leadRes.data as Lead | null) ?? null)
    const rows = ((quotesRes.data ?? []) as Quote[]).map(normalizeQuote)
    setQuotes(rows)
    const next = rows.find((q) => q.id === selectId) ?? rows[0] ?? null
    setSelectedId(next?.id ?? null)
    setForm(next && next.status === 'draft' ? formFromQuote(next) : null)
    setDirty(false)
    setLoading(false)
  }, [leadId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const selected = quotes.find((q) => q.id === selectedId) ?? null
  const latest = quotes[0] ?? null
  // Customer quotes are only part of the custom-upload workflow; preconfigured
  // leads already have the instant price the customer saw in the customizer.
  const quotingAllowed = !!lead?.is_custom
  const unpricedLeadParts = (Array.isArray(lead?.selected_parts) ? lead!.selected_parts : []).filter((p) => !p.priced)
  const editable = !!selected && selected.status === 'draft' && !readOnly && !!form && quotingAllowed

  const totals = useMemo(() => {
    if (form) return calculateQuoteTotals(form)
    if (!selected) return null
    // Sent quotes show exactly what was stored when the customer received it.
    return {
      parts_total: selected.parts_total,
      custom_lines_total: selected.custom_lines_total,
      discount_amount: selected.discount_amount,
      taxable_subtotal: Math.max(0, selected.parts_total + selected.custom_lines_total - selected.discount_amount),
      tax_total: selected.tax_total,
      shipping_total: selected.shipping_total,
      grand_total: selected.grand_total,
    }
  }, [form, selected])

  const selectQuote = (q: Quote) => {
    if (dirty && !window.confirm('Discard unsaved changes to this draft?')) return
    setSelectedId(q.id)
    setForm(q.status === 'draft' ? formFromQuote(q) : null)
    setDirty(false)
    setMessage(null)
  }

  const update = (patch: Partial<DraftForm>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev))
    setDirty(true)
  }

  const handleCreate = async () => {
    if (!lead || busy || !quotingAllowed) return
    setBusy('create')
    setMessage(null)
    const { quote, error } = await createInitialQuote(lead)
    setBusy(null)
    if (error || !quote) {
      setMessage({ type: 'error', text: error ?? 'Could not create the quote.' })
      return
    }
    await loadAll(quote.id)
  }

  const handleRevise = async () => {
    if (!latest || busy || !quotingAllowed) return
    setBusy('revise')
    setMessage(null)
    const { quote, error } = await createQuoteRevision(latest)
    setBusy(null)
    if (error || !quote) {
      setMessage({ type: 'error', text: error ?? 'Could not create the revision.' })
      return
    }
    await loadAll(quote.id)
  }

  const saveDraft = async (): Promise<boolean> => {
    if (!selected || !form) return false
    const { data, error } = await supabase
      .from('quotes')
      .update({
        selected_parts: form.selected_parts,
        custom_line_items: form.custom_line_items.map((i) => ({
          ...i,
          description: i.description.trim(),
          quantity: Math.max(0, Number(i.quantity) || 0),
          unit_price: Math.max(0, Number(i.unit_price) || 0),
        })),
        shipping_total: Math.max(0, form.shipping_total),
        discount_amount: Math.max(0, form.discount_amount),
        tax_rate: Math.min(100, Math.max(0, form.tax_rate)),
        estimated_lead_time_days: Math.max(0, Math.round(form.estimated_lead_time_days)),
        customer_notes: form.customer_notes.trim() || null,
        internal_notes: form.internal_notes.trim() || null,
        expires_at: form.expires_at || null,
      })
      .eq('id', selected.id)
      .select('*')
      .single()
    if (error || !data) {
      setMessage({ type: 'error', text: error?.message ?? 'Could not save the draft.' })
      return false
    }
    const saved = normalizeQuote(data as Quote)
    setQuotes((prev) => prev.map((q) => (q.id === saved.id ? saved : q)))
    setForm(formFromQuote(saved))
    setDirty(false)
    return true
  }

  const handleSave = async () => {
    if (busy) return
    setBusy('save')
    setMessage(null)
    const ok = await saveDraft()
    setBusy(null)
    if (ok) setMessage({ type: 'success', text: 'Draft saved.' })
  }

  const handleSend = async () => {
    if (!selected || !form || !lead || busy) return
    if (form.selected_parts.length === 0 && form.custom_line_items.length === 0) {
      setMessage({ type: 'error', text: 'Add at least one item before sending.' })
      return
    }
    const needsPrice = form.selected_parts.filter((p) => !p.priced)
    if (needsPrice.length > 0) {
      setMessage({ type: 'error', text: `Set a price for every area before sending: ${needsPrice.map((p) => p.name).join(', ')}.` })
      return
    }
    if (form.expires_at && isQuoteExpired(form.expires_at)) {
      setMessage({ type: 'error', text: 'The expiration date is in the past.' })
      return
    }
    if (!window.confirm(`Send Quote #${selected.revision_number} to ${lead.customer_email}? Once sent, its pricing can no longer be edited.`)) return

    setBusy('send')
    setMessage(null)
    if (dirty && !(await saveDraft())) {
      setBusy(null)
      return
    }

    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData.session?.access_token
    try {
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-quote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: selected.id }),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) {
        setMessage({ type: 'error', text: json?.error ?? 'Could not send the quote. Please try again.' })
      } else {
        setMessage({ type: 'success', text: `Quote #${selected.revision_number} emailed to ${lead.customer_email}.` })
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error while sending the quote.' })
    }
    setBusy(null)
    await loadAll(selected.id)
  }

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-zinc-300 border-t-brand-500 rounded-full animate-spin" />
      </div>
    )
  }

  if (!lead) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 font-medium">Lead not found</p>
          <button onClick={() => navigate('/dashboard')} className="text-sm text-brand-600 hover:underline mt-2">Back to dashboard</button>
        </div>
      </div>
    )
  }

  const backButton = (
    <button
      onClick={() => {
        if (dirty && !window.confirm('Discard unsaved changes to this draft?')) return
        navigate(`/dashboard/leads/${lead.id}`)
      }}
      className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 mb-4 transition-colors"
    >
      <ArrowLeft size={16} />
      Back to lead
    </button>
  )

  if (!selected) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-3xl mx-auto">
          {backButton}
          {!quotingAllowed ? (
            <div className="bg-white rounded-2xl border border-zinc-200 p-10 text-center">
              <FileText size={36} className="mx-auto text-zinc-300 mb-3" />
              <h1 className="text-lg font-bold text-zinc-900">No separate quote needed</h1>
              <p className="text-sm text-zinc-500 mt-1 mb-5">
                This lead already has customer-visible pricing from the vehicle customizer. A separate customer quote is not required.
              </p>
              <button
                onClick={() => navigate(`/dashboard/leads/${lead.id}`)}
                className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                <ArrowLeft size={15} />
                Back to lead
              </button>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-zinc-200 p-10 text-center">
              <FileText size={36} className="mx-auto text-zinc-300 mb-3" />
              <h1 className="text-lg font-bold text-zinc-900">Customer quote for {lead.customer_name}</h1>
              <p className="text-sm text-zinc-500 mt-1 mb-5">
                Review the requested areas, adjust the build and pricing, then send the finished quote to the customer.
              </p>
              {readOnly ? (
                <p className="text-sm text-amber-700">Quotes can't be sent while your account is read-only.</p>
              ) : (
                <button
                  onClick={handleCreate}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {busy === 'create' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  Review &amp; Send Quote
                </button>
              )}
              {unpricedLeadParts.length > 0 && (
                <p className="text-sm text-amber-700 mt-3">
                  {unpricedLeadParts.length} {unpricedLeadParts.length === 1 ? 'area still needs' : 'areas still need'} pricing. In Review &amp; Send Quote you can price these areas, remove them from the quote, or add new build items.
                </p>
              )}
              {message && <MessageBar message={message} />}
            </div>
          )}
        </div>
      </div>
    )
  }

  const parts = form ? form.selected_parts : selected.selected_parts
  const lineItems = form ? form.custom_line_items : selected.custom_line_items
  const meta = QUOTE_STATUS_META[selected.status]
  const isLatest = latest?.id === selected.id
  const customerUrl = selected.status !== 'draft' ? customerQuoteUrl(selected.public_token) : null
  const previewUrl = selected.status !== 'draft' ? staffPreviewUrl(selected.public_token) : null
  const inputCls = 'w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors disabled:opacity-70 disabled:cursor-not-allowed'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
        {backButton}

        {/* Header */}
        <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-zinc-900">Quote #{selected.revision_number}</h1>
                <span className={`text-xs font-medium border rounded-full px-2 py-0.5 ${meta.color}`}>{meta.label}</span>
                {selected.superseded_at && (
                  <span className="text-xs font-medium border rounded-full px-2 py-0.5 bg-zinc-100 text-zinc-500 border-zinc-200">Superseded</span>
                )}
              </div>
              <p className="text-sm text-zinc-500 mt-1">{lead.customer_name} · {lead.vehicle_name} · {lead.customer_email}</p>
            </div>
            {quotes.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {quotes.map((q) => (
                  <button
                    key={q.id}
                    onClick={() => selectQuote(q)}
                    className={`text-xs font-medium rounded-lg px-2.5 py-1.5 border transition-colors ${
                      q.id === selected.id ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                    }`}
                  >
                    #{q.revision_number} · {QUOTE_STATUS_META[q.status].label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected.status !== 'draft' && (
            <div className="flex items-start gap-2 mt-4 text-xs text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
              <Lock size={14} className="text-zinc-400 flex-shrink-0 mt-0.5" />
              <span>This quote was sent to the customer, so its terms are locked. {isLatest ? 'Use Revise Quote to prepare updated pricing as a new revision.' : 'A newer revision exists.'}</span>
            </div>
          )}
          {!quotingAllowed && (
            <div className="flex items-start gap-2 mt-4 text-xs text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
              <Lock size={14} className="text-zinc-400 flex-shrink-0 mt-0.5" />
              <span>This lead already has customer-visible pricing from the vehicle customizer, so a separate customer quote is not required. Existing quote history is shown read-only.</span>
            </div>
          )}
          {readOnly && quotingAllowed && selected.status === 'draft' && (
            <div className="flex items-start gap-2 mt-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <Lock size={14} className="flex-shrink-0 mt-0.5" />
              <span>Your account is read-only, so this draft can't be edited or sent.</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            {(selected.front_image_url || selected.rear_image_url) && (
              <div className="bg-white rounded-2xl border border-zinc-200 p-6">
                <h2 className="text-sm font-semibold text-zinc-900 mb-3">Customer's Build</h2>
                <QuoteVehiclePhotos parts={parts} frontUrl={selected.front_image_url} rearUrl={selected.rear_image_url} theme="light" />
              </div>
            )}

            {/* Parts */}
            <div className="bg-white rounded-2xl border border-zinc-200 p-6">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900 mb-1">Selected Parts ({parts.length})</h2>
                  <p className="text-xs text-zinc-500">
                    {editable
                      ? 'Prices, added and removed items apply to this quote only — the original lead stays as submitted.'
                      : 'Prices here apply to this quote only.'}
                  </p>
                </div>
                {editable && (
                  <button
                    onClick={() => setAddingItem(true)}
                    className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 rounded-lg px-3 py-1.5 transition-colors flex-shrink-0"
                  >
                    <Plus size={15} /> Add Build Item
                  </button>
                )}
              </div>
              {parts.length === 0 ? (
                <p className="text-sm text-zinc-400 py-2">No parts on this quote.</p>
              ) : (
                <div className="divide-y divide-zinc-100">
                  {parts.map((part, idx) => (
                    <div key={`${part.id}-${idx}`} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-800 truncate">{part.name}</p>
                        <p className="text-xs text-zinc-400">
                          {part.type === 'new' ? 'Buy new' : 'Paint customer part'}
                          {part.group_name ? ` · ${part.group_name}` : ''}
                          {part.paint_style_name ? ` · ${part.paint_style_name}` : ''}
                          {quotingAllowed && !part.priced && <span className="text-amber-600 font-medium"> · Needs price</span>}
                        </p>
                      </div>
                      {editable ? (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <div className="w-32">
                            <NumberField
                              value={part.price}
                              prefix="$"
                              className={inputCls}
                              onChange={(price) => update({
                                selected_parts: form!.selected_parts.map((p, i) => (i === idx ? { ...p, price, priced: true } : p)),
                              })}
                            />
                          </div>
                          <button
                            onClick={() => update({ selected_parts: form!.selected_parts.filter((_, i) => i !== idx) })}
                            className="p-1.5 text-zinc-400 hover:text-red-600 rounded-md transition-colors"
                            aria-label={`Remove ${part.name}`}
                            title="Remove from this quote"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-sm font-medium text-zinc-900 flex-shrink-0">{formatCurrency(Number(part.price) || 0)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Custom line items */}
            <div className="bg-white rounded-2xl border border-zinc-200 p-6">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">Additional Line Items</h2>
                  <p className="text-xs text-zinc-500">Labor, fabrication, or other work.</p>
                </div>
                {editable && (
                  <button
                    onClick={() => update({ custom_line_items: [...form!.custom_line_items, newLineItem()] })}
                    className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 rounded-lg px-3 py-1.5 transition-colors"
                  >
                    <Plus size={15} /> Add item
                  </button>
                )}
              </div>
              {lineItems.length === 0 ? (
                <p className="text-sm text-zinc-400 py-2">No additional line items.</p>
              ) : editable ? (
                <div className="space-y-2">
                  <div className="hidden sm:grid grid-cols-12 gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 px-1">
                    <span className="col-span-6">Description</span>
                    <span className="col-span-2">Qty</span>
                    <span className="col-span-2">Unit price</span>
                    <span className="col-span-2 text-right">Total</span>
                  </div>
                  {form!.custom_line_items.map((item, idx) => {
                    const setItem = (patch: Partial<QuoteLineItem>) => update({
                      custom_line_items: form!.custom_line_items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
                    })
                    return (
                      <div key={item.id} className="grid grid-cols-12 gap-2 items-center">
                        <input
                          value={item.description}
                          onChange={(e) => setItem({ description: e.target.value })}
                          placeholder="e.g. Labor — install and align"
                          maxLength={200}
                          className={`${inputCls} col-span-12 sm:col-span-6`}
                        />
                        <div className="col-span-4 sm:col-span-2">
                          <NumberField value={item.quantity} className={inputCls} onChange={(quantity) => setItem({ quantity })} />
                        </div>
                        <div className="col-span-4 sm:col-span-2">
                          <NumberField value={item.unit_price} prefix="$" className={inputCls} onChange={(unit_price) => setItem({ unit_price })} />
                        </div>
                        <div className="col-span-4 sm:col-span-2 flex items-center justify-end gap-1">
                          <span className="text-sm font-medium text-zinc-900">{formatCurrency(lineItemTotal(item))}</span>
                          <button
                            onClick={() => update({ custom_line_items: form!.custom_line_items.filter((_, i) => i !== idx) })}
                            className="p-1.5 text-zinc-400 hover:text-red-600 rounded-md transition-colors"
                            aria-label="Remove line item"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="divide-y divide-zinc-100">
                  {lineItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-800">{item.description || 'Additional work'}</p>
                        <p className="text-xs text-zinc-400">{item.quantity} × {formatCurrency(item.unit_price)}</p>
                      </div>
                      <span className="text-sm font-medium text-zinc-900">{formatCurrency(lineItemTotal(item))}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="bg-white rounded-2xl border border-zinc-200 p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-1">Notes to customer</label>
                {editable ? (
                  <textarea
                    value={form!.customer_notes}
                    onChange={(e) => update({ customer_notes: e.target.value })}
                    rows={4}
                    maxLength={5000}
                    placeholder="Shown on the customer's quote."
                    className={`${inputCls} resize-none`}
                  />
                ) : (
                  <p className="text-sm text-zinc-700 whitespace-pre-wrap">{selected.customer_notes || <span className="text-zinc-400">None</span>}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-1">Internal notes <span className="font-normal text-zinc-400">(shop only)</span></label>
                {editable ? (
                  <textarea
                    value={form!.internal_notes}
                    onChange={(e) => update({ internal_notes: e.target.value })}
                    rows={4}
                    maxLength={5000}
                    placeholder="Never shown to the customer."
                    className={`${inputCls} resize-none`}
                  />
                ) : (
                  <p className="text-sm text-zinc-700 whitespace-pre-wrap">{selected.internal_notes || <span className="text-zinc-400">None</span>}</p>
                )}
              </div>
            </div>
          </div>

          {/* Totals & actions */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-zinc-200 p-6 lg:sticky lg:top-6">
              <h2 className="text-sm font-semibold text-zinc-900 mb-3">Pricing</h2>
              {editable ? (
                <div className="space-y-3 mb-4">
                  <Field label="Shipping">
                    <NumberField value={form!.shipping_total} prefix="$" className={inputCls} onChange={(shipping_total) => update({ shipping_total })} />
                  </Field>
                  <Field label="Discount">
                    <NumberField value={form!.discount_amount} prefix="$" className={inputCls} onChange={(discount_amount) => update({ discount_amount })} />
                  </Field>
                  <Field label="Tax rate (%)">
                    <NumberField value={form!.tax_rate} max={100} className={inputCls} onChange={(tax_rate) => update({ tax_rate })} />
                  </Field>
                  <Field label="Est. lead time (days)">
                    <NumberField value={form!.estimated_lead_time_days} integer className={inputCls} onChange={(estimated_lead_time_days) => update({ estimated_lead_time_days })} />
                  </Field>
                  <Field label="Expires on">
                    <input
                      type="date"
                      value={form!.expires_at}
                      onChange={(e) => update({ expires_at: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                </div>
              ) : (
                <div className="space-y-1 text-sm mb-4">
                  <Row label="Est. lead time" value={`${selected.estimated_lead_time_days} ${selected.estimated_lead_time_days === 1 ? 'day' : 'days'}`} />
                  <Row label="Expires" value={selected.expires_at ? formatQuoteDate(selected.expires_at) : 'No expiration'} />
                </div>
              )}

              {totals && (
                <div className="space-y-1.5 text-sm border-t border-zinc-100 pt-3">
                  <Row label="Parts" value={formatCurrency(totals.parts_total)} />
                  <Row label="Line items" value={formatCurrency(totals.custom_lines_total)} />
                  {totals.discount_amount > 0 && <Row label="Discount" value={`−${formatCurrency(totals.discount_amount)}`} />}
                  <Row label="Taxable subtotal" value={formatCurrency(totals.taxable_subtotal)} />
                  <Row label={`Tax (${form ? form.tax_rate : selected.tax_rate}%)`} value={formatCurrency(totals.tax_total)} />
                  <Row label="Shipping" value={formatCurrency(totals.shipping_total)} />
                  <div className="flex justify-between text-zinc-900 font-bold pt-2 border-t border-zinc-100">
                    <span>Grand Total</span>
                    <span>{formatCurrency(totals.grand_total)}</span>
                  </div>
                </div>
              )}

              {editable && (
                <div className="flex flex-col gap-2 mt-5">
                  <button
                    onClick={handleSend}
                    disabled={busy !== null}
                    className="flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                  >
                    {busy === 'send' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                    {busy === 'send' ? 'Sending…' : 'Send Quote'}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={busy !== null || !dirty}
                    className="flex items-center justify-center gap-2 bg-white border border-zinc-200 hover:bg-zinc-50 disabled:opacity-60 text-zinc-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                  >
                    {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                    {dirty ? 'Save Draft' : 'Draft Saved'}
                  </button>
                </div>
              )}

              {!readOnly && quotingAllowed && isLatest && selected.status !== 'draft' && (
                <button
                  onClick={handleRevise}
                  disabled={busy !== null}
                  className="w-full flex items-center justify-center gap-2 mt-5 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {busy === 'revise' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                  Revise Quote
                </button>
              )}

              {message && <MessageBar message={message} />}
            </div>

            {selected.status !== 'draft' && (
              <div className="bg-white rounded-2xl border border-zinc-200 p-6">
                <h2 className="text-sm font-semibold text-zinc-900 mb-3">Customer Engagement</h2>
                <div className="space-y-1 text-sm">
                  <Row label="Sent" value={selected.sent_at ? formatDateTime(selected.sent_at) : '—'} />
                  <Row label="First viewed" value={selected.first_viewed_at ? formatDateTime(selected.first_viewed_at) : 'Not yet'} />
                  <Row label="Last viewed" value={selected.last_viewed_at ? formatDateTime(selected.last_viewed_at) : 'Not yet'} />
                  <Row label="Views" value={String(selected.view_count)} />
                  {selected.approved_at && <Row label="Approved" value={formatDateTime(selected.approved_at)} />}
                  {selected.declined_at && <Row label="Declined" value={formatDateTime(selected.declined_at)} />}
                </div>
                {customerUrl && previewUrl && (
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => copyLink(customerUrl)}
                      className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg px-3 py-2 transition-colors"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg px-3 py-2 transition-colors"
                    >
                      <ExternalLink size={14} /> Preview
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {addingItem && editable && (
        <QuoteBuildItemEditor
          frontUrl={selected.front_image_url}
          rearUrl={selected.rear_image_url}
          existingParts={form!.selected_parts}
          onCancel={() => setAddingItem(false)}
          onAdd={(part) => {
            update({ selected_parts: [...form!.selected_parts, part] })
            setAddingItem(false)
          }}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-zinc-600">
      <span>{label}</span>
      <span className="font-medium text-zinc-900 text-right">{value}</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

function MessageBar({ message }: { message: NonNullable<Message> }) {
  return (
    <div
      className={`flex items-start gap-1.5 text-sm font-medium rounded-lg px-3 py-2 mt-4 text-left ${
        message.type === 'success' ? 'text-emerald-700 bg-emerald-50 border border-emerald-200' : 'text-red-700 bg-red-50 border border-red-200'
      }`}
    >
      {message.type === 'success' ? <Check size={15} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />}
      <span>{message.text}</span>
    </div>
  )
}

// Numeric input that keeps the user's in-progress text (e.g. "12." or "") and
// reports a clamped, non-negative number.
function NumberField({
  value, onChange, prefix, max, integer = false, className,
}: {
  value: number
  onChange: (n: number) => void
  prefix?: string
  max?: number
  integer?: boolean
  className: string
}) {
  const [text, setText] = useState(String(value))

  useEffect(() => {
    setText((prev) => (parseNumber(prev, max, integer) === value ? prev : String(value)))
  }, [value, max, integer])

  return (
    <div className="relative">
      {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400 pointer-events-none">{prefix}</span>}
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          onChange(parseNumber(e.target.value, max, integer))
        }}
        onBlur={() => setText(String(parseNumber(text, max, integer)))}
        className={`${className} ${prefix ? 'pl-6' : ''}`}
      />
    </div>
  )
}

function parseNumber(text: string, max: number | undefined, integer: boolean): number {
  const n = parseFloat(text.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(n) || n < 0) return 0
  const clamped = max !== undefined ? Math.min(max, n) : n
  return integer ? Math.round(clamped) : clamped
}
