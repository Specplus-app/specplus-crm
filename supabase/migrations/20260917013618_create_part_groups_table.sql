/*
# Create part_groups table and add group_id to vehicle_parts

## Purpose
Replaces the parent_part_id / sub-part hierarchy with a "Parts Group" concept.
A group is a named collection of parts. The first part selected in a group
presents Buy New or Paint Mine; subsequent parts in the same group only
offer Paint (since the part was already purchased in a previous selection).

## 1. New Table: part_groups
- id (uuid PK)
- vehicle_id (uuid FK → vehicles, cascade delete)
- name (text, not null) — e.g. "Front Bumper Group"
- sort_order (int, default 0)
- created_at (timestamptz)

## 2. Modified Tables
- vehicle_parts: add group_id (uuid, nullable FK → part_groups, SET NULL on delete)

## 3. Security
- RLS enabled on part_groups.
- Shop users: ownership via get_current_shop_id() matching vehicle's shop_id.
- Admin: full access via get_current_role() = 'admin'.
- Anon: read access for published vehicles (customer-facing).
*/

CREATE TABLE IF NOT EXISTS part_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE part_groups ENABLE ROW LEVEL SECURITY;

-- Shop user policies (via get_current_shop_id)
DROP POLICY IF EXISTS "shop_user_select_own_part_groups" ON part_groups;
CREATE POLICY "shop_user_select_own_part_groups" ON part_groups FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id = part_groups.vehicle_id AND v.shop_id = get_current_shop_id())
  );

DROP POLICY IF EXISTS "shop_user_insert_own_part_groups" ON part_groups;
CREATE POLICY "shop_user_insert_own_part_groups" ON part_groups FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id = part_groups.vehicle_id AND v.shop_id = get_current_shop_id())
  );

DROP POLICY IF EXISTS "shop_user_update_own_part_groups" ON part_groups;
CREATE POLICY "shop_user_update_own_part_groups" ON part_groups FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id = part_groups.vehicle_id AND v.shop_id = get_current_shop_id())
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id = part_groups.vehicle_id AND v.shop_id = get_current_shop_id())
  );

DROP POLICY IF EXISTS "shop_user_delete_own_part_groups" ON part_groups;
CREATE POLICY "shop_user_delete_own_part_groups" ON part_groups FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id = part_groups.vehicle_id AND v.shop_id = get_current_shop_id())
  );

-- Admin policies
DROP POLICY IF EXISTS "admin_select_part_groups" ON part_groups;
CREATE POLICY "admin_select_part_groups" ON part_groups FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_part_groups" ON part_groups;
CREATE POLICY "admin_insert_part_groups" ON part_groups FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_part_groups" ON part_groups;
CREATE POLICY "admin_update_part_groups" ON part_groups FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_part_groups" ON part_groups;
CREATE POLICY "admin_delete_part_groups" ON part_groups FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Anon read for published vehicles (customer-facing)
DROP POLICY IF EXISTS "anon_read_published_part_groups" ON part_groups;
CREATE POLICY "anon_read_published_part_groups" ON part_groups FOR SELECT
  TO anon, authenticated USING (
    EXISTS (SELECT 1 FROM vehicles v WHERE v.id = part_groups.vehicle_id AND v.status = 'published')
  );

-- Add group_id to vehicle_parts
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vehicle_parts' AND column_name = 'group_id'
  ) THEN
    ALTER TABLE vehicle_parts ADD COLUMN group_id uuid REFERENCES part_groups(id) ON DELETE SET NULL;
  END IF;
END $$;