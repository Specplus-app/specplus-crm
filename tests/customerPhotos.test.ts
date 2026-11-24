// Customer photo helpers (src/lib/customerUploadRefs.ts, src/lib/buildSheetShare.ts)
// and the customer-photos Edge Function handler, run in Node with Deno and
// Supabase mocked. No storage, database or network access is involved.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  CUSTOMER_UPLOAD_MAX_BYTES, customerUploadError, customerUploadObjectName, customerUploadPath,
} from '../src/lib/customerUploadRefs.ts'
import { classifyBuildLink, buildSheetShareUrl } from '../src/lib/buildSheetShare.ts'

const SHOP = '3f1c2a9e-0b7d-4c8e-9a51-2d6f4e8b7c10'
const FILE = `${SHOP}/0e8b1f4c-5d2a-4b3e-8c7f-9a6d1e2b3c4d.jpg`

// ---------------------------------------------------------------------------
// Frontend helpers
// ---------------------------------------------------------------------------

test('customerUploadPath recognizes bare paths and customer-uploads URLs only', () => {
  assert.equal(customerUploadPath(FILE), FILE)
  assert.equal(customerUploadPath(`https://p.example.test/storage/v1/object/public/customer-uploads/${FILE}`), FILE)
  assert.equal(customerUploadPath(`https://p.example.test/storage/v1/object/sign/customer-uploads/${FILE}?token=t`), FILE)
  assert.equal(customerUploadPath(`https://p.example.test/storage/v1/object/public/vehicles/${SHOP}/front.jpg`), null)
  assert.equal(customerUploadPath('https://cdn.example.test/logo.png'), null)
  assert.equal(customerUploadPath('a/b/c.jpg'), null)
  assert.equal(customerUploadPath(null), null)
  assert.equal(customerUploadPath(''), null)
})

test('uploads are named from the MIME type, never the original file name', () => {
  assert.equal(customerUploadObjectName(SHOP, { type: 'image/jpeg' }, 'u'), `${SHOP}/u.jpg`)
  assert.equal(customerUploadObjectName(SHOP, { type: 'image/heic' }, 'u'), `${SHOP}/u.heic`)
  assert.equal(customerUploadObjectName(SHOP, { type: 'image/svg+xml' }, 'u'), null)
  assert.equal(customerUploadObjectName(SHOP, { type: 'text/html' }, 'u'), null)
  assert.match(customerUploadObjectName(SHOP, { type: 'image/png' })!, new RegExp(`^${SHOP}/[0-9a-f-]{36}\\.png$`))
})

test('client-side checks match the bucket limits', () => {
  assert.equal(customerUploadError({ type: 'image/png', size: 1000 }), null)
  assert.equal(customerUploadError({ type: 'image/webp', size: CUSTOMER_UPLOAD_MAX_BYTES }), null)
  assert.match(customerUploadError({ type: 'image/jpeg', size: CUSTOMER_UPLOAD_MAX_BYTES + 1 })!, /too large/)
  assert.match(customerUploadError({ type: 'image/svg+xml', size: 10 })!, /JPEG, PNG, WebP or HEIC/)
  assert.match(customerUploadError({ type: 'application/pdf', size: 10 })!, /JPEG, PNG, WebP or HEIC/)
})

test('build links: share tokens open, legacy uuid links are reported as retired', () => {
  assert.equal(classifyBuildLink('a'.repeat(64)), 'share')
  assert.equal(classifyBuildLink('0e8b1f4c-5d2a-4b3e-8c7f-9a6d1e2b3c4d'), 'retired')
  assert.equal(classifyBuildLink('A'.repeat(64)), 'invalid')
  assert.equal(classifyBuildLink('abc'), 'invalid')
  assert.equal(classifyBuildLink(undefined), 'invalid')
  assert.equal(buildSheetShareUrl('f'.repeat(64), 'https://app.example.test'), `https://app.example.test/build/${'f'.repeat(64)}`)
})

// ---------------------------------------------------------------------------
// customer-photos Edge Function
// ---------------------------------------------------------------------------

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('npm:@supabase/supabase-js')) {
      return { url: new URL('./helpers/supabaseMock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

type Handler = (req: Request) => Promise<Response>
let handler: Handler | null = null
const env: Record<string, string> = {
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
}
;(globalThis as Record<string, unknown>).Deno = {
  env: { get: (k: string) => env[k] },
  serve: (h: Handler) => { handler = h },
}
await import('../supabase/functions/customer-photos/index.ts')

type State = {
  users: Record<string, unknown>
  tables: Record<string, unknown[]>
  rpcCalls: { name: string; args: any; isAdmin: boolean }[]
  rpcHandlers: Record<string, (args: any) => unknown>
  storageCalls?: { bucket: string; paths: string[]; expiresIn: number; isAdmin: boolean }[]
  storageHandler?: (bucket: string, paths: string[]) => unknown
}
let state: State
const QUOTE_TOKEN = '22222222-2222-4222-8222-222222222222'
const BUILD_TOKEN = 'c'.repeat(64)

beforeEach(() => {
  state = {
    users: {},
    tables: {},
    rpcCalls: [],
    rpcHandlers: {
      customer_photo_paths: ({ p_kind, p_token }: any) => ({
        data: (p_kind === 'quote' && p_token === QUOTE_TOKEN) || (p_kind === 'build_sheet' && p_token === BUILD_TOKEN) ? [FILE] : [],
        error: null,
      }),
    },
  }
  ;(globalThis as Record<string, unknown>).__supabaseMock = state
})

async function call(body: unknown, method = 'POST') {
  const resp = await handler!(new Request('https://fn.invalid/customer-photos', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }))
  return { status: resp.status, body: resp.status === 200 || resp.status >= 400 ? await resp.json().catch(() => null) : null }
}

test('a valid quote token gets signed URLs for exactly the paths the database allows', async () => {
  const r = await call({ kind: 'quote', token: QUOTE_TOKEN })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body.photos), [FILE])
  assert.match(r.body.photos[FILE], /^https:\/\/signed\.example\.test\/customer-uploads\//)
  assert.deepEqual(state.rpcCalls.map((c) => [c.name, c.args, c.isAdmin]), [['customer_photo_paths', { p_kind: 'quote', p_token: QUOTE_TOKEN }, true]])
  assert.deepEqual(state.storageCalls!.map((c) => [c.bucket, c.paths, c.expiresIn]), [['customer-uploads', [FILE], 3600]])
})

test('a shared build-sheet token works the same way', async () => {
  const r = await call({ kind: 'build_sheet', token: BUILD_TOKEN })
  assert.deepEqual(Object.keys(r.body.photos), [FILE])
})

test('unknown, malformed or mismatched tokens get no photos and sign nothing', async () => {
  for (const body of [
    { kind: 'quote', token: '33333333-3333-4333-8333-333333333333' },
    { kind: 'quote', token: BUILD_TOKEN },
    { kind: 'build_sheet', token: QUOTE_TOKEN },
    { kind: 'build_sheet', token: 'short' },
    { kind: 'lead', token: QUOTE_TOKEN },
    { token: QUOTE_TOKEN },
    {},
  ]) {
    const r = await call(body)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { photos: {} })
  }
  assert.equal((state.storageCalls ?? []).length, 0)
})

test('caller-supplied paths are ignored', async () => {
  const r = await call({ kind: 'quote', token: QUOTE_TOKEN, paths: ['other-shop/secret.jpg'] })
  assert.deepEqual(Object.keys(r.body.photos), [FILE])
  assert.deepEqual(state.storageCalls![0].paths, [FILE])
})

test('signed entries for paths the database did not return are dropped', async () => {
  state.storageHandler = () => ({ data: [
    { path: FILE, signedUrl: 'https://signed.example.test/ok', error: null },
    { path: 'other-shop/secret.jpg', signedUrl: 'https://signed.example.test/leak', error: null },
  ], error: null })
  const r = await call({ kind: 'quote', token: QUOTE_TOKEN })
  assert.deepEqual(r.body.photos, { [FILE]: 'https://signed.example.test/ok' })
})

test('database and storage failures return an error, not photos', async () => {
  state.rpcHandlers.customer_photo_paths = () => ({ data: null, error: { message: 'boom' } })
  assert.equal((await call({ kind: 'quote', token: QUOTE_TOKEN })).status, 500)
  state.rpcHandlers.customer_photo_paths = () => ({ data: [FILE], error: null })
  state.storageHandler = () => ({ data: null, error: { message: 'boom' } })
  assert.equal((await call({ kind: 'quote', token: QUOTE_TOKEN })).status, 500)
})

test('only POST is accepted', async () => {
  assert.equal((await call(null, 'GET')).status, 405)
})
