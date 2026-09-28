/*
# Align production Supabase backend

This migration records the security and policy changes that were applied manually
while recovering the production project. Earlier migrations already define the
core schema; this file intentionally focuses on the production deltas so a fresh
migration run converges on the same safer state.

Key points:
- keep helper functions deterministic and SECURITY DEFINER
- remove the unsafe profile self-update policy
- require shop note authors to match auth.uid()
- scope build-sheet writes to admins or the owning shop
- keep customer-uploads public/readable, but upload-only for visitors
- tighten table grants so RLS is the authorization layer instead of broad anon grants
*/

BEGIN;

-- ---------------------------------------------------------------------------
-- Canonical helper functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_current_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.get_current_shop_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT shop_id FROM public.profiles WHERE id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Profiles: do not allow a normal user to update their own role/shop_id.
-- Profile changes that affect authorization remain admin-controlled.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "user_update_own_profile" ON public.profiles;

-- ---------------------------------------------------------------------------
-- Shops: public customizer may read storefront fields only.
-- Authenticated users still rely on RLS for row-level access.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "anon_public_select_shops" ON public.shops;
CREATE POLICY "anon_public_select_shops"
ON public.shops FOR SELECT
TO anon
USING (true);

REVOKE ALL PRIVILEGES ON TABLE public.shops FROM anon;
GRANT SELECT (id, name, logo_url, customizer_config) ON TABLE public.shops TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shops TO authenticated;

-- ---------------------------------------------------------------------------
-- Profiles grants
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;

-- ---------------------------------------------------------------------------
-- Leads: anonymous visitors may submit, but cannot read or modify leads.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON TABLE public.leads FROM anon;
GRANT INSERT ON TABLE public.leads TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.leads TO authenticated;

-- ---------------------------------------------------------------------------
-- Lead notes: recreate the policies used in production. In particular, a shop
-- user may only insert a note as themselves.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "admin_select_lead_notes" ON public.lead_notes;
DROP POLICY IF EXISTS "admin_insert_lead_notes" ON public.lead_notes;
DROP POLICY IF EXISTS "admin_delete_lead_notes" ON public.lead_notes;
DROP POLICY IF EXISTS "shop_user_select_own_lead_notes" ON public.lead_notes;
DROP POLICY IF EXISTS "shop_user_insert_own_lead_notes" ON public.lead_notes;
DROP POLICY IF EXISTS "shop_user_delete_own_lead_notes" ON public.lead_notes;
DROP POLICY IF EXISTS "lead_notes_admin_select" ON public.lead_notes;
DROP POLICY IF EXISTS "lead_notes_admin_insert" ON public.lead_notes;
DROP POLICY IF EXISTS "lead_notes_admin_delete" ON public.lead_notes;
DROP POLICY IF EXISTS "lead_notes_shop_select" ON public.lead_notes;
DROP POLICY IF EXISTS "lead_notes_shop_insert" ON public.lead_notes;
DROP POLICY IF EXISTS "lead_notes_shop_delete" ON public.lead_notes;

CREATE POLICY "lead_notes_admin_select"
ON public.lead_notes FOR SELECT
TO authenticated
USING (public.get_current_role() = 'admin');

CREATE POLICY "lead_notes_admin_insert"
ON public.lead_notes FOR INSERT
TO authenticated
WITH CHECK (public.get_current_role() = 'admin');

CREATE POLICY "lead_notes_admin_delete"
ON public.lead_notes FOR DELETE
TO authenticated
USING (public.get_current_role() = 'admin');

CREATE POLICY "lead_notes_shop_select"
ON public.lead_notes FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.leads l
    WHERE l.id = lead_notes.lead_id
      AND l.shop_id = public.get_current_shop_id()
  )
);

CREATE POLICY "lead_notes_shop_insert"
ON public.lead_notes FOR INSERT
TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.leads l
    WHERE l.id = lead_id
      AND l.shop_id = public.get_current_shop_id()
  )
);

CREATE POLICY "lead_notes_shop_delete"
ON public.lead_notes FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.leads l
    WHERE l.id = lead_notes.lead_id
      AND l.shop_id = public.get_current_shop_id()
  )
);

REVOKE ALL PRIVILEGES ON TABLE public.lead_notes FROM anon;
GRANT SELECT, INSERT, DELETE ON TABLE public.lead_notes TO authenticated;

-- ---------------------------------------------------------------------------
-- Build sheets: public read-by-link remains intentional. Writes are restricted
-- to admins or the shop that owns the sheet.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "auth_insert_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "auth_update_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "admin_insert_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "admin_update_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "shop_user_insert_build_sheets" ON public.build_sheets;
DROP POLICY IF EXISTS "shop_user_update_build_sheets" ON public.build_sheets;

DROP POLICY IF EXISTS "public_select_build_sheets" ON public.build_sheets;
CREATE POLICY "public_select_build_sheets"
ON public.build_sheets FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "admin_insert_build_sheets"
ON public.build_sheets FOR INSERT
TO authenticated
WITH CHECK (public.get_current_role() = 'admin');

CREATE POLICY "admin_update_build_sheets"
ON public.build_sheets FOR UPDATE
TO authenticated
USING (public.get_current_role() = 'admin')
WITH CHECK (public.get_current_role() = 'admin');

CREATE POLICY "shop_user_insert_build_sheets"
ON public.build_sheets FOR INSERT
TO authenticated
WITH CHECK (shop_id = public.get_current_shop_id());

CREATE POLICY "shop_user_update_build_sheets"
ON public.build_sheets FOR UPDATE
TO authenticated
USING (shop_id = public.get_current_shop_id())
WITH CHECK (shop_id = public.get_current_shop_id());

REVOKE ALL PRIVILEGES ON TABLE public.build_sheets FROM anon;
GRANT SELECT ON TABLE public.build_sheets TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.build_sheets TO authenticated;

-- ---------------------------------------------------------------------------
-- Customer-upload storage. Public URLs are part of the current custom-build
-- design. Visitors can upload and read, but cannot update or delete objects.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('customer-uploads', 'customer-uploads', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "customer_uploads_insert" ON storage.objects;
CREATE POLICY "customer_uploads_insert"
ON storage.objects FOR INSERT
TO anon, authenticated
WITH CHECK (bucket_id = 'customer-uploads');

DROP POLICY IF EXISTS "customer_uploads_read" ON storage.objects;
CREATE POLICY "customer_uploads_read"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'customer-uploads');

DROP POLICY IF EXISTS "customer_uploads_update" ON storage.objects;
DROP POLICY IF EXISTS "customer_uploads_delete" ON storage.objects;

-- ---------------------------------------------------------------------------
-- Catalog tables: public users only need read access; authenticated users are
-- authorized further by RLS for admin/shop CRUD.
-- ---------------------------------------------------------------------------
REVOKE ALL PRIVILEGES ON TABLE public.vehicles FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.part_groups FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.vehicle_parts FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.part_paint_styles FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.part_options FROM anon;

GRANT SELECT ON TABLE public.vehicles TO anon;
GRANT SELECT ON TABLE public.part_groups TO anon;
GRANT SELECT ON TABLE public.vehicle_parts TO anon;
GRANT SELECT ON TABLE public.part_paint_styles TO anon;
GRANT SELECT ON TABLE public.part_options TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.part_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vehicle_parts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.part_paint_styles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.part_options TO authenticated;

COMMIT;
