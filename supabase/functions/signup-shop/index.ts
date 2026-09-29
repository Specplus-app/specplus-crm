import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()
    const shopName = typeof body.shop_name === 'string' ? body.shop_name.trim() : ''
    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''

    if (!shopName) {
      return new Response(JSON.stringify({ error: 'shop_name is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // The handle_new_user trigger already created the profile row. Guard against
    // creating a second shop if this account was already set up.
    const { data: existingProfile } = await adminClient
      .from('profiles')
      .select('shop_id, role')
      .eq('id', user.id)
      .maybeSingle()

    if (!existingProfile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (existingProfile.role !== 'shop_user') {
      return new Response(JSON.stringify({ error: 'This account cannot create a shop' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (existingProfile.shop_id) {
      return new Response(JSON.stringify({ success: true, shop_id: existingProfile.shop_id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: shop, error: shopError } = await adminClient
      .from('shops')
      .insert({ name: shopName, contact_email: user.email })
      .select('id')
      .single()

    if (shopError || !shop) {
      return new Response(JSON.stringify({ error: shopError?.message ?? 'Failed to create shop' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { error: profileError } = await adminClient
      .from('profiles')
      .update({ shop_id: shop.id, full_name: fullName, role: 'shop_user' })
      .eq('id', user.id)

    if (profileError) {
      return new Response(JSON.stringify({ error: profileError.message }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ success: true, shop_id: shop.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
