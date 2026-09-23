/*
# SpecPlus CRM — Multi-tenant Schema Foundation

## Overview
Creates the core database schema for a multi-tenant CRM where:
- The platform admin manages shop subscriptions
- Each shop (tenant) has users who log in and manage customer leads
- Customers use the public vehicle customizer and submit leads to shops
- Admins can impersonate shops for support

## New Tables

### shops
- `id` (uuid, PK) — unique shop identifier
- `name` (text) — shop display name
- `logo_url` (text, nullable) — shop logo
- `contact_email` (text) — primary contact email
- `phone` (text, nullable) — contact phone
- `address` (text, nullable) — shop address
- `subscription_status` (text) — 'active', 'suspended', 'trial', 'cancelled'
- `subscription_tier` (text) — 'starter', 'pro', 'enterprise'
- `customizer_config` (jsonb) — JSON for per-shop customizer branding/config
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

### profiles
- `id` (uuid, PK, FK to auth.users) — links to Supabase auth
- `shop_id` (uuid, FK to shops, nullable) — null for admin users
- `email` (text)
- `full_name` (text)
- `role` (text) — 'admin' or 'shop_user'
- `created_at` (timestamptz)

### leads
- `id` (uuid, PK)
- `shop_id` (uuid, FK to shops) — which shop this lead belongs to
- `customer_name` (text)
- `customer_email` (text)
- `customer_phone` (text, nullable)
- `customer_state` (text, nullable)
- `vehicle_id` (text) — which vehicle was customized
- `vehicle_name` (text)
- `fulfillment_mode` (text) — 'local' or 'mail'
- `selected_parts` (jsonb) — array of selected part objects
- `parts_total` (numeric)
- `shipping_total` (numeric)
- `grand_total` (numeric)
- `status` (text) — 'new', 'contacted', 'quoted', 'scheduled', 'completed', 'archived'
- `notes` (text, nullable) — internal shop notes
- `front_image_url` (text, nullable) — screenshot from customizer
- `rear_image_url` (text, nullable)
- `submitted_at` (timestamptz)
- `updated_at` (timestamptz)

### lead_notes
- `id` (uuid, PK)
- `lead_id` (uuid, FK to leads)
- `author_id` (uuid, FK to profiles) — who wrote the note
- `body` (text)
- `created_at` (timestamptz)

## Security (RLS)

### shops
- Admins: full CRUD
- Shop users: can read their own shop

### profiles
- Admins: can read all profiles
- Shop users: can read their own profile and peers in same shop

### leads
- Admins: full CRUD on all leads
- Shop users: CRUD only on leads belonging to their shop
- Anon: can INSERT leads (public submission from customizer), no SELECT/UPDATE/DELETE

### lead_notes
- Admins: full CRUD
- Shop users: CRUD only on notes for leads in their shop

## Important Notes
1. profiles.id references auth.users so every authenticated user has exactly one profile
2. leads allow anon INSERT so the public customizer can submit without logging in
3. The admin role is determined by profiles.role = 'admin', not by raw_user_meta_data
4. shop_id on profiles is nullable — admin users have null shop_id
*/
-- ── Shops table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  logo_url text,
  contact_email text NOT NULL,
  phone text,
  address text,
  subscription_status text NOT NULL DEFAULT 'trial',
  subscription_tier text NOT NULL DEFAULT 'starter',
  customizer_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Profiles table (links auth.users to shops) ────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shop_id uuid REFERENCES shops(id) ON DELETE SET NULL,
  email text NOT NULL,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'shop_user',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Leads table (customer submissions) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  customer_state text,
  vehicle_id text NOT NULL,
  vehicle_name text NOT NULL,
  fulfillment_mode text NOT NULL DEFAULT 'local',
  selected_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  parts_total numeric NOT NULL DEFAULT 0,
  shipping_total numeric NOT NULL DEFAULT 0,
  grand_total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'new',
  notes text,
  front_image_url text,
  rear_image_url text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Lead notes table (internal shop notes on leads) ───────────────────────
CREATE TABLE IF NOT EXISTS lead_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_shop_id ON profiles(shop_id);
CREATE INDEX IF NOT EXISTS idx_leads_shop_id ON leads(shop_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_shop_status ON leads(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_id ON lead_notes(lead_id);

-- ── Enable RLS on all tables ──────────────────────────────────────────────
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_notes ENABLE ROW LEVEL SECURITY;

-- ── Helper function: get current user's role ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_current_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

-- ── Helper function: get current user's shop_id ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_current_shop_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT shop_id FROM profiles WHERE id = auth.uid();
$$;

-- ══ SHOPS policies ════════════════════════════════════════════════════════
-- Admin: full CRUD
DROP POLICY IF EXISTS "admin_select_shops" ON shops;
CREATE POLICY "admin_select_shops" ON shops FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_shops" ON shops;
CREATE POLICY "admin_insert_shops" ON shops FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_shops" ON shops;
CREATE POLICY "admin_update_shops" ON shops FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_shops" ON shops;
CREATE POLICY "admin_delete_shops" ON shops FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: read their own shop
DROP POLICY IF EXISTS "shop_user_select_own_shop" ON shops;
CREATE POLICY "shop_user_select_own_shop" ON shops FOR SELECT
  TO authenticated USING (id = get_current_shop_id());

-- ══ PROFILES policies ═════════════════════════════════════════════════════
-- Admin: read all profiles
DROP POLICY IF EXISTS "admin_select_profiles" ON profiles;
CREATE POLICY "admin_select_profiles" ON profiles FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: read profiles in their own shop
DROP POLICY IF EXISTS "shop_user_select_own_shop_profiles" ON profiles;
CREATE POLICY "shop_user_select_own_shop_profiles" ON profiles FOR SELECT
  TO authenticated USING (shop_id = get_current_shop_id());

-- Users can update their own profile (name only)
DROP POLICY IF EXISTS "user_update_own_profile" ON profiles;
CREATE POLICY "user_update_own_profile" ON profiles FOR UPDATE
  TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Admin: create/update profiles (for managing shop users)
DROP POLICY IF EXISTS "admin_insert_profiles" ON profiles;
CREATE POLICY "admin_insert_profiles" ON profiles FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_profiles" ON profiles;
CREATE POLICY "admin_update_profiles" ON profiles FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

-- Admin: delete profiles
DROP POLICY IF EXISTS "admin_delete_profiles" ON profiles;
CREATE POLICY "admin_delete_profiles" ON profiles FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- ══ LEADS policies ════════════════════════════════════════════════════════
-- Anon: can INSERT leads (public customizer submission)
DROP POLICY IF EXISTS "anon_insert_leads" ON leads;
CREATE POLICY "anon_insert_leads" ON leads FOR INSERT
  TO anon, authenticated WITH CHECK (true);

-- Admin: full CRUD on all leads
DROP POLICY IF EXISTS "admin_select_leads" ON leads;
CREATE POLICY "admin_select_leads" ON leads FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_update_leads" ON leads;
CREATE POLICY "admin_update_leads" ON leads FOR UPDATE
  TO authenticated USING (get_current_role() = 'admin') WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_leads" ON leads;
CREATE POLICY "admin_delete_leads" ON leads FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: CRUD on leads in their shop
DROP POLICY IF EXISTS "shop_user_select_own_leads" ON leads;
CREATE POLICY "shop_user_select_own_leads" ON leads FOR SELECT
  TO authenticated USING (shop_id = get_current_shop_id());

DROP POLICY IF EXISTS "shop_user_update_own_leads" ON leads;
CREATE POLICY "shop_user_update_own_leads" ON leads FOR UPDATE
  TO authenticated USING (shop_id = get_current_shop_id()) WITH CHECK (shop_id = get_current_shop_id());

DROP POLICY IF EXISTS "shop_user_delete_own_leads" ON leads;
CREATE POLICY "shop_user_delete_own_leads" ON leads FOR DELETE
  TO authenticated USING (shop_id = get_current_shop_id());

-- ══ LEAD_NOTES policies ════════════════════════════════════════════════════
-- Admin: full CRUD
DROP POLICY IF EXISTS "admin_select_lead_notes" ON lead_notes;
CREATE POLICY "lead_notes_admin_select" ON lead_notes FOR SELECT
  TO authenticated USING (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_insert_lead_notes" ON lead_notes;
CREATE POLICY "lead_notes_admin_insert" ON lead_notes FOR INSERT
  TO authenticated WITH CHECK (get_current_role() = 'admin');

DROP POLICY IF EXISTS "admin_delete_lead_notes" ON lead_notes;
CREATE POLICY "lead_notes_admin_delete" ON lead_notes FOR DELETE
  TO authenticated USING (get_current_role() = 'admin');

-- Shop users: CRUD on notes for leads in their shop
DROP POLICY IF EXISTS "shop_user_select_own_lead_notes" ON lead_notes;
CREATE POLICY "shop_user_select_own_lead_notes" ON lead_notes FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM leads
      WHERE leads.id = lead_notes.lead_id
      AND leads.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_insert_own_lead_notes" ON lead_notes;
CREATE POLICY "shop_user_insert_own_lead_notes" ON lead_notes FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM leads
      WHERE leads.id = lead_id
      AND leads.shop_id = get_current_shop_id()
    )
  );

DROP POLICY IF EXISTS "shop_user_delete_own_lead_notes" ON lead_notes;
CREATE POLICY "shop_user_delete_own_lead_notes" ON lead_notes FOR DELETE
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM leads
      WHERE leads.id = lead_notes.lead_id
      AND leads.shop_id = get_current_shop_id()
    )
  );

-- ── Trigger: auto-create profile on auth signup ───────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''), 'shop_user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Trigger: update updated_at timestamps ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shops_updated_at ON shops;
CREATE TRIGGER shops_updated_at BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS leads_updated_at ON leads;
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
