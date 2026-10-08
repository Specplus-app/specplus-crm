import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

// Emails a project's quote review link with its new production date options,
// following the send-quote pattern: validate as the caller (RLS), send through
// Resend, and only then activate the options through the controlled database
// function (mark_schedule_offer_sent, service_role only).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

const DEFAULT_PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'
// Only hostnames ending exactly with this suffix are trusted, never arbitrary
// *.vercel.app domains.
const PREVIEW_HOST_SUFFIX = '-spec-plus.vercel.app'

function approvedPreviewOrigin(origin: string | null): string | null {
  if (!origin) return null
  try {
    const url = new URL(origin)
    if (url.protocol === 'https:' && url.hostname.endsWith(PREVIEW_HOST_SUFFIX) && !url.port) {
      return `https://${url.hostname}`
    }
  } catch {
    // Malformed Origin header: fall through to the default.
  }
  return null
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

// Date-only values are calendar dates; never shift them through a timezone.
const formatDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

// Mirrors the app's billing rule: active and lifetime-free shops can write;
// trial shops only while the trial is current; everything else is read-only.
function shopIsReadOnly(shop: { subscription_status: string; trial_ends_at: string | null; is_lifetime_free: boolean }) {
  if (shop.is_lifetime_free) return false
  if (shop.subscription_status === 'active') return false
  const isTrial = shop.subscription_status === 'trial' || shop.subscription_status === 'trialing'
  const trialEnd = shop.trial_ends_at ? new Date(shop.trial_ends_at).getTime() : NaN
  return !(isTrial && Number.isFinite(trialEnd) && trialEnd >= Date.now())
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  try {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) {
      return json(400, { error: 'Email is not configured yet. Add your Resend API key to enable sending date options.' })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? 'quotes@specplus.app'
    const publicOrigin = approvedPreviewOrigin(req.headers.get('Origin'))
      ?? (Deno.env.get('PUBLIC_QUOTE_ORIGIN') ?? DEFAULT_PUBLIC_QUOTE_ORIGIN).replace(/\/+$/, '')

    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token) {
      return json(401, { error: 'Missing authorization header' })
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: { user }, error: userError } = await adminClient.auth.getUser(token)
    if (userError || !user) {
      return json(401, { error: 'Invalid or expired session' })
    }

    const body = await req.json().catch(() => null)
    const offerId: string = typeof body?.offerId === 'string' ? body.offerId : ''
    if (!UUID_RE.test(offerId)) {
      return json(400, { error: 'offerId is required' })
    }

    // Read as the caller so shop RLS decides access.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: profile } = await userClient
      .from('profiles')
      .select('id, role, shop_id')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile || (profile.role !== 'admin' && profile.role !== 'shop_user')) {
      return json(403, { error: 'Not allowed to send date options' })
    }

    const { data: offer } = await userClient
      .from('schedule_offers')
      .select('id, lead_id, shop_id, quote_id, status, customer_note, is_reschedule')
      .eq('id', offerId)
      .maybeSingle()
    if (!offer || (profile.role === 'shop_user' && offer.shop_id !== profile.shop_id)) {
      return json(404, { error: 'Date options not found' })
    }
    if (offer.status !== 'draft') {
      return json(409, { error: 'These date options were already sent or replaced. Reload the lead.' })
    }

    const [{ data: lead }, { data: shop }, { data: quote }, { data: options }] = await Promise.all([
      userClient.from('leads').select('id, customer_name, customer_email, vehicle_name').eq('id', offer.lead_id).maybeSingle(),
      userClient.from('shops').select('id, name, contact_email, subscription_status, trial_ends_at, is_lifetime_free').eq('id', offer.shop_id).maybeSingle(),
      userClient.from('quotes').select('id, status, public_token, superseded_at').eq('id', offer.quote_id).maybeSingle(),
      userClient.from('schedule_offer_options').select('start_date').eq('offer_id', offer.id),
    ])
    if (!lead || !shop || !quote) {
      return json(404, { error: 'Date options not found' })
    }
    if (profile.role === 'shop_user' && shopIsReadOnly(shop)) {
      return json(403, { error: 'Your account is read-only. Reactivate your subscription to send date options.' })
    }
    if (quote.status !== 'approved' || quote.superseded_at) {
      return json(409, { error: 'The quote changed. Offer new dates once the customer approves the current quote.' })
    }
    const dates = ((options ?? []) as { start_date: string }[]).map((o) => String(o.start_date)).sort()
    if (dates.length === 0) {
      return json(400, { error: 'Add at least one start date.' })
    }
    // Same rule as the database (schedule_start_date_is_open): a date has
    // passed once it is earlier than yesterday (UTC). Never email those.
    const earliestOpen = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    if (dates[0] < earliestOpen) {
      return json(409, { error: 'One or more of these dates have passed. Offer fresh dates.' })
    }
    const customerEmail = String(lead.customer_email ?? '').trim()
    if (!customerEmail) {
      return json(400, { error: 'This lead has no customer email address.' })
    }

    const quoteUrl = `${publicOrigin}/q/${quote.public_token}`
    const shopName = String(shop.name ?? '').trim()
    const vehicleName = String(lead.vehicle_name ?? '').trim() || 'your vehicle'
    const safeName = escapeHtml(String(lead.customer_name ?? '').trim() || 'there')
    const safeVehicle = escapeHtml(vehicleName)
    const safeShop = escapeHtml(shopName || 'SpecPlus')
    const safeUrl = escapeHtml(quoteUrl)
    const safeNote = offer.customer_note ? escapeHtml(String(offer.customer_note)) : ''
    const dateItems = dates.map((d) => `<li style="margin:4px 0;color:#ffffff;">${escapeHtml(formatDate(d))}</li>`).join('')
    const intro = offer.is_reschedule
      ? 'We need to move your production start date. Please choose one of the new dates below.'
      : 'Thanks for approving your quote. Please choose a production start date that works for you.'

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0c10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c10;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#12151c;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0;color:#60a5fa;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${safeShop}</p>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">Choose your production start date</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 8px;">
          <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.6;">Hi ${safeName},</p>
          <p style="margin:12px 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">${intro} Your <strong style="color:#ffffff;">${safeVehicle}</strong> is booked once the shop confirms your choice.</p>
          <ul style="margin:12px 0 0;padding-left:20px;font-size:15px;">${dateItems}</ul>
          ${safeNote ? `<p style="margin:12px 0 0;color:#94a3b8;font-size:14px;line-height:1.6;white-space:pre-wrap;">${safeNote}</p>` : ''}
        </td></tr>
        <tr><td align="center" style="padding:28px 32px;">
          <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:12px;">Choose a date</a>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#60a5fa;word-break:break-all;">${safeUrl}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

    const senderName = shopName ? `${shopName.replace(/[<>"\r\n]/g, '')} via SpecPlus` : 'SpecPlus'
    const payload: Record<string, unknown> = {
      from: `${senderName} <${fromEmail}>`,
      to: [customerEmail],
      subject: `Choose a production date for your ${vehicleName.replace(/[\r\n]/g, ' ')}`,
      html,
    }
    const replyTo = String(shop.contact_email ?? '').trim()
    if (replyTo) payload.reply_to = replyTo

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const detail = await resp.text()
      console.error('Resend error:', detail)
      return json(502, { error: 'Failed to send email. The date options were not sent.' })
    }

    const { data: sent, error: markError } = await adminClient.rpc('mark_schedule_offer_sent', {
      p_offer_id: offer.id,
      p_actor_id: user.id,
    })
    if (markError) {
      console.error('mark_schedule_offer_sent error:', markError.message)
      return json(500, {
        error: `The email was sent, but the date options could not be activated: ${markError.message}`,
      })
    }

    return json(200, {
      success: true,
      version: (sent as { version?: number } | null)?.version ?? null,
      quote_url: quoteUrl,
    })
  } catch (err) {
    console.error('send-schedule-options error:', err)
    return json(500, { error: 'Unexpected error while sending date options.' })
  }
})
