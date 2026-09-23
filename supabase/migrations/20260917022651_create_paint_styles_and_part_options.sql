/*
# Paint Styles and Part Options for Vehicle Parts

## Overview
Shops can now define multiple paint styles per part (e.g. different ways headlights
can be painted, each with its own image and price) and add customizable options
(e.g. LED upgrades, demon eyes, halos) to any part. Customers will choose a paint
style and select optional add-ons when selecting a part in the customizer.

## New Tables

### part_paint_styles
- `id` (uuid, PK)
- `part_id` (uuid, FK to vehicle_parts, ON DELETE CASCADE) — which part this style belongs to
- `name` (text) — e.g. "Gloss Black", "Color-Matched", "Smoked"
- `image_path` (text, nullable) — storage path for a reference photo of this paint style
- `price` (numeric, NOT NULL DEFAULT 0) — the paint price when this style is chosen
- `sort_order` (int, NOT NULL DEFAULT 0) — display ordering
- `created_at` (timestamptz)

### part_options
- `id` (uuid, PK)
- `part_id` (uuid, FK to vehicle_parts, ON DELETE CASCADE) — which part this option belongs to
- `name` (text) — e.g. "Amber to White LED Conversion", "Demon Eyes", "Halo Lights"
- `description` (text, nullable) — longer explanation shown to the customer
- `price` (numeric, NOT NULL DEFAULT 0) — additional cost added to the part
- `sort_order` (int, NOT NULL DEFAULT 0) — display ordering
- `created_at` (timestamptz)

## Security
- Shops: full CRUD on paint styles and options for their own vehicles' parts
- Admin: full CRUD on all paint styles and options
- Anon: can SELECT paint styles and options for parts on published vehicles (for customer customizer)
- Storage: paint style images stored in the existing "vehicles" bucket under the same shop folder pattern

## Important Notes
1. If a part has no paint styles, the customizer falls back to the part's default `paint_price`.
2. If a part has paint styles, the customer must pick one; the first style is selected by default.
3. Part options are additive — each selected option adds its price to the part total.
4. Paint style images use the same storage bucket as vehicle images ("vehicles").
*/
-- ── Part paint styles table ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS part_paint_styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES vehicle_parts(id) ON DELETE CASCADE,
  name text NOT NULL,
  image_path text,
  price numeric NOT NULL DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Part options table ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS part_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id uuid NOT NULL REFERENCES vehicle_parts(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price numeric NOT NULL DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_part_paint_styles_part_id ON part_paint_styles(part_id);
CREATE INDEX IF NOT EXISTS idx_part_options_part_id ON part_options(part_id);

-- ── Enable RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE part_paint_styles ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_options ENABLE ROW LEVEL SECURITY;

-- ══ PART_PAINT_STYLES policies ════════════════════════════════════════════════
-- Admin: full CRUD
DROP POLICY IF EXISTS "admin_select_paint_styles" ON part_paint_styles;
CREATE POLICY "admin_select_paint_styles" ON part_paint_styles FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_paint_styles" ON part_paint_styles;
CREATE POLICY "admin_insert_paint_styles" ON part_paint_styles FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_paint_styles" ON part_paint_styles;
CREATE POLICY "admin_update_paint_styles" ON part_paint_styles FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_paint_styles" ON part_paint_styles;
CREATE POLICY "admin_delete_paint_styles" ON part_paint_styles FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: CRUD on paint styles for their own vehicles' parts
DROP POLICY IF EXISTS "shop_user_select_own_paint_styles" ON part_paint_styles;
CREATE POLICY "shop_user_select_own_paint_styles" ON part_paint_styles FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_paint_styles.part_id AND v.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_insert_own_paint_styles" ON part_paint_styles;
CREATE POLICY "shop_user_insert_own_paint_styles" ON part_paint_styles FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_id AND v.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_update_own_paint_styles" ON part_paint_styles;
CREATE POLICY "shop_user_update_own_paint_styles" ON part_paint_styles FOR UPDATE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_paint_styles.part_id AND v.shop_id = get_current_shop_id()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_paint_styles.part_id AND v.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_delete_own_paint_styles" ON part_paint_styles;
CREATE POLICY "shop_user_delete_own_paint_styles" ON part_paint_styles FOR DELETE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_paint_styles.part_id AND v.shop_id = get_current_shop_id()
    )
  );

-- Anon: can read paint styles for published vehicles
DROP POLICY IF EXISTS "anon_select_published_paint_styles" ON part_paint_styles;
CREATE POLICY "anon_select_published_paint_styles" ON part_paint_styles FOR SELECT
  TO anon, authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_paint_styles.part_id AND v.status = 'published'
    )
  );

-- ══ PART_OPTIONS policies ═════════════════════════════════════════════════════
-- Admin: full CRUD
DROP POLICY IF EXISTS "admin_select_part_options" ON part_options;
CREATE POLICY "admin_select_part_options" ON part_options FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_part_options" ON part_options;
CREATE POLICY "admin_insert_part_options" ON part_options FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_part_options" ON part_options;
CREATE POLICY "admin_update_part_options" ON part_options FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_part_options" ON part_options;
CREATE POLICY "admin_delete_part_options" ON part_options FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: CRUD on options for their own vehicles' parts
DROP POLICY IF EXISTS "shop_user_select_own_part_options" ON part_options;
CREATE POLICY "shop_user_select_own_part_options" ON part_options FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_options.part_id AND v.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_insert_own_part_options" ON part_options;
CREATE POLICY "shop_user_insert_own_part_options" ON part_options FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_id AND v.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_update_own_part_options" ON part_options;
CREATE POLICY "shop_user_update_own_part_options" ON part_options FOR UPDATE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_options.part_id AND v.shop_id = get_current_shop_id()
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_options.part_id AND v.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_delete_own_part_options" ON part_options;
CREATE POLICY "shop_user_delete_own_part_options" ON part_options FOR DELETE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_options.part_id AND v.shop_id = get_current_shop_id()
    )
  );

-- Anon: can read options for published vehicles
DROP POLICY IF EXISTS "anon_select_published_part_options" ON part_options;
CREATE POLICY "anon_select_published_part_options" ON part_options FOR SELECT
  TO anon, authenticated USING (
    EXISTS (
      SELECT 1 FROM vehicle_parts vp
      JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = part_options.part_id AND v.status = 'published'
    )
  );