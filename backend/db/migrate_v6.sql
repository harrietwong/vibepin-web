-- ============================================================
-- Migration v6 — trend_keywords: automated Trends API columns
-- Safe to re-run (all use IF NOT EXISTS).
-- Run in Supabase SQL editor AFTER migrate_v5.sql.
-- ============================================================

-- Columns written by trend_fetcher.py (missing from original schema)
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS weekly_change        numeric  DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS monthly_change       numeric  DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS yearly_change        numeric  DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS search_volume_level  text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS status               text     DEFAULT 'active';
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS notes                text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS intent_type          text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS content_type         text;

-- New v6 columns from trend_fetcher.py intelligence engine
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS search_volume_score  integer  DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS trend_source         text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS trend_rank           integer;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS last_fetched_at      timestamptz;

-- Fast queries: top-ranked active keywords per category
CREATE INDEX IF NOT EXISTS idx_trend_keywords_rank
    ON trend_keywords (category, trend_rank ASC NULLS LAST)
    WHERE status = 'active';

-- Fast queries: sort by volume + priority
CREATE INDEX IF NOT EXISTS idx_trend_keywords_priority
    ON trend_keywords (category, search_volume_score DESC, priority_score DESC)
    WHERE status = 'active';
