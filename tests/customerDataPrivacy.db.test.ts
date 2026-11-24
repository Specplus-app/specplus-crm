// Customer data privacy (20261124120000_customer_data_privacy.sql and the
// staged phase-2 SQL in supabase/rollout/): build-sheet share links, private
// customer photos, controlled anonymous uploads, and the custom and
// preconfigured quote flows. Runs the real migrations in an isolated in-memory
// PGlite database with synthetic data (see tests/helpers/pgliteDb.mjs). No
// hosted database, storage, email or network access is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// @ts-ignore -- plain JS helper
import { createDb, applyMigrations, as, one } from './helpers/pgliteDb.mjs'
import { customerUploadPath } from '../src/lib/customerUploadRefs.ts'

const PHASE1 = '20261124120000_customer_data_privacy.sql'
const PHASE2_SQL = readFileSync(new URL('../supabase/rollout/20261124130000_make_customer_uploads_private.sql', import.meta.url), 'utf8')
const STORAGE_URL = 'https://project.supabase.example.test/storage/v1/object/public'

let db: any
const ids: Record<string, string> = {}
const anon = { role: 'anon' }
const service = { role: 'service_role' }
const user = (key: string) => ({ role: 'authenticated', id: ids[key] })
const rand = () => Math.random().toString(36).slice(2, 10)
const uuid = () => crypto.randomUUID()

async function seed(target: any, store: Record<string, string>) {
  const shop = async (name: string) =>
    (await one(target, `INSERT INTO shops (name, contact_email, slug, subscription_status, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, 'active', '2030-01-01T00:00:00Z', false) RETURNING id`,
      [name, `${name.toLowerCase()}@shops.example.test`, name.toLowerCase() + rand()])).id
  store.shopA = await shop('ShopA')
  store.shopB = await shop('ShopB')
  const mk = async (key: string, role: string | null, shopId: string | null) => {
    const u = await one(target, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${key}-${rand()}@example.test`])
    if (role) {
      await target.query(`INSERT INTO profiles (id, email, full_name, role, shop_id) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, shop_id = EXCLUDED.shop_id`, [u.id, `${key}@example.test`, key, role, shopId])
    } else {
      await target.query(`DELETE FROM profiles WHERE id = $1`, [u.id])
    }
    store[key] = u.id
  }
  await mk('admin', 'admin', null)
  await mk('a1', 'shop_user', store.shopA)
  await mk('b1', 'shop_user', store.shopB)
  await mk('noprofile', null, null)
}

// A sheet saved the way the old lead page did it (staff insert, no share token).
async function newSheet(shopKey: string, userKey: string, extra: Record<string, unknown> = {}) {
  const front = extra.front ?? `${STORAGE_URL}/customer-uploads/${ids[shopKey]}/${uuid()}.jpg`
  return as(db, user(userKey), (tx: any) => one(tx, `INSERT INTO build_sheets (shop_id, shop_name, customer_name, customer_email, vehicle_name,
      front_image_url, rear_image_url, selected_parts, parts_total, grand_total)
    VALUES ($1, 'Shop', 'Jordan Customer', 'jordan@customers.example.test', 'Bronco', $2, $3, $4, 650, 650) RETURNING id, front_image_url`,
    [ids[shopKey], front, extra.rear ?? null, JSON.stringify(extra.parts ?? [{ id: 'p', name: 'Bumper', type: 'new', price: 650 }])]))
}

const shareLink = (who: any, sheetId: string) =>
  as(db, who, (tx: any) => one(tx, `SELECT public.create_build_sheet_share_link($1) AS t`, [sheetId])).then((r: any) => r.t as string)
const sharedSheet = (who: any, token: string | null) =>
  as(db, who, (tx: any) => one(tx, `SELECT public.get_shared_build_sheet($1) AS s`, [token])).then((r: any) => r.s)
const photoPaths = (kind: string, token: string | null) =>
  as(db, service, (tx: any) => one(tx, `SELECT public.customer_photo_paths($1, $2) AS p`, [kind, token])).then((r: any) => [...r.p].sort())

async function storeObject(name: string, bucket = 'customer-uploads') {
  await db.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)`, [bucket, name])
}

before(async () => {
  db = await createDb()
  await seed(db, ids)
})

// ---------------------------------------------------------------------------
// Build sheets
// ---------------------------------------------------------------------------

test('anonymous callers cannot read or list build sheets', async () => {
  await newSheet('shopA', 'a1')
  await assert.rejects(as(db, anon, (tx: any) => tx.query(`SELECT * FROM build_sheets`)), /permission denied/i)
  await assert.rejects(as(db, anon, (tx: any) => tx.query(`SELECT id FROM build_sheets LIMIT 1`)), /permission denied/i)
})

test('staff read only their own shop\'s build sheets; admins read all', async () => {
  const a = await newSheet('shopA', 'a1')
  const b = await newSheet('shopB', 'b1')
  const seenByA = await as(db, user('a1'), (tx: any) => tx.query(`SELECT id FROM build_sheets`))
  assert.ok(seenByA.rows.some((r: any) => r.id === a.id))
  assert.ok(!seenByA.rows.some((r: any) => r.id === b.id), 'shop A must not see shop B')
  const direct = await as(db, user('a1'), (tx: any) => tx.query(`SELECT id FROM build_sheets WHERE id = $1`, [b.id]))
  assert.equal(direct.rows.length, 0)
  const seenByAdmin = await as(db, user('admin'), (tx: any) => tx.query(`SELECT id FROM build_sheets WHERE id IN ($1, $2)`, [a.id, b.id]))
  assert.equal(seenByAdmin.rows.length, 2)
  const seenByNoProfile = await as(db, user('noprofile'), (tx: any) => tx.query(`SELECT id FROM build_sheets`))
  assert.equal(seenByNoProfile.rows.length, 0)
})

test('a shared build sheet opens anonymously with customer-facing fields only', async () => {
  const sheet = await newSheet('shopA', 'a1')
  const token = await shareLink(user('a1'), sheet.id)
  assert.match(token, /^[0-9a-f]{64}$/)
  const s = await sharedSheet(anon, token)
  assert.equal(s.customer_name, 'Jordan Customer')
  assert.equal(s.vehicle_name, 'Bronco')
  assert.equal(Number(s.grand_total), 650)
  for (const hidden of ['id', 'lead_id', 'shop_id', 'customer_email', 'share_token', 'updated_at']) {
    assert.ok(!(hidden in s), `${hidden} must not be returned`)
  }
})

test('unshared, legacy-id, malformed and revoked links return nothing', async () => {
  const sheet = await newSheet('shopA', 'a1')
  assert.equal(await sharedSheet(anon, sheet.id), null, 'legacy /build/<uuid> link is retired')
  assert.equal(await sharedSheet(anon, 'f'.repeat(64)), null)
  assert.equal(await sharedSheet(anon, 'not-a-token'), null)
  assert.equal(await sharedSheet(anon, null), null)

  const token = await shareLink(user('a1'), sheet.id)
  await as(db, user('a1'), (tx: any) => tx.query(`SELECT public.revoke_build_sheet_share_link($1)`, [sheet.id]))
  assert.equal(await sharedSheet(anon, token), null)
})

test('replacing a share link invalidates the previous one', async () => {
  const sheet = await newSheet('shopA', 'a1')
  const first = await shareLink(user('a1'), sheet.id)
  const second = await shareLink(user('a1'), sheet.id)
  assert.notEqual(first, second)
  assert.equal(await sharedSheet(anon, first), null)
  assert.ok(await sharedSheet(anon, second))
})

test('only the owning shop or an admin can share a build sheet', async () => {
  const sheet = await newSheet('shopA', 'a1')
  await assert.rejects(shareLink(user('b1'), sheet.id), /Build sheet not found/)
  await assert.rejects(shareLink(user('noprofile'), sheet.id), /Build sheet not found/)
  await assert.rejects(shareLink(anon, sheet.id), /permission denied/i)
  await assert.rejects(shareLink({ role: 'authenticated' }, sheet.id), /Not allowed/)
  assert.match(await shareLink(user('admin'), sheet.id), /^[0-9a-f]{64}$/)
})

test('share tokens cannot be written directly', async () => {
  const sheet = await newSheet('shopA', 'a1')
  await assert.rejects(
    as(db, user('a1'), (tx: any) => tx.query(`UPDATE build_sheets SET share_token = $2 WHERE id = $1`, [sheet.id, 'a'.repeat(64)])),
    /create_build_sheet_share_link/,
  )
  await assert.rejects(
    as(db, user('a1'), (tx: any) => tx.query(`INSERT INTO build_sheets (shop_id, share_token) VALUES ($1, $2)`, [ids.shopA, 'b'.repeat(64)])),
    /create_build_sheet_share_link/,
  )
  // Ordinary edits by the owning shop still work.
  const r = await as(db, user('a1'), (tx: any) => one(tx, `UPDATE build_sheets SET vehicle_trim = 'XLT' WHERE id = $1 RETURNING vehicle_trim`, [sheet.id]))
  assert.equal(r.vehicle_trim, 'XLT')
})

test('the migration retires share tokens on sheets that existed before it', async () => {
  const pre = await createDb({ before: PHASE1 })
  const store: Record<string, string> = {}
  await seed(pre, store)
  const old = await one(pre, `INSERT INTO build_sheets (shop_id, shop_name, customer_name, customer_email, vehicle_name)
    VALUES ($1, 'Shop', 'Old Customer', 'old@customers.example.test', 'Truck') RETURNING id`, [store.shopA])
  // Before: anyone could list the whole table, so every id was exposed.
  const listed = await as(pre, anon, (tx: any) => tx.query(`SELECT id, customer_email FROM build_sheets`))
  assert.ok(listed.rows.some((r: any) => r.id === old.id))

  await applyMigrations(pre, { from: PHASE1 })
  const row = await one(pre, `SELECT share_token FROM build_sheets WHERE id = $1`, [old.id])
  assert.equal(row.share_token, null)
  await assert.rejects(as(pre, anon, (tx: any) => tx.query(`SELECT id FROM build_sheets`)), /permission denied/i)
  await pre.close()
})

// ---------------------------------------------------------------------------
// Customer uploads
// ---------------------------------------------------------------------------

test('anonymous callers cannot list or read customer uploads', async () => {
  await storeObject(`${ids.shopA}/${uuid()}.jpg`)
  await storeObject(`${ids.shopB}/${uuid()}.png`)
  const listed = await as(db, anon, (tx: any) => tx.query(`SELECT name FROM storage.objects WHERE bucket_id = 'customer-uploads'`))
  assert.equal(listed.rows.length, 0)
  const noProfile = await as(db, user('noprofile'), (tx: any) => tx.query(`SELECT name FROM storage.objects WHERE bucket_id = 'customer-uploads'`))
  assert.equal(noProfile.rows.length, 0)
})

test('staff read only their own shop\'s customer uploads; admins read all', async () => {
  const mine = `${ids.shopA}/${uuid()}.jpg`
  const theirs = `${ids.shopB}/${uuid()}.jpg`
  await storeObject(mine)
  await storeObject(theirs)
  const names = async (key: string) =>
    (await as(db, user(key), (tx: any) => tx.query(`SELECT name FROM storage.objects WHERE bucket_id = 'customer-uploads'`))).rows.map((r: any) => r.name)
  const a = await names('a1')
  assert.ok(a.includes(mine))
  assert.ok(!a.includes(theirs), 'cross-shop photo must not be readable')
  assert.ok(a.every((n: string) => n.startsWith(`${ids.shopA}/`)))
  const admin = await names('admin')
  assert.ok(admin.includes(mine) && admin.includes(theirs))
})

test('anonymous custom-request uploads are limited to a controlled path', async () => {
  const upload = (name: string, who: any = anon) =>
    as(db, who, (tx: any) => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('customer-uploads', $1)`, [name]))
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) await upload(`${ids.shopA}/${uuid()}.${ext}`)
  await upload(`${ids.shopB}/${uuid()}.jpg`, user('a1'))

  const rejected = [
    `${ids.shopA}/${uuid()}.svg`,
    `${ids.shopA}/${uuid()}.html`,
    `${ids.shopA}/${uuid()}.JPG.exe`,
    `${ids.shopA}/photo.jpg`,
    `${ids.shopA}/nested/${uuid()}.jpg`,
    `${uuid()}/${uuid()}.jpg`, // not a shop
    `${uuid()}.jpg`,
    `../${ids.shopA}/${uuid()}.jpg`,
  ]
  for (const name of rejected) {
    await assert.rejects(upload(name), /row-level security|violates/i, `should reject ${name}`)
  }
  // Uploading into another bucket through this policy is not possible either.
  await assert.rejects(as(db, anon, (tx: any) => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicles', $1)`, [`${ids.shopA}/x.jpg`])), /row-level security|violates/i)
})

test('the bucket enforces size and image type limits server-side', async () => {
  const b = await one(db, `SELECT file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'customer-uploads'`)
  assert.equal(Number(b.file_size_limit), 10 * 1024 * 1024)
  assert.deepEqual([...b.allowed_mime_types].sort(), ['image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'])
})

test('phase 2 makes customer uploads private; vehicle images and shop logos stay public', async () => {
  const before = await one(db, `SELECT public FROM storage.buckets WHERE id = 'customer-uploads'`)
  assert.equal(before.public, true, 'phase 1 leaves the bucket public until readers are ready')
  const staged = await createDb()
  await staged.exec(PHASE2_SQL)
  const rows = (await staged.query(`SELECT id, public FROM storage.buckets WHERE id IN ('customer-uploads', 'vehicles', 'shop-logos') ORDER BY id`)).rows
  assert.deepEqual(rows.map((r: any) => [r.id, r.public]), [['customer-uploads', false], ['shop-logos', true], ['vehicles', true]])
  await staged.close()
})

test('database and frontend agree on which references are customer uploads', async () => {
  const shop = ids.shopA
  const file = `${shop}/${uuid()}.jpg`
  const cases = [
    file,
    `${STORAGE_URL}/customer-uploads/${file}`,
    `https://x.example.test/storage/v1/object/sign/customer-uploads/${file}?token=abc`,
    `${STORAGE_URL}/vehicles/${shop}/front.jpg`,
    'https://cdn.example.test/logo.png',
    'nested/too/deep.jpg',
    '',
  ]
  for (const ref of cases) {
    const r = await one(db, `SELECT public.customer_upload_object_path($1) AS p`, [ref])
    assert.equal(r.p, customerUploadPath(ref), `mismatch for ${ref}`)
  }
})

// ---------------------------------------------------------------------------
// Quote flows and customer photo authorization
// ---------------------------------------------------------------------------

async function newLead(shopKey: string, custom: boolean, front: string | null, rear: string | null, parts: unknown[]) {
  const marker = rand()
  await as(db, anon, (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom, notes,
      front_image_url, rear_image_url)
    VALUES ($1, 'Jordan Customer', $2, $3, 'Bronco', 'local', $4, 650, 0, 650, 5, 'new', $5, $6, $7, $8)`,
    [ids[shopKey], `${rand()}@customers.example.test`, custom ? 'custom' : 'veh', JSON.stringify(parts), custom, marker, front, rear]))
  return (await one(db, `SELECT id FROM leads WHERE notes = $1`, [marker])).id
}

async function quoteFor(leadId: string, userKey: string, front: string | null, rear: string | null, parts: unknown[], send = true) {
  const q = await as(db, user(userKey), (tx: any) => one(tx, `INSERT INTO quotes (lead_id, selected_parts, shipping_total, front_image_url, rear_image_url)
    VALUES ($1, $2, 0, $3, $4) RETURNING id, public_token`, [leadId, JSON.stringify(parts), front, rear]))
  if (send) await as(db, service, (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [q.id, ids[userKey]]))
  return q
}

test('custom quote flow: customer uploads, staff quote, customer sees only that quote\'s photos', async () => {
  const front = `${ids.shopA}/${uuid()}.jpg`
  const rear = `${ids.shopA}/${uuid()}.png`
  const ref = `${ids.shopA}/${uuid()}.webp`
  for (const p of [front, rear, ref]) {
    await as(db, anon, (tx: any) => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('customer-uploads', $1)`, [p]))
  }
  const parts = [{ id: 'c1', name: 'Fender', type: 'send', price: 300, priced: true, reference_image_path: ref, box: { view: 'front', x: 1, y: 1, w: 5, h: 5 } }]
  const leadId = await newLead('shopA', true, front, rear, parts)

  // Staff of the shop can read the lead's photos (and therefore sign them).
  const visible = await as(db, user('a1'), (tx: any) => tx.query(`SELECT name FROM storage.objects WHERE name = ANY($1)`, [[front, rear, ref]]))
  assert.equal(visible.rows.length, 3)

  // Older quotes stored public-URL-shaped values; new ones store paths.
  const q = await quoteFor(leadId, 'a1', `${STORAGE_URL}/customer-uploads/${front}`, rear, parts)
  const pub = await as(db, anon, (tx: any) => one(tx, `SELECT public.get_public_quote($1) AS q`, [q.public_token]))
  assert.ok(pub.q, 'customer can open the quote')
  assert.deepEqual(await photoPaths('quote', q.public_token), [front, rear, ref].sort())
})

test('preconfigured quote flow still works and exposes no customer uploads', async () => {
  const leadId = await newLead('shopA', false, null, null, [{ id: 'p', name: 'Bumper', type: 'new', price: 650, priced: true }])
  const q = await quoteFor(leadId, 'a1', `${STORAGE_URL}/vehicles/${ids.shopA}/front.jpg`, `${STORAGE_URL}/vehicles/${ids.shopA}/rear.jpg`,
    [{ id: 'p', name: 'Bumper', type: 'new', price: 650, priced: true }])
  const pub = await as(db, anon, (tx: any) => one(tx, `SELECT public.get_public_quote($1) AS q`, [q.public_token]))
  assert.ok(pub.q)
  assert.equal(pub.q.front_image_url, `${STORAGE_URL}/vehicles/${ids.shopA}/front.jpg`, 'public vehicle image unchanged')
  assert.deepEqual(await photoPaths('quote', q.public_token), [])
})

test('customer photo access is scoped to the token\'s own record and shop', async () => {
  const own = `${ids.shopA}/${uuid()}.jpg`
  const foreign = `${ids.shopB}/${uuid()}.jpg`
  const item = [{ id: 'w', name: 'Work', type: 'send', price: 100, priced: true }]
  const draftLead = await newLead('shopA', true, own, foreign, [])
  const draft = await quoteFor(draftLead, 'a1', own, foreign, item, false)
  assert.deepEqual(await photoPaths('quote', draft.public_token), [], 'draft quotes are not visible')

  const leadId = await newLead('shopA', true, own, foreign, [])
  const sent = await quoteFor(leadId, 'a1', own, foreign, item)
  assert.deepEqual(await photoPaths('quote', sent.public_token), [own], 'another shop\'s file is never returned')
  assert.deepEqual(await photoPaths('quote', uuid()), [])
  assert.deepEqual(await photoPaths('quote', 'nope'), [])
  assert.deepEqual(await photoPaths('build_sheet', sent.public_token), [], 'a quote token does not open build sheets')
  assert.deepEqual(await photoPaths('other', sent.public_token), [])

  const sheet = await newSheet('shopA', 'a1', { front: own, rear: `${STORAGE_URL}/customer-uploads/${foreign}` })
  assert.deepEqual(await photoPaths('build_sheet', sheet.id), [], 'legacy id is not a token')
  const token = await shareLink(user('a1'), sheet.id)
  assert.deepEqual(await photoPaths('build_sheet', token), [own])
  await as(db, user('a1'), (tx: any) => tx.query(`SELECT public.revoke_build_sheet_share_link($1)`, [sheet.id]))
  assert.deepEqual(await photoPaths('build_sheet', token), [])
})

test('only the server can resolve photo paths for a token', async () => {
  for (const who of [anon, user('a1'), user('admin')]) {
    await assert.rejects(
      as(db, who, (tx: any) => tx.query(`SELECT public.customer_photo_paths('quote', $1)`, [uuid()])),
      /permission denied/i,
    )
  }
})
