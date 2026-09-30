/*
# Human-readable public quote URLs

Adds a stable, unique slug to each shop so customer quote pages can use URLs like
https://quotes.specplus.app/fastheadlights while preserving the existing UUID
/customize/:shopId route for compatibility.
*/

BEGIN;

ALTER TABLE public.shops
ADD COLUMN IF NOT EXISTS slug text;

CREATE OR REPLACE FUNCTION public.normalize_shop_slug(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  normalized text;
BEGIN
  normalized := trim(BOTH '-' FROM regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'));

  IF normalized = '' THEN
    normalized := 'shop';
  END IF;

  IF normalized = ANY (ARRAY['login', 'signup', 'admin', 'dashboard', 'customize', 'lead', 'embed', 'build']) THEN
    normalized := normalized || '-shop';
  END IF;

  RETURN normalized;
END;
$$;

DO $$
DECLARE
  shop_record record;
  base_slug text;
  candidate text;
  suffix integer;
BEGIN
  FOR shop_record IN
    SELECT id, name
    FROM public.shops
    WHERE slug IS NULL OR btrim(slug) = ''
    ORDER BY created_at, id
  LOOP
    base_slug := public.normalize_shop_slug(shop_record.name);
    candidate := base_slug;
    suffix := 2;

    WHILE EXISTS (
      SELECT 1
      FROM public.shops
      WHERE slug = candidate
        AND id <> shop_record.id
    ) LOOP
      candidate := base_slug || '-' || suffix::text;
      suffix := suffix + 1;
    END LOOP;

    UPDATE public.shops
    SET slug = candidate
    WHERE id = shop_record.id;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS shops_slug_key
ON public.shops (slug);

ALTER TABLE public.shops
ALTER COLUMN slug SET NOT NULL;

CREATE OR REPLACE FUNCTION public.set_new_shop_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix integer := 2;
BEGIN
  base_slug := public.normalize_shop_slug(coalesce(nullif(btrim(NEW.slug), ''), NEW.name));
  PERFORM pg_advisory_xact_lock(hashtext(base_slug));

  candidate := base_slug;
  WHILE EXISTS (
    SELECT 1
    FROM public.shops
    WHERE slug = candidate
      AND id IS DISTINCT FROM NEW.id
  ) LOOP
    candidate := base_slug || '-' || suffix::text;
    suffix := suffix + 1;
  END LOOP;

  NEW.slug := candidate;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shops_set_slug_before_insert ON public.shops;
CREATE TRIGGER shops_set_slug_before_insert
BEFORE INSERT ON public.shops
FOR EACH ROW
EXECUTE FUNCTION public.set_new_shop_slug();

GRANT SELECT (slug) ON TABLE public.shops TO anon;

COMMENT ON COLUMN public.shops.slug IS
  'Stable public URL slug used by quotes.specplus.app/<slug>';

COMMIT;
