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

    // Check if any admin already exists
    const { data: existingAdmins } = await adminClient
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .maybeSingle()

    if (existingAdmins) {
      return new Response(JSON.stringify({ error: 'Admin already exists. Use the admin panel.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()
    const { email, password, full_name } = body

    if (!email || !password) {
      return new Response(JSON.stringify({ error: 'email and password are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Create the auth user
    const { data: authData, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name || 'Admin' },
    })

    if (createError || !authData.user) {
      return new Response(JSON.stringify({ error: createError?.message ?? 'Failed to create user' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Set the profile role to admin
    const { error: updateError } = await adminClient
      .from('profiles')
      .update({ role: 'admin', full_name: full_name || 'Admin' })
      .eq('id', authData.user.id)

    if (updateError) {
      console.error('Failed to set admin role:', updateError.message)
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Admin user created. You can now log in.',
      email: authData.user.email,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
