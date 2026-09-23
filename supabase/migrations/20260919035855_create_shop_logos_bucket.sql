/*
# Shop logo storage bucket

1. Storage
- Create a public `shop-logos` bucket so each shop can upload a brand logo.
- Files live under a per-shop folder named `shop-<shop_id>/...`.

2. Security (storage.objects policies)
- Public read: anyone (anon + authenticated) can view logos, so the logo
  can appear on public customer pages.
- Shop users may upload/update/delete files only within their own shop folder,
  matched via the existing `get_current_shop_id()` helper. Admins may manage any.
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('shop-logos', 'shop-logos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public_read_shop_logos" ON storage.objects;
CREATE POLICY "public_read_shop_logos" ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'shop-logos');

DROP POLICY IF EXISTS "shop_upload_own_logo" ON storage.objects;
CREATE POLICY "shop_upload_own_logo" ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'shop-logos'
    AND (
      (storage.foldername(name))[1] = ('shop-' || (get_current_shop_id())::text)
      OR get_current_role() = 'admin'
    )
  );

DROP POLICY IF EXISTS "shop_update_own_logo" ON storage.objects;
CREATE POLICY "shop_update_own_logo" ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'shop-logos'
    AND (
      (storage.foldername(name))[1] = ('shop-' || (get_current_shop_id())::text)
      OR get_current_role() = 'admin'
    )
  )
  WITH CHECK (
    bucket_id = 'shop-logos'
    AND (
      (storage.foldername(name))[1] = ('shop-' || (get_current_shop_id())::text)
      OR get_current_role() = 'admin'
    )
  );

DROP POLICY IF EXISTS "shop_delete_own_logo" ON storage.objects;
CREATE POLICY "shop_delete_own_logo" ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'shop-logos'
    AND (
      (storage.foldername(name))[1] = ('shop-' || (get_current_shop_id())::text)
      OR get_current_role() = 'admin'
    )
  );
