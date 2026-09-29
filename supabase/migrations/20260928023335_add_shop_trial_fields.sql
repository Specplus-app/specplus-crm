/*
# Add trial and read-only billing fields to shops

1. Modified Tables
   - `shops`
     - `trial_ends_at` (timestamptz, defaults to 14 days after row creation) — when the
       free trial ends. Existing rows are backfilled to 14 days from now.
     - `is_lifetime_free` (boolean, default false) — when true the shop always has full
       access and never sees trial banners.
   - `subscription_status` default changed from 'trial' to 'trialing' for new shops.
     Existing legacy `trial` rows are normalized to `trialing`.

2. Security
   - No RLS changes. Existing shop policies continue to apply.

3. Notes
   1. Active and lifetime-free shops retain full access. A `trial`/`trialing` shop
      remains writable only while `trial_ends_at` is current. Suspended, cancelled,
      or other non-active statuses are read-only immediately. This is computed in
      the application layer.
   2. Adding `trial_ends_at` with a default populates all existing shops so no shop is
      left without a trial end date.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shops' AND column_name = 'trial_ends_at'
  ) THEN
    ALTER TABLE shops ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT (now() + interval '14 days');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'shops' AND column_name = 'is_lifetime_free'
  ) THEN
    ALTER TABLE shops ADD COLUMN is_lifetime_free boolean NOT NULL DEFAULT false;
  END IF;
END $$;

ALTER TABLE shops ALTER COLUMN subscription_status SET DEFAULT 'trialing';
UPDATE shops SET subscription_status = 'trialing' WHERE subscription_status = 'trial';
