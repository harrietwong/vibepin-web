-- migrate_v24.sql — Cloud worker pipeline tracking + locks

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type          text        NOT NULL,
    status            text        NOT NULL DEFAULT 'running',
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    duration_seconds  numeric,
    error_message     text,
    rows_processed    int         DEFAULT 0,
    keywords_processed int        DEFAULT 0,
    created_by        text        DEFAULT 'cloud',
    metadata          jsonb       DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_job_started
    ON pipeline_runs (job_type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
    ON pipeline_runs (status, finished_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_locks (
    lock_name   text        PRIMARY KEY,
    locked_at   timestamptz NOT NULL DEFAULT now(),
    locked_by   text        NOT NULL,
    expires_at  timestamptz NOT NULL,
    run_id      uuid        REFERENCES pipeline_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_locks_expires
    ON pipeline_locks (expires_at);

-- crawl_queue scheduling (may already exist from v23)
ALTER TABLE crawl_queue
    ADD COLUMN IF NOT EXISTS last_crawled_at timestamptz,
    ADD COLUMN IF NOT EXISTS next_crawl_at   timestamptz;

CREATE INDEX IF NOT EXISTS idx_crawl_queue_due
    ON crawl_queue (priority_score DESC, attempts ASC, created_at ASC)
    WHERE status = 'pending';
