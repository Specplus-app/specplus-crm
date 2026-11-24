/*
# Bind customer photos to the request that uploaded them

Follows 20261124120000_customer_data_privacy.sql. That migration let a quote or
build-sheet token reveal any customer-upload path the record referenced inside
its shop's folder. Lead photo fields are written by anonymous customers, so a
customer who knew another customer's path (every path was listable before
phase 1) could reference it in their own request and see it through their own
quote link. A matching shop folder is not proof of ownership.

1. New uploads are bound to one request
   - The custom-build flow generates a random 64-hex `upload key` per request and
     uploads to `<shop id>/<upload ref>/<uuid>.<ext>`, where
     upload ref = first 32 hex chars of sha256(upload key).
   - The request is inserted with `upload_key`. A BEFORE trigger stores only
     `upload_ref` (the hash) on the lead and discards the key. It is never
     stored, logged or readable. `upload_ref` cannot be set or changed by
     callers.
   - Knowing a path reveals the ref but not the key, so another request cannot
     claim it.

2. Existing (legacy) photos: `<shop id>/<uuid>.<ext>`
   - Legacy photos are STAFF-ONLY. There is no automatic matching by upload
     time or by how many requests reference a photo: while every path was
     listable, those signals could be arranged by someone else, so they are
     not proof that a photo belongs to a request.
   - The shop's staff (and admins) still see every legacy photo through the
     shop-folder Storage policy.
   - When needed, a staff member can explicitly share one legacy photo with
     one request's customer, after confirming with that customer that the
     photo is theirs: share_legacy_customer_photo(lead, path). This is audited
     (who, when) in legacy_customer_photo_shares and can be undone with
     unshare_legacy_customer_photo(). lead_legacy_photos(lead) lists a lead's
     legacy photos, their share state, and how many other requests reference
     each one.

3. customer_photo_paths(kind, token) now returns a referenced path only if it
   belongs to the quote's or build sheet's own lead: a keyed path whose ref
   matches the lead's upload_ref, or a legacy path a staff member explicitly
   shared with that lead.

4. Anonymous uploads accept the keyed layout. The legacy two-level layout is
   still accepted so the currently deployed frontend keeps working during
   rollout. Such uploads are staff-only (they can be shared explicitly like any
   legacy photo). Remove the legacy layout once the new frontend is live
   everywhere (see the rollout doc).
*/

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Request-bound upload refs on leads
-- ---------------------------------------------------------------------------
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS upload_key text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS upload_ref text;

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_upload_ref_format;
ALTER TABLE public.leads ADD CONSTRAINT leads_upload_ref_format
  CHECK (upload_ref IS NULL OR upload_ref ~ '^[0-9a-f]{32}$');
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_upload_key_never_stored;
ALTER TABLE public.leads ADD CONSTRAINT leads_upload_key_never_stored
  CHECK (upload_key IS NULL);

CREATE OR REPLACE FUNCTION public.customer_upload_ref(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_key ~ '^[0-9a-f]{64}$' THEN left(encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), 32)
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.leads_bind_upload_ref()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.upload_ref := public.customer_upload_ref(NEW.upload_key);
  ELSE
    NEW.upload_ref := OLD.upload_ref;
  END IF;
  NEW.upload_key := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.leads_bind_upload_ref() FROM PUBLIC, anon, authenticated;

-- Named to sort before the other BEFORE INSERT triggers, so the key is gone
-- before anything else sees the row.
DROP TRIGGER IF EXISTS leads_aa_bind_upload_ref ON public.leads;
CREATE TRIGGER leads_aa_bind_upload_ref
BEFORE INSERT OR UPDATE ON public.leads
FOR EACH ROW EXECUTE FUNCTION public.leads_bind_upload_ref();

-- ---------------------------------------------------------------------------
-- 2. Path helpers: accept the keyed three-level layout
-- ---------------------------------------------------------------------------
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
    WHEN p_ref ~ '^[^/]+/[^/]+(/[^/]+)?$' THEN p_ref
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.customer_upload_path_allowed(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
      -- keyed: <shop>/<upload ref>/<uuid>.<ext>
      p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$'
      -- legacy (rollout window only; staff-only unless explicitly shared)
      OR p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$'
    )
    AND EXISTS (SELECT 1 FROM public.shops s WHERE s.id::text = split_part(p_name, '/', 1));
$$;

-- ---------------------------------------------------------------------------
-- 3. Legacy photos: staff-only unless a staff member explicitly shares one
-- ---------------------------------------------------------------------------
-- There is no automatic matching. Timestamps and "only one request references
-- it" are inferences an attacker could have arranged while every path was
-- listable, so they are not proof of ownership.
CREATE TABLE IF NOT EXISTS public.legacy_customer_photo_shares (
  lead_id     uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  object_path text NOT NULL,
  shared_by   uuid NOT NULL,
  shared_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, object_path)
);
CREATE INDEX IF NOT EXISTS legacy_customer_photo_shares_path_idx
  ON public.legacy_customer_photo_shares (object_path);

ALTER TABLE public.legacy_customer_photo_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.legacy_customer_photo_shares FROM PUBLIC, anon, authenticated;
-- Staff may see the shares on their own shop's leads (audit). Writes go
-- through the functions below only.
GRANT SELECT ON TABLE public.legacy_customer_photo_shares TO authenticated;

DROP POLICY IF EXISTS "staff_select_legacy_photo_shares" ON public.legacy_customer_photo_shares;
CREATE POLICY "staff_select_legacy_photo_shares"
ON public.legacy_customer_photo_shares FOR SELECT
TO authenticated
USING (
  public.get_current_role() = 'admin'
  OR EXISTS (
    SELECT 1 FROM public.leads l
    WHERE l.id = legacy_customer_photo_shares.lead_id
      AND public.get_current_role() = 'shop_user'
      AND l.shop_id = public.get_current_shop_id()
  )
);

-- Legacy (two-level) customer-upload paths one lead references, in its shop.
CREATE OR REPLACE FUNCTION public.lead_legacy_photo_paths(p_lead_id uuid)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT refs.p
  FROM public.leads l
  CROSS JOIN LATERAL (
    SELECT public.customer_upload_object_path(l.front_image_url) AS p
    UNION ALL SELECT public.customer_upload_object_path(l.rear_image_url)
    UNION ALL
    SELECT public.customer_upload_object_path(e ->> 'reference_image_path')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.selected_parts) = 'array' THEN l.selected_parts ELSE '[]'::jsonb END) e
  ) refs
  WHERE l.id = p_lead_id
    AND refs.p IS NOT NULL
    AND refs.p ~ '^[^/]+/[^/]+$'
    AND split_part(refs.p, '/', 1) = l.shop_id::text;
$$;

REVOKE ALL ON FUNCTION public.lead_legacy_photo_paths(uuid) FROM PUBLIC, anon, authenticated;

-- Staff of the lead's shop (or an admin): the caller's role for that lead, or NULL.
CREATE OR REPLACE FUNCTION public.legacy_photo_staff_for_lead(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.leads l ON l.id = p_lead_id
    WHERE p.id = auth.uid()
      AND (p.role = 'admin' OR (p.role = 'shop_user' AND p.shop_id = l.shop_id))
  );
$$;

REVOKE ALL ON FUNCTION public.legacy_photo_staff_for_lead(uuid) FROM PUBLIC, anon, authenticated;

-- For the lead page: each legacy photo on this lead, whether it is shared
-- with the customer, and how many OTHER requests also reference it (a warning
-- sign that the photo may not belong to this customer).
CREATE OR REPLACE FUNCTION public.lead_legacy_photos(p_lead_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.legacy_photo_staff_for_lead(p_lead_id) THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'path', p.path,
      'shared', s.lead_id IS NOT NULL,
      'shared_at', s.shared_at,
      'other_requests', (
        SELECT count(*) FROM public.leads o
        WHERE o.id <> p_lead_id
          AND o.shop_id = (SELECT shop_id FROM public.leads WHERE id = p_lead_id)
          AND p.path IN (SELECT public.lead_legacy_photo_paths(o.id))
      )
    ) ORDER BY p.path)
    FROM public.lead_legacy_photo_paths(p_lead_id) AS p(path)
    LEFT JOIN public.legacy_customer_photo_shares s
      ON s.lead_id = p_lead_id AND s.object_path = p.path
  ), '[]'::jsonb);
END;
$$;

-- Explicit, audited re-share of one legacy photo with this lead's customer.
-- Staff should do this only after confirming with the customer that the
-- photo is theirs (see docs/customer-data-privacy-rollout.md).
CREATE OR REPLACE FUNCTION public.share_legacy_customer_photo(p_lead_id uuid, p_path text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.legacy_photo_staff_for_lead(p_lead_id) THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_path IS NULL OR p_path NOT IN (SELECT public.lead_legacy_photo_paths(p_lead_id)) THEN
    RAISE EXCEPTION 'That photo is not a legacy photo on this request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'customer-uploads' AND o.name = p_path) THEN
    RAISE EXCEPTION 'Photo not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.legacy_customer_photo_shares (lead_id, object_path, shared_by)
  VALUES (p_lead_id, p_path, auth.uid())
  ON CONFLICT (lead_id, object_path) DO UPDATE SET shared_by = EXCLUDED.shared_by, shared_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.unshare_legacy_customer_photo(p_lead_id uuid, p_path text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.legacy_photo_staff_for_lead(p_lead_id) THEN
    RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM public.legacy_customer_photo_shares WHERE lead_id = p_lead_id AND object_path = p_path;
END;
$$;

REVOKE ALL ON FUNCTION public.lead_legacy_photos(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.share_legacy_customer_photo(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unshare_legacy_customer_photo(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lead_legacy_photos(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.share_legacy_customer_photo(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unshare_legacy_customer_photo(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Customer photo authorization: the record's own request only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_photo_paths(p_kind text, p_token text)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_id    uuid;
  v_shop_id    uuid;
  v_upload_ref text;
  v_front      text;
  v_rear       text;
  v_parts      jsonb;
  v_paths      text[];
BEGIN
  IF p_kind = 'quote' THEN
    IF p_token IS NULL OR p_token !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN ARRAY[]::text[];
    END IF;
    SELECT q.lead_id, q.shop_id, q.front_image_url, q.rear_image_url, q.selected_parts
      INTO v_lead_id, v_shop_id, v_front, v_rear, v_parts
    FROM public.quotes q
    WHERE q.public_token = p_token::uuid AND q.status <> 'draft';
  ELSIF p_kind = 'build_sheet' THEN
    IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
      RETURN ARRAY[]::text[];
    END IF;
    SELECT b.lead_id, b.shop_id, b.front_image_url, b.rear_image_url, b.selected_parts
      INTO v_lead_id, v_shop_id, v_front, v_rear, v_parts
    FROM public.build_sheets b
    WHERE b.share_token = p_token;
  ELSE
    RETURN ARRAY[]::text[];
  END IF;

  IF v_shop_id IS NULL OR v_lead_id IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;

  -- The lead must belong to the same shop as the record.
  SELECT l.upload_ref INTO v_upload_ref
  FROM public.leads l
  WHERE l.id = v_lead_id AND l.shop_id = v_shop_id;
  IF NOT FOUND THEN
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
  WHERE p IS NOT NULL
    AND split_part(p, '/', 1) = v_shop_id::text
    AND (
      -- uploaded under this request's key
      (v_upload_ref IS NOT NULL AND p ~ '^[^/]+/[0-9a-f]{32}/[^/]+$' AND split_part(p, '/', 2) = v_upload_ref)
      -- legacy photo a staff member explicitly shared with this request
      OR EXISTS (
        SELECT 1 FROM public.legacy_customer_photo_shares sh
        WHERE sh.lead_id = v_lead_id AND sh.object_path = p
      )
    );

  RETURN v_paths;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_photo_paths(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_photo_paths(text, text) TO service_role;

COMMIT;
