-- migrate_v28: Shop-the-Look product-card provenance (REVIEW ONLY — DO NOT APPLY)
--
-- Provenance strategy: B
--   discovery_method = 'stl'  (within v27 CHECK constraint — no constraint change needed)
--   discovery_method_detail = 'pinterest_product_card_bootstrap'  (unrestricted text)
--
-- This proposal is intentionally additive. It does not alter or replace the
-- existing discovery_method CHECK from v27. Product-card rows keep
-- discovery_method='stl' and use discovery_method_detail for the more precise
-- provenance value 'pinterest_product_card_bootstrap'.
--
-- Additive provenance columns and indexes only. No unrelated tables.
-- source_category and seed_keyword added so Product Ideas category filters
-- work correctly; womens-fashion must not collapse into generic fashion.

ALTER TABLE pin_products
  ADD COLUMN IF NOT EXISTS discovery_method_detail text,
  ADD COLUMN IF NOT EXISTS discovery_depth integer,
  ADD COLUMN IF NOT EXISTS discovery_path text,
  ADD COLUMN IF NOT EXISTS source_pin_id text,
  ADD COLUMN IF NOT EXISTS source_pin_url text,
  -- Category of the source pin; preserved verbatim (womens-fashion ≠ fashion).
  ADD COLUMN IF NOT EXISTS source_category text,
  -- Keyword from the source pin (NULL for STL bootstrap if source pin lacked it).
  ADD COLUMN IF NOT EXISTS seed_keyword text,
  ADD COLUMN IF NOT EXISTS product_card_title text,
  ADD COLUMN IF NOT EXISTS product_card_merchant text,
  ADD COLUMN IF NOT EXISTS product_card_price text,
  ADD COLUMN IF NOT EXISTS product_card_image_url text,
  ADD COLUMN IF NOT EXISTS product_card_position integer,
  ADD COLUMN IF NOT EXISTS extraction_method text,
  ADD COLUMN IF NOT EXISTS shop_module_detected boolean,
  ADD COLUMN IF NOT EXISTS shop_tab_clicked boolean,
  ADD COLUMN IF NOT EXISTS product_source_domain text,
  ADD COLUMN IF NOT EXISTS normalized_product_url_hash text;

COMMENT ON COLUMN pin_products.discovery_method_detail IS
  'Detailed additive provenance. Shop-the-Look bootstrap value: pinterest_product_card_bootstrap.';

COMMENT ON COLUMN pin_products.extraction_method IS
  'How the product destination was observed: network_json, product_card_click, redirect, or dom.';

COMMENT ON COLUMN pin_products.source_category IS
  'Category of the source pin. Preserved verbatim (womens-fashion stays womens-fashion).';

COMMENT ON COLUMN pin_products.seed_keyword IS
  'Keyword from the source pin, if available. NULL for STL bootstrap when source pin lacked a keyword.';

CREATE INDEX IF NOT EXISTS idx_pin_products_discovery_method_detail
  ON pin_products (discovery_method_detail)
  WHERE discovery_method_detail IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pin_products_source_pin_id
  ON pin_products (source_pin_id)
  WHERE source_pin_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_products_normalized_product_url_hash
  ON pin_products (normalized_product_url_hash)
  WHERE normalized_product_url_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pin_products_source_category
  ON pin_products (source_category)
  WHERE source_category IS NOT NULL;

-- Review queries after a future apply (not part of this task):
-- SELECT discovery_method, discovery_method_detail, extraction_method, count(*)
-- FROM pin_products
-- GROUP BY 1,2,3
-- ORDER BY count(*) DESC;
--
-- SELECT source_category, count(*)
-- FROM pin_products
-- WHERE discovery_method_detail = 'pinterest_product_card_bootstrap'
-- GROUP BY 1
-- ORDER BY count(*) DESC;
