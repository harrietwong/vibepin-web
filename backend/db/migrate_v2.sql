-- ============================================================
-- Migration v2 — 增量字段（可重复执行）
-- ============================================================

-- trend_keywords 新增字段
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS intent_type          text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS content_type         text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS weekly_change        numeric DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS monthly_change       numeric DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS yearly_change        numeric DEFAULT 0;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS search_volume_level  text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS status               text DEFAULT 'active';
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS notes                text;
ALTER TABLE trend_keywords ADD COLUMN IF NOT EXISTS last_scraped_at      timestamptz;

-- pin_style_analysis 新增字段
ALTER TABLE pin_style_analysis ADD COLUMN IF NOT EXISTS prompt_seed          text;
ALTER TABLE pin_style_analysis ADD COLUMN IF NOT EXISTS title_pattern        text;
ALTER TABLE pin_style_analysis ADD COLUMN IF NOT EXISTS description_pattern  text;
