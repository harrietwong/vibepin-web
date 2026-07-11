-- ============================================================
-- Migration v18 — Unique constraint on pin_products.product_url_hash
--
-- Allows ON CONFLICT (product_url_hash) upserts in the digital
-- product scraper for pins that have no source_url but do have
-- a stable pin-ID-derived hash.
--
-- Safe to re-run (CREATE UNIQUE INDEX IF NOT EXISTS).
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_pin_products_url_hash
    ON pin_products (product_url_hash)
    WHERE product_url_hash IS NOT NULL;
