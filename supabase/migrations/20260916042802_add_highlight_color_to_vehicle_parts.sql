/*
# Add highlight_color to vehicle_parts

1. Modified Tables
- `vehicle_parts`: Add `highlight_color` column (text, default 'green')
  - Stores the color used to highlight this part when a customer selects it
  - Valid values: 'green', 'blue', 'orange', 'pink', 'teal'
  - Defaults to 'green' for all existing and new parts
2. Security
- No RLS policy changes — existing policies on vehicle_parts remain unchanged
*/

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vehicle_parts' AND column_name = 'highlight_color'
  ) THEN
    ALTER TABLE vehicle_parts ADD COLUMN highlight_color text NOT NULL DEFAULT 'green';
  END IF;
END $$;
