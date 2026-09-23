/*
# Vehicle Templates — Admin-authored template vehicles + push-to-shops cloning

## Overview
Adds the ability for the SpecPlus admin to build reusable "template" vehicles
(photos, traced parts, merges, and part groupings) that belong to no single shop,
then push a copy of a template into one or more shops. Each shop receives its own
editable vehicle with the structure intact and all pricing fields reset to zero,
so the shop only has to fill in costs, lead times, and option/paint prices.

## 1. Modified table: vehicles
- New column `is_template` (boolean, NOT NULL, default false) — true for admin-authored templates.
- New column `template_source_id` (uuid, nullable, FK -> vehicles.id ON DELETE SET NULL)
  — on a shop's copy, points back to the template it was cloned from (used to avoid
  pushing the same template to the same shop twice).
- `shop_id` is made nullable so template rows (which belong to no shop) can exist.
  Existing shop vehicles keep their shop_id; nothing is deleted or changed.
- New indexes on `is_template` and `template_source_id`.

## 2. New function: clone_vehicle_template(p_template_id uuid, p_shop_ids uuid[])
- SECURITY DEFINER. Guarded so ONLY users whose profile role is 'admin' may run it.
- For each target shop:
  1. Skips the shop if it already has a vehicle cloned from this template.
  2. Inserts a new draft vehicle for the shop (copying name/year/make/model and the
     template image paths).
  3. Copies the template's part groups (new ids), then its parts (remapping each
     part's group to the new group), then each part's paint styles and options.
  4. Resets all pricing on the copy: part_cost = 0, paint_price = 0, lead_time_days = 7,
     paint style price = 0, option price = 0.
- Returns JSON { created: [{shop_id, vehicle_id}...], skipped: [shop_id...] }.

## 3. Security
- No new RLS policies are required: admins already have full CRUD on vehicles,
  vehicle_parts, part_groups, part_paint_styles and part_options via the existing
  get_current_role() = 'admin' policies, so an admin can build template rows.
- Shop-scoped SELECT policies compare shop_id = get_current_shop_id(); template rows
  have a NULL shop_id, so shops never see templates directly — they only receive copies.
- EXECUTE on clone_vehicle_template is granted to authenticated; the function itself
  rejects any caller that is not an admin.
*/

-- 1. Columns ------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vehicles' AND column_name = 'is_template'
  ) THEN
    ALTER TABLE vehicles ADD COLUMN is_template boolean NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vehicles' AND column_name = 'template_source_id'
  ) THEN
    ALTER TABLE vehicles ADD COLUMN template_source_id uuid REFERENCES vehicles(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE vehicles ALTER COLUMN shop_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicles_is_template ON vehicles(is_template);
CREATE INDEX IF NOT EXISTS idx_vehicles_template_source ON vehicles(template_source_id);

-- 2. Clone function -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clone_vehicle_template(p_template_id uuid, p_shop_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template   vehicles%ROWTYPE;
  v_shop_id    uuid;
  v_new_vehicle_id uuid;
  v_new_group_id   uuid;
  v_new_part_id    uuid;
  v_group      RECORD;
  v_part       RECORD;
  v_group_map  jsonb;
  v_created    jsonb := '[]'::jsonb;
  v_skipped    jsonb := '[]'::jsonb;
BEGIN
  IF get_current_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can push vehicle templates';
  END IF;

  SELECT * INTO v_template FROM vehicles WHERE id = p_template_id AND is_template = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found';
  END IF;

  FOREACH v_shop_id IN ARRAY p_shop_ids LOOP
    IF EXISTS (
      SELECT 1 FROM vehicles WHERE shop_id = v_shop_id AND template_source_id = p_template_id
    ) THEN
      v_skipped := v_skipped || to_jsonb(v_shop_id);
      CONTINUE;
    END IF;

    v_new_vehicle_id := gen_random_uuid();
    INSERT INTO vehicles (
      id, shop_id, name, year, make, model, status,
      front_image_path, rear_image_path, is_template, template_source_id
    ) VALUES (
      v_new_vehicle_id, v_shop_id, v_template.name, v_template.year, v_template.make,
      v_template.model, 'draft', v_template.front_image_path, v_template.rear_image_path,
      false, p_template_id
    );

    -- Copy groups, keeping an old-id -> new-id map
    v_group_map := '{}'::jsonb;
    FOR v_group IN SELECT * FROM part_groups WHERE vehicle_id = p_template_id LOOP
      v_new_group_id := gen_random_uuid();
      INSERT INTO part_groups (id, vehicle_id, name, sort_order)
      VALUES (v_new_group_id, v_new_vehicle_id, v_group.name, v_group.sort_order);
      v_group_map := v_group_map || jsonb_build_object(v_group.id::text, v_new_group_id::text);
    END LOOP;

    -- Copy parts (remapping group_id), then their styles and options
    FOR v_part IN SELECT * FROM vehicle_parts WHERE vehicle_id = p_template_id LOOP
      v_new_part_id := gen_random_uuid();
      INSERT INTO vehicle_parts (
        id, vehicle_id, name, view, svg_path, part_cost, paint_price,
        allow_send_parts, lead_time_days, sort_order, group_id, highlight_color, ship_size
      ) VALUES (
        v_new_part_id, v_new_vehicle_id, v_part.name, v_part.view, v_part.svg_path,
        0, 0, v_part.allow_send_parts, 7, v_part.sort_order,
        CASE WHEN v_part.group_id IS NULL THEN NULL
             ELSE (v_group_map ->> v_part.group_id::text)::uuid END,
        v_part.highlight_color, v_part.ship_size
      );

      INSERT INTO part_paint_styles (part_id, name, image_path, price, sort_order)
      SELECT v_new_part_id, name, image_path, 0, sort_order
      FROM part_paint_styles WHERE part_id = v_part.id;

      INSERT INTO part_options (part_id, name, description, price, sort_order)
      SELECT v_new_part_id, name, description, 0, sort_order
      FROM part_options WHERE part_id = v_part.id;
    END LOOP;

    v_created := v_created || jsonb_build_object('shop_id', v_shop_id, 'vehicle_id', v_new_vehicle_id);
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) TO authenticated;
