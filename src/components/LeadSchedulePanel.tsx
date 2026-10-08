import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Lead, formatCurrency, formatDateTime } from '../lib/supabase'
import {
  LeadScheduleState, cancelSchedule, confirmSchedule, createScheduleOffer, loadLeadSchedule, scheduleActions,
  sendScheduleOptions, suggestedReadyDate, validateOfferDates,
} from '../lib/schedule'
import { addDays, formatDateOnly, todayDateOnly } from '../lib/scheduleDates'
import { AlertCircle, AlertTriangle, CalendarCheck, CalendarClock, CalendarDays, CalendarX, Loader2, Plus, RefreshCw, Send, Trash2, X } from 'lucide-react'

const longDate = (d: string) => formatDateOnly(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })

type Dialog = 'offer' | 'confirm' | 'cancel' | null

// Production scheduling for one lead: current offers, the customer's pending
// request, the confirmed booking and its history, plus the staff actions.
// Every action is checked again by the database.
export default function LeadSchedulePanel({
  lead, readOnly, intent, onChanged,
}: {
  lead: Lead
  readOnly: boolean
  // Incremented when staff pick "Scheduled" in a status dropdown.
  intent: number
  onChanged: () => void
}) {
  const [state, setState] = useState<LeadScheduleState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sendingDraft, setSendingDraft] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Latest known concurrency version, updated from action results so a retry
  // right after a partial failure does not use a stale value.
  const versionRef = useRef(0)

  const reload = useCallback(async () => {
    const { data, error } = await loadLeadSchedule(lead.id)
    if (error || !data) {
      setLoadError(error ?? 'Could not load the schedule.')
      return
    }
    versionRef.current = data.version
    setState(data)
    setLoadError(null)
  }, [lead.id])

  useEffect(() => {
    reload()
  }, [reload, lead.status])

  const actions = state ? scheduleActions(lead.status, state, readOnly) : null

  // "Scheduled" chosen in a status dropdown: open the right step of the flow
  // instead of changing the status directly.
  const handledIntent = useRef(0)
  useEffect(() => {
    if (!intent || intent === handledIntent.current || !state || !actions) return
    handledIntent.current = intent
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (actions.canConfirm) {
      setNotice(null)
      setDialog('confirm')
    } else if (state.pendingRequest) {
      setNotice('The customer\'s requested date can\'t be confirmed right now. See the details below.')
    } else if (state.activeOffer && !state.reservation) {
      setNotice('Date options were sent. The job moves to Scheduled after the customer picks a date and you confirm it.')
    } else if (actions.canOffer) {
      setNotice('Scheduled needs a confirmed production date. Offer dates to the customer first.')
      setDialog('offer')
    } else {
      setNotice(`Scheduled needs a confirmed production date. ${actions.offerBlockedReason ?? ''}`.trim())
    }
  }, [intent, state, actions])

  const afterChange = async () => {
    await reload()
    onChanged()
  }

  const sendDraft = async (offerId: string): Promise<string | null> => {
    const { error } = await sendScheduleOptions(offerId)
    await afterChange()
    return error
  }

  if (!state) {
    return (
      <div ref={panelRef} className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4">
        <PanelTitle />
        {loadError ? (
          <ErrorLine text={loadError} action={<button onClick={reload} className="underline">Retry</button>} />
        ) : (
          <div className="h-10 bg-zinc-100 rounded-lg animate-pulse" />
        )}
      </div>
    )
  }

  const a = actions!
  const relevant = !!state.currentQuote || !!state.reservation || state.pastReservations.length > 0 || a.scheduleMissing || !!notice
  if (!relevant) return <div ref={panelRef} />

  const { reservation, pendingRequest, activeOffer, draftOffer } = state
  const btnPrimary = 'flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors'
  const btnSecondary = 'flex items-center gap-2 bg-white border border-zinc-200 hover:bg-zinc-50 disabled:opacity-60 text-zinc-800 text-sm font-medium rounded-lg px-4 py-2 transition-colors'

  return (
    <div ref={panelRef} className="bg-white rounded-2xl border border-zinc-200 p-6 mb-4 scroll-mt-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <PanelTitle />
        {a.scheduleMissing && (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-2 py-0.5">
            <AlertTriangle size={11} /> Schedule missing
          </span>
        )}
      </div>

      {notice && (
        <div className="flex items-start justify-between gap-2 text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 mb-3">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" className="text-sky-600 hover:text-sky-800"><X size={13} /></button>
        </div>
      )}
      {loadError && <ErrorLine text={loadError} />}

      <div className="space-y-3">
        {a.scheduleMissing && (
          <p className="text-sm text-zinc-600">
            This job is marked Scheduled but has no confirmed production date. Offer dates to the customer to book one.
          </p>
        )}

        {reservation && (
          <Section icon={CalendarCheck} tone="emerald" title="Confirmed">
            <p className="text-sm text-zinc-800">
              Start <strong>{longDate(reservation.start_date)}</strong> · Ready <strong>{longDate(reservation.estimated_ready_date)}</strong>
            </p>
            <p className="text-xs text-zinc-500 mt-0.5">Booked against Quote #{reservation.quote_revision_number} · confirmed {formatDateTime(reservation.confirmed_at)}</p>
            {reservation.internal_notes && (
              <p className="text-xs text-zinc-600 mt-1 whitespace-pre-wrap"><span className="font-medium">Internal:</span> {reservation.internal_notes}</p>
            )}
            {a.newerTerms && (
              <p className="flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
                <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
                Quote #{a.newerTerms.revision_number} ({a.newerTerms.status}, {formatCurrency(a.newerTerms.grand_total)}) is newer than the booked Quote #{reservation.quote_revision_number}. The booking is unchanged; review the new terms.
              </p>
            )}
          </Section>
        )}

        {pendingRequest && (
          <Section icon={CalendarClock} tone="amber" title="Date requested — awaiting shop confirmation">
            <p className="text-sm text-zinc-800">Customer chose <strong>{longDate(pendingRequest.start_date)}</strong></p>
            <p className="text-xs text-zinc-500 mt-0.5">Requested {formatDateTime(pendingRequest.requested_at)}. Nothing is reserved until you confirm.</p>
            {!a.canConfirm && !readOnly && (
              <p className="text-xs text-amber-700 mt-1">{a.offerBlockedReason ?? 'This request can no longer be confirmed. Offer new dates.'}</p>
            )}
          </Section>
        )}

        {activeOffer && (
          <Section icon={CalendarDays} tone="sky" title={activeOffer.is_reschedule ? 'New dates offered (reschedule)' : 'Dates offered'}>
            <ul className="flex flex-wrap gap-1.5">
              {activeOffer.options.map((o) => (
                <li key={o.id} className={`text-xs rounded-md border px-2 py-0.5 ${pendingRequest?.start_date === o.start_date ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-zinc-50 border-zinc-200 text-zinc-700'}`}>
                  {longDate(o.start_date)}
                </li>
              ))}
            </ul>
            {activeOffer.customer_note && <p className="text-xs text-zinc-600 mt-1.5 whitespace-pre-wrap">Note to customer: {activeOffer.customer_note}</p>}
            {activeOffer.sent_at && <p className="text-xs text-zinc-500 mt-1">Sent {formatDateTime(activeOffer.sent_at)} · Quote #{activeOffer.quote_revision_number}</p>}
          </Section>
        )}

        {draftOffer && (
          <Section icon={Send} tone="zinc" title="Unsent date options">
            <p className="text-sm text-zinc-700">{draftOffer.options.map((o) => longDate(o.start_date)).join(', ')}</p>
            <p className="text-xs text-zinc-500 mt-0.5">These were saved but the email did not go out, so the customer can't see them yet.</p>
            {draftError && <ErrorLine text={draftError} />}
            {!readOnly && (
              <button
                onClick={async () => {
                  setSendingDraft(true)
                  setDraftError(await sendDraft(draftOffer.id))
                  setSendingDraft(false)
                }}
                disabled={sendingDraft}
                className={`${btnSecondary} mt-2`}
              >
                {sendingDraft ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Send date options
              </button>
            )}
          </Section>
        )}

        {!reservation && !pendingRequest && !activeOffer && !draftOffer && a.offerBlockedReason && !readOnly && (
          <p className="text-sm text-zinc-500">{a.offerBlockedReason}</p>
        )}
      </div>

      {!readOnly && (a.canOffer || a.canConfirm || a.canCancel) && (
        <div className="flex flex-wrap items-center gap-2 mt-5 pt-5 border-t border-zinc-100">
          {a.canConfirm && (
            <button onClick={() => setDialog('confirm')} className={btnPrimary}>
              <CalendarCheck size={15} /> Confirm schedule
            </button>
          )}
          {a.canOffer && (
            <button onClick={() => setDialog('offer')} className={a.canConfirm ? btnSecondary : btnPrimary}>
              <CalendarDays size={15} /> {a.offerLabel}
            </button>
          )}
          {a.canCancel && (
            <button onClick={() => setDialog('cancel')} className={`${btnSecondary} text-red-700`}>
              <CalendarX size={15} /> Cancel schedule
            </button>
          )}
        </div>
      )}
      {readOnly && <p className="text-xs text-zinc-400 mt-4">Scheduling is read-only while your account is inactive.</p>}

      {state.pastReservations.length > 0 && (
        <details className="mt-4">
          <summary className="text-xs font-medium text-zinc-500 cursor-pointer">Schedule history ({state.pastReservations.length})</summary>
          <ul className="mt-2 space-y-1">
            {state.pastReservations.map((r) => (
              <li key={r.id} className="text-xs text-zinc-600">
                <span className="font-medium capitalize">{r.status}</span>: {longDate(r.start_date)} – {longDate(r.estimated_ready_date)}
                {r.ended_at ? ` · ${formatDateTime(r.ended_at)}` : ''}{r.cancel_reason ? ` · ${r.cancel_reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      {dialog === 'offer' && (
        <OfferDatesDialog
          isReschedule={!!reservation}
          replacing={!!activeOffer || !!pendingRequest}
          onClose={() => setDialog(null)}
          onSubmit={async (dates, note) => {
            const created = await createScheduleOffer(lead.id, versionRef.current, dates, note)
            if (created.error || !created.data) {
              await reload()
              return created.error ?? 'Could not save the date options.'
            }
            const sendError = await sendDraft(created.data.offer_id)
            if (sendError) return `${sendError} The dates were saved as unsent options; you can retry from the schedule.`
            setDialog(null)
            setNotice(null)
            return null
          }}
        />
      )}
      {dialog === 'confirm' && pendingRequest && (
        <ConfirmScheduleDialog
          startDate={pendingRequest.start_date}
          suggestedReady={suggestedReadyDate(pendingRequest.start_date, Number(state.currentQuote?.estimated_lead_time_days) || 0, addDays)}
          leadTimeDays={Number(state.currentQuote?.estimated_lead_time_days) || 0}
          replacing={reservation ? `${longDate(reservation.start_date)} – ${longDate(reservation.estimated_ready_date)}` : null}
          onClose={() => setDialog(null)}
          onSubmit={async (ready, notes) => {
            const { error } = await confirmSchedule(pendingRequest.id, versionRef.current, ready, notes)
            if (error) {
              await reload()
              return error
            }
            setDialog(null)
            setNotice(null)
            await afterChange()
            return null
          }}
        />
      )}
      {dialog === 'cancel' && reservation && (
        <CancelScheduleDialog
          booking={`${longDate(reservation.start_date)} – ${longDate(reservation.estimated_ready_date)}`}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const { error } = await cancelSchedule(lead.id, versionRef.current, reason)
            if (error) {
              await reload()
              return error
            }
            setDialog(null)
            await afterChange()
            return null
          }}
        />
      )}
    </div>
  )
}

function PanelTitle() {
  return (
    <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
      <CalendarDays size={16} className="text-zinc-400" />
      Production Schedule
    </h2>
  )
}

const TONES = {
  emerald: 'border-emerald-200 bg-emerald-50/50 text-emerald-700',
  amber: 'border-amber-200 bg-amber-50/50 text-amber-700',
  sky: 'border-sky-200 bg-sky-50/50 text-sky-700',
  zinc: 'border-zinc-200 bg-zinc-50 text-zinc-600',
} as const

function Section({ icon: Icon, tone, title, children }: { icon: typeof CalendarDays; tone: keyof typeof TONES; title: string; children: ReactNode }) {
  return (
    <div className={`border rounded-xl px-3 py-2.5 ${TONES[tone]}`}>
      <p className="text-xs font-semibold flex items-center gap-1.5 mb-1"><Icon size={13} /> {title}</p>
      {children}
    </div>
  )
}

function ErrorLine({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">
      <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
      <span className="flex-1">{text}</span>
      {action}
    </p>
  )
}

const inputCls = 'w-full bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors'

function Modal({ title, onClose, busy, children }: { title: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => { if (!busy) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-zinc-100">
          <h2 className="text-lg font-bold text-zinc-900">{title}</h2>
          <button onClick={onClose} disabled={busy} className="text-zinc-400 hover:text-zinc-600 disabled:opacity-40" aria-label="Close"><X size={20} /></button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  )
}

function DialogButtons({ busy, label, onCancel, onConfirm, danger = false }: { busy: boolean; label: string; onCancel: () => void; onConfirm: () => void; danger?: boolean }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-zinc-200 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50">Close</button>
      <button
        onClick={onConfirm}
        disabled={busy}
        className={`inline-flex items-center gap-2 text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 transition-colors ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'}`}
      >
        {busy && <Loader2 size={15} className="animate-spin" />}
        {label}
      </button>
    </div>
  )
}

// Inputs stay in place on failure so nothing has to be re-entered.
function useSubmit(onSubmit: () => Promise<string | null>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await onSubmit()
    setBusy(false)
    if (result) setError(result)
  }
  return { busy, error, setError, run }
}

function OfferDatesDialog({ isReschedule, replacing, onClose, onSubmit }: {
  isReschedule: boolean
  replacing: boolean
  onClose: () => void
  onSubmit: (dates: string[], note: string) => Promise<string | null>
}) {
  const today = todayDateOnly()
  const [dates, setDates] = useState<string[]>([''])
  const [note, setNote] = useState('')
  const submit = useSubmit(async () => {
    const checked = validateOfferDates(dates, today)
    if (checked.error) return checked.error
    return onSubmit(checked.dates, note)
  })

  return (
    <Modal title={isReschedule ? 'Reschedule' : 'Offer dates'} onClose={onClose} busy={submit.busy}>
      <p className="text-sm text-zinc-600">
        {isReschedule
          ? 'The current booking stays in place until you confirm the customer\'s new choice.'
          : 'The customer picks one of these production start dates from their quote link. Nothing is reserved until you confirm.'}
      </p>
      {replacing && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Sending replaces the dates already offered, including any date the customer has requested.</p>}
      <div>
        <label className="block text-xs font-semibold text-zinc-600 mb-1">Start dates</label>
        <div className="space-y-2">
          {dates.map((d, i) => (
            <div key={i} className="flex gap-2">
              <input type="date" min={today} value={d} onChange={(e) => setDates(dates.map((x, j) => (j === i ? e.target.value : x)))} className={inputCls} />
              {dates.length > 1 && (
                <button onClick={() => setDates(dates.filter((_, j) => j !== i))} className="p-2 text-zinc-400 hover:text-red-600" aria-label="Remove date"><Trash2 size={15} /></button>
              )}
            </div>
          ))}
        </div>
        {dates.length < 10 && (
          <button onClick={() => setDates([...dates, ''])} className="flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 rounded-lg px-2 py-1 mt-2">
            <Plus size={14} /> Add another date
          </button>
        )}
      </div>
      <div>
        <label className="block text-xs font-semibold text-zinc-600 mb-1">Note to customer <span className="font-normal text-zinc-400">(optional, shown to the customer)</span></label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} className={`${inputCls} resize-none`} />
      </div>
      {submit.error && <ErrorLine text={submit.error} />}
      <DialogButtons busy={submit.busy} label="Send date options" onCancel={onClose} onConfirm={submit.run} />
    </Modal>
  )
}

function ConfirmScheduleDialog({ startDate, suggestedReady, leadTimeDays, replacing, onClose, onSubmit }: {
  startDate: string
  suggestedReady: string
  leadTimeDays: number
  replacing: string | null
  onClose: () => void
  onSubmit: (ready: string, notes: string) => Promise<string | null>
}) {
  const [ready, setReady] = useState(suggestedReady)
  const [notes, setNotes] = useState('')
  const submit = useSubmit(async () => {
    if (!ready) return 'Set the estimated-ready date.'
    if (ready < startDate) return 'The estimated-ready date must be on or after the start date.'
    return onSubmit(ready, notes)
  })

  return (
    <Modal title="Confirm schedule" onClose={onClose} busy={submit.busy}>
      <p className="text-sm text-zinc-700">Customer's requested start: <strong>{longDate(startDate)}</strong></p>
      {replacing && <p className="text-xs text-zinc-600 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">This replaces the current booking ({replacing}).</p>}
      <div>
        <label className="block text-xs font-semibold text-zinc-600 mb-1">Estimated ready date</label>
        <input type="date" min={startDate} value={ready} onChange={(e) => setReady(e.target.value)} className={inputCls} />
        {leadTimeDays > 0 && <p className="text-[11px] text-zinc-500 mt-1">For reference: the approved quote estimates {leadTimeDays} {leadTimeDays === 1 ? 'day' : 'days'} of lead time.</p>}
      </div>
      <div>
        <label className="block text-xs font-semibold text-zinc-600 mb-1">Internal notes <span className="font-normal text-zinc-400">(shop only)</span></label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} className={`${inputCls} resize-none`} />
      </div>
      {submit.error && <ErrorLine text={submit.error} />}
      <DialogButtons busy={submit.busy} label="Confirm schedule" onCancel={onClose} onConfirm={submit.run} />
    </Modal>
  )
}

function CancelScheduleDialog({ booking, onClose, onSubmit }: {
  booking: string
  onClose: () => void
  onSubmit: (reason: string) => Promise<string | null>
}) {
  const [reason, setReason] = useState('')
  const submit = useSubmit(() => onSubmit(reason))
  return (
    <Modal title="Cancel schedule" onClose={onClose} busy={submit.busy}>
      <p className="text-sm text-zinc-700">Cancel the booking for <strong>{booking}</strong>? The job returns to Scheduling and the booking stays in its history. Outstanding date options are withdrawn.</p>
      <div>
        <label className="block text-xs font-semibold text-zinc-600 mb-1">Reason <span className="font-normal text-zinc-400">(shop only, optional)</span></label>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} className={`${inputCls} resize-none`} />
      </div>
      {submit.error && <ErrorLine text={submit.error} />}
      <DialogButtons busy={submit.busy} label="Cancel schedule" onCancel={onClose} onConfirm={submit.run} danger />
    </Modal>
  )
}
