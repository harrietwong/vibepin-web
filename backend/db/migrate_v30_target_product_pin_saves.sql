-- migrate_v30: explicit, unambiguous Target Product Pin save fields
-- =====================================================================
-- REVIEW ONLY — NOT YET APPLIED. Additive (IF NOT EXISTS) only.
--
-- Why this exists
-- ---------------
-- pin_products.save_count is OVERLOADED today:
--   * 891 legacy rows: product_pin_id IS NOT NULL and save_count is a genuine
--     TARGET PRODUCT PIN save count (verified: save_count != source_pin_save_count).
--   * 1,594 rows: product_pin_id IS NULL and save_count is a verbatim COPY of the
--     source main pin's saves (save_count == source_pin_save_count) — NOT a product
--     metric.
--
-- This migration introduces explicit columns so the verifiable metric has an
-- unambiguous home. The verifiable metric is the save count of the TARGET
-- PRODUCT PIN reached after clicking a Shop-the-Look / Shop-similar product card.
--
-- NAMING RULE: the verifiable field is `target_product_pin_save_count`.
-- It is deliberately NOT named `product_save_count` — we do NOT yet have
-- SKU-level product saves (that requires aggregating multiple Product Pins that
-- resolve to one product/entity, a later task).
--
-- This migration does NOT alter or drop any existing column. The legacy
-- save_count / product_pin_id columns are left exactly as-is.

-- ── 1. Additive columns ──────────────────────────────────────────────────────
ALTER TABLE pin_products
  ADD COLUMN IF NOT EXISTS target_product_pin_id          text,
  ADD COLUMN IF NOT EXISTS target_product_pin_url         text,
  ADD COLUMN IF NOT EXISTS target_product_pin_save_count  integer,
  ADD COLUMN IF NOT EXISTS target_product_pin_title       text,
  ADD COLUMN IF NOT EXISTS target_product_pin_image_url   text,
  ADD COLUMN IF NOT EXISTS section_type                   text,   -- shop_the_look | shop_similar
  ADD COLUMN IF NOT EXISTS item_index                     integer,
  ADD COLUMN IF NOT EXISTS extraction_status              text,   -- ok | no_target_pin | goto_timeout | saves_not_found | ...
  ADD COLUMN IF NOT EXISTS error_reason                   text,
  ADD COLUMN IF NOT EXISTS target_product_pin_scraped_at  timestamptz;

COMMENT ON COLUMN pin_products.target_product_pin_save_count IS
  'Saves on the TARGET Product Pin reached from a Shop-the-Look / Shop-similar card. '
  'Pin-level metric, verifiable now. NOT SKU-level product saves.';
COMMENT ON COLUMN pin_products.target_product_pin_id IS
  'Pinterest pin id of the target Product Pin (the closeup reached from the product card).';
COMMENT ON COLUMN pin_products.section_type IS
  'Which module the product card came from: shop_the_look or shop_similar.';
COMMENT ON COLUMN pin_products.extraction_status IS
  'Result of the target-pin resolution attempt: ok | no_target_pin | goto_timeout | '
  'saves_not_found | login_wall | captcha | legacy_backfill.';

-- ── 2. Indexes (partial; only where the new fields are populated) ─────────────
CREATE INDEX IF NOT EXISTS idx_pin_products_target_product_pin_id
  ON pin_products (target_product_pin_id)
  WHERE target_product_pin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pin_products_section_type
  ON pin_products (section_type)
  WHERE section_type IS NOT NULL;

-- ── 3. SAFE legacy backfill (PENDING — run only after explicit approval) ──────
-- Copies the already-verified legacy target-pin saves into the explicit columns.
-- Idempotent (target_product_pin_id IS NULL guard). Touches ONLY unambiguous rows:
--   product_pin_id IS NOT NULL              (we know the target pin)
--   AND save_count IS NOT NULL AND save_count <> 0
--   AND save_count <> source_pin_save_count (save_count is NOT a copy of main-pin saves)
--
-- Measured 2026-06-26 (read-only): 887 rows match (891 with product_pin_id, minus 4
-- whose save_count = 0). 1,594 ambiguous rows are intentionally NOT touched.
--
-- UPDATE pin_products
-- SET target_product_pin_id         = product_pin_id,
--     target_product_pin_url        = 'https://www.pinterest.com/pin/' || product_pin_id || '/',
--     target_product_pin_save_count = save_count,
--     target_product_pin_title      = COALESCE(target_product_pin_title, product_name),
--     target_product_pin_image_url  = COALESCE(target_product_pin_image_url, image_url),
--     target_product_pin_scraped_at = COALESCE(scraped_at, created_at),
--     extraction_status             = COALESCE(extraction_status, 'legacy_backfill')
-- WHERE product_pin_id IS NOT NULL
--   AND save_count IS NOT NULL
--   AND save_count <> 0
--   AND save_count <> source_pin_save_count
--   AND target_product_pin_id IS NULL;
--
-- Verify after backfill:
-- SELECT count(*) FROM pin_products WHERE extraction_status = 'legacy_backfill';      -- expect 887
-- SELECT count(*) FROM pin_products WHERE target_product_pin_save_count IS NOT NULL;  -- expect >= 887
