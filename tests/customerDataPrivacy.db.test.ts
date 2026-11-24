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
import { customerUploadPath, customerUploadRef, newUploadKey } from '../src/lib/customerUploadRefs.ts'

const PHASE1 = '20261124120000_customer_data_privacy.sql'
const BINDING = '20261125120000_bind_customer_photos_to_requests.sql'
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
      front_image_url, rear_image_url, selected_parts, parts_total, grand_total, lead_id)
    VALUES ($1, 'Shop', 'Jordan Customer', 'jordan@customers.example.test', 'Bronco', $2, $3, $4, 650, 650, $5) RETURNING id, front_image_url`,
    [ids[shopKey], front, extra.rear ?? null, JSON.stringify(extra.parts ?? [{ id: 'p', name: 'Bumper', type: 'new', price: 650 }]), extra.lead ?? null]))
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
  const keyed = await customerUploadRef(newUploadKey())
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) await upload(`${ids.shopA}/${keyed}/${uuid()}.${ext}`)
  // Legacy layout stays accepted during rollout (staff-only unless claimed).
  await upload(`${ids.shopA}/${uuid()}.jpg`)
  await upload(`${ids.shopB}/${uuid()}.jpg`, user('a1'))

  const rejected = [
    `${ids.shopA}/${uuid()}.svg`,
    `${ids.shopA}/${uuid()}.html`,
    `${ids.shopA}/${uuid()}.JPG.exe`,
    `${ids.shopA}/photo.jpg`,
    `${ids.shopA}/nested/${uuid()}.jpg`,
    `${ids.shopA}/${keyed}/${uuid()}.svg`,
    `${ids.shopA}/${keyed.slice(0, 31)}/${uuid()}.jpg`,
    `${ids.shopA}/${keyed}/extra/${uuid()}.jpg`,
    `${uuid()}/${keyed}/${uuid()}.jpg`, // not a shop
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
    `${shop}/${'a'.repeat(32)}/${uuid()}.png`,
    `${STORAGE_URL}/customer-uploads/${shop}/${'b'.repeat(32)}/${uuid()}.jpg`,
    'nested/too/deep/four.jpg',
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

type Upload = { key: string; ref: string }
async function uploadSession(): Promise<Upload> {
  const key = newUploadKey()
  return { key, ref: await customerUploadRef(key) }
}

// What the custom-build flow does: upload each photo under the request's
// upload ref, as an anonymous visitor.
async function uploadPhotos(shopKey: string, session: Upload, n: number, ext = 'jpg'): Promise<string[]> {
  const paths: string[] = []
  for (let i = 0; i < n; i++) {
    const p = `${ids[shopKey]}/${session.ref}/${uuid()}.${ext}`
    await as(db, anon, (tx: any) => tx.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('customer-uploads', $1)`, [p]))
    paths.push(p)
  }
  return paths
}

async function newLead(shopKey: string, custom: boolean, front: string | null, rear: string | null, parts: unknown[], uploadKey: string | null = null) {
  const marker = rand()
  await as(db, anon, (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name,
      fulfillment_mode, selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom, notes,
      front_image_url, rear_image_url, upload_key)
    VALUES ($1, 'Jordan Customer', $2, $3, 'Bronco', 'local', $4, 650, 0, 650, 5, 'new', $5, $6, $7, $8, $9)`,
    [ids[shopKey], `${rand()}@customers.example.test`, custom ? 'custom' : 'veh', JSON.stringify(parts), custom, marker, front, rear, uploadKey]))
  return (await one(db, `SELECT id FROM leads WHERE notes = $1`, [marker])).id
}

async function quoteFor(leadId: string, userKey: string, front: string | null, rear: string | null, parts: unknown[], send = true) {
  const q = await as(db, user(userKey), (tx: any) => one(tx, `INSERT INTO quotes (lead_id, selected_parts, shipping_total, front_image_url, rear_image_url)
    VALUES ($1, $2, 0, $3, $4) RETURNING id, public_token`, [leadId, JSON.stringify(parts), front, rear]))
  if (send) await as(db, service, (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [q.id, ids[userKey]]))
  return q
}

const ITEM = [{ id: 'w', name: 'Work', type: 'send', price: 100, priced: true }]
const partsWithRef = (ref: string) =>
  [{ id: 'c1', name: 'Fender', type: 'send', price: 300, priced: true, reference_image_path: ref, box: { view: 'front', x: 1, y: 1, w: 5, h: 5 } }]

test('frontend and database derive the same upload ref from a key', async () => {
  const key = newUploadKey()
  assert.match(key, /^[0-9a-f]{64}$/)
  const r = await one(db, `SELECT public.customer_upload_ref($1) AS ref`, [key])
  assert.equal(r.ref, await customerUploadRef(key))
  assert.equal((await one(db, `SELECT public.customer_upload_ref('not-a-key') AS ref`)).ref, null)
})

test('custom quote flow: customer uploads, staff quote, customer sees only that request\'s photos', async () => {
  const s = await uploadSession()
  const [front, rear, ref] = await uploadPhotos('shopA', s, 3)
  const parts = partsWithRef(ref)
  const leadId = await newLead('shopA', true, front, rear, parts, s.key)

  // The key is never stored; only its ref is.
  const lead = await one(db, `SELECT upload_key, upload_ref FROM leads WHERE id = $1`, [leadId])
  assert.equal(lead.upload_key, null)
  assert.equal(lead.upload_ref, s.ref)

  // Staff of the shop can read the lead's photos (and therefore sign them).
  const visible = await as(db, user('a1'), (tx: any) => tx.query(`SELECT name FROM storage.objects WHERE name = ANY($1)`, [[front, rear, ref]]))
  assert.equal(visible.rows.length, 3)

  // Older quotes stored public-URL-shaped values; new ones store paths.
  const q = await quoteFor(leadId, 'a1', `${STORAGE_URL}/customer-uploads/${front}`, rear, parts)
  const pub = await as(db, anon, (tx: any) => one(tx, `SELECT public.get_public_quote($1) AS q`, [q.public_token]))
  assert.ok(pub.q, 'customer can open the quote')
  assert.deepEqual(await photoPaths('quote', q.public_token), [front, rear, ref].sort())

  // Build-sheet sharing for the same request shows the same photos.
  const sheet = await newSheet('shopA', 'a1', { front, rear, parts, lead: leadId })
  const token = await shareLink(user('a1'), sheet.id)
  assert.deepEqual(await photoPaths('build_sheet', token), [front, rear, ref].sort())
})

test('two customers of the same shop cannot see each other\'s photos', async () => {
  // Customer 1 submits a custom request with photos.
  const s1 = await uploadSession()
  const [front1, rear1, ref1] = await uploadPhotos('shopA', s1, 3)
  const lead1 = await newLead('shopA', true, front1, rear1, partsWithRef(ref1), s1.key)

  // Customer 2, same shop, learns customer 1's paths and references them in
  // their own request: with no key, with their own key, and with a forged ref.
  const s2 = await uploadSession()
  const [front2] = await uploadPhotos('shopA', s2, 1)
  const leadNoKey = await newLead('shopA', true, front1, rear1, partsWithRef(ref1))
  const leadOwnKey = await newLead('shopA', true, front1, front2, partsWithRef(ref1), s2.key)
  const forged = rand()
  await as(db, anon, (tx: any) => tx.query(`INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name, fulfillment_mode,
      selected_parts, parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom, notes, front_image_url, upload_ref)
    VALUES ($1, 'Mallory', 'm@customers.example.test', 'custom', 'Truck', 'local', '[]', 0, 0, 0, 0, 'new', true, $2, $3, $4)`,
    [ids.shopA, forged, front1, s1.ref]))
  const leadForged = (await one(db, `SELECT id, upload_ref FROM leads WHERE notes = $1`, [forged]))
  assert.equal(leadForged.upload_ref, null, 'callers cannot set upload_ref')

  // Staff quote each request exactly as submitted.
  const q1 = await quoteFor(lead1, 'a1', front1, rear1, partsWithRef(ref1))
  const qNoKey = await quoteFor(leadNoKey, 'a1', front1, rear1, partsWithRef(ref1))
  const qOwnKey = await quoteFor(leadOwnKey, 'a1', front1, front2, partsWithRef(ref1))
  const qForged = await quoteFor(leadForged.id, 'a1', front1, null, ITEM)

  assert.deepEqual(await photoPaths('quote', q1.public_token), [front1, rear1, ref1].sort(), 'customer 1 still sees their own photos')
  assert.deepEqual(await photoPaths('quote', qNoKey.public_token), [], 'no key: no photos')
  assert.deepEqual(await photoPaths('quote', qOwnKey.public_token), [front2], 'own key: only their own photo')
  assert.deepEqual(await photoPaths('quote', qForged.public_token), [], 'forged ref: no photos')

  // A build sheet for customer 2's request does not leak customer 1's photos either.
  const sheet = await newSheet('shopA', 'a1', { front: front1, rear: front2, parts: partsWithRef(ref1), lead: leadOwnKey })
  const token = await shareLink(user('a1'), sheet.id)
  assert.deepEqual(await photoPaths('build_sheet', token), [front2])

  // Staff cannot move a request onto another request's photos.
  await as(db, user('a1'), (tx: any) => tx.query(`UPDATE leads SET upload_ref = $2 WHERE id = $1`, [leadNoKey, s1.ref]))
  assert.equal((await one(db, `SELECT upload_ref FROM leads WHERE id = $1`, [leadNoKey])).upload_ref, null)
  assert.deepEqual(await photoPaths('quote', qNoKey.public_token), [])

  // Staff still see every photo in their shop.
  const staffSees = await as(db, user('a1'), (tx: any) => tx.query(`SELECT name FROM storage.objects WHERE name = ANY($1)`, [[front1, rear1, ref1, front2]]))
  assert.equal(staffSees.rows.length, 4)
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
  const s = await uploadSession()
  const [own] = await uploadPhotos('shopA', s, 1)
  const foreign = `${ids.shopB}/${s.ref}/${uuid()}.jpg` // same ref, other shop's folder
  const draftLead = await newLead('shopA', true, own, foreign, [], s.key)
  const draft = await quoteFor(draftLead, 'a1', own, foreign, ITEM, false)
  assert.deepEqual(await photoPaths('quote', draft.public_token), [], 'draft quotes are not visible')

  const leadId = await newLead('shopA', true, own, foreign, [], s.key)
  const sent = await quoteFor(leadId, 'a1', own, foreign, ITEM)
  assert.deepEqual(await photoPaths('quote', sent.public_token), [own], 'another shop\'s file is never returned')
  assert.deepEqual(await photoPaths('quote', uuid()), [])
  assert.deepEqual(await photoPaths('quote', 'nope'), [])
  assert.deepEqual(await photoPaths('build_sheet', sent.public_token), [], 'a quote token does not open build sheets')
  assert.deepEqual(await photoPaths('other', sent.public_token), [])

  const sheet = await newSheet('shopA', 'a1', { front: own, rear: `${STORAGE_URL}/customer-uploads/${foreign}`, lead: leadId })
  assert.deepEqual(await photoPaths('build_sheet', sheet.id), [], 'legacy id is not a token')
  const token = await shareLink(user('a1'), sheet.id)
  assert.deepEqual(await photoPaths('build_sheet', token), [own])
  await as(db, user('a1'), (tx: any) => tx.query(`SELECT public.revoke_build_sheet_share_link($1)`, [sheet.id]))
  assert.deepEqual(await photoPaths('build_sheet', token), [])

  // A build sheet with no linked request shows no customer photos.
  const orphan = await newSheet('shopA', 'a1', { front: own })
  assert.deepEqual(await photoPaths('build_sheet', await shareLink(user('a1'), orphan.id)), [])
})

test('only the server can resolve photo paths or re-run the legacy backfill', async () => {
  for (const who of [anon, user('a1'), user('admin')]) {
    await assert.rejects(
      as(db, who, (tx: any) => tx.query(`SELECT public.customer_photo_paths('quote', $1)`, [uuid()])),
      /permission denied/i,
    )
    await assert.rejects(
      as(db, who, (tx: any) => tx.query(`SELECT public.backfill_legacy_customer_photo_claims()`)),
      /permission denied/i,
    )
    await assert.rejects(
      as(db, who, (tx: any) => tx.query(`SELECT * FROM legacy_customer_photo_claims`)),
      /permission denied/i,
    )
  }
})

// ---------------------------------------------------------------------------
// Legacy photos (uploaded before request binding)
// ---------------------------------------------------------------------------

test('legacy photos: unambiguous ones stay visible to their customer; others become staff-only', async () => {
  const pre = await createDb({ before: BINDING })
  const store: Record<string, string> = {}
  await seed(pre, store)
  const legacy = () => `${store.shopA}/${uuid()}.jpg`
  const obj = (name: string, at: string) =>
    pre.query(`INSERT INTO storage.objects (bucket_id, name, created_at) VALUES ('customer-uploads', $1, $2)`, [name, at])
  const lead = async (front: string | null, rear: string | null, at: string, parts: unknown[] = []) =>
    (await one(pre, `INSERT INTO leads (shop_id, customer_name, customer_email, vehicle_id, vehicle_name, fulfillment_mode, selected_parts,
        parts_total, shipping_total, grand_total, estimated_lead_time_days, status, is_custom, front_image_url, rear_image_url, submitted_at)
      VALUES ($1, 'Legacy', $2, 'custom', 'Truck', 'local', $3, 0, 0, 0, 0, 'new', true, $4, $5, $6) RETURNING id`,
      [store.shopA, `${rand()}@customers.example.test`, JSON.stringify(parts), front, rear, at])).id

  // Genuine: uploaded minutes before the request that references it.
  const good = legacy(); const goodRef = legacy()
  await obj(good, '2026-09-01T10:00:00Z'); await obj(goodRef, '2026-09-01T10:01:00Z')
  const goodLead = await lead(`${STORAGE_URL}/customer-uploads/${good}`, null, '2026-09-01T10:05:00Z', partsWithRef(goodRef))
  // Hijacked: a second request references the same photo.
  const shared = legacy()
  await obj(shared, '2026-09-02T10:00:00Z')
  const victim = await lead(shared, null, '2026-09-02T10:05:00Z')
  const thief = await lead(shared, null, '2026-09-03T09:00:00Z')
  // Photo uploaded after the request, or long before it.
  const late = legacy(); const stale = legacy()
  await obj(late, '2026-09-04T12:00:00Z'); await obj(stale, '2026-08-01T00:00:00Z')
  const oddLead = await lead(late, stale, '2026-09-04T10:00:00Z')

  await applyMigrations(pre, { from: BINDING })

  const claims = (await pre.query(`SELECT lead_id, object_path FROM legacy_customer_photo_claims`)).rows
  const claimed = (l: string) => claims.filter((c: any) => c.lead_id === l).map((c: any) => c.object_path).sort()
  assert.deepEqual(claimed(goodLead), [good, goodRef].sort())
  assert.deepEqual(claimed(victim), [], 'ambiguous: staff-only')
  assert.deepEqual(claimed(thief), [])
  assert.deepEqual(claimed(oddLead), [])

  // Through a quote link, the genuine customer sees exactly their photos.
  const send = async (leadId: string, front: string | null) => {
    const q = await as(pre, { role: 'authenticated', id: store.a1 }, (tx: any) => one(tx,
      `INSERT INTO quotes (lead_id, selected_parts, shipping_total, front_image_url) VALUES ($1, $2, 0, $3) RETURNING id, public_token`,
      [leadId, JSON.stringify([...ITEM, ...partsWithRef(goodRef)]), front]))
    await as(pre, service, (tx: any) => tx.query(`SELECT public.mark_quote_sent($1, $2)`, [q.id, store.a1]))
    return as(pre, service, (tx: any) => one(tx, `SELECT public.customer_photo_paths('quote', $1) AS p`, [q.public_token])).then((r: any) => [...r.p].sort())
  }
  assert.deepEqual(await send(goodLead, `${STORAGE_URL}/customer-uploads/${good}`), [good, goodRef].sort())
  assert.deepEqual(await send(thief, shared), [], 'the second request cannot see the shared photo')
  assert.deepEqual(await send(victim, shared), [])

  // Staff-only fallback: staff of the shop can still read every legacy photo.
  const staffSees = await as(pre, { role: 'authenticated', id: store.a1 }, (tx: any) =>
    tx.query(`SELECT name FROM storage.objects WHERE name = ANY($1)`, [[good, goodRef, shared, late, stale]]))
  assert.equal(staffSees.rows.length, 5)

  // Re-running the backfill is idempotent, and a later request referencing a
  // claimed legacy photo makes it ambiguous, removing the claim.
  const rerun = async () => (await as(pre, service, (tx: any) => one(tx, `SELECT public.backfill_legacy_customer_photo_claims() AS r`))).r
  assert.deepEqual(await rerun(), { added: 0, removed: 0 })
  await lead(good, null, '2026-09-05T00:00:00Z')
  const r = await rerun()
  assert.equal(r.removed, 1)
  const after = (await pre.query(`SELECT object_path FROM legacy_customer_photo_claims WHERE lead_id = $1`, [goodLead])).rows.map((x: any) => x.object_path)
  assert.deepEqual(after, [goodRef])
  await pre.close()
})
