// Delivers queued notifications (email via Resend, Web Push via VAPID).
//
// This is NOT a sending endpoint: it accepts no recipients or content. It only
// drains public.notification_deliveries, where recipients were resolved and
// authorization is re-checked by claim_notification_deliveries. Callers must
// present NOTIFICATION_DISPATCH_SECRET (server-side scheduler only; see
// docs/notifications.md). Outcomes are recorded per delivery with
// complete_notification_delivery, which owns retries and backoff.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import { sendWebPush, type PushOutcome } from '../_shared/webpush.ts'
import {
  renderCustomerEmail, renderShopEmail, resendOutcome, type CustomerEmailPayload, type ShopEmailPayload,
} from '../_shared/notificationEmails.ts'

const DEFAULT_CRM_ORIGIN = 'https://crm.specplus.app'
const DEFAULT_PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'
const BATCH_SIZE = 25
const MAX_BATCHES = 4
const TIME_BUDGET_MS = 25_000

type Outcome = { outcome: PushOutcome; error?: string; providerId?: string }

type Claimed = Record<string, unknown> & {
  delivery_id: string
  lease_token: string
  channel: 'email' | 'push'
  recipient_type: 'shop' | 'customer' | 'staff'
  kind: string
  attempt: number
}

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

async function deliverEmail(row: Claimed, env: (k: string) => string | undefined): Promise<Outcome> {
  const apiKey = env('RESEND_API_KEY')
  if (!apiKey) return { outcome: 'retry', error: 'email_not_configured' }
  const fromEmail = env('NOTIFICATION_FROM_EMAIL') ?? env('RESEND_FROM_EMAIL') ?? 'quotes@specplus.app'

  let email
  try {
    email = row.recipient_type === 'customer'
      ? renderCustomerEmail(row as unknown as CustomerEmailPayload, origin(env('PUBLIC_QUOTE_ORIGIN'), DEFAULT_PUBLIC_QUOTE_ORIGIN))
      : renderShopEmail(row as unknown as ShopEmailPayload, origin(env('CRM_ORIGIN'), DEFAULT_CRM_ORIGIN))
  } catch (err) {
    return { outcome: 'failed', error: `render: ${err instanceof Error ? err.message : String(err)}` }
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
    })
    const outcome = resendOutcome(resp.status)
    if (outcome === 'sent') {
      const data = await resp.json().catch(() => null) as { id?: string } | null
      return { outcome, providerId: typeof data?.id === 'string' ? data.id : undefined }
    }
    const detail = await resp.text().catch(() => '')
    return { outcome, error: `Resend HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
  } catch (err) {
    return { outcome: 'retry', error: `network: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }
  }
}

async function deliverPush(row: Claimed, env: (k: string) => string | undefined): Promise<Outcome> {
  const publicKey = env('VAPID_PUBLIC_KEY')
  const privateKey = env('VAPID_PRIVATE_KEY')
  const subject = env('VAPID_SUBJECT')
  if (!publicKey || !privateKey || !subject) return { outcome: 'retry', error: 'push_not_configured' }
  const n = row.notification as { title: string; body: string; url: string; tag: string }
  const res = await sendWebPush(
    { endpoint: String(row.endpoint), p256dh: String(row.p256dh), auth: String(row.auth) },
    { title: n.title, body: n.body, url: n.url, tag: n.tag },
    { publicKey, privateKey, subject },
    { topic: String(n.tag).replace(/-/g, '') },
  )
  return { outcome: res.outcome, error: res.error }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const env = (k: string) => Deno.env.get(k)
  const secret = env('NOTIFICATION_DISPATCH_SECRET') ?? ''
  if (secret.length < 32) {
    console.error('notification-dispatch: NOTIFICATION_DISPATCH_SECRET is not configured')
    return json(503, { error: 'Not configured' })
  }
  if (!timingSafeEqual(req.headers.get('x-notification-secret') ?? '', secret)) {
    return json(401, { error: 'Unauthorized' })
  }

  const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const started = Date.now()
  const totals: Record<string, number> = { claimed: 0, sent: 0, retry: 0, failed: 0, gone: 0, lease_lost: 0 }

  for (let batch = 0; batch < MAX_BATCHES && Date.now() - started < TIME_BUDGET_MS; batch++) {
    const { data, error } = await admin.rpc('claim_notification_deliveries', { p_limit: BATCH_SIZE })
    if (error) {
      console.error('claim_notification_deliveries failed:', error.message)
      return json(500, { error: 'Could not claim deliveries', ...totals })
    }
    const rows = (Array.isArray(data) ? data : []) as Claimed[]
    if (rows.length === 0) break
    totals.claimed += rows.length

    for (const row of rows) {
      let result: Outcome
      try {
        result = row.channel === 'email' ? await deliverEmail(row, env) : await deliverPush(row, env)
      } catch (err) {
        result = { outcome: 'retry', error: `unexpected: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }
      }
      const { data: done, error: completeError } = await admin.rpc('complete_notification_delivery', {
        p_delivery_id: row.delivery_id,
        p_lease_token: row.lease_token,
        p_outcome: result.outcome,
        p_error: result.error ?? null,
        p_provider_message_id: result.providerId ?? null,
      })
      if (completeError) {
        // The lease expires and the row is retried; Resend's idempotency key
        // and the push Topic keep that from duplicating what was delivered.
        console.error('complete_notification_delivery failed:', completeError.message)
        continue
      }
      if ((done as { ok?: boolean } | null)?.ok === false) totals.lease_lost++
      else totals[result.outcome]++
      if (result.outcome !== 'sent') {
        // Log ids and reasons only: never addresses, endpoints or content.
        console.warn(`delivery ${row.delivery_id} (${row.channel}/${row.kind}, attempt ${row.attempt}): ${result.outcome} ${result.error ?? ''}`)
      }
    }
    if (rows.length < BATCH_SIZE) break
  }

  return json(200, totals)
})
