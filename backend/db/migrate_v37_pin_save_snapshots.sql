-- ── migrate_v37: pin_save_snapshots — point-in-time save counts per pin ───────
-- PRD v2.0 final (Phase 3): pin_samples stores only the LATEST save_count, so
-- 7-day / 30-day save velocity could never be measured honestly. This table
-- records one snapshot per pin per (UTC) day whenever the crawler observes the
-- pin again. Once enough history accumulates, real windows become:
--   7d velocity  = (latest.save_count − snapshot(≥7d ago).save_count) / days
--   30d velocity = (latest.save_count − snapshot(≥30d ago).save_count) / days
-- The UI keeps using the historical-average approximation (clearly labelled)
-- until per-window data exists for a pin.
--
-- captured_on is a plain date column (NOT an expression index on a timestamptz
-- cast, which is non-IMMUTABLE) so the daily-dedupe unique index is valid and
-- the writer can upsert idempotently on (pin_id, captured_on).
--
-- Apply via Supabase SQL Editor (raw :5432 is proxy-blocked from this machine).

CREATE TABLE IF NOT EXISTS pin_save_snapshots (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pin_id         text        NOT NULL,
    save_count     integer     NOT NULL,
    reaction_count integer,
    captured_at    timestamptz NOT NULL DEFAULT now(),
    captured_on    date        NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
    UNIQUE (pin_id, captured_on)
);

CREATE INDEX IF NOT EXISTS idx_pin_save_snapshots_pin_time
    ON pin_save_snapshots (pin_id, captured_at DESC);

COMMENT ON TABLE pin_save_snapshots IS
    'One save-count snapshot per pin per UTC day, written by the crawler on every observation. Powers real 7d/30d save velocity.';
