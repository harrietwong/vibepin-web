-- migrate_v23.sql — crawl_queue stale requeue + trend source quality labels

ALTER TABLE crawl_queue
    ADD COLUMN IF NOT EXISTS last_crawled_at timestamptz,
    ADD COLUMN IF NOT EXISTS next_crawl_at   timestamptz;

ALTER TABLE trend_keywords
    ADD COLUMN IF NOT EXISTS data_quality text,
    ADD COLUMN IF NOT EXISTS confidence   text;

CREATE INDEX IF NOT EXISTS idx_crawl_queue_last_crawled
    ON crawl_queue (last_crawled_at DESC NULLS LAST)
    WHERE status IN ('completed', 'done');
