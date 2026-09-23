/*
# Add estimated lead time to leads

1. Modified Tables
- `leads`
- Adds `estimated_lead_time_days` (integer, not null, default 0): the build's
  estimated turnaround in days, captured from the customizer at the moment the
  customer submits their quote request. Stored so shops see the promised timeline
  on the lead without recomputing it.

2. Security
- No RLS changes. Existing policies continue to apply.

3. Notes
1. The column is additive and defaults to 0, so existing leads remain valid.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads' AND column_name = 'estimated_lead_time_days'
  ) THEN
    ALTER TABLE leads ADD COLUMN estimated_lead_time_days integer NOT NULL DEFAULT 0;
  END IF;
END $$;