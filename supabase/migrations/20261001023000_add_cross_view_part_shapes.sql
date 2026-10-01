/*
# Cross-view part shapes

Adds a second optional SVG outline to vehicle parts so one logical part can
have a traced shape on both the front and rear vehicle views. Also updates
template cloning so both view shapes and external URLs survive a push to a shop.
*/

BEGIN;

ALTER TABLE public.vehicle_parts
ADD COLUMN IF NOT EXISTS alt_view_svg_path text;

CREATE OR REPLACE FUNCTION public.clone_vehicle_template(
  p_template_id uuid,
  p_shop_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template       vehicles%ROWTYPE;
  v_shop_id        uuid;
  v_new_vehicle_id uuid;
  v_new_group_id   uuid;
  v_new_part_id    uuid;
  v_group          RECORD;
  v_part           RECORD;
  v_group_map      jsonb;
  v_created        jsonb := '[]'::jsonb;
  v_skipped        jsonb := '[]'::jsonb;
BEGIN
  IF get_current_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can push vehicle templates';
  END IF;

  SELECT *
  INTO v_template
  FROM vehicles
  WHERE id = p_template_id
    AND is_template = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template not found';
  END IF;

  FOREACH v_shop_id IN ARRAY p_shop_ids LOOP
    IF EXISTS (
      SELECT 1
      FROM vehicles
      WHERE shop_id = v_shop_id
        AND template_source_id = p_template_id
    ) THEN
      v_skipped := v_skipped || to_jsonb(v_shop_id);
      CONTINUE;
    END IF;

    v_new_vehicle_id := gen_random_uuid();

    INSERT INTO vehicles (
      id, shop_id, name, year, make, model, status,
      front_image_path, rear_image_path, is_template, template_source_id
    )
    VALUES (
      v_new_vehicle_id, v_shop_id, v_template.name, v_template.year,
      v_template.make, v_template.model, 'draft', v_template.front_image_path,
      v_template.rear_image_path, false, p_template_id
    );

    v_group_map := '{}'::jsonb;

    FOR v_group IN
      SELECT * FROM part_groups WHERE vehicle_id = p_template_id
    LOOP
      v_new_group_id := gen_random_uuid();
      INSERT INTO part_groups (id, vehicle_id, name, sort_order)
      VALUES (v_new_group_id, v_new_vehicle_id, v_group.name, v_group.sort_order);
      v_group_map := v_group_map || jsonb_build_object(v_group.id::text, v_new_group_id::text);
    END LOOP;

    FOR v_part IN
      SELECT * FROM vehicle_parts WHERE vehicle_id = p_template_id
    LOOP
      v_new_part_id := gen_random_uuid();

      INSERT INTO vehicle_parts (
        id, vehicle_id, name, view, svg_path, alt_view_svg_path,
        part_cost, paint_price, allow_send_parts, lead_time_days,
        sort_order, group_id, highlight_color, ship_size, external_url
      )
      VALUES (
        v_new_part_id, v_new_vehicle_id, v_part.name, v_part.view,
        v_part.svg_path, v_part.alt_view_svg_path, 0, 0,
        v_part.allow_send_parts, 7, v_part.sort_order,
        CASE
WHEN v_part.group_id IS NULL THEN NULL
ELSE (v_group_map ->> v_part.group_id::text)::uuid
        END,
        v_part.highlight_color, v_part.ship_size, v_part.external_url
      );

      INSERT INTO part_paint_styles (part_id, name, image_path, price, sort_order)
      SELECT v_new_part_id, name, image_path, 0, sort_order
      FROM part_paint_styles
      WHERE part_id = v_part.id;

      INSERT INTO part_options (part_id, name, description, price, sort_order)
      SELECT v_new_part_id, name, description, 0, sort_order
      FROM part_options
      WHERE part_id = v_part.id;
    END LOOP;

    v_created := v_created || jsonb_build_object(
      'shop_id', v_shop_id,
      'vehicle_id', v_new_vehicle_id
    );
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END;
$$;

REVOKE ALL ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) TO authenticated;

COMMIT;
