/*
# Add customer intake fields to leads

1. Modified Tables
- `leads`
- Adds `paint_code` (text, nullable): the paint color code the customer provides
  up front so the shop knows exactly which color to match.
- Adds `customer_address` (text, nullable): the customer's mailing/service address,
  collected at checkout for scheduling and shipping.
- Adds `target_start_date` (date, nullable): the customer's desired project start
  date, so the shop can plan the job.

2. Security
- No RLS changes. Existing policies continue to apply.

3. Notes
1. All three columns are additive and nullable, so existing leads remain valid.
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'paint_code') THEN
    ALTER TABLE leads ADD COLUMN paint_code text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'customer_address') THEN
    ALTER TABLE leads ADD COLUMN customer_address text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'target_start_date') THEN
    ALTER TABLE leads ADD COLUMN target_start_date date;
  END IF;
END $$;