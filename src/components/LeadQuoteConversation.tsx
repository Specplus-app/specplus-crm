import { useCallback, useEffect, useState } from 'react'
import { supabase, Lead, QuoteMessage, QuoteStatus, formatDateTime } from '../lib/supabase'
import { MESSAGE_MAX_LENGTH } from '../lib/quotes'
import { AlertCircle, Loader2, MessageSquare, Send } from 'lucide-react'

type QuoteRef = { id: string; revision_number: number; status: QuoteStatus; superseded_at: string | null }

// Staff view of the customer quote conversation for a custom lead. Messages
// stay attached to the revision they were written on; replies always go to the
// current active sent quote.
export default function LeadQuoteConversation({ lead, readOnly }: { lead: Lead; readOnly: boolean }) {
  const [quotes, setQuotes] = useState<QuoteRef[]>([])
  const [messages, setMessages] = useState<QuoteMessage[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [quotesRes, messagesRes] = await Promise.all([
      supabase.from('quotes').select('id, revision_number, status, superseded_at').eq('lead_id', lead.id).order('revision_number', { ascending: false }),
      supabase.from('quote_messages').select('*').eq('lead_id', lead.id).order('created_at', { ascending: true }),
    ])
    if (quotesRes.error) console.error('Failed to load quotes:', quotesRes.error.message)
    if (messagesRes.error) console.error('Failed to load messages:', messagesRes.error.message)
    const rows = (messagesRes.data ?? []) as QuoteMessage[]
    setQuotes((quotesRes.data ?? []) as QuoteRef[])
    setMessages(rows)
    setLoaded(true)

    const staffIds = Array.from(new Set(rows.map((m) => m.sender_id).filter((id): id is string => !!id)))
    if (staffIds.length > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', staffIds)
      setNames(new Map((profiles ?? []).map((p) => [p.id as string, (p.full_name as string) || (p.email as string)])))
    }
  }, [lead.id])

  useEffect(() => {
    load()
  }, [load])

  const sentQuotes = quotes.filter((q) => q.status !== 'draft')
  // The customer-visible quote: latest sent revision that has not been superseded.
  const activeQuote = sentQuotes.find((q) => !q.superseded_at) ?? null
  const revisionById = new Map(quotes.map((q) => [q.id, q.revision_number]))

  if (!loaded || (sentQuotes.length === 0 && messages.length === 0)) return null

  const send = async () => {
    const body = draft.trim()
    if (!body || sending || !activeQuote || readOnly) return
    setSending(true)
    setError(null)
    const { error: sendError } = await supabase.rpc('send_shop_quote_message', { p_quote_id: activeQuote.id, p_body: body })
    setSending(false)
    if (sendError) {
      setError(sendError.message || 'Could not send the reply.')
      return
    }
    setDraft('')
    await load()
  }

  const multipleRevisions = new Set(messages.map((m) => revisionById.get(m.quote_id))).size > 1

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
      <h2 className="text-sm font-semibold text-zinc-900 mb-1 flex items-center gap-2">
        <MessageSquare size={16} className="text-zinc-400" />
        Conversation
      </h2>
      <p className="text-xs text-zinc-500 mb-4">Messages with {lead.customer_name} on the customer quote.</p>

      {messages.length === 0 ? (
        <p className="text-sm text-zinc-400 text-center py-3">No messages yet.</p>
      ) : (
        <div className="space-y-3 mb-4">
          {messages.map((m, idx) => {
            const fromCustomer = m.sender_type === 'customer'
            const revision = revisionById.get(m.quote_id)
            const showRevision = multipleRevisions && (idx === 0 || revisionById.get(messages[idx - 1].quote_id) !== revision)
            const sender = fromCustomer
              ? lead.customer_name
              : (m.sender_id && names.get(m.sender_id)) || (m.sender_type === 'admin' ? 'SpecPlus admin' : 'Shop team')
            return (
              <div key={m.id}>
                {showRevision && revision !== undefined && (
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 text-center my-2">Quote #{revision}</p>
                )}
                <div className={`flex ${fromCustomer ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${fromCustomer ? 'bg-zinc-100 text-zinc-800' : 'bg-brand-600 text-white'}`}>
                    <p className={`text-[11px] font-semibold mb-0.5 ${fromCustomer ? 'text-zinc-500' : 'text-brand-100'}`}>
                      {fromCustomer ? `${sender} (customer)` : sender}
                    </p>
                    <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{m.body}</p>
                    <p className={`text-[10px] mt-1 ${fromCustomer ? 'text-zinc-400' : 'text-brand-100/80'}`}>{formatDateTime(m.created_at)}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {readOnly ? (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Replies are unavailable while your account is read-only.</p>
      ) : !activeQuote ? (
        <p className="text-xs text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
          There's no active quote with the customer right now. Send the current draft to continue the conversation.
        </p>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply to the customer…"
            rows={3}
            maxLength={MESSAGE_MAX_LENGTH}
            className="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors resize-y"
          />
          {error && (
            <p className="flex items-center gap-1.5 text-sm text-red-700 mt-2"><AlertCircle size={14} /> {error}</p>
          )}
          <div className="flex items-center justify-between gap-3 mt-2">
            <span className="text-xs text-zinc-400">Replying on Quote #{activeQuote.revision_number}</span>
            <button
              onClick={send}
              disabled={sending || !draft.trim()}
              className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Send Reply
            </button>
          </div>
        </>
      )}
    </div>
  )
}
