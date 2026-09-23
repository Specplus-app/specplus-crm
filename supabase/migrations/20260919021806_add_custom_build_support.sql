/*
# Custom build support for customer quotes

1. Changes to existing tables
- `leads`
- Adds `is_custom` (boolean, not null, default false): marks a lead that was
  created from the "build from my own photos" flow (customer uploaded their own
  truck photos and drew the areas they want done) instead of a shop catalog vehicle.

2. Storage
- Creates a public storage bucket `customer-uploads` where anonymous customers can
  upload their truck photos and per-part reference photos. Files are read publicly
  via their (unguessable, UUID-based) path so the shop can open them from the lead.

3. Security
- `customer-uploads` bucket:
1. Anonymous and authenticated visitors may INSERT (upload) objects into this
   bucket only (`bucket_id = 'customer-uploads'`).
2. Anonymous and authenticated visitors may SELECT (read) objects in this bucket.
   The bucket is public, so images resolve through their public URL.
- No UPDATE or DELETE policies are granted to the public, so uploaded files cannot
  be overwritten or removed by visitors.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'is_custom'
  ) THEN
    ALTER TABLE leads ADD COLUMN is_custom boolean NOT NULL DEFAULT false;
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public)
VALUES ('customer-uploads', 'customer-uploads', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "customer_uploads_insert" ON storage.objects;
CREATE POLICY "customer_uploads_insert" ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'customer-uploads');

DROP POLICY IF EXISTS "customer_uploads_read" ON storage.objects;
CREATE POLICY "customer_uploads_read" ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'customer-uploads');