import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

const DEFAULT_PUBLIC_QUOTE_ORIGIN = 'https://quotes.specplus.app'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)

const formatDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
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
      return json(400, { error: 'Email is not configured yet. Add your Resend API key to enable sending quotes.' })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') ?? 'quotes@specplus.app'
    const publicOrigin = (Deno.env.get('PUBLIC_QUOTE_ORIGIN') ?? DEFAULT_PUBLIC_QUOTE_ORIGIN).replace(/\/+$/, '')

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
    const quoteId: string = typeof body?.quoteId === 'string' ? body.quoteId : ''
    if (!UUID_RE.test(quoteId)) {
      return json(400, { error: 'quoteId is required' })
    }

    // Read everything as the caller so existing shop RLS decides access: a user
    // can only load quotes, leads and shops belonging to their own shop.
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
      return json(403, { error: 'Not allowed to send quotes' })
    }

    const { data: quote, error: quoteError } = await userClient
      .from('quotes')
      .select('id, lead_id, shop_id, status, revision_number, public_token, grand_total, expires_at, selected_parts, custom_line_items')
      .eq('id', quoteId)
      .maybeSingle()
    if (quoteError || !quote) {
      return json(404, { error: 'Quote not found' })
    }
    if (profile.role === 'shop_user' && quote.shop_id !== profile.shop_id) {
      return json(404, { error: 'Quote not found' })
    }
    if (quote.status !== 'draft') {
      return json(409, { error: 'This quote has already been sent. Revise it to send updated pricing.' })
    }
    const partCount = Array.isArray(quote.selected_parts) ? quote.selected_parts.length : 0
    const lineCount = Array.isArray(quote.custom_line_items) ? quote.custom_line_items.length : 0
    if (partCount === 0 && lineCount === 0) {
      return json(400, { error: 'Add at least one item before sending this quote.' })
    }

    const [{ data: lead }, { data: shop }] = await Promise.all([
      userClient.from('leads').select('id, customer_name, customer_email, vehicle_name').eq('id', quote.lead_id).maybeSingle(),
      userClient.from('shops').select('id, name, contact_email, subscription_status, trial_ends_at, is_lifetime_free').eq('id', quote.shop_id).maybeSingle(),
    ])
    if (!lead || !shop) {
      return json(404, { error: 'Quote not found' })
    }
    if (profile.role === 'shop_user' && shopIsReadOnly(shop)) {
      return json(403, { error: 'Your account is read-only. Reactivate your subscription to send quotes.' })
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
    const safeTotal = escapeHtml(formatCurrency(Number(quote.grand_total) || 0))
    const safeExpiry = quote.expires_at ? escapeHtml(formatDate(String(quote.expires_at))) : ''

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0c10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c10;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#12151c;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0;color:#60a5fa;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${safeShop}</p>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">Your quote is ready</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 8px;">
          <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.6;">Hi ${safeName},</p>
          <p style="margin:12px 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">We've prepared a quote for your <strong style="color:#ffffff;">${safeVehicle}</strong>. You can review the itemized pricing and approve or decline it online.</p>
          <p style="margin:16px 0 0;color:#94a3b8;font-size:14px;">Quote total: <strong style="color:#ffffff;">${safeTotal}</strong></p>
          ${safeExpiry ? `<p style="margin:4px 0 0;color:#94a3b8;font-size:14px;">Valid through ${safeExpiry}</p>` : ''}
        </td></tr>
        <tr><td align="center" style="padding:28px 32px;">
          <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:12px;">View your quote</a>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#60a5fa;word-break:break-all;">${safeUrl}</a></p>
          <p style="margin:20px 0 0;color:#64748b;font-size:13px;line-height:1.6;">Have questions? Just reply to this email.</p>
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
      subject: `Your ${vehicleName.replace(/[\r\n]/g, ' ')} quote${shopName ? ` from ${shopName.replace(/[\r\n]/g, ' ')}` : ''}`,
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
      return json(502, { error: 'Failed to send email. The quote was not marked as sent.' })
    }

    // Only after Resend accepted the email: mark the quote sent through the
    // controlled database path (timestamps, lead stage and audit events).
    const { data: sent, error: markError } = await adminClient.rpc('mark_quote_sent', {
      p_quote_id: quote.id,
      p_actor_id: user.id,
    })
    if (markError) {
      console.error('mark_quote_sent error:', markError.message)
      return json(500, {
        error: 'The email was sent, but the quote could not be marked as sent. Please contact support before sending it again.',
      })
    }

    return json(200, {
      success: true,
      sent_at: (sent as { sent_at?: string } | null)?.sent_at ?? null,
      quote_url: quoteUrl,
    })
  } catch (err) {
    console.error('send-quote error:', err)
    return json(500, { error: 'Unexpected error while sending the quote.' })
  }
})
