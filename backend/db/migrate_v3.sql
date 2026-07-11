-- ============================================================
-- Migration v3 — pin_samples new columns for 3-stage scraper
-- Safe to re-run (all use IF NOT EXISTS / IF NOT EXISTS pattern)
-- ============================================================

-- New fields captured by the multi-category 3-stage scraper
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS seed_keyword      text;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS description       text;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS comment_count     integer DEFAULT 0;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS image_ratio       numeric;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS parent_pin_id     text;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS related_rank      integer;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS source_type       text DEFAULT 'search_result';
