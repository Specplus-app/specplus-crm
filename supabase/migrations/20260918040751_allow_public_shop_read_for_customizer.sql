/*
# Allow public read of safe shop fields for the customer customizer

1. Problem
- The customer build link (`/customize/:shopId`) is opened by visitors who are
  NOT signed in (the `anon` role). The `shops` table had no policy for `anon`,
  so the page could not load the shop and showed "Shop not found".

2. Changes
- `shops`
- Adds a SELECT policy `anon_public_select_shops` scoped to the `anon` role only,
  allowing anonymous visitors to read shop rows. Signed-in behavior is unchanged
  (existing owner/admin policies still apply).
- Restricts anonymous column access with column-level privileges: anonymous
  visitors may read ONLY `id`, `name`, `logo_url`, and `customizer_config`.
  The private columns (`contact_email`, `phone`, `address`, `subscription_status`,
  `subscription_tier`, timestamps) remain hidden from anonymous visitors.

3. Security
1. Anonymous visitors can see only the four public storefront fields, never
   contact or subscription details.
2. Authenticated access (shop owners, admins) is unchanged.
*/

DROP POLICY IF EXISTS "anon_public_select_shops" ON shops;
CREATE POLICY "anon_public_select_shops" ON shops FOR SELECT
  TO anon USING (true);

REVOKE SELECT ON shops FROM anon;
GRANT SELECT (id, name, logo_url, customizer_config) ON shops TO anon;