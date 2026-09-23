/*
# Add shop_user UPDATE policy on shops

## Why
Shop users could SELECT their own shop row but had no UPDATE policy.
This meant saving shipping rates (customizer_config.shipping_rates) silently
failed — the Supabase client returned no error but the row never changed,
so both the Vehicle Builder preview and the live customer customizer always
showed $0 shipping.

## Changes
1. Adds an UPDATE policy for authenticated shop users on their own shop row.
   - USING: id = get_current_shop_id()
   - WITH CHECK: id = get_current_shop_id()
   Scoped identical to the existing shop_user_select_own_shop SELECT policy.
*/

DROP POLICY IF EXISTS "shop_user_update_own_shop" ON shops;

CREATE POLICY "shop_user_update_own_shop"
ON shops FOR UPDATE
TO authenticated
USING (id = get_current_shop_id())
WITH CHECK (id = get_current_shop_id());
