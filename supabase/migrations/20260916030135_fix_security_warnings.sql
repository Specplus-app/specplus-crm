/*
# Fix security warnings on helper functions

Revoke EXECUTE on SECURITY DEFINER helper functions from anon and authenticated roles.
These functions are only used internally by RLS policies, not via the REST API.

1. REVOKE EXECUTE on get_current_role(), get_current_shop_id(), handle_new_user() from anon and authenticated
2. Set search_path on update_updated_at() function
*/
REVOKE EXECUTE ON FUNCTION public.get_current_role() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_current_shop_id() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- Fix mutable search_path on update_updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
