/*
# Customer data privacy, phase 2: make customer-uploads private

STAGED, NOT YET A MIGRATION. Move this file into supabase/migrations/ in a
follow-up PR, and apply it ONLY after, in each environment:
  1. 20261124120000_customer_data_privacy.sql is applied,
  2. the customer-photos Edge Function is deployed, and
  3. the frontend that resolves customer photos through signed URLs is live.

After this, /storage/v1/object/public/customer-uploads/... URLs stop
resolving. Staff see their shop's photos through signed URLs (RLS policy
customer_uploads_staff_read); customers see only the photos attached to the
quote or shared build sheet they opened, signed by the customer-photos Edge
Function. The `vehicles` and `shop-logos` buckets remain public.

Rollback: do not set public = true again (that reopens every customer photo to
anyone holding or guessing a URL). Roll back the frontend/function instead;
staff signed URLs keep working, and customer pages render without photos until
the function is restored.
*/

UPDATE storage.buckets SET public = false WHERE id = 'customer-uploads';
