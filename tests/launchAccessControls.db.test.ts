// Launch access controls (20261123120000_launch_access_controls.sql):
// admin-only vehicle template cloning and database-enforced protection of
// shop subscription fields. Runs the real migrations in an isolated in-memory
// PGlite database with synthetic data (see tests/helpers/pgliteDb.mjs). No
// hosted database or network access is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore -- plain JS helper
import { createDb, applyMigrations, as, one } from './helpers/pgliteDb.mjs'

const MIGRATION = '20261123120000_launch_access_controls.sql'
const CLONE_SIG = 'public.clone_vehicle_template(uuid, uuid[])'

let db: any
const ids: Record<string, string> = {}

const anon = { role: 'anon' }
const user = (key: string) => ({ role: 'authenticated', id: ids[key] })

async function seedUsers(target: any, store: Record<string, string>) {
  const shop = async (name: string) =>
    (await one(target, `INSERT INTO shops (name, contact_email, slug, subscription_status, subscription_tier, trial_ends_at, is_lifetime_free)
      VALUES ($1, $2, $3, 'trialing', 'basic', '2030-01-01T00:00:00Z', false) RETURNING id`,
      [name, `${name.toLowerCase()}@shops.example.test`, name.toLowerCase()])).id
  store.templateShop = await shop('TemplateShop')
  store.shopA = await shop('ShopA')
  store.shopB = await shop('ShopB')
  const mk = async (key: string, role: string | null, shopId: string | null) => {
    const u = await one(target, `INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [`${key}@example.test`])
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
  await mk('noprofile', null, null)
}

async function seedTemplate(target: any): Promise<string> {
  const v = await one(target, `INSERT INTO vehicles (shop_id, name, year, make, model, status, front_image_path, rear_image_path, is_template)
    VALUES ($1, 'Synthetic Truck', 2024, 'Make', 'Model', 'published', 'front.png', 'rear.png', true) RETURNING id`, [ids.templateShop])
  const g = await one(target, `INSERT INTO part_groups (vehicle_id, name, sort_order) VALUES ($1, 'Bumpers', 2) RETURNING id`, [v.id])
  const p = await one(target, `INSERT INTO vehicle_parts (vehicle_id, name, view, svg_path, alt_view_svg_path, part_cost, paint_price,
      allow_send_parts, lead_time_days, sort_order, group_id, highlight_color, external_url)
    VALUES ($1, 'Front Bumper', 'front', 'M0 0 L10 10', 'M1 1 L9 9', 120, 40, false, 14, 3, $2, 'blue', 'https://parts.example.test/bumper')
    RETURNING id`, [v.id, g.id])
  await target.query(`INSERT INTO part_paint_styles (part_id, name, image_path, price, sort_order) VALUES ($1, 'Gloss', 'gloss.png', 25, 1)`, [p.id])
  await target.query(`INSERT INTO part_options (part_id, name, description, price, sort_order) VALUES ($1, 'Tow hook', 'Adds hooks', 30, 1)`, [p.id])
  return v.id
}

const clone = (who: any, templateId: string, shops: string[]) =>
  as(db, who, (tx: any) => one(tx, `SELECT public.clone_vehicle_template($1, $2::uuid[]) AS r`, [templateId, shops]))

before(async () => {
  db = await createDb()
  await seedUsers(db, ids)
  ids.template = await seedTemplate(db)
})

// ---------------------------------------------------------------------------
// Vehicle template cloning
// ---------------------------------------------------------------------------

test('anonymous callers cannot execute clone_vehicle_template', async () => {
  await assert.rejects(clone(anon, ids.template, [ids.shopA]), /permission denied/i)
  const r = await one(db, `SELECT has_function_privilege('anon', '${CLONE_SIG}', 'EXECUTE') AS ok`)
  assert.equal(r.ok, false)
})

test('a signed-in caller with no profile is denied template cloning', async () => {
  await assert.rejects(clone(user('noprofile'), ids.template, [ids.shopA]), /Only admins can push vehicle templates/)
})

test('an authenticated request with no identity (no sub) is denied template cloning', async () => {
  await assert.rejects(clone({ role: 'authenticated' }, ids.template, [ids.shopA]), /Only admins can push vehicle templates/)
})

test('shop users are denied template cloning', async () => {
  await assert.rejects(clone(user('a1'), ids.template, [ids.shopA]), /Only admins can push vehicle templates/)
  const n = await one(db, `SELECT count(*)::int AS n FROM vehicles WHERE template_source_id = $1`, [ids.template])
  assert.equal(n.n, 0)
})

test('admins can still clone templates, copying every supported field', async () => {
  const { r } = await clone(user('admin'), ids.template, [ids.shopA])
  assert.equal(r.created.length, 1)
  assert.deepEqual(r.skipped, [])
  const vehicleId = r.created[0].vehicle_id

  const v = await one(db, `SELECT * FROM vehicles WHERE id = $1`, [vehicleId])
  assert.equal(v.shop_id, ids.shopA)
  assert.equal(v.name, 'Synthetic Truck')
  assert.equal(v.year, 2024)
  assert.equal(v.make, 'Make')
  assert.equal(v.model, 'Model')
  assert.equal(v.status, 'draft')
  assert.equal(v.front_image_path, 'front.png')
  assert.equal(v.rear_image_path, 'rear.png')
  assert.equal(v.is_template, false)
  assert.equal(v.template_source_id, ids.template)

  const g = await one(db, `SELECT * FROM part_groups WHERE vehicle_id = $1`, [vehicleId])
  assert.equal(g.name, 'Bumpers')
  assert.equal(g.sort_order, 2)

  const p = await one(db, `SELECT * FROM vehicle_parts WHERE vehicle_id = $1`, [vehicleId])
  assert.equal(p.name, 'Front Bumper')
  assert.equal(p.view, 'front')
  assert.equal(p.svg_path, 'M0 0 L10 10')
  assert.equal(p.alt_view_svg_path, 'M1 1 L9 9')
  assert.equal(p.external_url, 'https://parts.example.test/bumper')
  assert.equal(p.allow_send_parts, false)
  assert.equal(p.sort_order, 3)
  assert.equal(p.highlight_color, 'blue')
  assert.equal(p.group_id, g.id)
  assert.equal(Number(p.part_cost), 0)
  assert.equal(Number(p.paint_price), 0)
  assert.equal(p.lead_time_days, 7)

  const ps = await one(db, `SELECT * FROM part_paint_styles WHERE part_id = $1`, [p.id])
  assert.equal(ps.name, 'Gloss')
  assert.equal(ps.image_path, 'gloss.png')
  assert.equal(Number(ps.price), 0)
  const po = await one(db, `SELECT * FROM part_options WHERE part_id = $1`, [p.id])
  assert.equal(po.name, 'Tow hook')
  assert.equal(po.description, 'Adds hooks')
  assert.equal(Number(po.price), 0)

  // A second push to the same shop is skipped, as before.
  const again = await clone(user('admin'), ids.template, [ids.shopA, ids.shopB])
  assert.deepEqual(again.r.skipped, [ids.shopA])
  assert.equal(again.r.created.length, 1)
})

test('the migration also closes direct and inherited anon grants left on the hosted baseline', async () => {
  const prod = await createDb({ before: MIGRATION })
  // Simulate the hosted grants: Supabase default privileges grant EXECUTE
  // directly to anon, and PUBLIC carries an inherited grant.
  await prod.exec(`GRANT EXECUTE ON FUNCTION ${CLONE_SIG} TO PUBLIC; GRANT EXECUTE ON FUNCTION ${CLONE_SIG} TO anon;`)
  const pre = await one(prod, `SELECT has_function_privilege('anon', '${CLONE_SIG}', 'EXECUTE') AS ok`)
  assert.equal(pre.ok, true)

  await applyMigrations(prod, { from: MIGRATION })

  const post = await one(prod, `SELECT has_function_privilege('anon', '${CLONE_SIG}', 'EXECUTE') AS anon_ok,
      has_function_privilege('authenticated', '${CLONE_SIG}', 'EXECUTE') AS auth_ok`)
  assert.equal(post.anon_ok, false)
  assert.equal(post.auth_ok, true)
  const acl = await one(prod, `SELECT array_to_string(proacl, ',') AS acl FROM pg_proc WHERE oid = '${CLONE_SIG}'::regprocedure`)
  assert.doesNotMatch(acl.acl, /(^|,)=X/, 'no PUBLIC execute grant')
  assert.doesNotMatch(acl.acl, /(^|,)anon=/, 'no direct anon grant')
  await prod.close()
})

// ---------------------------------------------------------------------------
// Shop subscription fields
// ---------------------------------------------------------------------------

const PROTECTED: Record<string, unknown> = {
  subscription_status: 'active',
  subscription_tier: 'pro',
  trial_ends_at: '2099-01-01T00:00:00Z',
  is_lifetime_free: true,
}

async function subscription(shopId: string) {
  return one(db, `SELECT subscription_status, subscription_tier, trial_ends_at, is_lifetime_free FROM shops WHERE id = $1`, [shopId])
}

test('shop users can still edit permitted shop settings', async () => {
  const before = await subscription(ids.shopA)
  const row = await as(db, user('a1'), (tx: any) => one(tx,
    `UPDATE shops SET name = 'ShopA Renamed', phone = '555-0100', address = '1 Example St',
       contact_email = 'new@shops.example.test', logo_url = 'logo.png',
       customizer_config = '{"shipping_rates": {"small": 10}}'::jsonb
     WHERE id = $1 RETURNING name, phone, customizer_config`, [ids.shopA]))
  assert.equal(row.name, 'ShopA Renamed')
  assert.equal(row.phone, '555-0100')
  assert.deepEqual(row.customizer_config, { shipping_rates: { small: 10 } })
  assert.deepEqual(await subscription(ids.shopA), before)
})

test('shop users may resend unchanged subscription values alongside a settings edit', async () => {
  const cur = await subscription(ids.shopA)
  const row = await as(db, user('a1'), (tx: any) => one(tx,
    `UPDATE shops SET name = 'ShopA Again', subscription_status = $2, subscription_tier = $3, trial_ends_at = $4, is_lifetime_free = $5
     WHERE id = $1 RETURNING name`, [ids.shopA, cur.subscription_status, cur.subscription_tier, cur.trial_ends_at, cur.is_lifetime_free]))
  assert.equal(row.name, 'ShopA Again')
})

for (const [column, value] of Object.entries(PROTECTED)) {
  test(`shop users cannot change ${column}, even with a direct API update`, async () => {
    const before = await subscription(ids.shopA)
    await assert.rejects(
      as(db, user('a1'), (tx: any) => tx.query(`UPDATE shops SET ${column} = $2 WHERE id = $1`, [ids.shopA, value])),
      /Only admins can change shop subscription settings/,
    )
    // Mixed with a permitted field, the whole update is refused.
    await assert.rejects(
      as(db, user('a1'), (tx: any) => tx.query(`UPDATE shops SET name = 'Sneaky', ${column} = $2 WHERE id = $1`, [ids.shopA, value])),
      /Only admins can change shop subscription settings/,
    )
    assert.deepEqual(await subscription(ids.shopA), before)
  })
}

test('signed-in callers without a profile cannot change subscription fields', async () => {
  const r = await as(db, user('noprofile'), (tx: any) =>
    tx.query(`UPDATE shops SET subscription_status = 'active' WHERE id = $1`, [ids.shopA]))
  assert.equal(r.affectedRows ?? 0, 0) // RLS hides the row entirely
  assert.equal((await subscription(ids.shopA)).subscription_status, 'trialing')
})

test('admins can still manage shop subscriptions', async () => {
  const row = await as(db, user('admin'), (tx: any) => one(tx,
    `UPDATE shops SET subscription_status = 'active', subscription_tier = 'pro', trial_ends_at = '2099-01-01T00:00:00Z', is_lifetime_free = true
     WHERE id = $1 RETURNING subscription_status, subscription_tier, trial_ends_at, is_lifetime_free`, [ids.shopB]))
  assert.equal(row.subscription_status, 'active')
  assert.equal(row.subscription_tier, 'pro')
  assert.equal(new Date(row.trial_ends_at).toISOString(), '2099-01-01T00:00:00.000Z')
  assert.equal(row.is_lifetime_free, true)

  const back = await as(db, user('admin'), (tx: any) => one(tx,
    `UPDATE shops SET subscription_status = 'cancelled', is_lifetime_free = false WHERE id = $1 RETURNING subscription_status, is_lifetime_free`, [ids.shopB]))
  assert.equal(back.subscription_status, 'cancelled')
  assert.equal(back.is_lifetime_free, false)
})

test('trusted server-side updates (database owner, not an API end user) are not blocked', async () => {
  // The local harness does not grant service_role table privileges, so the
  // trusted path is exercised as the database owner (migrations, dashboard).
  const row = await one(db, `UPDATE shops SET subscription_status = 'active' WHERE id = $1 RETURNING subscription_status`, [ids.shopB])
  assert.equal(row.subscription_status, 'active')
})
