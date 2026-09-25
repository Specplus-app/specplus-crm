/*
# Create build_sheets table (public shareable build sheets)

1. Purpose
- Stores a saved snapshot of a completed build so it can be viewed on a public,
  shareable page at /build/:id and linked from the customer email.

2. New Tables
- `build_sheets`
  - `id` (uuid, primary key) — the public identifier used in the /build/:id URL.
  - `lead_id` (uuid, unique, nullable) — links back to the originating lead; unique so
    re-generating a sheet for the same lead updates the existing row instead of duplicating.
  - `shop_id` (uuid, nullable) — owning shop, for reference.
  - `shop_name` (text) — shop display name shown on the public page.
  - `shop_logo_url` (text, nullable) — public logo URL shown on the public page.
  - `customer_name` (text) — customer the build is for.
  - `customer_email` (text) — where the build sheet email was sent.
  - `vehicle_name` (text) — headline vehicle name.
  - `vehicle_year`, `vehicle_make`, `vehicle_model`, `vehicle_trim` (text, nullable) — vehicle details.
  - `paint_code` (text, nullable) — optional paint code.
  - `fulfillment_mode` (text) — 'local' or 'mail'.
  - `is_custom` (boolean) — whether this was a custom (photo-traced) build.
  - `front_image_url`, `rear_image_url` (text, nullable) — public photo URLs with labeled parts.
  - `selected_parts` (jsonb) — itemized parts incl. labeled coordinates and pricing.
  - `parts_total`, `shipping_total`, `grand_total` (numeric) — pricing summary.
  - `estimated_lead_time_days` (integer) — estimated lead time.
  - `created_at`, `updated_at` (timestamptz) — timestamps.

3. Security (RLS)
  1. RLS is enabled on `build_sheets`.
  2. SELECT is intentionally PUBLIC (TO anon, authenticated, USING true): the build sheet is a
     shareable customer-facing link, so anyone holding the /build/:id URL can view it.
  3. INSERT and UPDATE are limited to authenticated shop users, who generate the sheet from the
     lead detail screen. DELETE is not exposed.
*/

CREATE TABLE IF NOT EXISTS build_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
  shop_id uuid,
  shop_name text NOT NULL DEFAULT '',
  shop_logo_url text,
  customer_name text NOT NULL DEFAULT '',
  customer_email text NOT NULL DEFAULT '',
  vehicle_name text NOT NULL DEFAULT '',
  vehicle_year text,
  vehicle_make text,
  vehicle_model text,
  vehicle_trim text,
  paint_code text,
  fulfillment_mode text NOT NULL DEFAULT 'local',
  is_custom boolean NOT NULL DEFAULT false,
  front_image_url text,
  rear_image_url text,
  selected_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  parts_total numeric NOT NULL DEFAULT 0,
  shipping_total numeric NOT NULL DEFAULT 0,
  grand_total numeric NOT NULL DEFAULT 0,
  estimated_lead_time_days integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE build_sheets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_select_build_sheets" ON build_sheets;
CREATE POLICY "public_select_build_sheets" ON build_sheets FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_build_sheets" ON build_sheets;
CREATE POLICY "auth_insert_build_sheets" ON build_sheets FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_build_sheets" ON build_sheets;
CREATE POLICY "auth_update_build_sheets" ON build_sheets FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);
