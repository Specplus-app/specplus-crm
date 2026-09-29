/*
# Simplify subscription tiers to Basic and Pro

1. Changes
   - `shops.subscription_tier` default changed from 'starter' to 'basic'.
   - Existing rows are migrated: 'starter' becomes 'basic', 'enterprise' becomes 'pro'.
     'pro' is left unchanged. No rows are deleted and no columns are dropped.

2. Notes
   - Only two tiers are supported going forward: 'basic' and 'pro'.
*/

ALTER TABLE shops ALTER COLUMN subscription_tier SET DEFAULT 'basic';

UPDATE shops SET subscription_tier = 'basic' WHERE subscription_tier = 'starter';
UPDATE shops SET subscription_tier = 'pro' WHERE subscription_tier = 'enterprise';
