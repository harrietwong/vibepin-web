-- migrate_v29.sql — Official v5 trend provenance columns (REVIEW ONLY — do not apply automatically)
--
-- Adds first-class storage for Pinterest v5 top-trends metadata on trend_keywords.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.

ALTER TABLE trend_keywords
    ADD COLUMN IF NOT EXISTS trend_type text,
    ADD COLUMN IF NOT EXISTS v5_interest_param text;

COMMENT ON COLUMN trend_keywords.trend_type IS
    'Pinterest v5 top trend_type: growing | monthly | yearly | seasonal | top';

COMMENT ON COLUMN trend_keywords.v5_interest_param IS
    'Interest filter passed to v5 API when keyword was discovered';

CREATE INDEX IF NOT EXISTS idx_trend_keywords_v5_provenance
    ON trend_keywords (source_layer, trend_type)
    WHERE source_layer = 'official_v5';
