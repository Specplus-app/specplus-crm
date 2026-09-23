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
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // Admin client with service role (bypasses RLS, can call admin APIs)
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Verify the caller is an admin using their session token
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userError } = await adminClient.auth.getUser(token)
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check the caller's profile role
    const { data: adminProfile, error: profileError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !adminProfile || adminProfile.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Only admins can impersonate' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Parse request body
    const body = await req.json()
    const targetUserId = body.target_user_id as string | undefined

    if (!targetUserId) {
      return new Response(JSON.stringify({ error: 'target_user_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Verify target user exists and is not an admin
    const { data: targetProfile, error: targetError } = await adminClient
      .from('profiles')
      .select('id, role, email')
      .eq('id', targetUserId)
      .maybeSingle()

    if (targetError || !targetProfile) {
      return new Response(JSON.stringify({ error: 'Target user not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (targetProfile.role === 'admin') {
      return new Response(JSON.stringify({ error: 'Cannot impersonate admin users' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Generate a magic link for the target user.
    // With the service role key, this does NOT send an email.
    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: 'magiclink',
      email: targetProfile.email,
    })

    if (linkError || !linkData) {
      console.error('generateLink error:', linkError?.message)
      return new Response(JSON.stringify({ error: 'Failed to generate impersonation link' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // The hashed_token is what we need — it can be exchanged via verifyOtp
    const tokenHash = linkData.properties?.hashed_token as string | undefined

    if (!tokenHash) {
      console.error('No hashed_token in response:', JSON.stringify(linkData.properties ?? {}))
      return new Response(JSON.stringify({ error: 'Failed to get impersonation token' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Use a fresh client with the anon key to verify the OTP and get a session.
    // verifyOtp with token_hash is the correct way to exchange a magic link token.
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: otpData, error: otpError } = await userClient.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    })

    if (otpError || !otpData.session) {
      console.error('verifyOtp failed:', otpError?.message)
      return new Response(JSON.stringify({
        error: 'Failed to verify impersonation session',
        detail: otpError?.message,
      }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({
      access_token: otpData.session.access_token,
      refresh_token: otpData.session.refresh_token,
      user: otpData.user,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Impersonation error:', err)
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
