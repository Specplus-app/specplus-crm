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
   - legacy_customer_photo_claims records which lead owns a legacy path. It is
     filled by backfill_legacy_customer_photo_claims() under conservative rules:
     the path is in the lead's shop folder, exactly ONE lead references it, and
     the object was uploaded within 24 hours before that lead was submitted.
   - Ambiguous or unmatched legacy photos are not shown to customers. They stay
     visible to staff through the shop-folder Storage policy (staff-only
     fallback).
   - The backfill runs here and is safe to re-run after the new frontend is
     live, to pick up requests submitted by the old frontend in between
     (service_role only). A path that became ambiguous loses its claim.

3. customer_photo_paths(kind, token) now returns a referenced path only if it
   belongs to the quote's or build sheet's own lead: a keyed path whose ref
   matches the lead's upload_ref, or a legacy path claimed by that lead.

4. Anonymous uploads accept the keyed layout. The legacy two-level layout is
   still accepted so the currently deployed frontend keeps working during
   rollout. Such uploads are staff-only unless later claimed by the backfill.
   Remove it once the new frontend is live everywhere (see the rollout doc).
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
      -- legacy (rollout window only; never customer-visible unless claimed)
      OR p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|heic|heif)$'
    )
    AND EXISTS (SELECT 1 FROM public.shops s WHERE s.id::text = split_part(p_name, '/', 1));
$$;

-- ---------------------------------------------------------------------------
-- 3. Legacy claims
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legacy_customer_photo_claims (
  lead_id     uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  object_path text NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, object_path)
);
CREATE INDEX IF NOT EXISTS legacy_customer_photo_claims_path_idx
  ON public.legacy_customer_photo_claims (object_path);

ALTER TABLE public.legacy_customer_photo_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.legacy_customer_photo_claims FROM PUBLIC, anon, authenticated;

-- Every legacy (two-level) customer-upload path each lead references.
CREATE OR REPLACE FUNCTION public.lead_legacy_photo_refs()
RETURNS TABLE (lead_id uuid, shop_id uuid, lead_submitted_at timestamptz, object_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT l.id, l.shop_id, l.submitted_at, refs.p
  FROM public.leads l
  CROSS JOIN LATERAL (
    SELECT public.customer_upload_object_path(l.front_image_url) AS p
    UNION ALL SELECT public.customer_upload_object_path(l.rear_image_url)
    UNION ALL
    SELECT public.customer_upload_object_path(e ->> 'reference_image_path')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.selected_parts) = 'array' THEN l.selected_parts ELSE '[]'::jsonb END) e
  ) refs
  WHERE refs.p IS NOT NULL
    AND refs.p ~ '^[^/]+/[^/]+$'
    AND split_part(refs.p, '/', 1) = l.shop_id::text;
$$;

REVOKE ALL ON FUNCTION public.lead_legacy_photo_refs() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.backfill_legacy_customer_photo_claims()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed integer;
  v_added   integer;
BEGIN
  -- A path referenced by more than one lead is ambiguous: nobody gets it.
  WITH ambiguous AS (
    SELECT object_path FROM public.lead_legacy_photo_refs() GROUP BY object_path HAVING count(DISTINCT lead_id) > 1
  )
  DELETE FROM public.legacy_customer_photo_claims c
  USING ambiguous a
  WHERE c.object_path = a.object_path;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  WITH refs AS (
    SELECT r.*, count(*) OVER (PARTITION BY r.object_path) AS n
    FROM public.lead_legacy_photo_refs() r
  )
  INSERT INTO public.legacy_customer_photo_claims (lead_id, object_path)
  SELECT r.lead_id, r.object_path
  FROM refs r
  JOIN storage.objects o
    ON o.bucket_id = 'customer-uploads' AND o.name = r.object_path
  WHERE r.n = 1
    AND o.created_at <= r.lead_submitted_at
    AND o.created_at >= r.lead_submitted_at - interval '24 hours'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  RETURN jsonb_build_object('added', v_added, 'removed', v_removed);
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_legacy_customer_photo_claims() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_legacy_customer_photo_claims() TO service_role;

SELECT public.backfill_legacy_customer_photo_claims();

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
      -- legacy photo claimed by this request
      OR EXISTS (
        SELECT 1 FROM public.legacy_customer_photo_claims c
        WHERE c.lead_id = v_lead_id AND c.object_path = p
      )
    );

  RETURN v_paths;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_photo_paths(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_photo_paths(text, text) TO service_role;

COMMIT;
