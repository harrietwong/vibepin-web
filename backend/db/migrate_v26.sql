-- migrate_v26.sql — Official vs derived trend series metadata

ALTER TABLE trend_keywords
    ADD COLUMN IF NOT EXISTS trend_series              JSONB,
    ADD COLUMN IF NOT EXISTS trend_series_granularity  text,
    ADD COLUMN IF NOT EXISTS trend_series_source       text,
    ADD COLUMN IF NOT EXISTS trend_series_updated_at   timestamptz;

CREATE INDEX IF NOT EXISTS idx_trend_keywords_series_source
    ON trend_keywords (trend_series_source)
    WHERE trend_series IS NOT NULL;

COMMENT ON COLUMN trend_keywords.trend_series IS
    'Official Pinterest time series (weekly 0-100). Use trend_series_source to distinguish from derived curves in trend_history.';

COMMENT ON COLUMN trend_keywords.trend_series_source IS
    'pinterest_trends_api | derived_growth_metrics | synthetic';
