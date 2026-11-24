/*
# Launch access controls

1. Vehicle template cloning is admin-only.
   - clone_vehicle_template now explicitly rejects a caller with no signed-in
     identity (auth.uid() IS NULL), no profile/role, or any role other than
     'admin'. The previous check (`get_current_role() <> 'admin'`) evaluated to
     NULL for a missing role, which let the call through.
   - EXECUTE is removed from PUBLIC (the inherited grant every role, including
     anon, receives) and from anon directly. The repository only revoked PUBLIC,
     while the hosted project also carried a direct anon grant from Supabase's
     default function privileges; revoking both closes the gap on either
     baseline. EXECUTE stays granted to authenticated for the admin workflow.
   - The cloning body and every copied field (including alt_view_svg_path and
     external_url) are unchanged from 20261001023000_add_cross_view_part_shapes.

2. Shop subscription settings are protected in the database.
   - A BEFORE UPDATE trigger on shops rejects changes to subscription_status,
     subscription_tier, trial_ends_at or is_lifetime_free when the request comes
     from an API end user (anon/authenticated) who is not an admin. Updates that
     leave those columns unchanged (normal shop settings edits) are unaffected.
   - Admins keep full subscription management. Trusted server-side contexts
     (service_role, the database owner, migrations) are not restricted.
*/

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. clone_vehicle_template: admin-only
-- ---------------------------------------------------------------------------
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
  v_caller_id      uuid := auth.uid();
  v_caller_role    text;
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
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Only admins can push vehicle templates'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_caller_role FROM profiles WHERE id = v_caller_id;

  IF v_caller_role IS NULL OR v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can push vehicle templates'
      USING ERRCODE = '42501';
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

-- Remove both the inherited (PUBLIC) and any direct anon grant, then grant
-- only the signed-in API role. The function body enforces admin.
REVOKE ALL ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.clone_vehicle_template(uuid, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. shops: subscription fields are admin-managed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_shop_subscription_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Only API end-user requests are restricted. service_role, the database
  -- owner and migrations run as other roles and pass through.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.subscription_status IS NOT DISTINCT FROM OLD.subscription_status
     AND NEW.subscription_tier IS NOT DISTINCT FROM OLD.subscription_tier
     AND NEW.trial_ends_at IS NOT DISTINCT FROM OLD.trial_ends_at
     AND NEW.is_lifetime_free IS NOT DISTINCT FROM OLD.is_lifetime_free THEN
    RETURN NEW;
  END IF;

  -- get_current_role() is the same SECURITY DEFINER helper the shops RLS
  -- policies use, so this does not depend on profiles RLS.
  IF auth.uid() IS NOT NULL AND get_current_role() IS NOT DISTINCT FROM 'admin' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only admins can change shop subscription settings'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.protect_shop_subscription_fields() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_shop_subscription_fields() FROM anon, authenticated;

DROP TRIGGER IF EXISTS shops_protect_subscription_fields ON public.shops;
CREATE TRIGGER shops_protect_subscription_fields
BEFORE UPDATE ON public.shops
FOR EACH ROW
EXECUTE FUNCTION public.protect_shop_subscription_fields();

COMMIT;
