-- ============================================================
-- Migration v10 — Product Canonicalization
-- Adds URL normalization and dedup fields to pin_products.
-- Safe to re-run (all ADD COLUMN IF NOT EXISTS).
-- Run in Supabase SQL editor AFTER migrate_v9.sql.
-- ============================================================

-- canonical_product_url: source_url with UTM/tracking params stripped
ALTER TABLE pin_products ADD COLUMN IF NOT EXISTS canonical_product_url  text;

-- product_url_hash: md5(canonical_product_url) for fast cross-pin dedup
ALTER TABLE pin_products ADD COLUMN IF NOT EXISTS product_url_hash       text;

-- normalized_merchant: lowercase, www-stripped, known alias resolved
ALTER TABLE pin_products ADD COLUMN IF NOT EXISTS normalized_merchant    text;

-- normalized_product_name: lowercased, trimmed, punctuation collapsed
ALTER TABLE pin_products ADD COLUMN IF NOT EXISTS normalized_product_name text;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Fast cross-pin product dedup lookups
CREATE INDEX IF NOT EXISTS idx_pin_products_url_hash
    ON pin_products (product_url_hash)
    WHERE product_url_hash IS NOT NULL;

-- Merchant rollup queries
CREATE INDEX IF NOT EXISTS idx_pin_products_norm_merchant
    ON pin_products (normalized_merchant)
    WHERE normalized_merchant IS NOT NULL;

-- ── Backfill note ─────────────────────────────────────────────────────────────
-- To populate existing rows, run:
--   py calculate_product_scores.py
-- (it calls shop_the_look.canonicalize_url on existing source_url values
--  during the scoring pass and patches the columns via upsert)
