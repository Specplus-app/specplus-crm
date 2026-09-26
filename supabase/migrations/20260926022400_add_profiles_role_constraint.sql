-- Keep profile roles aligned with the roles supported by the application.
-- The CRM currently recognizes only: admin and shop_user.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_role_check'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('admin', 'shop_user'));
  END IF;
END
$$;
