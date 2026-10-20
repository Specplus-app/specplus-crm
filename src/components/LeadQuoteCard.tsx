import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, Lead, Quote, formatCurrency, formatDateTime } from '../lib/supabase'
import {
  QUOTE_STATUS_META, formatQuoteDate, isQuoteExpired, leadBuildDiffersFromQuote, normalizeQuote, openDraftQuote,
  partsNeedingPrice, customerQuoteUrl, staffPreviewUrl, MESSAGE_MAX_LENGTH,
} from '../lib/quotes'
import { activeCustomerQuote, describeFollowUpResult, followUpAvailability, followUpPrefill, FollowUpOutcome, FollowUpResult } from '../lib/quoteFollowUp'
import { AlertCircle, BellRing, Check, Copy, ExternalLink, FileText, Loader2, Pencil, RefreshCw, Send } from 'lucide-react'

export default function LeadQuoteCard({ lead, readOnly, onFollowUpSent }: { lead: Lead; readOnly: boolean; onFollowUpSent?: () => void }) {
  const navigate = useNavigate()
  const [latest, setLatest] = useState<Quote | null>(null)
  const [revisionCount, setRevisionCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // The quote the customer has now. Differs from `latest` while a newer
  // revision is still an unsent draft; follow-ups always target this one.
  const [activeQuote, setActiveQuote] = useState<Quote | null>(null)
  const [lastFollowUpAt, setLastFollowUpAt] = useState<string | null>(null)
  // Follow-up composer. requestId stays the same across retries of one
  // follow-up so the server can recognize a repeated send.
  const [followUp, setFollowUp] = useState<{ body: string; requestId: string } | null>(null)
  const [followUpSending, setFollowUpSending] = useState(false)
  const [followUpError, setFollowUpError] = useState<string | null>(null)
  const [followUpOutcome, setFollowUpOutcome] = useState<FollowUpOutcome | null>(null)

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
        setActiveQuote(activeCustomerQuote(rows))
        setRevisionCount(rows.length)
        setLoading(false)
      })
    return () => { active = false }
  }, [lead.id])

  const loadLastFollowUp = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('quote_messages')
      .select('created_at')
      .eq('lead_id', lead.id)
      .eq('is_follow_up', true)
      .order('created_at', { ascending: false })
      .limit(1)
    if (loadError) console.error('Failed to load follow-ups:', loadError.message)
    setLastFollowUpAt((data?.[0]?.created_at as string | undefined) ?? null)
  }, [lead.id])

  useEffect(() => {
    loadLastFollowUp()
  }, [loadLastFollowUp])

  const builderPath = `/dashboard/leads/${lead.id}/quote`
  const parts = Array.isArray(lead.selected_parts) ? lead.selected_parts : []
  // Custom-build areas the shop has not priced yet (existing lead pricing flow).
  // Preconfigured parts already carry their configured prices.
  const unpriced = partsNeedingPrice(parts, lead.is_custom)
  const buildChanged = !!latest && leadBuildDiffersFromQuote(lead, latest)

  // Both actions reuse an open draft if one exists (stale page, second tab),
  // so repeated clicks never create duplicate drafts.
  const openDraft = async (revise: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const { error: openError } = await openDraftQuote(lead, { revise })
    setBusy(false)
    if (openError) {
      setError(openError)
      return
    }
    navigate(builderPath)
  }
  const handleCreate = () => openDraft(false)
  const handleRevise = () => openDraft(true)

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  // Follow-ups apply to the customer's current quote while they haven't answered it.
  const followUpQuote = activeQuote && (activeQuote.status === 'sent' || activeQuote.status === 'viewed') ? activeQuote : null
  const canFollowUp = !!followUpQuote && !readOnly
  const followUpState = followUpQuote ? followUpAvailability(followUpQuote, lead.status, lastFollowUpAt) : null
  const draftPending = !!followUpQuote && latest?.status === 'draft'

  const openFollowUp = () => {
    setFollowUpError(null)
    setFollowUpOutcome(null)
    setFollowUp({ body: followUpPrefill(lead.customer_name, lead.vehicle_name), requestId: crypto.randomUUID() })
  }

  const cancelFollowUp = () => {
    setFollowUp(null)
    setFollowUpError(null)
  }

  const sendFollowUp = async () => {
    if (!followUpQuote || !followUp || followUpSending) return
    const body = followUp.body.trim()
    if (!body) return
    setFollowUpSending(true)
    setFollowUpError(null)
    // On any failure the composer keeps the draft and its request id, so a
    // retry can't post the follow-up twice.
    let outcome: FollowUpOutcome
    try {
      const { data, error: rpcError } = await supabase.rpc('send_quote_follow_up', {
        p_quote_id: followUpQuote.id,
        p_body: body,
        p_request_id: followUp.requestId,
      })
      if (rpcError || !data) {
        setFollowUpError(rpcError?.message || 'Could not send the follow-up. Try again.')
        return
      }
      outcome = describeFollowUpResult(data as FollowUpResult, formatDateTime)
    } catch (err) {
      setFollowUpError(err instanceof Error && err.message ? err.message : 'Could not send the follow-up. Try again.')
      return
    } finally {
      setFollowUpSending(false)
    }
    if (!outcome.posted) {
      setFollowUpError(outcome.message)
      loadLastFollowUp()
      return
    }
    setFollowUp(null)
    setFollowUpOutcome(outcome)
    loadLastFollowUp()
    onFollowUpSent?.()
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
            <p className="text-sm text-zinc-500">
              {lead.is_custom
                ? 'Review the requested areas, adjust the build and pricing, then send the finished quote to the customer.'
                : 'Review the configured build and pricing, confirm shipping and any labor, then send the quote to the customer.'}
            </p>
            {!readOnly && (
              <button onClick={handleCreate} disabled={busy} className={btnPrimary}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                Review &amp; Send Quote
              </button>
            )}
          </div>
          {unpriced.length > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
              <p className="font-medium">
                {unpriced.length} of {parts.length} {parts.length === 1 ? 'area still needs' : 'areas still need'} pricing.
              </p>
              <p className="mt-0.5">In Review &amp; Send Quote you can price these areas, remove them from the quote, or add new build items.</p>
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
            {(followUpQuote || lastFollowUpAt) && <Stat label="Last follow-up" value={lastFollowUpAt ? formatDateTime(lastFollowUpAt) : '—'} />}
          </div>

          {buildChanged && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-4">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              {latest.status === 'draft'
                ? `The build was edited and no longer matches draft Quote #${latest.revision_number}. Open the quote to review the difference before sending.`
                : `The build was edited after Quote #${latest.revision_number} was sent. The customer's quote has not changed; revise the quote to send the updated terms for approval.`}
            </p>
          )}

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
            {/* Targets the customer's active quote, even while a newer revision is still a draft. */}
            {canFollowUp && (
              <button
                onClick={openFollowUp}
                disabled={!followUpState?.available || !!followUp}
                className={`${btnSecondary} disabled:opacity-60 disabled:cursor-not-allowed`}
              >
                <BellRing size={15} />
                {draftPending ? `Follow up on Quote #${followUpQuote!.revision_number}` : 'Follow up'}
              </button>
            )}
          </div>

          {canFollowUp && followUpState && !followUpState.available && (
            <p className="text-xs text-zinc-500 mt-2">
              {followUpState.reason === 'cooldown'
                ? `One follow-up every 24 hours. Next follow-up available ${formatDateTime(followUpState.nextAllowedAt.toISOString())}.`
                : followUpState.reason === 'expired'
                  ? 'This quote has expired. Revise the quote to send new terms instead of following up.'
                  : followUpState.reason === 'lead_closed'
                    ? "Follow-ups aren't available for completed or lost leads."
                    : 'This quote can no longer be followed up.'}
            </p>
          )}

          {followUp && (
            <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <p className="text-sm font-medium text-zinc-900">Follow up with {lead.customer_name}</p>
              <p className="text-xs text-zinc-500 mt-0.5 mb-3">
                Posts to the conversation on Quote #{followUpQuote?.revision_number} and queues an email alert with a link for the customer to read and reply on their quote.
              </p>
              <textarea
                value={followUp.body}
                onChange={(e) => setFollowUp({ ...followUp, body: e.target.value })}
                rows={6}
                maxLength={MESSAGE_MAX_LENGTH}
                disabled={followUpSending}
                aria-label="Follow-up message"
                className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors resize-y"
              />
              {followUpError && (
                <p className="flex items-center gap-1.5 text-sm text-red-700 mt-2"><AlertCircle size={14} /> {followUpError}</p>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2 mt-3">
                <button onClick={cancelFollowUp} disabled={followUpSending} className={btnSecondary}>
                  Cancel
                </button>
                <button onClick={sendFollowUp} disabled={followUpSending || !followUp.body.trim()} className={btnPrimary}>
                  {followUpSending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  Send follow-up
                </button>
              </div>
            </div>
          )}

          {followUpOutcome && (
            <div className="mt-3 space-y-2">
              <p className="flex items-start gap-1.5 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <Check size={15} className="flex-shrink-0 mt-0.5" /> {followUpOutcome.message}
              </p>
              {followUpOutcome.alertWarning && (
                <p className="flex items-start gap-1.5 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertCircle size={15} className="flex-shrink-0 mt-0.5" /> {followUpOutcome.alertWarning}
                </p>
              )}
            </div>
          )}
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
