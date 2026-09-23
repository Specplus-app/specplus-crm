-- Add optional external product URL (e.g. a Shopify product link) to a traced part.
-- Used by the public embed view: clicking a highlighted part opens this link.
ALTER TABLE vehicle_parts ADD COLUMN IF NOT EXISTS external_url text;