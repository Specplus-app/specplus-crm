// Delivers queued notifications (email via Resend, Web Push via VAPID).
//
// This is NOT a sending endpoint: it accepts no recipients or content. It only
// drains public.notification_deliveries, where recipients were resolved and
// authorization is re-checked by claim_notification_deliveries. Callers must
// present NOTIFICATION_DISPATCH_SECRET (server-side scheduler only; see
// docs/notifications.md). Outcomes are recorded per delivery with
// complete_notification_delivery, which owns retries and backoff.
//
// Each run first re-enqueues events whose notification enqueue failed
// (recover_notification_events), then sends. Every provider and database wait
// is bounded, and a delivery only starts if it can finish well inside its
// lease (see _shared/dispatchLimits.ts); the rest are released unsent.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { sendWebPush, type PushOutcome } from '../_shared/webpush.ts'
import {
  renderCustomerEmail, renderShopEmail, resendOutcome, type CustomerEmailPayload, type ShopEmailPayload,
} from '../_shared/notificationEmails.ts'
import { DB_TIMEOUT_MS, canStartDelivery, dispatchLimits, isTimeout, type DispatchLimits } from '../_shared/dispatchLimits.ts'

const DEFAULT_CRM_ORIGIN = 'https://crm.specplus.app'
const DEFAULT_PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'
const BATCH_SIZE = 25
const MAX_BATCHES = 4
const RECOVERY_LIMIT = 100

type Outcome = { outcome: PushOutcome | 'release'; error?: string; providerId?: string }

type Claimed = Record<string, unknown> & {
  delivery_id: string
  lease_token: string
  channel: 'email' | 'push'
  recipient_type: 'shop' | 'customer' | 'staff'
  kind: string
  attempt: number
}

type Env = (k: string) => string | undefined

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

const origin = (value: string | undefined, fallback: string) => (value ?? fallback).replace(/\/+$/, '')
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function deliverEmail(row: Claimed, env: Env, limits: DispatchLimits): Promise<Outcome> {
  const apiKey = env('RESEND_API_KEY')
  if (!apiKey) return { outcome: 'retry', error: 'email_not_configured' }
  const fromEmail = env('NOTIFICATION_FROM_EMAIL') ?? env('RESEND_FROM_EMAIL') ?? 'quotes@specplus.app'

  let email
  try {
    email = row.recipient_type === 'customer'
      ? renderCustomerEmail(row as unknown as CustomerEmailPayload, origin(env('PUBLIC_QUOTE_ORIGIN'), DEFAULT_PUBLIC_QUOTE_ORIGIN))
      : renderShopEmail(row as unknown as ShopEmailPayload, origin(env('CRM_ORIGIN'), DEFAULT_CRM_ORIGIN))
  } catch (err) {
    return { outcome: 'failed', error: `render: ${message(err)}` }
  }

  const payload: Record<string, unknown> = {
    from: `${email.fromName} <${fromEmail}>`,
    to: [email.to],
    subject: email.subject,
    html: email.html,
    text: email.text,
  }
  if (email.replyTo) payload.reply_to = email.replyTo

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Resend de-duplicates retries of the same delivery for 24 hours.
        'Idempotency-Key': `notification-${row.delivery_id}`,
      },
      body: JSON.stringify(payload),
      // Also bounds reading the response body.
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    })
    const outcome = resendOutcome(resp.status)
    if (outcome === 'sent') {
      const data = await resp.json().catch(() => null) as { id?: string } | null
      return { outcome, providerId: typeof data?.id === 'string' ? data.id : undefined }
    }
    const detail = await resp.text().catch(() => '')
    return { outcome, error: `Resend HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
  } catch (err) {
    // A timed-out request may still have been accepted: the retry reuses the
    // same Idempotency-Key, so Resend does not send it twice.
    if (isTimeout(err)) return { outcome: 'retry', error: `timeout after ${limits.requestTimeoutMs}ms` }
    return { outcome: 'retry', error: `network: ${message(err)}`.slice(0, 300) }
  }
}

async function deliverPush(row: Claimed, env: Env, limits: DispatchLimits): Promise<Outcome> {
  const publicKey = env('VAPID_PUBLIC_KEY')
  const privateKey = env('VAPID_PRIVATE_KEY')
  const subject = env('VAPID_SUBJECT')
  if (!publicKey || !privateKey || !subject) return { outcome: 'retry', error: 'push_not_configured' }
  const n = row.notification as { title: string; body: string; url: string; tag: string }
  const res = await sendWebPush(
    { endpoint: String(row.endpoint), p256dh: String(row.p256dh), auth: String(row.auth) },
    { title: n.title, body: n.body, url: n.url, tag: n.tag },
    { publicKey, privateKey, subject },
    { topic: String(n.tag).replace(/-/g, ''), timeoutMs: limits.requestTimeoutMs },
  )
  return { outcome: res.outcome, error: res.error }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const env: Env = (k) => Deno.env.get(k)
  const secret = env('NOTIFICATION_DISPATCH_SECRET') ?? ''
  if (secret.length < 32) {
    console.error('notification-dispatch: NOTIFICATION_DISPATCH_SECRET is not configured')
    return json(503, { error: 'Not configured' })
  }
  if (!timingSafeEqual(req.headers.get('x-notification-secret') ?? '', secret)) {
    return json(401, { error: 'Unauthorized' })
  }

  const limits = dispatchLimits(env)
  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
    // The dispatcher's own database calls are bounded too.
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: AbortSignal.timeout(DB_TIMEOUT_MS) }),
    },
  })

  const started = Date.now()
  const totals: Record<string, number> = {
    recovered: 0, claimed: 0, sent: 0, retry: 0, failed: 0, gone: 0, released: 0, lease_lost: 0,
  }

  // true = recorded, false = lease lost, null = could not record.
  const complete = async (row: Claimed, result: Outcome): Promise<boolean | null> => {
    try {
      const { data, error } = await admin.rpc('complete_notification_delivery', {
        p_delivery_id: row.delivery_id,
        p_lease_token: row.lease_token,
        p_outcome: result.outcome,
        p_error: result.error ?? null,
        p_provider_message_id: result.providerId ?? null,
      })
      if (error) throw new Error(error.message)
      return (data as { ok?: boolean } | null)?.ok !== false
    } catch (err) {
      // The lease expires and the row is retried: Resend's idempotency key
      // prevents a second email; a second push is possible (see docs).
      console.error('complete_notification_delivery failed:', message(err))
      return null
    }
  }

  // Rebuild notifications lost to an enqueue failure (bounded, idempotent).
  try {
    const { data, error } = await admin.rpc('recover_notification_events', { p_limit: RECOVERY_LIMIT })
    if (error) throw new Error(error.message)
    totals.recovered = Number((data as { recovered?: number } | null)?.recovered ?? 0)
  } catch (err) {
    console.error('recover_notification_events failed:', message(err))
  }

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    // No point claiming work this run could not start.
    if (!canStartDelivery(limits, Date.now(), started, Date.now())) break
    const claimedAt = Date.now()
    let rows: Claimed[]
    try {
      const { data, error } = await admin.rpc('claim_notification_deliveries', { p_limit: BATCH_SIZE })
      if (error) throw new Error(error.message)
      rows = (Array.isArray(data) ? data : []) as Claimed[]
    } catch (err) {
      console.error('claim_notification_deliveries failed:', message(err))
      return json(500, { error: 'Could not claim deliveries', ...totals })
    }
    if (rows.length === 0) break
    totals.claimed += rows.length

    let stopped = false
    for (const row of rows) {
      // Checked before EVERY delivery: if a request could not finish inside
      // the run budget and this batch's lease, hand the rest back unsent.
      if (stopped || !canStartDelivery(limits, Date.now(), started, claimedAt)) {
        stopped = true
        if (await complete(row, { outcome: 'release' })) totals.released++
        continue
      }
      let result: Outcome
      try {
        result = row.channel === 'email' ? await deliverEmail(row, env, limits) : await deliverPush(row, env, limits)
      } catch (err) {
        result = { outcome: 'retry', error: `unexpected: ${message(err)}`.slice(0, 300) }
      }
      const recorded = await complete(row, result)
      if (recorded === null) continue
      if (!recorded) totals.lease_lost++
      else totals[result.outcome]++
      if (result.outcome !== 'sent') {
        // Log ids and reasons only: never addresses, endpoints or content.
        console.warn(`delivery ${row.delivery_id} (${row.channel}/${row.kind}, attempt ${row.attempt}): ${result.outcome} ${result.error ?? ''}`)
      }
    }
    if (stopped || rows.length < BATCH_SIZE) break
  }

  return json(200, totals)
})
