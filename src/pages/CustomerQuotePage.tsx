import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { supabase, PublicQuote, PartEntry, formatCurrency, formatDateTime, getHighlightColor } from '../lib/supabase'
import { formatQuoteDate, lineItemTotal, quoteViewSessionId } from '../lib/quotes'
import QuoteVehiclePhotos from '../components/QuoteVehiclePhotos'
import { AlertCircle, CheckCircle2, Clock, Eye, FileText, Loader2, Mail, Package, Palette, Phone, RefreshCw, XCircle } from 'lucide-react'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Tokens whose view has been recorded during this page lifetime, so React
// re-renders / StrictMode double effects never send a second request.
const recordedViewTokens = new Set<string>()

const VIEW_DELAY_MS = 2000

const RESPONSE_ERRORS: Record<string, string> = {
  expired: 'This quote has expired, so it can no longer be approved or declined. Please contact the shop for an updated quote.',
  superseded: 'This quote has been revised. Please use the link to the latest quote from the shop.',
  already_responded: 'A response has already been recorded for this quote.',
  staff_preview: 'You are signed in as shop staff. Customer responses cannot be recorded from a staff account.',
  invalid_state: 'This quote can no longer be approved or declined.',
  not_found: 'Quote not found.',
}

export default function CustomerQuotePage() {
  const { token } = useParams<{ token: string }>()
  const [quote, setQuote] = useState<PublicQuote | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState<'approve' | 'decline' | null>(null)
  const [responding, setResponding] = useState(false)
  const [responseError, setResponseError] = useState<string | null>(null)

  const validToken = !!token && UUID_RE.test(token)

  const loadQuote = useCallback(async () => {
    if (!token || !UUID_RE.test(token)) {
      setQuote(null)
      setLoading(false)
      return
    }
    const { data, error } = await supabase.rpc('get_public_quote', { p_token: token })
    if (error) console.error('Failed to load quote:', error.message)
    setQuote((data as PublicQuote | null) ?? null)
    setLoading(false)
  }, [token])

  useEffect(() => {
    loadQuote()
  }, [loadQuote])

  // Engagement: count a view only once the quote has actually been visible for
  // a moment, so link scanners and prefetchers that never render or that load
  // the page in the background are not counted.
  const loaded = !!quote
  const staffViewer = !!quote?.viewer_is_staff
  useEffect(() => {
    if (!token || !loaded || staffViewer || recordedViewTokens.has(token)) return
    let timer: number | null = null
    let cancelled = false

    const start = () => {
      if (cancelled || timer !== null || document.visibilityState !== 'visible') return
      timer = window.setTimeout(() => {
        timer = null
        if (cancelled || document.visibilityState !== 'visible' || recordedViewTokens.has(token)) return
        recordedViewTokens.add(token)
        supabase
          .rpc('record_quote_view', { p_token: token, p_view_session_id: quoteViewSessionId(token) })
          .then(({ error }) => {
            if (error) {
              recordedViewTokens.delete(token)
              console.error('Failed to record quote view:', error.message)
            }
          })
      }, VIEW_DELAY_MS)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        start()
      } else if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [token, loaded, staffViewer])

  const submitResponse = async () => {
    if (!token || !confirming || responding) return
    setResponding(true)
    setResponseError(null)
    const { data, error } = await supabase.rpc('respond_to_quote', { p_token: token, p_response: confirming })
    setResponding(false)
    setConfirming(null)
    if (error) {
      setResponseError('Something went wrong while recording your response. Please try again.')
      return
    }
    const result = data as { ok: boolean; error?: string } | null
    if (!result?.ok) {
      setResponseError(RESPONSE_ERRORS[result?.error ?? ''] ?? 'Your response could not be recorded. Please try again.')
    }
    await loadQuote()
  }

  if (loading) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight">
        <div className="w-9 h-9 border-[3px] border-white/15 border-t-cobalt-400 rounded-full animate-spin" />
      </div>
    )
  }

  if (!validToken || !quote) {
    return (
      <div className="dark-surface min-h-screen flex items-center justify-center bg-obsidian-950 bg-radial-spotlight text-slate-100 px-4">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-lg font-medium">Quote not found</p>
          <p className="text-sm text-slate-500 mt-1">Please check the link in your email, or contact the shop that sent it.</p>
        </div>
      </div>
    )
  }

  const parts: PartEntry[] = Array.isArray(quote.selected_parts) ? quote.selected_parts : []
  const lineItems = Array.isArray(quote.custom_line_items) ? quote.custom_line_items : []
  const v = quote.vehicle
  const vehicleLine = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || v.name
  const responded = quote.status === 'approved' || quote.status === 'declined'
  const canRespond = !responded && !quote.is_superseded && !quote.is_expired
  const subtotal = Math.max(0, Number(quote.parts_total) + Number(quote.custom_lines_total) - Number(quote.discount_amount))

  return (
    <div className="dark-surface min-h-screen bg-obsidian-950 bg-radial-spotlight text-slate-100">
      <div className="max-w-3xl mx-auto px-4 py-8 sm:py-12">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-8">
          <div className="flex items-center gap-3 min-w-0">
            {quote.shop.logo_url ? (
              <img src={quote.shop.logo_url} alt={quote.shop.name} className="h-11 w-11 rounded-xl object-cover border border-white/10" />
            ) : (
              <div className="h-11 w-11 rounded-xl bg-metallic-gradient border border-white/10 flex items-center justify-center">
                <Package size={20} className="text-slate-300" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white leading-tight truncate">{quote.shop.name}</p>
              <p className="text-xs text-slate-400">Quote #{quote.revision_number}</p>
            </div>
          </div>
          {quote.sent_at && <p className="text-xs text-slate-500 text-right">Sent {formatDateTime(quote.sent_at)}</p>}
        </div>

        {quote.viewer_is_staff && (
          <Banner tone="info" icon={Eye}>
            Staff preview — you are signed in as shop staff, so this visit is not counted as a customer view.
          </Banner>
        )}
        {quote.is_superseded && (
          <Banner tone="warning" icon={RefreshCw}>
            This quote has been revised. It is kept here for your records — please use the link to the latest quote from {quote.shop.name}.
          </Banner>
        )}
        {quote.status === 'approved' && (
          <Banner tone="success" icon={CheckCircle2}>
            You approved this quote{quote.approved_at ? ` on ${formatDateTime(quote.approved_at)}` : ''}. {quote.shop.name} will be in touch about next steps.
          </Banner>
        )}
        {quote.status === 'declined' && (
          <Banner tone="neutral" icon={XCircle}>
            You declined this quote{quote.declined_at ? ` on ${formatDateTime(quote.declined_at)}` : ''}. Reach out to {quote.shop.name} if you would like changes.
          </Banner>
        )}
        {!responded && quote.is_expired && (
          <Banner tone="warning" icon={Clock}>
            This quote expired{quote.expires_at ? ` on ${formatQuoteDate(quote.expires_at)}` : ''}. Please contact {quote.shop.name} for an updated quote.
          </Banner>
        )}
        {responseError && <Banner tone="error" icon={AlertCircle}>{responseError}</Banner>}

        {/* Vehicle */}
        <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-6 mb-5">
          <p className="text-xs uppercase tracking-wider text-cobalt-300 font-semibold mb-1">Prepared for {quote.customer_name}</p>
          <h1 className="text-2xl font-bold text-white">{vehicleLine}</h1>
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-sm text-slate-400">
            {v.paint_code && <span className="flex items-center gap-1.5"><Palette size={13} /> Paint code: {v.paint_code}</span>}
            <span className="flex items-center gap-1.5"><Package size={13} /> {v.fulfillment_mode === 'mail' ? 'Mail-Order DIY' : 'Local Drop-off'}</span>
            {quote.estimated_lead_time_days > 0 && (
              <span className="flex items-center gap-1.5"><Clock size={13} /> Est. {quote.estimated_lead_time_days} {quote.estimated_lead_time_days === 1 ? 'day' : 'days'}</span>
            )}
            {quote.expires_at && (
              <span className="flex items-center gap-1.5"><FileText size={13} /> Valid through {formatQuoteDate(quote.expires_at)}</span>
            )}
          </div>
        </div>

        {/* Visual */}
        {(quote.front_image_url || quote.rear_image_url) && (
          <div className="mb-5">
            <QuoteVehiclePhotos parts={parts} frontUrl={quote.front_image_url} rearUrl={quote.rear_image_url} theme="dark" />
          </div>
        )}

        {/* Itemized */}
        {(parts.length > 0 || lineItems.length > 0) && (
          <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-6 mb-5">
            {parts.length > 0 && (
              <>
                <h2 className="text-sm font-semibold text-white mb-3">Selected Parts ({parts.length})</h2>
                <div className="mb-2">
                  {parts.map((part) => (
                    <div key={part.id} className="py-2 border-b border-white/5 last:border-0">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2.5 h-2.5 rounded-full ${getHighlightColor(part.highlight_color ?? 'green').dot} flex-shrink-0`} />
                          <span className="text-sm text-slate-200 truncate">{part.name}</span>
                          <span className="text-[11px] text-slate-500 flex-shrink-0">{part.type === 'new' ? 'Buy new' : 'Paint mine'}</span>
                        </div>
                        <span className="text-sm font-medium text-white flex-shrink-0">{part.price > 0 ? formatCurrency(part.price) : 'Included'}</span>
                      </div>
                      {part.paint_style_name && <p className="text-xs text-slate-400 mt-0.5 ml-5">Paint style: {part.paint_style_name}</p>}
                      {part.selected_options && part.selected_options.length > 0 && (
                        <ul className="text-xs text-slate-400 mt-0.5 ml-5 space-y-0.5">
                          {part.selected_options.map((opt) => <li key={opt.id}>+ {opt.name}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            {lineItems.length > 0 && (
              <>
                <h2 className={`text-sm font-semibold text-white mb-3 ${parts.length > 0 ? 'mt-5' : ''}`}>Additional Work</h2>
                {lineItems.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 py-2 border-b border-white/5 last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200">{item.description || 'Additional work'}</p>
                      {item.quantity !== 1 && (
                        <p className="text-xs text-slate-500">{item.quantity} × {formatCurrency(item.unit_price)}</p>
                      )}
                    </div>
                    <span className="text-sm font-medium text-white flex-shrink-0">{formatCurrency(lineItemTotal(item))}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Pricing */}
        <div className="bg-metallic-gradient rounded-2xl border border-white/10 border-t-white/20 shadow-glass-card p-6 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">Quote Summary</h2>
          <div className="space-y-1.5 text-sm">
            <SummaryRow label="Parts" value={formatCurrency(Number(quote.parts_total))} />
            {Number(quote.custom_lines_total) > 0 && <SummaryRow label="Additional work" value={formatCurrency(Number(quote.custom_lines_total))} />}
            {Number(quote.discount_amount) > 0 && <SummaryRow label="Discount" value={`−${formatCurrency(Number(quote.discount_amount))}`} />}
            <SummaryRow label="Subtotal" value={formatCurrency(subtotal)} />
            {Number(quote.tax_total) > 0 && <SummaryRow label={`Tax (${Number(quote.tax_rate)}%)`} value={formatCurrency(Number(quote.tax_total))} />}
            {Number(quote.shipping_total) > 0 && <SummaryRow label="Shipping" value={formatCurrency(Number(quote.shipping_total))} />}
            <div className="flex justify-between text-white font-bold text-lg pt-3 mt-1 border-t border-white/10">
              <span>Total</span>
              <span>{formatCurrency(Number(quote.grand_total))}</span>
            </div>
          </div>
        </div>

        {quote.customer_notes && (
          <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-6 mb-5">
            <h2 className="text-sm font-semibold text-white mb-2">Notes from {quote.shop.name}</h2>
            <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{quote.customer_notes}</p>
          </div>
        )}

        {/* Response */}
        {canRespond && (
          <div className="bg-obsidian-900/60 backdrop-blur-xl rounded-2xl border border-white/10 p-6 mb-5">
            <h2 className="text-sm font-semibold text-white mb-1">Ready to move forward?</h2>
            <p className="text-sm text-slate-400 mb-4">Let {quote.shop.name} know whether you would like to go ahead with this quote.</p>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => { setResponseError(null); setConfirming('approve') }}
                disabled={quote.viewer_is_staff}
                className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-5 py-3 transition-colors"
              >
                <CheckCircle2 size={18} /> Approve Quote
              </button>
              <button
                onClick={() => { setResponseError(null); setConfirming('decline') }}
                disabled={quote.viewer_is_staff}
                className="flex-1 flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border border-white/15 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 font-semibold rounded-xl px-5 py-3 transition-colors"
              >
                <XCircle size={18} /> Decline Quote
              </button>
            </div>
          </div>
        )}

        {(quote.shop.contact_email || quote.shop.phone) && (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-slate-500 mt-8">
            <span>Questions about this quote?</span>
            {quote.shop.contact_email && (
              <a href={`mailto:${quote.shop.contact_email}`} className="flex items-center gap-1 text-slate-400 hover:text-white"><Mail size={12} /> {quote.shop.contact_email}</a>
            )}
            {quote.shop.phone && (
              <a href={`tel:${quote.shop.phone}`} className="flex items-center gap-1 text-slate-400 hover:text-white"><Phone size={12} /> {quote.shop.phone}</a>
            )}
          </div>
        )}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => { if (!responding) setConfirming(null) }}>
          <div className="w-full max-w-md bg-obsidian-900 border border-white/10 rounded-2xl shadow-glass-card p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white">
              {confirming === 'approve' ? 'Approve this quote?' : 'Decline this quote?'}
            </h2>
            <p className="text-sm text-slate-400 mt-2 leading-relaxed">
              {confirming === 'approve'
                ? `You're approving Quote #${quote.revision_number} for ${formatCurrency(Number(quote.grand_total))}. ${quote.shop.name} will be notified and will follow up about next steps.`
                : `You're declining Quote #${quote.revision_number}. ${quote.shop.name} will be notified.`}
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setConfirming(null)}
                disabled={responding}
                className="flex-1 bg-white/5 hover:bg-white/10 border border-white/15 text-slate-200 font-medium rounded-xl px-4 py-2.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitResponse}
                disabled={responding}
                className={`flex-1 flex items-center justify-center gap-2 font-semibold rounded-xl px-4 py-2.5 transition-colors disabled:opacity-60 text-white ${
                  confirming === 'approve' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'
                }`}
              >
                {responding && <Loader2 size={16} className="animate-spin" />}
                {confirming === 'approve' ? 'Yes, approve' : 'Yes, decline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-slate-200">
      <span>{label}</span>
      <span className="font-medium text-white">{value}</span>
    </div>
  )
}

const BANNER_TONES = {
  info: 'bg-cobalt-500/10 border-cobalt-500/30 text-cobalt-200',
  success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
  warning: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
  error: 'bg-red-500/10 border-red-500/30 text-red-200',
  neutral: 'bg-white/5 border-white/15 text-slate-300',
} as const

function Banner({ tone, icon: Icon, children }: { tone: keyof typeof BANNER_TONES; icon: typeof AlertCircle; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 border rounded-2xl p-4 mb-5 text-sm leading-relaxed ${BANNER_TONES[tone]}`}>
      <Icon size={18} className="flex-shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  )
}
