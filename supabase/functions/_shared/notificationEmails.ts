// Notification emails sent by notification-dispatch. Payload fields come from
// public.notification_delivery_payload (resolved and authorized server-side).
// Message bodies are never included: recipients follow the link to read them.

export type ShopEmailPayload = {
  kind: 'new_request' | 'customer_message'
  to: string
  shop_name: string | null
  lead_path: string
  customer_name: string | null
  customer_email: string | null
  vehicle_name: string | null
  is_custom: boolean | null
}

export type CustomerEmailPayload = {
  kind: 'shop_reply'
  to: string
  shop_name: string | null
  shop_email: string | null
  customer_name: string | null
  vehicle_name: string | null
  quote_path: string
}

export type RenderedEmail = { to: string; subject: string; html: string; text: string; fromName: string; replyTo?: string }

const LEAD_PATH_RE = /^\/dashboard\/leads\/[0-9a-f-]{36}$/
const QUOTE_PATH_RE = /^\/q\/[0-9a-f-]{36}$/
const EMAIL_RE = /^[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+$/

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// Header-safe single line.
const line = (s: string | null | undefined) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()
const displayName = (s: string | null | undefined) => line(s).replace(/[<>"]/g, '')

function layout(eyebrow: string, heading: string, paragraphs: string[], cta: { label: string; url: string }, footer: string): string {
  const safeUrl = escapeHtml(cta.url)
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0c10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c10;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#12151c;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0;color:#60a5fa;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(eyebrow)}</p>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 8px;">
          ${paragraphs.map((p) => `<p style="margin:0 0 12px;color:#cbd5e1;font-size:15px;line-height:1.6;">${p}</p>`).join('\n          ')}
        </td></tr>
        <tr><td align="center" style="padding:20px 32px 28px;">
          <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:12px;">${escapeHtml(cta.label)}</a>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#60a5fa;word-break:break-all;">${safeUrl}</a></p>
          <p style="margin:20px 0 0;color:#64748b;font-size:12px;line-height:1.6;">${escapeHtml(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export function renderShopEmail(p: ShopEmailPayload, crmOrigin: string): RenderedEmail {
  if (!LEAD_PATH_RE.test(p.lead_path)) throw new Error('Invalid lead link')
  if (!EMAIL_RE.test(p.to)) throw new Error('Invalid shop email')
  const url = `${crmOrigin}${p.lead_path}`
  const customer = line(p.customer_name) || 'A customer'
  const vehicle = line(p.vehicle_name) || 'their vehicle'
  const shop = line(p.shop_name) || 'your shop'
  const build = p.is_custom ? 'custom build' : 'build'
  const footer = `You're receiving this because ${shop} uses SpecPlus. Notification emails go to the shop's contact email.`

  if (p.kind === 'new_request') {
    const replyTo = line(p.customer_email)
    return {
      to: p.to,
      fromName: 'SpecPlus',
      subject: `New ${build} request from ${customer} – ${vehicle}`,
      replyTo: EMAIL_RE.test(replyTo) ? replyTo : undefined,
      html: layout(shop, 'New request received', [
        `<strong style="color:#ffffff;">${escapeHtml(customer)}</strong> submitted a ${escapeHtml(build)} request for <strong style="color:#ffffff;">${escapeHtml(vehicle)}</strong>.`,
        'Open the lead in SpecPlus to review the build and prepare a quote.',
      ], { label: 'Open lead', url }, footer),
      text: `${customer} submitted a ${build} request for ${vehicle}.\n\nOpen the lead in SpecPlus: ${url}\n\n${footer}`,
    }
  }

  return {
    to: p.to,
    fromName: 'SpecPlus',
    subject: `New message from ${customer} about their ${vehicle} quote`,
    html: layout(shop, 'New customer message', [
      `<strong style="color:#ffffff;">${escapeHtml(customer)}</strong> sent a message about their quote for <strong style="color:#ffffff;">${escapeHtml(vehicle)}</strong>.`,
      'Open the lead in SpecPlus to read it and reply. Replies sent from SpecPlus stay with the quote.',
    ], { label: 'Read and reply', url }, footer),
    text: `${customer} sent a message about their quote for ${vehicle}.\n\nRead and reply in SpecPlus: ${url}\n\n${footer}`,
  }
}

export function renderCustomerEmail(p: CustomerEmailPayload, quoteOrigin: string): RenderedEmail {
  if (!QUOTE_PATH_RE.test(p.quote_path)) throw new Error('Invalid quote link')
  if (!EMAIL_RE.test(p.to)) throw new Error('Invalid customer email')
  const url = `${quoteOrigin}${p.quote_path}`
  const shop = line(p.shop_name)
  const name = line(p.customer_name) || 'there'
  const vehicle = line(p.vehicle_name) || 'your vehicle'
  const shopLabel = shop || 'The shop'
  const replyTo = line(p.shop_email)
  return {
    to: p.to,
    fromName: shop ? `${displayName(shop)} via SpecPlus` : 'SpecPlus',
    subject: `${shopLabel} sent you a message about your ${vehicle} quote`,
    replyTo: EMAIL_RE.test(replyTo) ? replyTo : undefined,
    html: layout(shop || 'SpecPlus', 'You have a new message', [
      `Hi ${escapeHtml(name)},`,
      `${escapeHtml(shopLabel)} sent you a message about the quote for your <strong style="color:#ffffff;">${escapeHtml(vehicle)}</strong>.`,
      'Open your quote to read the message and reply.',
    ], { label: 'View message', url }, 'You received this because you requested a quote. Your quote link is private; please do not share it.'),
    text: `Hi ${name},\n\n${shopLabel} sent you a message about the quote for your ${vehicle}.\n\nView the message: ${url}`,
  }
}

export function resendOutcome(status: number): 'sent' | 'retry' | 'failed' {
  if (status >= 200 && status < 300) return 'sent'
  // Rate limits, outages and key/domain configuration problems can recover.
  if (status === 429 || status >= 500 || status === 401 || status === 403) return 'retry'
  return 'failed' // 400/422: this message will never be accepted
}
