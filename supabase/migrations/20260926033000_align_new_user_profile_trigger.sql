-- Align production user creation with the current CRM auth model.
-- New auth users should receive a shop_user profile; the admin-create-user
-- Edge Function assigns the selected shop_id after the auth user is created.

ALTER TABLE public.profiles
  ALTER COLUMN role SET DEFAULT 'shop_user';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'shop_user'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;
