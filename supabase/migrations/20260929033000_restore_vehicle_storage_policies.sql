/*
# Restore vehicle storage policies

Production was missing the storage.object policies for the public `vehicles`
bucket, so authenticated shops could create vehicle records but image uploads
were silently rejected by Supabase Storage. This migration records the policies
applied manually in production and adds UPDATE support required by `upsert: true`.
*/

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES ('vehicles', 'vehicles', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "shop_upload_vehicles" ON storage.objects;
CREATE POLICY "shop_upload_vehicles"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'vehicles'
  AND (storage.foldername(name))[1]
      = 'shop-' || public.get_current_shop_id()::text
);

DROP POLICY IF EXISTS "admin_upload_vehicles" ON storage.objects;
CREATE POLICY "admin_upload_vehicles"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'vehicles'
  AND public.get_current_role() = 'admin'
);

DROP POLICY IF EXISTS "shop_update_own_vehicle_images" ON storage.objects;
CREATE POLICY "shop_update_own_vehicle_images"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'vehicles'
  AND (
    (storage.foldername(name))[1]
      = 'shop-' || public.get_current_shop_id()::text
    OR public.get_current_role() = 'admin'
  )
)
WITH CHECK (
  bucket_id = 'vehicles'
  AND (
    (storage.foldername(name))[1]
      = 'shop-' || public.get_current_shop_id()::text
    OR public.get_current_role() = 'admin'
  )
);

DROP POLICY IF EXISTS "shop_delete_own_vehicles" ON storage.objects;
CREATE POLICY "shop_delete_own_vehicles"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'vehicles'
  AND (
    (storage.foldername(name))[1]
      = 'shop-' || public.get_current_shop_id()::text
    OR public.get_current_role() = 'admin'
  )
);

DROP POLICY IF EXISTS "public_read_vehicles" ON storage.objects;
CREATE POLICY "public_read_vehicles"
ON storage.objects
FOR SELECT
TO anon, authenticated
USING (bucket_id = 'vehicles');

COMMIT;
