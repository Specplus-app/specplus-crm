-- Add shipping size classification to vehicle parts
alter table public.vehicle_parts
  add column ship_size text not null default 'medium';

-- Backfill existing parts to 'medium'
update public.vehicle_parts set ship_size = 'medium' where ship_size is null;

-- Add a check constraint for valid sizes
alter table public.vehicle_parts
  add constraint vehicle_parts_ship_size_check
  check (ship_size in ('small', 'medium', 'large', 'x-large'));
