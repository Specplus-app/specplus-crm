/*
# Add part_groups table and group_id on vehicle_parts

## Purpose
Replaces the parent_part_id / sub-part hierarchy with a "Parts Group" concept.
A group is a named collection of parts. The first part selected in a group
presents Buy New or Paint Mine; subsequent parts in the same group only
offer Paint (since the part was already purchased in a previous selection).

## 1. New Tables
- `part_groups`
  - `id` (uuid PK)
  - `vehicle_id` (uuid FK → vehicles, cascade delete)
  - `name` (text, not null) — e.g. "Front Bumper Group"
  - `sort_order` (int, default 0)
  - `created_at` (timestamptz)

## 2. Modified Tables
- `vehicle_parts`
  - Add `group_id` (uuid, nullable FK → part_groups, set null on delete)
  - The existing `parent_part_id` column is kept for backward compatibility
    but will no longer be used by the app logic. New code uses `group_id`.

## 3. Security
- RLS enabled on `part_groups`.
- Same ownership pattern as vehicle_parts: shop-scoped via vehicle ownership.
- 4 CRUD policies for authenticated users (select/insert/update/delete).
*/