-- migrate_v27: explicit product provenance on pin_products
--
-- Adds a clear `discovery_method` column so every product is queryable by origin.
-- This replaces any implicit "product_pin_id IS NULL" provenance heuristic, which
-- is too fragile for reporting. Additive + idempotent; safe to re-run.
--
-- Allowed values:
--   stl                     — Shop-the-Look visual-shop extraction (shop_the_look.py)
--   outbound_link_bootstrap — harvested from pin_samples.outbound_link (product_harvest.py)
--   manual_import           — manual / CSV product import (future)
--   user_upload             — user-owned uploads (user_products / session)

ALTER TABLE pin_products
  ADD COLUMN IF NOT EXISTS discovery_method text;

-- Every pin_products row written to date came from Shop-the-Look — label them.
UPDATE pin_products
   SET discovery_method = 'stl'
 WHERE discovery_method IS NULL;

-- Keep the field clean + queryable. NULL allowed so writes never hard-fail if a
-- new code path forgets to set it; known values are constrained against typos.
ALTER TABLE pin_products
  DROP CONSTRAINT IF EXISTS pin_products_discovery_method_check;
ALTER TABLE pin_products
  ADD CONSTRAINT pin_products_discovery_method_check
  CHECK (discovery_method IS NULL OR discovery_method IN
         ('stl', 'outbound_link_bootstrap', 'manual_import', 'user_upload'));

CREATE INDEX IF NOT EXISTS idx_pin_products_discovery_method
  ON pin_products (discovery_method)
  WHERE discovery_method IS NOT NULL;
