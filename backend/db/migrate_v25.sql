-- migrate_v25.sql — Honest keyword source labels + volume signals

ALTER TABLE trend_keywords
    ADD COLUMN IF NOT EXISTS data_quality text,
    ADD COLUMN IF NOT EXISTS confidence text,
    ADD COLUMN IF NOT EXISTS source_layer text,
    ADD COLUMN IF NOT EXISTS volume_signal text,
    ADD COLUMN IF NOT EXISTS volume_score numeric,
    ADD COLUMN IF NOT EXISTS search_volume_score numeric,
    ADD COLUMN IF NOT EXISTS search_volume numeric,
    ADD COLUMN IF NOT EXISTS last_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_trend_keywords_source_quality
    ON trend_keywords (source, data_quality, confidence);

CREATE INDEX IF NOT EXISTS idx_trend_keywords_volume_signal
    ON trend_keywords (category, volume_signal, volume_score DESC);

ALTER TABLE crawl_queue
    ADD COLUMN IF NOT EXISTS last_crawled_at timestamptz,
    ADD COLUMN IF NOT EXISTS next_crawl_at timestamptz,
    ADD COLUMN IF NOT EXISTS attempts int DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error text,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_crawl_queue_keyword_unique
    ON crawl_queue (keyword);

CREATE INDEX IF NOT EXISTS idx_crawl_queue_due_priority
    ON crawl_queue (priority_score DESC, attempts ASC, created_at ASC)
    WHERE status = 'pending';
