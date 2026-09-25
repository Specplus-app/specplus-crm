const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'Email is not configured yet. Add your Resend API key to enable sending build sheets.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const body = await req.json()
    const customerEmail: string = body.customerEmail ?? ''
    const customerName: string = body.customerName ?? 'there'
    const vehicleName: string = body.vehicleName ?? 'your vehicle'
    const shopName: string = body.shopName ?? 'Your build'
    const replyTo: string = body.replyTo ?? ''
    const buildUrl: string = body.buildUrl ?? ''
    const grandTotal: string = body.grandTotal ?? ''
    const fromEmail: string = Deno.env.get('RESEND_FROM_EMAIL') ?? 'quotes@specplus.app'

    if (!customerEmail || !buildUrl) {
      return new Response(
        JSON.stringify({ error: 'customerEmail and buildUrl are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const safeName = escapeHtml(customerName)
    const safeVehicle = escapeHtml(vehicleName)
    const safeShop = escapeHtml(shopName)
    const safeUrl = escapeHtml(buildUrl)
    const safeTotal = escapeHtml(grandTotal)

    const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0c10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c10;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#12151c;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <p style="margin:0;color:#60a5fa;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${safeShop}</p>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px;font-weight:700;">Your build sheet is ready</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 8px;">
          <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.6;">Hi ${safeName},</p>
          <p style="margin:12px 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">We've put together the completed build sheet for your <strong style="color:#ffffff;">${safeVehicle}</strong>. It includes your labeled photos and full itemized pricing.</p>
          ${safeTotal ? `<p style="margin:16px 0 0;color:#94a3b8;font-size:14px;">Grand total: <strong style="color:#ffffff;">${safeTotal}</strong></p>` : ''}
        </td></tr>
        <tr><td align="center" style="padding:28px 32px;">
          <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:12px;">View your build sheet</a>
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

    const senderName = shopName ? `${shopName} via SpecPlus` : 'SpecPlus'
    const payload: Record<string, unknown> = {
      from: `${senderName} <${fromEmail}>`,
      to: [customerEmail],
      subject: `Your ${vehicleName} build sheet`,
      html,
    }
    if (replyTo) payload.reply_to = replyTo

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const detail = await resp.text()
      console.error('Resend error:', detail)
      return new Response(
        JSON.stringify({ error: 'Failed to send email. Check that your Resend API key and sending domain are valid.' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('send-build-sheet error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
