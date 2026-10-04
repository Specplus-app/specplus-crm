import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, Lead, Quote, formatCurrency, formatDateTime } from '../lib/supabase'
import { QUOTE_STATUS_META, createInitialQuote, createQuoteRevision, formatQuoteDate, isQuoteExpired, normalizeQuote, customerQuoteUrl, staffPreviewUrl } from '../lib/quotes'
import { AlertCircle, Check, Copy, ExternalLink, FileText, Loader2, Pencil, RefreshCw, Send } from 'lucide-react'

export default function LeadQuoteCard({ lead, readOnly }: { lead: Lead; readOnly: boolean }) {
  const navigate = useNavigate()
  const [latest, setLatest] = useState<Quote | null>(null)
  const [revisionCount, setRevisionCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    supabase
      .from('quotes')
      .select('*')
      .eq('lead_id', lead.id)
      .order('revision_number', { ascending: false })
      .then(({ data, error: loadError }) => {
        if (!active) return
        if (loadError) console.error('Failed to load quotes:', loadError.message)
        const rows = ((data ?? []) as Quote[]).map(normalizeQuote)
        setLatest(rows[0] ?? null)
        setRevisionCount(rows.length)
        setLoading(false)
      })
    return () => { active = false }
  }, [lead.id])

  const builderPath = `/dashboard/leads/${lead.id}/quote`
  const parts = Array.isArray(lead.selected_parts) ? lead.selected_parts : []
  // Custom-build areas the shop has not priced yet (existing lead pricing flow).
  const unpriced = parts.filter((p) => !p.priced)

  const handleCreate = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const { error: createError } = await createInitialQuote(lead)
    setBusy(false)
    if (createError) {
      setError(createError)
      return
    }
    navigate(builderPath)
  }

  const handleRevise = async () => {
    if (busy || !latest) return
    setBusy(true)
    setError(null)
    const { error: reviseError } = await createQuoteRevision(latest)
    setBusy(false)
    if (reviseError) {
      setError(reviseError)
      return
    }
    navigate(builderPath)
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

  const btnPrimary = 'flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors'
  const btnSecondary = 'flex items-center gap-2 bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors'

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
          <FileText size={16} className="text-zinc-400" />
          Customer Quote
        </h2>
        {latest && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Revision #{latest.revision_number}{revisionCount > 1 ? ` of ${revisionCount}` : ''}</span>
            <span className={`text-xs font-medium border rounded-full px-2 py-0.5 ${QUOTE_STATUS_META[latest.status].color}`}>
              {QUOTE_STATUS_META[latest.status].label}
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div className="h-10 bg-zinc-100 rounded-lg animate-pulse" />
      ) : !latest ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-500">Complete the missing pricing, then review and send the finished quote to the customer.</p>
            {!readOnly && (
              <button onClick={handleCreate} disabled={busy || unpriced.length > 0} className={btnPrimary}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                Review &amp; Send Quote
              </button>
            )}
          </div>
          {unpriced.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
              <p className="font-medium">
                {unpriced.length} of {parts.length} {parts.length === 1 ? 'area still needs' : 'areas still need'} pricing before the quote can be reviewed:
              </p>
              <p className="mt-0.5">{unpriced.map((p) => p.name).join(', ')}</p>
              <p className="mt-0.5 text-amber-600">Use “Set price” on the customer photos or in Build Details above.</p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-sm">
            <Stat label="Total" value={formatCurrency(latest.grand_total)} />
            <Stat
              label="Expires"
              value={latest.expires_at ? `${formatQuoteDate(latest.expires_at)}${isQuoteExpired(latest.expires_at) ? ' (expired)' : ''}` : 'No expiration'}
            />
            <Stat label="Sent" value={latest.sent_at ? formatDateTime(latest.sent_at) : 'Not sent'} />
            <Stat label="First viewed" value={latest.first_viewed_at ? formatDateTime(latest.first_viewed_at) : '—'} />
            <Stat label="Last viewed" value={latest.last_viewed_at ? formatDateTime(latest.last_viewed_at) : '—'} />
            <Stat label="Views" value={String(latest.view_count)} />
            {latest.approved_at && <Stat label="Approved" value={formatDateTime(latest.approved_at)} />}
            {latest.declined_at && <Stat label="Declined" value={formatDateTime(latest.declined_at)} />}
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-5 pt-5 border-t border-zinc-100">
            {latest.status === 'draft' ? (
              <button onClick={() => navigate(builderPath)} className={btnPrimary}>
                <Pencil size={15} />
                {readOnly ? 'View Quote' : 'Continue Quote'}
              </button>
            ) : (
              <>
                <button onClick={() => navigate(builderPath)} className={btnSecondary}>
                  <FileText size={15} />
                  View Quote
                </button>
                {!readOnly && (
                  <button onClick={handleRevise} disabled={busy} className={btnPrimary}>
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                    Revise Quote
                  </button>
                )}
                <button onClick={() => copyLink(customerQuoteUrl(latest.public_token))} className={btnSecondary}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? 'Copied' : 'Copy customer link'}
                </button>
                <a href={staffPreviewUrl(latest.public_token)} target="_blank" rel="noopener noreferrer" className={btnSecondary}>
                  <ExternalLink size={15} />
                  Preview
                </a>
              </>
            )}
          </div>
        </>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">
          <AlertCircle size={15} /> {error}
        </p>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="text-sm text-zinc-800">{value}</p>
    </div>
  )
}
