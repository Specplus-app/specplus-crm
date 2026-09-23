/*
# Add customer vehicle details to leads

1. Changes to existing tables
- `leads`
- Adds `vehicle_year`, `vehicle_make`, `vehicle_model`, `vehicle_trim` (all text, nullable):
  captures the customer's year / make / model / trim entered when submitting a
  custom build request. Nullable because catalog-vehicle leads do not collect them.

No security changes: existing lead policies already govern these columns.
*/

ALTER TABLE leads ADD COLUMN IF NOT EXISTS vehicle_year text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS vehicle_make text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS vehicle_model text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS vehicle_trim text;