-- ============================================================
-- Migration v4 — Viral Intelligence Engine columns
-- Safe to re-run (all use IF NOT EXISTS)
-- Run in Supabase SQL editor AFTER migrate_v3.sql
-- ============================================================

-- pin_samples: viral metric columns
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS days_since_creation integer;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS save_velocity       numeric;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS intent_ratio        numeric;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS is_high_growth      boolean DEFAULT false;
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS reject_reason       text;

-- Computed index: fast lookup of high-growth premium pins
CREATE INDEX IF NOT EXISTS idx_pin_samples_high_growth
    ON pin_samples (is_high_growth, save_count DESC)
    WHERE is_high_growth = true;

-- Computed index: freshness + volume filter (the hot feed query)
CREATE INDEX IF NOT EXISTS idx_pin_samples_fresh_viral
    ON pin_samples (save_count DESC, days_since_creation)
    WHERE days_since_creation IS NOT NULL AND days_since_creation <= 90;

-- pin_style_analysis: add prompt_seed if not already present
ALTER TABLE pin_style_analysis ADD COLUMN IF NOT EXISTS prompt_seed text;
