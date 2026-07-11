-- ============================================================
-- Migration v7 — Frontend transparency fields
-- Safe to re-run (all use IF NOT EXISTS).
-- Run in Supabase SQL editor AFTER migrate_v6.sql.
-- ============================================================

-- Direct link to the pin page (e.g. https://www.pinterest.com/pin/123456789/)
-- Used by frontend to render clickable source attribution.
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS pinterest_url  text;

-- Original creation timestamp from Pinterest (distinct from Supabase's auto-managed
-- created_at). Frontend uses this for real-time age calculation and velocity display.
ALTER TABLE pin_samples ADD COLUMN IF NOT EXISTS pin_created_at timestamptz;

-- Fast lookup: newest pins first (frontend "sorted by post age" queries)
CREATE INDEX IF NOT EXISTS idx_pin_samples_pin_created_at
    ON pin_samples (pin_created_at DESC NULLS LAST)
    WHERE pin_created_at IS NOT NULL;

-- Fast lookup: direct pin URL (dedup / lookup by link)
CREATE INDEX IF NOT EXISTS idx_pin_samples_pinterest_url
    ON pin_samples (pinterest_url)
    WHERE pinterest_url IS NOT NULL;
