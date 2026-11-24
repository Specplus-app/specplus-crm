/*
# Customer data privacy, phase 1: build-sheet share links and scoped photo access

Safe to apply while the current frontend is live. It does NOT make the
customer-uploads bucket private; that is phase 2
(supabase/rollout/20261124130000_make_customer_uploads_private.sql, staged
   outside migrations/), applied only after the new
frontend and the customer-photos Edge Function are deployed.

1. Build sheets
   - Removes the broad public SELECT policy and the anon table grant. Anyone
     holding the anon key could previously list every build sheet (customer
     names, emails, totals, photo URLs) through the REST API.
   - Staff read: admins, or users whose profile shop matches the sheet's shop.
   - Adds `share_token` (NULL = not shared). Customers open a shared sheet at
     /build/<share_token> through get_shared_build_sheet(), which returns only
     the customer-facing fields (no ids, lead/shop ids or customer email).
   - Tokens are minted/rotated/revoked only through
     create_build_sheet_share_link() / revoke_build_sheet_share_link(); a
     trigger refuses direct writes to share_token.
   - Existing sheets start unshared. Every existing sheet id was listable by
     anon, so a /build/<id> link cannot be told apart from an id harvested from
     the open table. Old links are retired; shops issue new share links.

2. Customer uploads (storage bucket `customer-uploads`)
   - Drops the policy that let anon and authenticated callers read and list
     every object in the bucket.
   - Staff may read (and therefore sign URLs for) objects in their own shop's
     folder; admins may read all.
   - Anonymous uploads stay allowed, but only as
     `<existing shop id>/<uuid>.<jpg|jpeg|png|webp|heic|heif>`.
   - The bucket enforces a 10 MB size limit and image MIME types server-side.
   - customer_photo_paths() (service_role only) returns the customer-upload
     paths attached to a non-draft quote or a shared build sheet, for the
     customer-photos Edge Function to sign.

The `vehicles` and `shop-logos` buckets are not changed and remain public.
*/

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Build sheets
-- ---------------------------------------------------------------------------
ALTER TABLE public.build_sheets ADD COLUMN IF NOT EXISTS share_token text;
ALTER TABLE public.build_sheets ADD COLUMN IF NOT EXISTS shared_at timestamptz;

-- Retire every pre-existing link (see header). Idempotent.
UPDATE public.build_sheets SET share_token = NULL, shared_at = NULL WHERE share_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS build_sheets_share_token_key
  ON public.build_sheets (share_token) WHERE share_token IS NOT NULL;

ALTER TABLE public.build_sheets DROP CONSTRAINT IF EXISTS build_sheets_share_token_format;
ALTER TABLE public.build_sheets ADD CONSTRAINT build_sheets_share_token_format
  CHECK (share_token IS NULL OR share_token ~ '^[0-9a-f]{64}$');

DROP POLICY IF EXISTS "public_select_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "admin_select_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "shop_user_select_build_sheets" ON public.build_sheets;

CREATE POLICY "admin_select_build_sheets"
ON public.build_sheets FOR SELECT
TO authenticated
USING (public.get_current_role() = 'admin');

CREATE POLICY "shop_user_select_build_sheets"
ON public.build_sheets FOR SELECT
TO authenticated
USING (shop_id IS NOT NULL AND shop_id = public.get_current_shop_id());

REVOKE ALL PRIVILEGES ON TABLE public.build_sheets FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.build_sheets FROM PUBLIC;

-- share_token may only change inside the share-link functions below.
CREATE OR REPLACE FUNCTION public.build_sheets_guard_share_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('specplus.build_sheet_share', true) IS NOT DISTINCT FROM 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.share_token IS NOT NULL OR NEW.shared_at IS NOT NULL THEN
      RAISE EXCEPTION 'Use create_build_sheet_share_link to share a build sheet' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.share_token IS DISTINCT FROM OLD.share_token OR NEW.shared_at IS DISTINCT FROM OLD.shared_at THEN
    RAISE EXCEPTION 'Use create_build_sheet_share_link to share a build sheet' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.build_sheets_guard_share_token() FROM PUBLIC;

DROP TRIGGER IF EXISTS build_sheets_guard_share_token ON public.build_sheets;
CREATE TRIGGER build_sheets_guard_share_token
BEFORE INSERT OR UPDATE ON public.build_sheets
FOR EACH ROW EXECUTE FUNCTION public.build_sheets_guard_share_token();

-- Staff authorization shared by the share-link functions.
CREATE OR REPLACE FUNCTION public.build_sheet_staff_can_manage(p_sheet_shop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND (
        p.role = 'admin'
        OR (p.role = 'shop_user' AND p_sheet_shop_id IS NOT NULL AND p.shop_id = p_sheet_shop_id)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.build_sheet_staff_can_manage(uuid) FROM PUBLIC, anon, authenticated;

-- Mints a new share token (rotating any previous one) and returns it.
CREATE OR REPLACE FUNCTION public.create_build_sheet_share_link(p_sheet_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop_id uuid;
  v_token   text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT shop_id INTO v_shop_id FROM public.build_sheets WHERE id = p_sheet_id;
  IF NOT FOUND OR NOT public.build_sheet_staff_can_manage(v_shop_id) THEN
    RAISE EXCEPTION 'Build sheet not found' USING ERRCODE = 'P0002';
  END IF;

  -- 2 x 122 random bits from gen_random_uuid(), hex only.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  PERFORM set_config('specplus.build_sheet_share', 'on', true);
  UPDATE public.build_sheets SET share_token = v_token, shared_at = now(), updated_at = now() WHERE id = p_sheet_id;
  PERFORM set_config('specplus.build_sheet_share', 'off', true);

  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_build_sheet_share_link(p_sheet_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT shop_id INTO v_shop_id FROM public.build_sheets WHERE id = p_sheet_id;
  IF NOT FOUND OR NOT public.build_sheet_staff_can_manage(v_shop_id) THEN
    RAISE EXCEPTION 'Build sheet not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('specplus.build_sheet_share', 'on', true);
  UPDATE public.build_sheets SET share_token = NULL, shared_at = NULL, updated_at = now() WHERE id = p_sheet_id;
  PERFORM set_config('specplus.build_sheet_share', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.create_build_sheet_share_link(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_build_sheet_share_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_build_sheet_share_link(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_build_sheet_share_link(uuid) TO authenticated;

-- Customer view of one shared sheet: customer-facing fields only.
CREATE OR REPLACE FUNCTION public.get_shared_build_sheet(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'shop_name', b.shop_name,
    'shop_logo_url', b.shop_logo_url,
    'customer_name', b.customer_name,
    'vehicle_name', b.vehicle_name,
    'vehicle_year', b.vehicle_year,
    'vehicle_make', b.vehicle_make,
    'vehicle_model', b.vehicle_model,
    'vehicle_trim', b.vehicle_trim,
    'paint_code', b.paint_code,
    'fulfillment_mode', b.fulfillment_mode,
    'is_custom', b.is_custom,
    'front_image_url', b.front_image_url,
    'rear_image_url', b.rear_image_url,
    'selected_parts', b.selected_parts,
    'parts_total', b.parts_total,
    'shipping_total', b.shipping_total,
    'grand_total', b.grand_total,
    'estimated_lead_time_days', b.estimated_lead_time_days,
    'created_at', b.created_at
  )
  INTO v_result
  FROM public.build_sheets b
  WHERE b.share_token = p_token;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_shared_build_sheet(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_build_sheet(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Customer uploads
-- ---------------------------------------------------------------------------

-- Server-enforced limits (checked by the Storage API on every upload).
UPDATE storage.buckets
SET file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
WHERE id = 'customer-uploads';

-- No more broad read/list for anon or authenticated callers.
DROP POLICY IF EXISTS "customer_uploads_read" ON storage.objects;

DROP POLICY IF EXISTS "customer_uploads_staff_read" ON storage.objects;
CREATE POLICY "customer_uploads_staff_read"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'customer-uploads'
  AND (
    public.get_current_role() = 'admin'
    OR (
      public.get_current_role() = 'shop_user'
      AND (storage.foldername(name))[1] = public.get_current_shop_id()::text
    )
  )
);

-- Controlled anonymous upload: one shop folder, a random file name, an image
-- extension. Size and MIME type are enforced by the bucket settings above.
CREATE OR REPLACE FUNCTION public.customer_upload_path_allowed(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$'
    AND EXISTS (SELECT 1 FROM public.shops s WHERE s.id::text = split_part(p_name, '/', 1));
$$;

REVOKE ALL ON FUNCTION public.customer_upload_path_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_upload_path_allowed(text) TO anon, authenticated;

DROP POLICY IF EXISTS "customer_uploads_insert" ON storage.objects;
CREATE POLICY "customer_uploads_insert"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (
  bucket_id = 'customer-uploads'
  AND public.customer_upload_path_allowed(name)
);

DROP POLICY IF EXISTS "customer_uploads_update" ON storage.objects;
DROP POLICY IF EXISTS "customer_uploads_delete" ON storage.objects;

-- Normalizes a stored photo reference (bare path, or a public/signed URL of
-- the customer-uploads bucket) to an object path; NULL for anything else,
-- such as public vehicle template images.
CREATE OR REPLACE FUNCTION public.customer_upload_object_path(p_ref text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_ref IS NULL OR p_ref = '' THEN NULL
    WHEN p_ref ~ '^https?://' THEN
      nullif(split_part(substring(p_ref FROM '/storage/v1/object/(?:public|sign|authenticated)/customer-uploads/(.*)$'), '?', 1), '')
    WHEN p_ref ~ '^[^/]+/[^/]+$' THEN p_ref
    ELSE NULL
  END;
$$;

-- Paths a customer may see for one token. Only the record's own shop folder
-- is returned, so a lead that references another shop's file gets nothing.
CREATE OR REPLACE FUNCTION public.customer_photo_paths(p_kind text, p_token text)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shop_id uuid;
  v_front   text;
  v_rear    text;
  v_parts   jsonb;
  v_paths   text[];
BEGIN
  IF p_kind = 'quote' THEN
    IF p_token IS NULL OR p_token !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN ARRAY[]::text[];
    END IF;
    SELECT q.shop_id, q.front_image_url, q.rear_image_url, q.selected_parts
      INTO v_shop_id, v_front, v_rear, v_parts
    FROM public.quotes q
    WHERE q.public_token = p_token::uuid AND q.status <> 'draft';
  ELSIF p_kind = 'build_sheet' THEN
    IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
      RETURN ARRAY[]::text[];
    END IF;
    SELECT b.shop_id, b.front_image_url, b.rear_image_url, b.selected_parts
      INTO v_shop_id, v_front, v_rear, v_parts
    FROM public.build_sheets b
    WHERE b.share_token = p_token;
  ELSE
    RETURN ARRAY[]::text[];
  END IF;

  IF v_shop_id IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;

  SELECT coalesce(array_agg(DISTINCT p), ARRAY[]::text[])
  INTO v_paths
  FROM (
    SELECT public.customer_upload_object_path(v_front) AS p
    UNION ALL SELECT public.customer_upload_object_path(v_rear)
    UNION ALL
    SELECT public.customer_upload_object_path(e ->> 'reference_image_path')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_parts) = 'array' THEN v_parts ELSE '[]'::jsonb END) e
  ) refs
  WHERE p IS NOT NULL AND split_part(p, '/', 1) = v_shop_id::text;

  RETURN v_paths;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_photo_paths(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_photo_paths(text, text) TO service_role;

COMMIT;
