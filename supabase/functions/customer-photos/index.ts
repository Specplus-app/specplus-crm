// Signs short-lived URLs for the customer photos attached to ONE quote or
// shared build sheet. Callable without signing in (customers open quote and
// build-sheet links anonymously); the token is the authorization. Which paths
// a token may see is decided in the database by customer_photo_paths()
// (service_role only): non-draft quotes, shared build sheets, and only files
// in that record's own shop folder. The function never accepts paths from the
// caller.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

export const SIGNED_URL_TTL_SECONDS = 60 * 60
const BUCKET = 'customer-uploads'
const QUOTE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BUILD_TOKEN_RE = /^[0-9a-f]{64}$/

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  let body: { kind?: unknown; token?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'Invalid request' })
  }
  const kind = body.kind
  const token = typeof body.token === 'string' ? body.token : ''
  const validToken = (kind === 'quote' && QUOTE_TOKEN_RE.test(token)) || (kind === 'build_sheet' && BUILD_TOKEN_RE.test(token))
  // Unknown or malformed tokens get the same empty answer as unshared ones.
  if (!validToken) return json(200, { photos: {} })

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return json(500, { error: 'Photo access is not configured' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: paths, error } = await admin.rpc('customer_photo_paths', { p_kind: kind, p_token: token })
  if (error) {
    console.error('customer_photo_paths failed:', error.message)
    return json(500, { error: 'Could not load photos' })
  }
  const list = Array.isArray(paths) ? (paths as unknown[]).filter((p): p is string => typeof p === 'string') : []
  if (list.length === 0) return json(200, { photos: {} })

  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUrls(list, SIGNED_URL_TTL_SECONDS)
  if (signError) {
    console.error('createSignedUrls failed:', signError.message)
    return json(500, { error: 'Could not load photos' })
  }
  const photos: Record<string, string> = {}
  for (const entry of signed ?? []) {
    if (entry?.path && entry.signedUrl && !entry.error && list.includes(entry.path)) photos[entry.path] = entry.signedUrl
  }
  return json(200, { photos })
})
