// Shop logo upload/removal (src/lib/shopLogo.ts) against a fake Supabase
// client: same validation, bucket, path and shops.logo_url update as the
// Vehicles page used, plus the change event that refreshes the sidebar.
import { test } from 'node:test'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).window = new EventTarget()
const { MAX_LOGO_BYTES, SHOP_LOGO_BUCKET, logoStoragePath, onShopLogoChange, removeShopLogo, uploadShopLogo, validateLogoFile } =
  await import('../src/lib/shopLogo.ts')

const SHOP = '3f1c2b9a-6d4e-4c1b-9a8e-2b7c5d6e7f80'

function fakeClient(opts: { uploadError?: boolean; updateError?: boolean } = {}) {
  const calls: Record<string, unknown>[] = []
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _file: unknown, options: unknown) => {
          calls.push({ op: 'upload', bucket, path, options })
          return { error: opts.uploadError ? { message: 'denied' } : null }
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example.test/${bucket}/${path}` } }),
      }),
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: async (column: string, value: string) => {
          calls.push({ op: 'update', table, values, column, value })
          return { error: opts.updateError ? { message: 'rls' } : null }
        },
      }),
    }),
  }
  return { client: client as any, calls }
}

const file = (name: string, type: string, size: number) => ({ name, type, size }) as unknown as File

test('validation and storage path are unchanged', () => {
  assert.equal(SHOP_LOGO_BUCKET, 'shop-logos')
  assert.equal(validateLogoFile({ type: 'image/png', size: 1000 }), null)
  assert.equal(validateLogoFile({ type: 'image/png', size: MAX_LOGO_BYTES }), null)
  assert.equal(validateLogoFile({ type: 'image/png', size: MAX_LOGO_BYTES + 1 }), 'Logo must be under 3 MB.')
  assert.equal(validateLogoFile({ type: 'application/pdf', size: 10 }), 'Please choose an image file.')
  assert.equal(logoStoragePath(SHOP, 'Logo.PNG', 1700000000000), `shop-${SHOP}/logo-1700000000000.png`)
  assert.equal(logoStoragePath(SHOP, 'noext', 1), `shop-${SHOP}/logo-1.noext`)
  assert.equal(logoStoragePath(SHOP, 'trailing.', 1), `shop-${SHOP}/logo-1.png`)
})

test('upload stores the file, saves logo_url and announces the new logo', async () => {
  const { client, calls } = fakeClient()
  const seen: unknown[] = []
  const stop = onShopLogoChange((c) => seen.push(c))
  const result = await uploadShopLogo(client, SHOP, file('mark.png', 'image/png', 2048))
  stop()
  assert.equal(result.ok, true)
  const [upload, update] = calls as any[]
  assert.equal(upload.op, 'upload')
  assert.equal(upload.bucket, 'shop-logos')
  assert.match(upload.path, new RegExp(`^shop-${SHOP}/logo-\\d+\\.png$`))
  assert.deepEqual(upload.options, { upsert: true })
  const url = `https://cdn.example.test/shop-logos/${upload.path}`
  assert.deepEqual(update, { op: 'update', table: 'shops', values: { logo_url: url }, column: 'id', value: SHOP })
  assert.deepEqual(result, { ok: true, logoUrl: url })
  assert.deepEqual(seen, [{ shopId: SHOP, logoUrl: url }], 'the sidebar refreshes without a reload')
})

test('invalid files and failures change nothing and announce nothing', async () => {
  const seen: unknown[] = []
  const stop = onShopLogoChange((c) => seen.push(c))
  try {
    const big = fakeClient()
    assert.deepEqual(await uploadShopLogo(big.client, SHOP, file('huge.png', 'image/png', MAX_LOGO_BYTES + 1)), { ok: false, error: 'Logo must be under 3 MB.' })
    assert.equal(big.calls.length, 0, 'rejected before uploading')

    const denied = fakeClient({ uploadError: true })
    assert.deepEqual(await uploadShopLogo(denied.client, SHOP, file('a.png', 'image/png', 10)), { ok: false, error: 'Upload failed. Please try again.' })
    assert.equal(denied.calls.filter((c) => c.op === 'update').length, 0, 'logo_url untouched when storage refuses')

    const rls = fakeClient({ updateError: true })
    assert.deepEqual(await uploadShopLogo(rls.client, SHOP, file('a.png', 'image/png', 10)), { ok: false, error: 'Could not save your logo. Please try again.' })
    assert.deepEqual(await removeShopLogo(rls.client, SHOP), { ok: false, error: 'Could not remove your logo. Please try again.' })
  } finally {
    stop()
  }
  assert.deepEqual(seen, [])
})

test('removal clears logo_url and announces it', async () => {
  const { client, calls } = fakeClient()
  const seen: unknown[] = []
  const stop = onShopLogoChange((c) => seen.push(c))
  assert.deepEqual(await removeShopLogo(client, SHOP), { ok: true, logoUrl: null })
  stop()
  assert.deepEqual(calls, [{ op: 'update', table: 'shops', values: { logo_url: null }, column: 'id', value: SHOP }])
  assert.deepEqual(seen, [{ shopId: SHOP, logoUrl: null }])
})
