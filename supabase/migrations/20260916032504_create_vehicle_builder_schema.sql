/*
# Vehicle Builder Schema — Vehicles, Parts, and Storage

## Overview
Shops can upload vehicle photos (front/rear views), trace parts on those photos
using SVG polygons, and define pricing for each part (buy-new vs paint-customer-parts).
Customers then use the customizer to select parts and submit a quote request.

## New Tables

### vehicles
- `id` (uuid, PK)
- `shop_id` (uuid, FK to shops) — which shop owns this vehicle
- `name` (text) — e.g. "2024 GMC Sierra 2500 HD"
- `year` (int, nullable)
- `make` (text, nullable)
- `model` (text, nullable)
- `status` (text) — 'draft' or 'published' (only published show to customers)
- `front_image_path` (text, nullable) — storage path for front view photo
- `rear_image_path` (text, nullable) — storage path for rear view photo
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

### vehicle_parts
- `id` (uuid, PK)
- `vehicle_id` (uuid, FK to vehicles, ON DELETE CASCADE)
- `name` (text) — e.g. "Front Bumper", "Headlights"
- `view` (text) — 'front' or 'rear' — which view this part is on
- `svg_path` (text) — SVG path data (polygon points) for the clickable region
- `part_cost` (numeric) — cost to buy new
- `paint_price` (numeric) — cost to paint customer's existing part
- `allow_send_parts` (boolean) — can customer send their own part?
- `lead_time_days` (int, default 7)
- `sort_order` (int, default 0)
- `created_at` (timestamptz)

## Storage
- Create a public storage bucket "vehicles" for storing vehicle photos
- Shops can upload to their own folder: `shop-{shop_id}/vehicle-{vehicle_id}/`
- Public read access for published vehicles (customers need to see photos)

## Security
- Shops: full CRUD on their own vehicles and parts
- Anon: can SELECT published vehicles and their parts (for customer customizer)
- Storage: shops can upload to their own folder, public can read published vehicle images
*/
-- ── Vehicles table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name text NOT NULL,
  year int,
  make text,
  model text,
  status text NOT NULL DEFAULT 'draft',
  front_image_path text,
  rear_image_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Vehicle parts table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  name text NOT NULL,
  view text NOT NULL DEFAULT 'front',
  svg_path text NOT NULL,
  part_cost numeric NOT NULL DEFAULT 0,
  paint_price numeric NOT NULL DEFAULT 0,
  allow_send_parts boolean NOT NULL DEFAULT true,
  lead_time_days int NOT NULL DEFAULT 7,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_vehicles_shop_id ON vehicles(shop_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_status ON vehicles(status);
CREATE INDEX IF NOT EXISTS idx_vehicle_parts_vehicle_id ON vehicle_parts(vehicle_id);

-- ── Enable RLS ──────────────────────────────────────────────────────────────
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_parts ENABLE ROW LEVEL SECURITY;

-- ══ VEHICLES policies ══════════════════════════════════════════════════════
-- Admin: full CRUD
DROP POLICY IF EXISTS "admin_select_vehicles" ON vehicles;
CREATE POLICY "admin_select_vehicles" ON vehicles FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_vehicles" ON vehicles;
CREATE POLICY "admin_insert_vehicles" ON vehicles FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_vehicles" ON vehicles;
CREATE POLICY "admin_update_vehicles" ON vehicles FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_vehicles" ON vehicles;
CREATE POLICY "admin_delete_vehicles" ON vehicles FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: CRUD on their own vehicles
DROP POLICY IF EXISTS "shop_user_select_own_vehicles" ON vehicles;
CREATE POLICY "shop_user_select_own_vehicles" ON vehicles FOR SELECT
  TO authenticated USING (shop_id = get_current_shop_id());

DROP POLICY IF EXISTS "shop_user_insert_own_vehicles" ON vehicles;
CREATE POLICY "shop_user_insert_own_vehicles" ON vehicles FOR INSERT
  TO authenticated WITH CHECK (shop_id = get_current_shop_id());

DROP POLICY IF EXISTS "shop_user_update_own_vehicles" ON vehicles;
CREATE POLICY "shop_user_update_own_vehicles" ON vehicles FOR UPDATE
  TO authenticated USING (shop_id = get_current_shop_id()) WITH CHECK (shop_id = get_current_shop_id());

DROP POLICY IF EXISTS "shop_user_delete_own_vehicles" ON vehicles;
CREATE POLICY "shop_user_delete_own_vehicles" ON vehicles FOR DELETE
  TO authenticated USING (shop_id = get_current_shop_id());

-- Anon: can read published vehicles (for customer customizer)
DROP POLICY IF EXISTS "anon_select_published_vehicles" ON vehicles;
CREATE POLICY "anon_select_published_vehicles" ON vehicles FOR SELECT
  TO anon, authenticated USING (status = 'published');

-- ══ VEHICLE_PARTS policies ═════════════════════════════════════════════════
-- Admin: full CRUD
DROP POLICY IF EXISTS "admin_select_vehicle_parts" ON vehicle_parts;
CREATE POLICY "admin_select_vehicle_parts" ON vehicle_parts FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_vehicle_parts" ON vehicle_parts;
CREATE POLICY "admin_insert_vehicle_parts" ON vehicle_parts FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_vehicle_parts" ON vehicle_parts;
CREATE POLICY "admin_update_vehicle_parts" ON vehicle_parts FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_vehicle_parts" ON vehicle_parts;
CREATE POLICY "admin_delete_vehicle_parts" ON vehicle_parts FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: CRUD on parts for their own vehicles
DROP POLICY IF EXISTS "shop_user_select_own_vehicle_parts" ON vehicle_parts;
CREATE POLICY "shop_user_select_own_vehicle_parts" ON vehicle_parts FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM vehicles WHERE vehicles.id = vehicle_parts.vehicle_id AND vehicles.shop_id = get_current_shop_id())
  );

DROP POLICY IF EXISTS "shop_user_insert_own_vehicle_parts" ON vehicle_parts;
CREATE POLICY "shop_user_insert_own_vehicle_parts" ON vehicle_parts FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM vehicles WHERE vehicles.id = vehicle_id AND vehicles.shop_id = get_current_shop_id())
  );

DROP POLICY IF EXISTS "shop_user_update_own_vehicle_parts" ON vehicle_parts;
CREATE POLICY "shop_user_update_own_vehicle_parts" ON vehicle_parts FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM vehicles WHERE vehicles.id = vehicle_parts.vehicle_id AND vehicles.shop_id = get_current_shop_id())
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM vehicles WHERE vehicles.id = vehicle_parts.vehicle_id AND vehicles.shop_id = get_current_shop_id())
  );

DROP POLICY IF EXISTS "shop_user_delete_own_vehicle_parts" ON vehicle_parts;
CREATE POLICY "shop_user_delete_own_vehicle_parts" ON vehicle_parts FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM vehicles WHERE vehicles.id = vehicle_parts.vehicle_id AND vehicles.shop_id = get_current_shop_id())
  );

-- Anon: can read parts for published vehicles
DROP POLICY IF EXISTS "anon_select_published_vehicle_parts" ON vehicle_parts;
CREATE POLICY "anon_select_published_vehicle_parts" ON vehicle_parts FOR SELECT
  TO anon, authenticated USING (
    EXISTS (SELECT 1 FROM vehicles WHERE vehicles.id = vehicle_parts.vehicle_id AND vehicles.status = 'published')
  );

-- ── Trigger: update updated_at on vehicles ─────────────────────────────────
DROP TRIGGER IF EXISTS vehicles_updated_at ON vehicles;
CREATE TRIGGER vehicles_updated_at BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Storage bucket for vehicle images ───────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('vehicles', 'vehicles', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: shops can upload/read their own folder, public can read
DROP POLICY IF EXISTS "shop_upload_vehicles" ON storage.objects;
CREATE POLICY "shop_upload_vehicles" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'vehicles' AND
    (storage.foldername(name))[1] = 'shop-' || get_current_shop_id()::text
  );

DROP POLICY IF EXISTS "admin_upload_vehicles" ON storage.objects;
CREATE POLICY "admin_upload_vehicles" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (
    bucket_id = 'vehicles' AND get_current_role() = 'admin'
  );

DROP POLICY IF EXISTS "shop_read_own_vehicles" ON storage.objects;
CREATE POLICY "shop_read_own_vehicles" ON storage.objects FOR SELECT
  TO authenticated USING (
    bucket_id = 'vehicles' AND
    ((storage.foldername(name))[1] = 'shop-' || get_current_shop_id()::text
     OR get_current_role() = 'admin')
  );

DROP POLICY IF EXISTS "shop_delete_own_vehicles" ON storage.objects;
CREATE POLICY "shop_delete_own_vehicles" ON storage.objects FOR DELETE
  TO authenticated USING (
    bucket_id = 'vehicles' AND
    ((storage.foldername(name))[1] = 'shop-' || get_current_shop_id()::text
     OR get_current_role() = 'admin')
  );

-- Public can read all vehicle images (they need to see published vehicle photos)
DROP POLICY IF EXISTS "public_read_vehicles" ON storage.objects;
CREATE POLICY "public_read_vehicles" ON storage.objects FOR SELECT
  TO anon, authenticated USING (bucket_id = 'vehicles');
